import { open, opendir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { assertAgent, assertId, KINDS } from './protocol.mjs';

const time = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : undefined;
const integer = (value, fallback, min, max, name) => {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < min || result > max) throw new Error(`Invalid ${name}`);
  return result;
};

function dateDirectories(threadId) {
  if (threadId[14] !== '7') return [];
  const epoch = Number.parseInt(threadId.replaceAll('-', '').slice(0, 12), 16);
  return [0, -1, 1].map(offset => new Date(epoch + offset * 86400000).toISOString().slice(0, 10).replaceAll('-', '/'));
}

/** Locate by filename before opening records; never crawl conversation contents. */
export async function findCodexRollout(target, config = {}, options = {}) {
  assertId(target.threadId);
  if (target.rolloutPath) return { path: resolve(target.rolloutPath), source: 'registered-rollout', complete: true };
  const codexHome = options.codexHome ?? config.codexHome
    ?? (config.home ? join(config.home, '.codex') : process.env.CODEX_HOME || join(homedir(), '.codex'));
  const sessions = join(codexHome, 'sessions');
  const suffix = `-${target.threadId}.jsonl`;
  const maxDirectories = integer(options.maxDirectories, 4096, 1, 10000, 'maxDirectories');
  const maxEntries = integer(options.maxEntries, 100000, 1, 1000000, 'maxEntries');
  let directories = 0, entries = 0, limited = false;
  const visited = new Set(), found = new Set();
  async function scan(directory, descendants = false) {
    if (visited.has(directory)) return;
    if (++directories > maxDirectories) { limited = true; return; }
    visited.add(directory);
    let handle;
    try { handle = await opendir(directory); }
    catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return; throw error; }
    const children = [];
    for await (const entry of handle) {
      if (++entries > maxEntries) { limited = true; break; }
      if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith(suffix)) found.add(join(directory, entry.name));
      else if (descendants && entry.isDirectory() && /^\d{2,4}$/.test(entry.name)) children.push(join(directory, entry.name));
    }
    if (descendants && !limited) for (const child of children) { await scan(child, true); if (limited) break; }
  }
  for (const date of dateDirectories(target.threadId)) await scan(join(sessions, date));
  if (!found.size && !limited) await scan(sessions, true);
  // Archived transcripts may confirm an old receipt but are never mistaken for
  // absence in an active chat. The caller suppresses negative evidence here.
  let archived = false;
  if (!found.size && !limited) { archived = true; await scan(join(codexHome, 'archived_sessions'), true); }
  return { path: found.size === 1 ? [...found][0] : null, source: archived ? 'archived-rollout' : 'codex-sessions',
    complete: !limited, ambiguous: found.size > 1, directories, entries };
}

function bridgeInput(text, nativeDelegation = false) {
  if (typeof text !== 'string') return null;
  if (!nativeDelegation) return text;
  // Native incoming messages are recorded as a named function_call_output, not
  // a user role. A generic tool output containing the same UUID is not receipt.
  const match = text.match(/^<codex_delegation>\s*<source_thread_id>[0-9a-f-]{36}<\/source_thread_id>\s*<input>([\s\S]*)<\/input>\s*<\/codex_delegation>\s*$/i);
  return match?.[1] ?? null;
}

function inboundTexts(row, threadId) {
  const payload = row?.payload;
  if (row.type === 'event_msg' && payload?.type === 'user_message') return [bridgeInput(payload.message)];
  if (row.type === 'response_item' && payload?.type === 'message' && payload.role === 'user') {
    const texts = (payload.content ?? []).filter(item => item.type === 'input_text' || item.type === 'text').map(item => item.text).filter(text => typeof text === 'string');
    return [...texts, texts.join(''), texts.join('\n')].map(text => bridgeInput(text));
  }
  const item = row.type === 'response_item' ? payload
    : row.type === 'event_msg' && payload?.type === 'item_completed' && payload.thread_id === threadId ? payload.item : null;
  if (['function_call_output', 'FunctionCallOutput'].includes(item?.type)
      && item.namespace === 'codex_app' && item.name === 'send_message_to_thread') return [bridgeInput(item.output, true)];
  return [];
}

function exactInbound(row, threadId, message) {
  const correlation = message.correlationId ?? '[0-9a-f-]{36}';
  const kind = message.kind ?? `(?:${KINDS.join('|')})`;
  const header = new RegExp(`^\\[agent-bridge v1 \\| ${message.from} → codex \\| ${kind}\\]\\r?\\nMessage ID: ${message.id}\\r?\\nCorrelation ID: ${correlation}(?:\\r?\\n|$)`, 'i');
  return inboundTexts(row, threadId).some(text => typeof text === 'string' && header.test(text));
}

/** Stream one immutable-size snapshot with bounded record memory. A partial,
 * malformed, replaced, growing or limited scan can confirm a found receipt but
 * cannot support negative evidence. No text or tool result leaves this module. */
export async function scanCodexRollout(path, threadId, message, options = {}) {
  const maxScanBytes = integer(options.maxScanBytes, 256 * 1024 * 1024, 1, 1024 * 1024 * 1024, 'maxScanBytes');
  const maxLineBytes = integer(options.maxLineBytes, 8 * 1024 * 1024, 1, 64 * 1024 * 1024, 'maxLineBytes');
  const file = await open(path, 'r');
  try {
    const before = await file.stat(), snapshotBytes = before.size, limit = Math.min(snapshotBytes, maxScanBytes);
    const chunk = Buffer.alloc(Math.min(256 * 1024, Math.max(1, limit)));
    let bytesScanned = 0, parts = [], lineBytes = 0, skipping = false, lineNumber = 0;
    let parseErrors = 0, oversizedRecords = 0, recordsBeforeMetadata = 0, sessionMatched = false, sessionMismatch = false, found;
    let lastRecordAt, lastTaskEvent;
    function consume(line) {
      lineNumber++;
      if (!line.length) return;
      let row;
      try { row = JSON.parse(line.toString('utf8')); } catch { parseErrors++; return; }
      if (time(row.timestamp)) lastRecordAt = row.timestamp;
      if (row.type === 'session_meta') {
        if (row.payload?.id !== threadId) sessionMismatch = true;
        else sessionMatched = true;
      } else if (!sessionMatched) recordsBeforeMetadata++;
      if (sessionMatched && !sessionMismatch && !found && exactInbound(row, threadId, message)) {
        found = { line: lineNumber, timestamp: time(row.timestamp), recordType: row.type, payloadType: row.payload?.type };
      }
      // Event activity is descriptive only; a later task may belong to another message.
      if (row.type === 'event_msg' && ['task_started', 'task_complete', 'turn_aborted'].includes(row.payload?.type)) {
        lastTaskEvent = { type: row.payload.type, timestamp: time(row.timestamp) };
      }
    }
    while (bytesScanned < limit) {
      const { bytesRead } = await file.read(chunk, 0, Math.min(chunk.length, limit - bytesScanned), bytesScanned);
      if (!bytesRead) break;
      bytesScanned += bytesRead;
      let start = 0;
      for (let index = 0; index < bytesRead; index++) {
        if (chunk[index] !== 10) continue;
        const segment = chunk.subarray(start, index);
        if (!skipping && lineBytes + segment.length <= maxLineBytes) {
          const line = parts.length ? Buffer.concat([...parts, segment], lineBytes + segment.length) : segment;
          consume(line);
        } else { oversizedRecords++; lineNumber++; }
        parts = []; lineBytes = 0; skipping = false; start = index + 1;
      }
      if (start < bytesRead && !skipping) {
        const segment = chunk.subarray(start, bytesRead);
        if (lineBytes + segment.length > maxLineBytes) { skipping = true; parts = []; lineBytes = 0; }
        else { parts.push(Buffer.from(segment)); lineBytes += segment.length; }
      }
    }
    const partialFinalLine = lineBytes > 0 || skipping;
    const after = await stat(path);
    const changedDuringScan = before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || before.ino !== after.ino || before.dev !== after.dev;
    const complete = sessionMatched && !sessionMismatch && bytesScanned === snapshotBytes
      && !partialFinalLine && !parseErrors && !oversizedRecords && !recordsBeforeMetadata && !changedDuringScan;
    return { found: sessionMismatch ? undefined : found, complete, threadId, messageId: message.id,
      sessionMatched, sessionMismatch, snapshotBytes, bytesScanned, lineCount: lineNumber,
      partialFinalLine, parseErrors, oversizedRecords, recordsBeforeMetadata, changedDuringScan, lastRecordAt, lastTaskEvent };
  } finally { await file.close(); }
}

export async function inspectCodexRollout(target, config, message, options = {}) {
  assertId(target?.threadId); assertId(message?.id); assertAgent(message?.from);
  if (message.correlationId !== undefined) assertId(message.correlationId);
  if (message.kind !== undefined && !KINDS.includes(message.kind)) throw new Error('Invalid message kind');
  const base = { transport: 'codex-app-tools', sessionId: target.threadId, messageId: message.id,
    observedAt: new Date().toISOString(), executionState: 'unknown' };
  if (target.hostId && target.hostId !== 'local') return { ...base, state: 'delivery-unconfirmed',
    reasonCode: 'codex-remote-observation-unavailable', evidence: { complete: false, threadId: target.threadId, messageId: message.id },
    nextAction: 'inspect-registered-remote-recipient' };
  let location, scan;
  try {
    location = await findCodexRollout(target, config, options);
    if (location.path) scan = await scanCodexRollout(location.path, target.threadId, message, options);
  } catch (error) {
    return { ...base, state: 'delivery-unconfirmed', reasonCode: error.code === 'ENOENT' ? 'codex-rollout-missing' : 'codex-rollout-unavailable',
      evidence: { complete: false, threadId: target.threadId, messageId: message.id }, nextAction: 'check-recipient-rollout-availability' };
  }
  if (!scan) return { ...base, state: 'delivery-unconfirmed',
    reasonCode: location.ambiguous ? 'codex-rollout-ambiguous' : location.complete ? 'codex-rollout-missing' : 'codex-discovery-limited',
    evidence: { complete: false, threadId: target.threadId, messageId: message.id }, nextAction: 'check-recipient-rollout-availability' };
  const { found, ...evidence } = scan;
  evidence.source = 'codex-rollout';
  if (!location.complete || location.source === 'archived-rollout') evidence.complete = false;
  if (found) return { ...base, state: 'recipient-observed', recipientObserved: true, reasonCode: 'codex-rollout-message-found',
    evidence: { ...evidence, ...found }, nextAction: 'none' };
  return { ...base, state: evidence.complete ? 'delivery-not-observed' : 'delivery-unconfirmed', recipientObserved: false,
    reasonCode: evidence.complete ? 'codex-message-absent-in-complete-rollout'
      : scan.sessionMismatch || !scan.sessionMatched ? 'codex-rollout-session-mismatch' : 'codex-rollout-incomplete',
    evidence, nextAction: evidence.complete ? 'resume-original-message-with-delivery-guard' : 'check-recipient-rollout-availability' };
}
