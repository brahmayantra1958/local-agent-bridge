import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, posix, win32 } from 'node:path';
import { assertAgent, assertId, MAX_BODY_BYTES, makeEnvelope } from './protocol.mjs';
import { selectRoute, selectRunner, RUNNERS } from './routing.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && Boolean(value.trim());
const absolute = value => nonempty(value) && (win32.isAbsolute(value) || posix.isAbsolute(value));
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
const optionalHash = value => value === undefined || /^[a-f0-9]{64}$/i.test(value);
const strings = value => Array.isArray(value) && value.every(nonempty);

export function validateDelegation(value) {
  if (!object(value) || value.contract !== 'delegation.v1') throw new Error('Unsupported delegation contract');
  if (!identifier(value.taskId) || !Number.isSafeInteger(value.revision) || value.revision < 1
    || !identifier(value.routeId) || !identifier(value.profileId)
    || !Number.isSafeInteger(value.profileRevision) || value.profileRevision < 1) throw new Error('Invalid delegation identity');
  if (!nonempty(value.objective)) throw new Error('Delegation objective is required');
  if (!Array.isArray(value.readOrder) || !value.readOrder.every(row => object(row) && absolute(row.path)
    && (row.section === undefined || nonempty(row.section)) && optionalHash(row.sha256))) throw new Error('Invalid read order');
  if (!Array.isArray(value.inputs) || !value.inputs.every(row => object(row) && absolute(row.path)
    && optionalHash(row.baseHash) && (row.changeRef === undefined || nonempty(row.changeRef)))) throw new Error('Invalid inputs');
  for (const key of ['writeScope', 'doNotChange']) {
    if (!Array.isArray(value[key]) || !value[key].every(absolute)) throw new Error('Invalid ' + key);
  }
  if (!strings(value.doneWhen) || !value.doneWhen.length) throw new Error('Observable completion criteria are required');
  if (!Array.isArray(value.verify) || !value.verify.every(row => object(row) && absolute(row.cwd) && nonempty(row.command))) throw new Error('Invalid verification commands');
  if (!object(value.report) || !Number.isInteger(value.report.summaryMaxLines) || value.report.summaryMaxLines < 1
    || value.report.summaryMaxLines > 5 || value.report.artifacts !== true || value.report.executionEvidence !== true) throw new Error('Invalid report policy');
  if (value.commitPolicy !== 'no-commit') throw new Error('Delegation must preserve the no-commit policy');
  if (!object(value.worker) || !RUNNERS.includes(value.worker.runner)
    || !(value.worker.modelId === null && value.worker.effort === null
      || nonempty(value.worker.modelId) && nonempty(value.worker.effort))) throw new Error('Invalid requested worker');
  if (!object(value.subagents) || typeof value.subagents.useWhenIndependent !== 'boolean'
    || !(value.subagents.maxConcurrent === null || Number.isSafeInteger(value.subagents.maxConcurrent) && value.subagents.maxConcurrent > 0)) throw new Error('Invalid subagent policy');
  if (!object(value.notify) || !Array.isArray(value.notify.on) || value.notify.on.length !== 3
    || !['completed', 'failed', 'blocked'].every(event => value.notify.on.includes(event))) throw new Error('Invalid completion notification policy');
  if (value.notify.replyTo !== null) assertId(value.notify.replyTo);
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_BODY_BYTES) throw new Error('Delegation body exceeds 48 KiB');
  return value;
}

export function createDelegation(task, { profile, taskType, runner = 'session', sessionId, evidence, messageId = null } = {}) {
  if (!object(task)) throw new Error('A delegation task is required');
  const route = selectRoute(profile, taskType);
  const worker = selectRunner(route, { runner, sessionId, evidence });
  return validateDelegation({
    contract: 'delegation.v1', taskId: task.taskId, revision: task.revision ?? 1,
    routeId: route.id, profileId: profile.profileId, profileRevision: profile.revision,
    objective: task.objective, readOrder: task.readOrder ?? [], inputs: task.inputs ?? [],
    writeScope: task.writeScope ?? [], doNotChange: task.doNotChange ?? [],
    doneWhen: task.doneWhen, verify: task.verify ?? [],
    report: { summaryMaxLines: 5, artifacts: true, executionEvidence: true }, commitPolicy: 'no-commit',
    worker: { modelId: worker.modelId, effort: worker.effort, runner: worker.runner },
    subagents: { ...route.subagents }, notify: { on: ['completed', 'failed', 'blocked'], replyTo: messageId },
  });
}

export function serializeDelegation(value) {
  return JSON.stringify(validateDelegation(value));
}

// Stable across process restarts. Existing bridge.send rejects changed content
// under this ID and does not resend uncertain/failed prior attempts.
export function delegationMessageId({ profileId, taskId, revision = 1 }) {
  const hex = createHash('sha256').update(JSON.stringify([profileId, taskId, revision])).digest('hex');
  return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-8' + hex.slice(13, 16)
    + '-a' + hex.slice(17, 20) + '-' + hex.slice(20, 32);
}

/** Validate once, then use the existing bridge transport exactly once. */
export async function delegate(bridge, { profile, taskType, task, from, id, correlationId, replyTo, runner, sessionId, evidence, sendOptions } = {}) {
  if (!bridge || typeof bridge.send !== 'function') throw new Error('A bridge.send implementation is required');
  if (!object(task)) throw new Error('A delegation task is required');
  assertAgent(from);
  const route = selectRoute(profile, taskType);
  let settings = null;
  if (nonempty(bridge.root)) {
    try { settings = JSON.parse(await readFile(join(bridge.root, '.bridge', 'config.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (settings && !settings.agents?.[route.app]) {
    throw new Error(`Route ${route.id} sends ${taskType} work to ${route.app}, which is not registered here. `
      + 'Register that app with join, or regenerate the routing profile for the registered apps (Setup or join).');
  }
  if (route.worker.modelId !== null && (runner ?? 'session') !== 'ccb-worker') {
    if (!nonempty(bridge.root)) throw new Error('Exact-model session delegation requires the bridge registration root');
    settings ??= JSON.parse(await readFile(join(bridge.root, '.bridge', 'config.json'), 'utf8'));
    const target = settings.agents?.[route.app];
    const registeredId = target?.threadId ?? target?.sessionId ?? target?.conversationId;
    if (!nonempty(sessionId) || registeredId !== sessionId) throw new Error('Execution evidence does not match the registered recipient session');
  }
  const messageId = assertId(id ?? delegationMessageId({ profileId: profile.profileId,
    taskId: task.taskId, revision: task.revision ?? 1 }));
  const body = createDelegation(task, { profile, taskType, runner, sessionId, evidence, messageId });
  const message = makeEnvelope({ id: messageId, from, to: route.app, kind: 'task', body: serializeDelegation(body),
    correlationId, replyTo });
  return sendOptions ? bridge.send(message, sendOptions) : bridge.send(message);
}
