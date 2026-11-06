import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, link, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { assertId, MAX_BODY_BYTES } from './protocol.mjs';

const terminalStatuses = new Set(['completed', 'failed', 'blocked']);
const text = value => typeof value === 'string' && value.trim().length > 0;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const iso = value => new Date(value).toISOString();

export function completionMessageId(requestId, runId) {
  assertId(requestId);
  const hex = digest(['agent-bridge-completion.v1', requestId, runId]);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// Complete immutable records are published atomically. The winning terminal
// event and its envelope never change, including after a crash or replay.
async function publish(path, value) {
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  try { await link(temp, path); return { created: true, value }; }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return { created: false, value: await readJson(path) };
  } finally { await unlink(temp).catch(() => {}); }
}

function validateRunId(runId) {
  if (!text(runId) || runId.length > 256) throw new Error('A bounded runId is required');
  return runId;
}

function completionReport(input) {
  if (!terminalStatuses.has(input.status)) throw new Error('Completion status must be completed, failed or blocked');
  if (!text(input.summary)) throw new Error('A completion summary is required');
  if (!Array.isArray(input.artifacts ?? []) || !(input.artifacts ?? []).every(text)) throw new Error('Artifacts must be paths or native references');
  const report = { contract: 'completion.v1', runId: validateRunId(input.runId), status: input.status,
    summary: input.summary, artifacts: input.artifacts ?? [], evidence: input.evidence ?? null };
  if (Buffer.byteLength(JSON.stringify(report)) > MAX_BODY_BYTES) throw new Error('Completion report exceeds bridge body limit');
  return report;
}

/** Convert only genuine terminal events. Process exit and streamed answers do
 * not prove task completion; a planned workflow never emits a completed reply. */
export function terminalEvent(event) {
  if (event?.type === 'workflow-run-finished' && event.status !== 'planned') {
    const status = { answered: 'completed', partial: 'blocked', failed: 'failed', error: 'failed' }[event.status];
    if (!status) return null;
    return { runId: event.workflowRunId, status,
      summary: `Workflow ${event.status}: ${event.text || event.workflowPath || event.workflowRunId}`,
      artifacts: event.resultPath ? [event.resultPath] : [],
      evidence: { source: 'workflow-run-finished', status: event.status, timestamp: event.timestamp ?? null } };
  }
  if (event?.type === 'session-task-finished' && terminalStatuses.has(event.status)) {
    return { runId: event.runId, status: event.status, summary: event.text,
      artifacts: event.artifacts ?? [], evidence: { source: event.type, sessionId: event.sessionId } };
  }
  if (event?.type === 'session-error' || event?.type === 'session-stopped') {
    return { runId: event.sessionId, status: event.type === 'session-error' || event.exitCode ? 'failed' : 'blocked',
      summary: event.type === 'session-error' ? 'Session failed before an explicit task result.' : 'Session stopped without an explicit task result.',
      artifacts: [], evidence: { source: event.type, exitCode: event.exitCode ?? null } };
  }
  return null;
}

/** Error identity excludes secret logs and ports from other machines. Optional
 * incidentId scopes recurrence; omitted IDs retain the original SDK hash. */
export function recoveryFingerprint({ environment, endpoint, code, phase, scope = '', incidentId }) {
  if (![environment, endpoint, code, phase].every(text)) throw new Error('Recovery requires environment, endpoint, code and phase');
  if (incidentId !== undefined && (!text(incidentId) || incidentId.length > 256)) throw new Error('Recovery incidentId must contain 1–256 characters');
  return digest(incidentId === undefined ? ['recovery.v1', environment, endpoint, code, phase, scope]
    : ['recovery.v2', incidentId, environment, endpoint, code, phase, scope]);
}

/** Existing host events drive this coordinator. It starts no timer, watcher,
 * model, process or scheduler by itself. Scheduler callbacks are optional host
 * capabilities; absent support is reported explicitly. */
export function createCoordinator({ bridge, stateDir, scheduler = null, recoveryDelegate = null, deliveryOptions = {}, now = () => new Date() } = {}) {
  if (!bridge || !['get', 'receive', 'send'].every(key => typeof bridge[key] === 'function')) throw new Error('A bridge is required');
  const directory = resolve(stateDir ?? join(bridge.root, '.bridge', 'coordination'));
  const location = (runId, suffix) => join(directory, `${digest(validateRunId(runId))}.${suffix}.json`);
  const prepare = () => mkdir(directory, { recursive: true });
  const read = async runId => readJson(location(runId, 'binding'));

  async function register({ requestId, runId, source = 'workflow', eventAvailable = true } = {}) {
    assertId(requestId); validateRunId(runId);
    const parent = await bridge.get(requestId);
    if (parent.kind !== 'task') throw new Error('Completion can bind only a task message');
    if (!['workflow', 'session', 'external'].includes(source)) throw new Error('Unknown completion event source');
    await prepare();
    const binding = { version: 1, requestId, runId, source, eventAvailable: Boolean(eventAvailable),
      from: parent.to, to: parent.from, correlationId: parent.correlationId,
      registeredAt: iso(now()), authority: { source: 'registered-peer-task', messageId: parent.id, peer: parent.from } };
    const result = await publish(location(runId, 'binding'), binding);
    if (['requestId', 'source', 'from', 'to', 'correlationId', 'eventAvailable'].some(key => result.value[key] !== binding[key])) {
      throw new Error('Run is already bound to a different task or event contract');
    }
    return result.value;
  }

  async function cancelEta(runId) {
    const ticket = await readJson(location(runId, 'eta-ticket'));
    if (!ticket || !scheduler?.cancel) return { cancelled: false };
    if (await readJson(location(runId, 'eta-cancelled'))) return { cancelled: true, duplicate: true };
    try {
      await scheduler.cancel({ key: ticket.key, ticket: ticket.ticket });
      await publish(location(runId, 'eta-cancelled'), { cancelledAt: iso(now()) });
      return { cancelled: true };
    } catch { return { cancelled: false, reason: 'scheduler-cancel-failed', completionGuardActive: true }; }
  }

  async function finish(input) {
    const report = completionReport(input);
    const binding = await read(report.runId);
    if (!binding) return { ignored: true, reason: 'unbound-run' };
    const result = await publish(location(report.runId, 'terminal'), { ...report, finishedAt: iso(now()) });
    const terminal = result.value;
    const id = completionMessageId(binding.requestId, binding.runId);
    const cancellation = await cancelEta(binding.runId);
    // A replay may complete a crash between terminal publication and send.
    // bridge.send persists before transport and rejects duplicate IDs itself.
    await bridge.receive(binding.from, binding.requestId);
    let sent = await bridge.send({ id, from: binding.from, to: binding.to, kind: 'result',
      replyTo: binding.requestId, correlationId: binding.correlationId, body: JSON.stringify(terminal) }, deliveryOptions);
    // send() preserves duplicates without resubmitting. Replay may resume a
    // persisted failure, using the transport's durable same-ID guard. That
    // guard decides whether an uncertain delivery permits bounded redelivery.
    if (sent.duplicate && typeof bridge.resume === 'function'
      && ['not-submitted', 'unconfirmed', 'uncertain'].includes(sent.status?.transportState)
      && sent.status?.receiptState === 'unconfirmed') sent = await bridge.resume(id, deliveryOptions);
    await publish(location(binding.runId, 'notification'), { messageId: id, attemptedAt: iso(now()) });
    return { terminal, messageId: id, duplicate: !result.created || sent.duplicate === true,
      delivery: sent.status ?? sent.delivery, status: sent.status ?? null,
      requiresAttention: sent.status?.requiresAttention === true, cancellation };
  }

  async function onEvent(event) {
    const report = terminalEvent(event);
    return report ? finish(report) : { ignored: true, reason: 'nonterminal-event' };
  }

  async function armEta({ runId, at, rationale } = {}) {
    const binding = await read(validateRunId(runId));
    if (!binding) throw new Error('Run is not registered');
    if (binding.eventAvailable) return { scheduled: false, reason: 'event-path-available' };
    if (await readJson(location(runId, 'terminal'))) return { scheduled: false, reason: 'already-terminal' };
    if (!scheduler?.armOnce || !scheduler?.cancel) return { scheduled: false, reason: 'scheduler-unavailable' };
    if (!text(rationale) || !Number.isFinite(Date.parse(at)) || Date.parse(at) <= Number(now())) throw new Error('ETA requires a future instant and rationale');
    const key = `agent-bridge-eta:${completionMessageId(binding.requestId, runId)}`;
    const intent = await publish(location(runId, 'eta-intent'), { key, runId, at: iso(at), rationale });
    if (!intent.created) return { scheduled: false, duplicate: true, ticket: await readJson(location(runId, 'eta-ticket')) };
    // armOnce must use this key as its own platform idempotency identity. A
    // crash after platform creation cannot justify a fresh scheduler request.
    const ticket = await scheduler.armOnce({ ...intent.value, callback: { operation: 'agent-bridge-eta-check', runId, requestId: binding.requestId } });
    await publish(location(runId, 'eta-ticket'), { key, ticket });
    if (await readJson(location(runId, 'terminal'))) await cancelEta(runId);
    return { scheduled: true, key, ticket };
  }

  async function checkEta(runId, inspect) {
    const binding = await read(validateRunId(runId));
    if (!binding) throw new Error('Run is not registered');
    if (await readJson(location(runId, 'terminal'))) return { ignored: true, reason: 'already-terminal' };
    if (binding.eventAvailable || !await readJson(location(runId, 'eta-intent'))) return { ignored: true, reason: 'eta-not-armed' };
    if (typeof inspect !== 'function') throw new Error('ETA needs a bounded read-only inspector');
    const claim = await publish(location(runId, 'eta-checked'), { checkedAt: iso(now()) });
    if (!claim.created) return { ignored: true, reason: 'eta-already-checked' };
    const observed = await inspect(binding);
    if (!terminalStatuses.has(observed?.status)) return { inspected: true, notified: false, status: observed?.status ?? 'unknown' };
    return finish({ ...observed, runId });
  }

  async function recover(error, task) {
    if (!text(task?.owner) || !text(task?.objective) || !Array.isArray(task?.writeScope) || !task.writeScope.every(text)) throw new Error('Recovery requires one owner, objective and write scope');
    assertId(task.requestId);
    const parent = await bridge.get(task.requestId);
    const incidentId = error.incidentId ?? parent.correlationId;
    const fingerprint = recoveryFingerprint({ ...error, incidentId });
    if (typeof recoveryDelegate !== 'function') return { dispatched: false, reason: 'recovery-runner-unavailable', fingerprint };
    await prepare();
    // Preserve an older uncertain claim for this task family after upgrading.
    // An unrelated correlation or an explicit new incident may get a new owner.
    if (error.incidentId == null) {
      const legacyFingerprint = recoveryFingerprint({ ...error, incidentId: undefined });
      const legacy = await readJson(join(directory, `recovery-${legacyFingerprint}.json`));
      if (legacy) {
        let legacyParent;
        try { legacyParent = legacy.requestId === task.requestId ? parent : await bridge.get(legacy.requestId); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (legacyParent?.correlationId === parent.correlationId) return { dispatched: false, duplicate: true, claim: legacy,
          result: await readJson(join(directory, `recovery-${legacyFingerprint}.result.json`)) };
      }
    }
    const claim = await publish(join(directory, `recovery-${fingerprint}.json`), {
      contract: 'recovery.v1', fingerprint, incidentId, correlationId: parent.correlationId,
      requestId: task.requestId, owner: task.owner,
      objective: task.objective, writeScope: task.writeScope, environment: error.environment,
      endpoint: error.endpoint, code: error.code, phase: error.phase, scope: error.scope ?? '',
      dispatchIntentAt: iso(now()), notify: ['completed', 'failed', 'blocked'] });
    if (!claim.created) return { dispatched: false, duplicate: true, claim: claim.value,
      result: await readJson(join(directory, `recovery-${fingerprint}.result.json`)) };
    try {
      const worker = await recoveryDelegate(claim.value);
      // Legacy native delegates return a worker handle. Registered transports
      // explicitly report whether submission was confirmed and preserve state.
      const dispatched = worker?.dispatched !== false;
      const status = worker?.state ?? (dispatched ? 'dispatched' : 'dispatch-unconfirmed');
      await publish(join(directory, `recovery-${fingerprint}.result.json`), { status, dispatched, worker, observedAt: iso(now()) });
      return { dispatched, fingerprint, worker, state: status, status: worker?.status ?? null };
    } catch (error) {
      // An error may occur after a worker started; never dispatch a second one.
      await publish(join(directory, `recovery-${fingerprint}.result.json`), { status: 'dispatch-uncertain', observedAt: iso(now()) });
      throw error;
    }
  }

  return { directory, register, read, finish, onEvent, armEta, checkEta, cancelEta, recover };
}
