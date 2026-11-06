import { readFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createBridge, atomicCreate } from './index.mjs';
import { discoverClaude } from './adapters/claude.mjs';
import { normalizeSession, selectMessageTarget } from './session-routing.mjs';

const uuid = value => typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const events = new Set(['SessionStart', 'Stop', 'SessionEnd']);
const completedReceipts = new Set(['received', 'recipient-observed', 'work-claimed', 'handled',
  'message-superseded', 'superseded', 'execution-running', 'execution-failed']);
const compactStatus = status => ({ state: status?.state ?? 'unconfirmed',
  receiptState: status?.receiptState ?? 'unconfirmed', requiresAttention: status?.requiresAttention === true });
const identityOf = target => normalizeSession('claude', {
  ...(target?.sessionId ? { sessionId: target.sessionId } : {}),
  ...(target?.hostSessionId ? { hostSessionId: target.hostSessionId } : {}),
});

function integer(value, name, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error('Invalid lifecycle ' + name);
  return value;
}

function rootsOf(roots) {
  if (!Array.isArray(roots) || roots.length > 20
      || roots.some(root => typeof root !== 'string' || !isAbsolute(root))) {
    throw new Error('Lifecycle roots must be at most 20 explicit absolute paths');
  }
  const unique = new Map();
  for (const root of roots) {
    const absolute = resolve(root), key = process.platform === 'win32' ? absolute.toLowerCase() : absolute;
    if (!unique.has(key)) unique.set(key, absolute);
  }
  return [...unique.values()];
}

function exactRuntime(rows, sessionId) {
  const exact = rows.filter(row => row.sessionId === sessionId);
  if (exact.length > 1) return { reason: 'runtime-ambiguous', requiresAttention: true };
  if (!exact.length) return { reason: 'runtime-not-ready' };
  const runtime = exact[0];
  if (runtime.hostSessionId && rows.filter(row => row.hostSessionId === runtime.hostSessionId).length > 1) {
    return { reason: 'runtime-ambiguous', requiresAttention: true };
  }
  try { return { identity: identityOf(runtime) }; }
  catch { return { reason: 'runtime-identity-invalid', requiresAttention: true }; }
}

/** A host-bound message requires a verified host, even if the runtime ID happens
 * to match. Hook cwd/title and a manufactured local_ prefix are never identity. */
function sameRecipient(identity, target) {
  const recipient = identityOf(target);
  return recipient.hostSessionId ? identity.hostSessionId === recipient.hostSessionId
    : Boolean(recipient.sessionId && identity.sessionId === recipient.sessionId);
}

async function storedIdentity(root, sessionId) {
  try {
    const record = JSON.parse(await readFile(join(root, '.bridge', 'lifecycle', sessionId + '.json'), 'utf8'));
    if (record.version !== 1 || record.sessionId !== sessionId) throw new Error('Invalid lifecycle mapping');
    const identity = normalizeSession('claude', record.identity);
    if (identity?.sessionId !== sessionId) throw new Error('Invalid lifecycle mapping');
    return identity;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function retainIdentity(root, sessionId, identity, now) {
  const directory = join(root, '.bridge', 'lifecycle');
  await mkdir(directory, { recursive: true });
  await atomicCreate(join(directory, sessionId + '.json'), { version: 1, sessionId, identity,
    observedAt: new Date(now()).toISOString() });
  const stored = await storedIdentity(root, sessionId);
  if (!stored || stored.sessionId !== identity.sessionId || stored.hostSessionId !== identity.hostSessionId) {
    return false;
  }
  return true;
}

function pendingReceipt(message) {
  return !(message.receipts ?? []).some(row => completedReceipts.has(row.state)
    || row.observation?.recipientObserved === true)
    && !['received', 'recipient-observed'].includes(message.delivery?.receiptState);
}

/** One host lifecycle event, bounded work, no watcher/model call/ACK. The native
 * event is a readiness signal, never a receive/claim receipt. Stored identities
 * permit read-only reconciliation after runtime teardown, never an offline send.
 * Budgets are checked between awaited operations; in-flight transports retain
 * their own deadline/receipt ownership and are not abandoned with Promise.race. */
export async function handleClaudeLifecycle({ event, roots, readyWaitMs = 1500, budgetMs = 8000,
  limit = 20, bridgeFactory = createBridge, discover = discoverClaude,
  now = () => Date.now(), wait = milliseconds => sleep(milliseconds) } = {}) {
  const configuredRoots = rootsOf(roots);
  integer(readyWaitMs, 'readyWaitMs', 0, 10000);
  integer(budgetMs, 'budgetMs', 1, 60000);
  integer(limit, 'limit', 1, 100);
  const result = { event: typeof event?.hook_event_name === 'string' ? event.hook_event_name : null,
    sessionId: uuid(event?.session_id) ? event.session_id : null, roots: [], requiresAttention: false };
  if (!events.has(result.event) || event?.agent_id
      || result.event === 'SessionStart' && !['startup', 'resume'].includes(event.source)) {
    return { ...result, reason: 'unsupported-event' };
  }
  if (!result.sessionId) return { ...result, reason: 'invalid-session-id', requiresAttention: true };
  const deadlineAt = now() + budgetMs, available = () => now() < deadlineAt;
  const contexts = [];
  for (const root of configuredRoots) {
    if (!available()) { result.roots.push({ root, reason: 'deadline-reached' }); continue; }
    try {
      const settings = JSON.parse(await readFile(join(root, '.bridge', 'config.json'), 'utf8'));
      const home = settings.home ?? homedir();
      if (!settings.agents?.claude || typeof home !== 'string' || !isAbsolute(home)) {
        result.roots.push({ root, reason: 'configuration-invalid', requiresAttention: true }); continue;
      }
      contexts.push({ root, settings, home: resolve(home) });
    } catch { result.roots.push({ root, reason: 'configuration-unavailable', requiresAttention: true }); }
  }

  const homes = [...new Set(contexts.map(context => context.home))], discovered = new Map();
  const inspectHomes = async () => {
    for (const home of homes) {
      if (!available()) break;
      try {
        const rows = await discover({ home });
        if (!Array.isArray(rows)) throw new Error('Invalid discovery');
        discovered.set(home, exactRuntime(rows, result.sessionId));
      } catch { discovered.set(home, { reason: 'discovery-unavailable', requiresAttention: true }); }
    }
  };
  await inspectHomes();
  const readinessDeadline = Math.min(deadlineAt, now() + readyWaitMs);
  // One shared readiness budget across all explicitly configured homes. Finding
  // the event's runtime ends the wait; unrelated homes never add their own delay.
  while (result.event === 'SessionStart' && now() < readinessDeadline && available()
      && ![...discovered.values()].some(value => value.identity || value.reason === 'runtime-ambiguous')
      && [...discovered.values()].some(value => value.reason === 'runtime-not-ready')) {
    await wait(Math.min(100, readinessDeadline - now()));
    await inspectHomes();
  }

  let remaining = limit;
  for (const context of contexts) {
    const row = { root: context.root, flushed: { inspected: 0, results: [] }, observed: [] };
    result.roots.push(row);
    if (!available()) { row.reason = 'deadline-reached'; continue; }
    if (!remaining) { row.reason = 'message-limit-reached'; continue; }
    const runtime = discovered.get(context.home) ?? { reason: 'deadline-reached' };
    let identity = runtime.identity;
    if (!identity && result.event === 'SessionEnd'
        && ['runtime-not-ready', 'discovery-unavailable'].includes(runtime.reason)) {
      try { identity = await storedIdentity(context.root, result.sessionId); }
      catch { row.reason = 'stored-identity-invalid'; row.requiresAttention = true; continue; }
    }
    if (!identity) { row.reason = runtime.reason; row.requiresAttention = runtime.requiresAttention === true; continue; }
    row.identity = identity;
    if (runtime.identity) {
      try {
        if (!await retainIdentity(context.root, result.sessionId, identity, now)) {
          row.reason = 'historical-identity-conflict'; row.requiresAttention = true; continue;
        }
      } catch { row.reason = 'identity-storage-unavailable'; row.requiresAttention = true; continue; }
    }
    let bridge;
    try { bridge = bridgeFactory({ root: context.root }); }
    catch { row.reason = 'bridge-unavailable'; row.requiresAttention = true; continue; }
    if (result.event !== 'SessionEnd' && available()) {
      try {
        const flushed = await bridge.flush({ to: 'claude', session: identity, onlyUnsubmitted: true,
          limit: remaining, lockTimeoutMs: 250, responseTimeoutMs: 1500, deadlineAt,
          diagnoseAvailability: false, skipImmediateObservation: true, autoWake: false });
        row.flushed = { inspected: flushed.inspected ?? 0,
          results: (flushed.results ?? []).map(item => ({ messageId: item.messageId, resumed: item.resumed === true,
            ...(typeof item.reason === 'string' ? { reason: item.reason } : {}), ...compactStatus(item.status) })) };
        remaining -= Math.min(remaining, row.flushed.inspected);
        row.requiresAttention = flushed.requiresAttention === true;
      } catch { row.reason = 'flush-failed'; row.requiresAttention = true; }
    }
    if (!available()) { row.reason ??= 'deadline-reached'; continue; }
    if (!remaining) { row.reason ??= 'message-limit-reached'; continue; }
    let snapshot;
    try { snapshot = await bridge.status({ includeBodies: false }); }
    catch { row.reason ??= 'status-unavailable'; row.requiresAttention = true; continue; }
    for (const message of snapshot.messages) {
      if (!available() || !remaining) { row.reason ??= available() ? 'message-limit-reached' : 'deadline-reached'; break; }
      if (message.to !== 'claude' || !pendingReceipt(message)) continue;
      let matches;
      try { matches = sameRecipient(identity, selectMessageTarget(message, context.settings)); }
      catch { row.requiresAttention = true; row.reason ??= 'recipient-route-invalid'; continue; }
      if (!matches) continue;
      remaining--;
      try {
        const checked = await bridge.check(message.id, { lockTimeoutMs: 250, responseTimeoutMs: 1500 });
        row.observed.push({ messageId: message.id, ...compactStatus(checked.status) });
        row.requiresAttention ||= checked.status?.requiresAttention === true;
      } catch { row.observed.push({ messageId: message.id, reason: 'observation-failed' }); row.requiresAttention = true; }
    }
    row.reason ??= 'processed';
  }
  result.requiresAttention = result.roots.some(row => row.requiresAttention === true);
  return result;
}
