import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { discoverAntigravity, antigravityRpc } from './adapters/antigravity.mjs';
import { execFileAsync } from './runtime.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const recoverable = new Set(['ANTIGRAVITY_APP_NOT_RUNNING', 'ANTIGRAVITY_ENDPOINT_UNAVAILABLE']);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function isFile(path) { try { return (await stat(path)).isFile(); } catch { return false; } }

/** Normal application launch, with its own login/settings/single-instance guard.
 * No alternate CLI session, model/permission flags or new-conversation command.
 * The launched app remains user-owned; this function never terminates it.
 */
async function launchApplication(executable) {
  await new Promise((resolve, reject) => {
    const child = spawn(executable, [], { windowsHide: true, detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

async function readMetadata(target, connection, timeoutMs) {
  const result = await execFileAsync(connection.exe,
    ['agentapi', 'get-conversation-metadata', target.conversationId],
    { windowsHide: true, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 1024 * 1024,
      env: { ...process.env, ANTIGRAVITY_LS_ADDRESS: connection.address,
        ANTIGRAVITY_CSRF_TOKEN: connection.csrfToken } });
  return JSON.parse(result.stdout).response?.conversationMetadata?.metadata;
}

/** One bounded recovery of the pinned App conversation. Caller holds endpoint
 * mutex and only calls after a proven pre-submission failure. This function
 * sends no prompt and never rewrites the envelope/config or creates a cascade.
 */
export async function wakeAntigravity(target, config = {}, options = {}) {
  const base = { agent: 'gemini', conversationId: target?.conversationId,
    appStarted: false, rehydrated: false };
  const failed = reasonCode => ({ ...base, ready: false, reasonCode });
  if (!UUID.test(target?.conversationId ?? '')) return failed('invalid-conversation-id');
  const budgetMs = options.wakeTimeoutMs ?? 20000;
  if (!Number.isSafeInteger(budgetMs) || budgetMs < 1 || budgetMs > 60000) return failed('invalid-wake-timeout');
  const now = options.now ?? Date.now, pause = options.wait ?? wait;
  const discover = options.discover ?? discoverAntigravity;
  const rpc = options.rpc ?? antigravityRpc;
  const fileExists = options.isFile ?? isFile;
  const home = config.home ?? homedir();
  const deadline = now() + budgetMs;
  let connection, initialError;
  try { connection = await discover({timeoutMs: Math.max(1, deadline-now())}); } catch (error) { initialError = error; }
  if (now() >= deadline) return failed('app-readiness-timeout');
  if (!connection) {
    if (!recoverable.has(initialError?.code)) return failed('endpoint-not-recoverable');
    if (initialError.code === 'ANTIGRAVITY_APP_NOT_RUNNING') {
      // Confirm a stored original before starting an application for it. Never
      // fall back to --continue or a newly allocated conversation.
      const stored = join(home, '.gemini', 'antigravity', 'conversations', target.conversationId + '.db');
      if (!await fileExists(stored)) return failed('stored-conversation-unavailable');
      const executable = join(home, 'AppData', 'Local', 'Programs', 'antigravity', 'Antigravity.exe');
      if (!await fileExists(executable)) return failed('app-executable-unavailable');
      if (now() >= deadline) return failed('app-readiness-timeout');
      try { await (options.launchApplication ?? launchApplication)(executable); }
      catch { return failed('app-launch-failed'); }
      base.appStarted = true;
    }
    // These checks are within this one launch request, never a persistent
    // watcher or a model-polling loop. No prompts are submitted while waiting.
    while (now() < deadline) {
      await pause(Math.min(400, Math.max(1, deadline - now())));
      if (now() >= deadline) break;
      try { connection = await discover({timeoutMs: Math.max(1, deadline-now())}); break; }
      catch (error) { if (!recoverable.has(error?.code)) return failed('endpoint-not-recoverable'); }
    }
    if (!connection) return failed('app-readiness-timeout');
  }
  if (now() >= deadline) return failed('app-readiness-timeout');
  // The existing project is part of the pinned route. Read metadata without
  // prompting before asking the app to rehydrate a stored cascade.
  if (target.projectId) {
    let metadata;
    try { metadata = await (options.readMetadata ?? readMetadata)(target, connection,
      Math.max(1, Math.min(10000, deadline - now()))); }
    catch { return failed('conversation-metadata-unavailable'); }
    if (metadata?.projectId !== target.projectId) return failed('conversation-project-mismatch');
    if (now() >= deadline) return failed('app-readiness-timeout');
  }
  let result;
  try {
    result = await rpc('GetCascadeTrajectory', { cascadeId: target.conversationId, disableRehydration: false },
      { ...options, connection, timeoutMs: Math.max(1, Math.min(15000, deadline - now())) });
  } catch { return failed('conversation-rehydration-failed'); }
  if (result.trajectory?.cascadeId !== target.conversationId) return failed('conversation-identity-unconfirmed');
  if (target.projectId && result.trajectory?.metadata?.projectId !== target.projectId) return failed('conversation-project-mismatch');
  if (!Array.isArray(result.trajectory?.steps)) return failed('conversation-history-unavailable');
  return { ...base, ready: true, rehydrated: true, method: 'app-launch-and-rehydrate', reasonCode: 'existing-conversation-ready' };
}
