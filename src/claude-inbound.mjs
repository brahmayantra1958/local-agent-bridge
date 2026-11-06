import { open, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { findClaudeTranscript } from './claude-observation.mjs';

// Pre-submit prediction of Claude's documented inbound rule (code.claude.com
// cross-session messaging). An explicit crossSessionInbound hold/refuse applies
// to every message; otherwise a session that bypasses permission prompts holds
// messages unless the sender also asserts bypass, and a prompting session holds
// a sender asserting bypass. Desktop cannot show the approval dialog and drops
// a held message at the dialog deadline (default five minutes).
// Prediction reads only metadata (latest recorded mode, settings values) and
// blocks only when every signal agrees, so an unknown never stops delivery.

const MODES = new Set(['bypassPermissions', 'default', 'plan', 'acceptEdits', 'dontAsk', 'auto']);
const INBOUND = ['accept', 'hold', 'refuse'];
const strictness = value => INBOUND.indexOf(value);
const DIALOG_UNAVAILABLE = value => value === 'claude-desktop' || /vscode/i.test(value ?? '');

/** bypass | prompting | null. Plan mode depends on terminal availability of bypass, so it is unknown. */
export function claudePermissionClass(mode) {
  if (mode === 'bypassPermissions') return 'bypass';
  return ['default', 'acceptEdits', 'dontAsk', 'auto'].includes(mode) ? 'prompting' : null;
}

/** Latest permission mode recorded on a user turn of this exact session (bounded tail read). */
export async function readClaudeRecipientMode(target, config = {}, { maxBytes = 2 * 1024 * 1024, find = findClaudeTranscript } = {}) {
  let location;
  try { location = await find(target, config); } catch { return null; }
  if (!location?.path) return null;
  let handle;
  try { handle = await open(location.path, 'r'); } catch { return null; }
  try {
    const { size } = await handle.stat(), length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, size - length);
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n');
    if (size > length) lines.shift();
    for (let index = lines.length - 1; index >= 0; index--) {
      let row;
      try { row = JSON.parse(lines[index]); } catch { continue; }
      if (row?.type !== 'user' || !MODES.has(row.permissionMode)) continue;
      if ((row.sessionId ?? row.session_id ?? target.sessionId) !== target.sessionId) continue;
      return { mode: row.permissionMode, ...(typeof row.timestamp === 'string' ? { recordedAt: row.timestamp } : {}) };
    }
    return null;
  } catch { return null; } finally { await handle.close(); }
}

async function settingValue(path) {
  let text;
  try { text = await readFile(path, 'utf8'); }
  catch (error) { return error.code === 'ENOENT' ? { present: false } : { present: true, unreadable: true }; }
  try {
    const value = JSON.parse(text.replace(/^\uFEFF/, ''));
    return { present: true, value: value && typeof value === 'object' ? value.crossSessionInbound : undefined };
  } catch { return { present: true, unreadable: true }; }
}

/** Settings files the recipient runtime reads. The --settings flag of a running
 * process is not observable; managed files are checked at both Windows locations. */
export function claudeSettingsSources(home, cwd) {
  const managed = process.platform === 'win32'
    ? [join(process.env.ProgramFiles ?? 'C:\\Program Files', 'ClaudeCode', 'managed-settings.json'),
      join(process.env.ProgramData ?? 'C:\\ProgramData', 'ClaudeCode', 'managed-settings.json')]
    : process.platform === 'darwin' ? ['/Library/Application Support/ClaudeCode/managed-settings.json']
      : ['/etc/claude-code/managed-settings.json'];
  return { managed, user: [join(home, '.claude', 'settings.json')],
    project: cwd ? [join(cwd, '.claude', 'settings.json')] : [], local: cwd ? [join(cwd, '.claude', 'settings.local.json')] : [] };
}

/** accept | hold | refuse | undefined (per-message rule) | 'unknown' (a source could not be read). */
export function effectiveInbound({ managed, user, project, local }) {
  const known = (value, source) => value === undefined ? undefined
    : INBOUND.includes(value) ? value : source === 'managed' ? 'refuse' : 'hold';
  const trusted = known(managed, 'managed') ?? known(user, 'user');
  const repository = [known(project, 'project'), known(local, 'local')].filter(Boolean)
    .sort((a, b) => strictness(b) - strictness(a))[0];
  // An unrecognized non-managed value holds even if a higher source accepts.
  const unrecognized = [user, project, local].some(value => value !== undefined && !INBOUND.includes(value));
  let result = trusted;
  if (repository && (result === undefined ? repository !== 'accept' : strictness(repository) > strictness(result))) result = repository;
  if (unrecognized && (result === undefined || strictness(result) < strictness('hold'))) result = 'hold';
  return result;
}

export async function readClaudeInboundSetting(home, cwd) {
  const sources = claudeSettingsSources(home, cwd), values = {};
  for (const [scope, paths] of Object.entries(sources)) {
    for (const path of paths) {
      const read = await settingValue(path);
      if (read.unreadable) return 'unknown';
      if (read.present && read.value !== undefined && values[scope] === undefined) values[scope] = read.value;
    }
  }
  return effectiveInbound(values);
}

/** Pure decision. Only a recipient that cannot show the approval dialog is blocked. */
export function predictClaudeHold({ entrypoint, recipientMode, senderClass, inbound }) {
  if (!DIALOG_UNAVAILABLE(entrypoint)) return { predicted: false, reason: 'approval-dialog-available-or-unknown' };
  if (inbound === 'unknown') return { predicted: false, reason: 'inbound-setting-unreadable' };
  if (inbound === 'refuse') return { predicted: true, outcome: 'refused', reasonCode: 'claude-inbound-refused-by-setting' };
  if (inbound === 'hold') return { predicted: true, outcome: 'held', reasonCode: 'claude-inbound-hold-by-setting' };
  if (inbound === 'accept') return { predicted: false, reason: 'inbound-accept' };
  const recipientClass = claudePermissionClass(recipientMode);
  if (!recipientClass) return { predicted: false, reason: 'recipient-mode-unknown' };
  const sender = senderClass === 'bypass' ? 'bypass' : 'prompting';
  if (recipientClass === sender) return { predicted: false, reason: 'permission-classes-match' };
  return { predicted: true, outcome: 'held', reasonCode: 'claude-desktop-hold-predicted', recipientClass, senderClass: sender };
}

/** Never throws; any read failure yields no prediction. */
export async function predictClaudeInboundHold(live, config = {}, senderClass = 'prompting') {
  try {
    if (!DIALOG_UNAVAILABLE(live?.entrypoint)) return { predicted: false, reason: 'approval-dialog-available-or-unknown' };
    const home = config.home ?? homedir();
    const [mode, inbound] = await Promise.all([readClaudeRecipientMode({ sessionId: live.sessionId }, config),
      readClaudeInboundSetting(home, typeof live.cwd === 'string' ? live.cwd : null)]);
    return { ...predictClaudeHold({ entrypoint: live.entrypoint, recipientMode: mode?.mode, senderClass, inbound }),
      evidence: { source: 'claude-inbound-prediction', entrypoint: live.entrypoint,
        ...(mode ? { recipientMode: mode.mode, ...(mode.recordedAt ? { modeRecordedAt: mode.recordedAt } : {}) } : {}),
        senderClass: senderClass === 'bypass' ? 'bypass' : 'prompting', inbound: inbound ?? 'per-message' } };
  } catch { return { predicted: false, reason: 'prediction-unavailable' }; }
}
