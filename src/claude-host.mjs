import { readdir, open, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { powershell } from './runtime.mjs';
import { normalizeSession } from './session-routing.mjs';

const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const nativeHost = value => typeof value === 'string' && value.startsWith('local_') && uuid(value.slice(6));
const slashPath = value => value.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
const positiveLimit = (value, fallback, maximum) => {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error('Invalid Claude host inspection limit');
  return value;
};

async function readDesktopProcesses() {
  if (process.platform !== 'win32') throw new Error('Windows process inventory unavailable');
  // Never collect command lines: Desktop and its embedded runtime share a name,
  // while arguments can contain credentials and user input.
  return JSON.parse(await powershell(`$bridgeProcesses = @(Get-CimInstance Win32_Process -Filter "Name = 'claude.exe'" -ErrorAction Stop | Select-Object ProcessId,ExecutablePath); ConvertTo-Json -InputObject $bridgeProcesses -Compress`));
}

async function desktopState(home, readProcesses) {
  try {
    const processes = await readProcesses();
    if (!Array.isArray(processes)) return 'unknown';
    const installation = slashPath(join(home, 'AppData', 'Local', 'AnthropicClaude')) + '/';
    const embedded = slashPath(join(home, 'AppData', 'Roaming', 'Claude', 'claude-code')) + '/';
    let unknown = false;
    for (const row of processes) {
      if (!row || !Number.isSafeInteger(row.ProcessId) || row.ProcessId < 1 || typeof row.ExecutablePath !== 'string') {
        unknown = true; continue;
      }
      const path = slashPath(row.ExecutablePath);
      if (path.startsWith(installation) && /^app-\d+(?:\.\d+)*\/claude\.exe$/.test(path.slice(installation.length))) return 'running';
      // An embedded CLI by itself is not evidence that Desktop is running.
      // Unknown installs (e.g. a future Store layout) are not reported as closed.
      if (!path.startsWith(embedded) || !path.endsWith('/claude.exe')) unknown = true;
    }
    return unknown ? 'unknown' : 'not-running';
  } catch { return 'unknown'; }
}

async function readBoundedMetadata(path, maxBytes) {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size > maxBytes) throw new Error('Unusable Claude metadata');
  const file = await open(path, 'r');
  try {
    const snapshot = await file.stat();
    if (snapshot.ino !== before.ino || snapshot.dev !== before.dev || snapshot.size > maxBytes) throw new Error('Claude metadata changed');
    const buffer = Buffer.alloc(snapshot.size);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) throw new Error('Incomplete Claude metadata');
      offset += bytesRead;
    }
    const after = await file.stat(), named = await lstat(path);
    if (snapshot.size !== after.size || snapshot.mtimeMs !== after.mtimeMs
        || after.ino !== named.ino || after.dev !== named.dev || named.isSymbolicLink()) throw new Error('Claude metadata changed');
    return JSON.parse(buffer.toString('utf8').replace(/^\uFEFF/, ''));
  } finally { await file.close(); }
}

async function conversationState(home, hostSessionId, limits) {
  if (!nativeHost(hostSessionId)) return 'unknown';
  const base = join(home, 'AppData', 'Roaming', 'Claude', 'claude-code-sessions');
  let accounts;
  try { accounts = await readdir(base, { withFileTypes: true }); }
  catch (error) { return error.code === 'ENOENT' ? 'missing' : 'unknown'; }
  const dirs = rows => rows.filter(row => row.isDirectory() && !row.isSymbolicLink() && uuid(row.name));
  accounts = dirs(accounts);
  let incomplete = accounts.length > limits.maxAccounts, organizationsSeen = 0;
  const candidates = [];
  for (const account of accounts.slice(0, limits.maxAccounts)) {
    let organizations;
    try { organizations = dirs(await readdir(join(base, account.name), { withFileTypes: true })); }
    catch { incomplete = true; continue; }
    for (const organization of organizations) {
      if (++organizationsSeen > limits.maxOrganizations) { incomplete = true; break; }
      const path = join(base, account.name, organization.name, hostSessionId + '.json');
      try {
        const row = await readBoundedMetadata(path, limits.maxMetadataBytes);
        if (!row || row.sessionId !== hostSessionId || !uuid(row.cliSessionId)
            || row.isArchived !== undefined && typeof row.isArchived !== 'boolean') { incomplete = true; continue; }
        candidates.push(row.isArchived === true ? 'archived' : 'stored');
        if (candidates.length > 1) return 'ambiguous';
      } catch (error) { if (error.code !== 'ENOENT') incomplete = true; }
    }
    if (organizationsSeen > limits.maxOrganizations) break;
  }
  return incomplete ? 'unknown' : candidates[0] ?? 'missing';
}

async function runtimeInventory(home, { maxRuntimeFiles, maxMetadataBytes }) {
  let entries;
  try { entries = await readdir(join(home, '.claude', 'sessions'), { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  entries = entries.filter(entry => entry.isFile() && /^\d+\.json$/.test(entry.name));
  if (entries.length > maxRuntimeFiles) throw new Error('Claude runtime inventory limited');
  const rows = [];
  for (const entry of entries) {
    let row;
    try { row = await readBoundedMetadata(join(home, '.claude', 'sessions', entry.name), maxMetadataBytes); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!row || !Number.isSafeInteger(row.pid) || row.pid <= 0 || String(row.pid) !== entry.name.slice(0, -5)) continue;
    try { process.kill(row.pid, 0); }
    catch (error) { if (error.code === 'ESRCH') continue; throw error; }
    rows.push(row);
  }
  return rows;
}

function runtimeState(target, sessions) {
  if (!Array.isArray(sessions)) return { runtimeState: 'unknown' };
  if (target.sessionId && target.hostSessionId && sessions.some(row => row?.sessionId === target.sessionId
      && row.hostSessionId !== target.hostSessionId)) return { runtimeState: 'unknown' };
  const candidates = sessions.filter(row => row && (target.hostSessionId
    ? row.hostSessionId === target.hostSessionId : row.sessionId === target.sessionId));
  if (candidates.length > 1) return { runtimeState: 'ambiguous' };
  const row = candidates[0];
  if (!row) return { runtimeState: 'absent' };
  if (!uuid(row.sessionId) || target.hostSessionId && row.hostSessionId !== target.hostSessionId) return { runtimeState: 'unknown' };
  return { runtimeState: 'running', sessionId: row.sessionId,
    ...(nativeHost(row.hostSessionId) ? { hostSessionId: row.hostSessionId } : {}) };
}

/** Read-only, independent Desktop / saved chat / runtime diagnostics.
 * The current 4.16336.0 Desktop layout and 2.1.317 CLI provide no supported
 * unattended runtime-wake command. The bridge's separate Codex UI recovery
 * can submit to the existing Desktop conversation. This diagnostic itself
 * starts no application and sends no message.
 * `sessions`, when supplied, must be a live discovery snapshot, not saved chats.
 * Only allowlisted identifiers and states escape this boundary.
 */
export async function inspectClaudeHost(target, config = {}, options = {}) {
  const identity = normalizeSession('claude', { sessionId: target?.sessionId, hostSessionId: target?.hostSessionId });
  const home = resolve(config.home ?? homedir());
  const limits = {
    maxAccounts: positiveLimit(options.maxAccounts, 64, 1024),
    maxOrganizations: positiveLimit(options.maxOrganizations, 256, 4096),
    maxMetadataBytes: positiveLimit(options.maxMetadataBytes, 2 * 1024 * 1024, 16 * 1024 * 1024),
    maxRuntimeFiles: positiveLimit(options.maxRuntimeFiles, 512, 4096),
  };
  const [appState, stored, runtime] = await Promise.all([
    desktopState(home, options.readDesktopProcesses ?? readDesktopProcesses),
    conversationState(home, identity.hostSessionId, limits),
    (async () => {
      try { return runtimeState(identity, options.sessions ?? await runtimeInventory(home, limits)); }
      catch { return { runtimeState: 'unknown' }; }
    })(),
  ]);
  return { appState, conversationState: stored,
    ...(nativeHost(identity.hostSessionId) ? { hostSessionId: identity.hostSessionId } : {}), ...runtime,
    wake: { supported: false, reason: 'desktop-no-supported-unattended-runtime-wake' },
    ...(config.agents?.codex?.threadId ? { recovery: { method: 'codex-ui-recovery',
      requiresInteractiveDesktop: true } } : {}) };
}
