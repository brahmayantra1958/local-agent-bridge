import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { assertAgent, assertId } from './protocol.mjs';

const nonempty = value => typeof value === 'string' && Boolean(value.trim());

export function unavailableExecutionEvidence(app, sessionId, reason = 'No supported execution metadata source is available') {
  assertAgent(app);
  return { app, sessionId, observedModel: null, observedEffort: null,
    observedAt: null, evidenceStatus: 'unavailable', reason, source: null };
}

/** Only session_meta and turn_context are interpreted; conversation bodies are never returned. */
export async function readCodexExecutionEvidence(path, { sessionId, parentThreadId, includeParent = false, at } = {}) {
  if (sessionId) assertId(sessionId);
  if (parentThreadId) assertId(parentThreadId);
  const cutoff = at === undefined ? Infinity : Date.parse(at);
  if (!Number.isFinite(cutoff) && cutoff !== Infinity) throw new Error('Invalid evidence cutoff timestamp');
  const stream = createReadStream(path, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let meta, metaLine, startedAt, context, contextLine, lineNumber = 0;
  try {
    for await (const line of lines) {
      lineNumber++;
      if (!/"type"\s*:\s*"(?:session_meta|turn_context)"/.test(line)) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (row.type === 'session_meta' && !meta) {
        meta = row.payload; metaLine = lineNumber;
        try { assertId(meta?.id); } catch { meta = null; continue; }
        startedAt = Number.isFinite(Date.parse(meta.timestamp)) ? meta.timestamp
          : Number.isFinite(Date.parse(row.timestamp)) ? row.timestamp : null;
        if (at !== undefined && (startedAt === null || Date.parse(startedAt) > cutoff)) return null;
        if (sessionId && meta.id !== sessionId) return null;
        if (parentThreadId && meta.parent_thread_id !== parentThreadId && !(includeParent && meta.id === parentThreadId)) return null;
      } else if (row.type === 'turn_context' && meta) {
        const timestamp = Date.parse(row.timestamp);
        if (Number.isFinite(timestamp) && timestamp <= cutoff
          && (!context || timestamp >= Date.parse(context.timestamp))) {
          context = row; contextLine = lineNumber;
        }
      }
    }
  } finally { lines.close(); stream.destroy(); }
  if (!meta || typeof meta.id !== 'string') return null;
  const model = context?.payload?.model, effort = context?.payload?.effort;
  const observed = nonempty(model) && nonempty(effort);
  return { app: 'codex', sessionId: meta.id, parentThreadId: meta.parent_thread_id ?? null, startedAt,
    nickname: nonempty(meta.agent_nickname) ? meta.agent_nickname : null,
    observedModel: nonempty(model) ? model : null, observedEffort: nonempty(effort) ? effort : null,
    observedAt: context?.timestamp ?? null, evidenceStatus: observed ? 'observed' : 'unavailable',
    ...(observed ? {} : { reason: 'No complete turn_context model and effort at the requested time' }),
    source: { type: 'codex-rollout', path: resolve(path), sessionMetaLine: metaLine,
      turnContextLine: contextLine ?? null } };
}

async function rolloutFiles(directory) {
  const files = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if (item.isDirectory()) files.push(...await rolloutFiles(join(directory, item.name)));
    else if (item.isFile() && /^rollout-.*\.jsonl$/.test(item.name)) files.push(join(directory, item.name));
  }
  return files.sort();
}

/** Counts actual direct children from session metadata; use a date directory to bound I/O. */
export async function collectCodexExecutionEvidence({ parentThreadId, rootDirectory = join(homedir(), '.codex', 'sessions'), files, at } = {}) {
  assertId(parentThreadId);
  const found = new Map(), unavailableFiles = [];
  let paths = files;
  if (paths === undefined) {
    try { paths = await rolloutFiles(rootDirectory); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return { app: 'codex', parentThreadId, parent: null, subagents: [], startedSubagentCount: 0,
        evidenceStatus: 'unavailable', reason: 'Rollout directory is absent', unavailableFiles: [] };
    }
  }
  if (!Array.isArray(paths)) throw new Error('Evidence files must be an array');
  for (const path of paths) {
    let evidence;
    try { evidence = await readCodexExecutionEvidence(path, { parentThreadId, includeParent: true, at }); }
    catch (error) { unavailableFiles.push({ path: resolve(path), code: error.code ?? 'read-error' }); continue; }
    if (!evidence) continue;
    const previous = found.get(evidence.sessionId);
    if (!previous || (Date.parse(evidence.observedAt) || 0) >= (Date.parse(previous.observedAt) || 0)) found.set(evidence.sessionId, evidence);
  }
  const parent = found.get(parentThreadId) ?? null;
  const subagents = [...found.values()].filter(item => item.sessionId !== parentThreadId).sort((a, b) => a.sessionId.localeCompare(b.sessionId));
  return { app: 'codex', parentThreadId, parent, subagents, startedSubagentCount: subagents.length,
    ...(at === undefined ? {} : { asOf: at, countScope: 'Only sessions with a creation timestamp at or before asOf' }),
    evidenceStatus: !found.size ? 'unavailable' : [...found.values()].every(item => item.evidenceStatus === 'observed') ? 'observed' : 'partial', unavailableFiles };
}
