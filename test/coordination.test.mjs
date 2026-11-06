import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBridge } from '../src/index.mjs';
import { createCoordinator, completionMessageId, terminalEvent, recoveryFingerprint } from '../src/coordination.mjs';

async function fixture(t, adapters = {}) {
  const root = await mkdtemp(join(tmpdir(), 'bridge-coordination-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.bridge'));
  await writeFile(join(root, '.bridge', 'config.json'), JSON.stringify({ agents: { codex: {}, claude: {} } }));
  const sent = [];
  const send = async (_target, _prompt, _settings, message) => { sent.push(message); return { state: 'native-accepted', transport: 'test-fixture' }; };
  const bridge = createBridge({ root, adapters: { codex: send, claude: send, ...adapters }, inspectors: {} });
  const original = (await bridge.send({ from: 'codex', to: 'claude', body: 'Fixture scoped task' })).message;
  return { root, bridge, sent, requestId: original.id, coordinator: createCoordinator({ bridge }) };
}

test('duplicate terminal events across instances and restart send one correlated result', async t => {
  const f = await fixture(t);
  await f.coordinator.register({ requestId: f.requestId, runId: 'run:1' });
  const other = createCoordinator({ bridge: f.bridge });
  const input = { runId: 'run:1', status: 'completed', summary: 'Finished fixture', artifacts: ['artifact://fixture/result'] };
  const results = await Promise.all([f.coordinator.finish(input), other.finish(input)]);
  await createCoordinator({ bridge: f.bridge }).finish(input);
  assert.equal(f.sent.filter(row => row.kind === 'result').length, 1);
  assert.equal(new Set(results.map(row => row.messageId)).size, 1);
  const reply = f.sent.find(row => row.kind === 'result');
  assert.equal(reply.replyTo, f.requestId);
  assert.equal(reply.correlationId, f.requestId);
  assert.equal(reply.from, 'claude');
  assert.equal(reply.to, 'codex');
  assert.equal(reply.id, completionMessageId(f.requestId, 'run:1'));
});

test('replay repairs crash before send; uncertain persisted send is never repeated', async t => {
  let transportCalls = 0;
  const f = await fixture(t, { codex: async () => { transportCalls++; throw new Error('ambiguous after write'); } });
  let failBeforePersistence = true;
  const wrapper = { ...f.bridge, send: input => {
    if (failBeforePersistence) { failBeforePersistence = false; throw new Error('crash before send'); }
    return f.bridge.send(input);
  } };
  const c = createCoordinator({ bridge: wrapper });
  await c.register({ requestId: f.requestId, runId: 'run:crash' });
  const report = { runId: 'run:crash', status: 'failed', summary: 'Original failure' };
  await assert.rejects(c.finish(report), /crash before send/);
  await assert.rejects(c.finish(report), /persisted;.*uncertain/);
  const replay = await c.finish({ ...report, summary: 'A later changed error must not replace the first terminal event.' });
  assert.equal(transportCalls, 1);
  assert.equal(replay.terminal.summary, 'Original failure');
  assert.equal(replay.duplicate, true);
  assert.equal(replay.requiresAttention, true);
});

test('terminal replay resumes a proven pre-submit failure using the same immutable result', async t => {
  let calls = 0;
  const f = await fixture(t, { codex: async (_target, _prompt, _config, message) => {
    calls++;
    if (calls === 1) {
      const error = new Error('fixture endpoint offline');
      error.code = 'ECONNREFUSED';
      error.delivery = { submitted: false, phase: 'connect', retryable: false };
      throw error;
    }
    return { state: 'native-accepted', transport: 'fixture', message };
  } });
  await f.coordinator.register({ requestId: f.requestId, runId: 'run:pre-submit' });
  const input = { runId: 'run:pre-submit', status: 'completed', summary: 'Saved original result' };
  await assert.rejects(f.coordinator.finish(input), /nothing submitted/);
  const resumed = await createCoordinator({ bridge: f.bridge }).finish({ ...input, summary: 'Must not replace original' });
  assert.equal(calls, 2);
  assert.equal(resumed.status.transportState, 'native-accepted');
  assert.equal(resumed.requiresAttention, false);
  assert.equal(resumed.terminal.summary, input.summary);
  assert.equal(resumed.messageId, completionMessageId(f.requestId, input.runId));
  await f.coordinator.finish(input);
  assert.equal(calls, 2);
});

test('ETA and completion race uses one result; late ticket is cancelled', async t => {
  const f = await fixture(t);
  const armed = [], cancelled = [];
  let release;
  const scheduler = { armOnce: async value => { armed.push(value); await new Promise(resolve => { release = resolve; }); return 'fixture-ticket'; },
    cancel: async value => { cancelled.push(value); } };
  const c = createCoordinator({ bridge: f.bridge, scheduler });
  await c.register({ requestId: f.requestId, runId: 'run:eta', eventAvailable: false });
  const arm = c.armEta({ runId: 'run:eta', at: new Date(Date.now() + 60_000).toISOString(), rationale: 'Fixture measured duration' });
  while (!release) await new Promise(resolve => setImmediate(resolve));
  await Promise.all([
    c.finish({ runId: 'run:eta', status: 'completed', summary: 'Event completed' }),
    c.checkEta('run:eta', async () => ({ status: 'completed', summary: 'Observed completion' })),
  ]);
  release(); await arm;
  await c.checkEta('run:eta', () => { throw new Error('must not inspect terminal run'); });
  assert.equal(f.sent.filter(row => row.kind === 'result').length, 1);
  assert.equal(armed.length, 1);
  assert.equal(cancelled.length, 1);
  assert.equal((await c.armEta({ runId: 'run:eta' })).reason, 'already-terminal');
});

test('ETA is optional, one read-only check and never recurring polling', async t => {
  const f = await fixture(t);
  await f.coordinator.register({ requestId: f.requestId, runId: 'event-run' });
  assert.equal((await f.coordinator.armEta({ runId: 'event-run' })).reason, 'event-path-available');
  await f.coordinator.register({ requestId: f.requestId, runId: 'external-run', eventAvailable: false });
  assert.equal((await f.coordinator.armEta({ runId: 'external-run' })).reason, 'scheduler-unavailable');
  let checks = 0, schedules = 0;
  const c = createCoordinator({ bridge: f.bridge, scheduler: {
    armOnce: async () => { schedules++; return 'once'; }, cancel: async () => {},
  } });
  const input = { runId: 'external-run', at: new Date(Date.now() + 60_000).toISOString(), rationale: 'Estimated once' };
  await Promise.all([c.armEta(input), c.armEta(input)]);
  const inspect = async () => { checks++; return { status: 'running' }; };
  await Promise.all([c.checkEta('external-run', inspect), c.checkEta('external-run', inspect)]);
  assert.equal(schedules, 1); assert.equal(checks, 1);
  assert.equal(f.sent.filter(row => row.kind === 'result').length, 0);
});

test('only terminal workflow states relay, partial stays blocked and session exit is not completion', async t => {
  const f = await fixture(t);
  await f.coordinator.register({ requestId: f.requestId, runId: 'run:planned' });
  assert.equal((await f.coordinator.onEvent({ type: 'workflow-run-finished', workflowRunId: 'run:planned', status: 'planned' })).ignored, true);
  assert.equal((await f.coordinator.onEvent({ type: 'workflow-run-finished', workflowRunId: 'unbound', status: 'answered' })).reason, 'unbound-run');
  const result = await f.coordinator.onEvent({ type: 'workflow-run-finished', workflowRunId: 'run:planned', status: 'partial', text: 'one step failed' });
  assert.equal(result.terminal.status, 'blocked');
  assert.equal(terminalEvent({ type: 'session-stopped', sessionId: 's', exitCode: 0 }).status, 'blocked');
  assert.equal(terminalEvent({ type: 'model-answer', text: 'stream text' }), null);
  await assert.rejects(f.coordinator.register({ requestId: f.requestId, runId: 'run:planned', eventAvailable: false }), /different task or event contract/);
});

test('same error dispatches one recovery owner, ambiguous dispatch never duplicates worker', async t => {
  const f = await fixture(t);
  let calls = 0;
  const delegate = async value => { calls++; assert.equal(value.owner, 'fix-transport'); return { workerId: 'fixture-child' }; };
  const a = createCoordinator({ bridge: f.bridge, recoveryDelegate: delegate });
  const b = createCoordinator({ bridge: f.bridge, recoveryDelegate: delegate });
  const error = { environment: 'fixture-machine', endpoint: '127.0.0.1:51993', code: 'ECONNREFUSED', phase: 'connect' };
  const task = { requestId: f.requestId, owner: 'fix-transport', objective: 'Fix observed fixture failure', writeScope: [f.root] };
  const results = await Promise.all([a.recover(error, task), b.recover(error, task)]);
  assert.equal(calls, 1); assert.equal(results.filter(row => row.dispatched).length, 1);
  const uncertain = createCoordinator({ bridge: f.bridge, recoveryDelegate: async () => { calls++; throw new Error('unknown started state'); } });
  const second = { ...error, phase: 'write' };
  await assert.rejects(uncertain.recover(second, task), /unknown started state/);
  const duplicate = await uncertain.recover(second, task);
  assert.equal(calls, 2); assert.equal(duplicate.result.status, 'dispatch-uncertain');
});

test('optional recovery incident identity preserves the original SDK fingerprint', () => {
  const error = { environment: 'fixture-machine', endpoint: '127.0.0.1:51993', code: 'ECONNREFUSED', phase: 'connect' };
  assert.equal(recoveryFingerprint(error), '7d53be0554f95bd310c8d676a8f525ed434739e9c011a2534e73403fff8370d8');
  assert.notEqual(recoveryFingerprint({ ...error, incidentId: 'run:one' }), recoveryFingerprint({ ...error, incidentId: 'run:two' }));
  assert.throws(() => recoveryFingerprint({ ...error, incidentId: '' }), /incidentId/);
});

test('new task correlations get independent recovery owners while subtasks share one incident', async t => {
  const f = await fixture(t), calls = [];
  const subtask = (await f.bridge.send({ from: 'codex', to: 'claude', body: 'Same task family', correlationId: f.requestId })).message;
  const separate = (await f.bridge.send({ from: 'codex', to: 'claude', body: 'Independent later task' })).message;
  const delegate = async claim => { calls.push(claim); return { workerId: `fixture-worker-${calls.length}` }; };
  const c = createCoordinator({ bridge: f.bridge, recoveryDelegate: delegate });
  const error = { environment: 'fixture-machine', endpoint: '127.0.0.1:51993', code: 'ECONNREFUSED', phase: 'connect', scope: 'connection' };
  const task = { owner: 'fix-transport', objective: 'Fix actual incident', writeScope: [f.root] };
  const results = await Promise.all([f.requestId, subtask.id, separate.id, separate.id].map(requestId => c.recover(error, { ...task, requestId })));
  assert.equal(calls.length, 2);
  assert.equal(results.filter(result => result.dispatched).length, 2);
  assert.deepEqual(new Set(calls.map(claim => claim.incidentId)), new Set([f.requestId, separate.correlationId]));
  assert.equal(new Set(calls.map(claim => claim.fingerprint)).size, 2);
  const restarted = createCoordinator({ bridge: f.bridge, recoveryDelegate: delegate });
  for (const requestId of [f.requestId, subtask.id, separate.id]) assert.equal((await restarted.recover(error, { ...task, requestId })).duplicate, true);
  assert.equal(calls.length, 2);
});

test('an explicit actual incident ID permits recurrence within one task without replaying an uncertain worker', async t => {
  const f = await fixture(t), calls = [];
  const c = createCoordinator({ bridge: f.bridge, recoveryDelegate: async claim => {
    calls.push(claim.incidentId);
    if (claim.incidentId === 'actual-run:first') throw new Error('worker may already have started');
    return { workerId: 'fixture-second-run' };
  } });
  const error = { environment: 'fixture-machine', endpoint: '127.0.0.1:51993', code: 'ECONNREFUSED', phase: 'connect' };
  const task = { requestId: f.requestId, owner: 'fix-transport', objective: 'Fix actual incident', writeScope: [f.root] };
  await assert.rejects(c.recover({ ...error, incidentId: 'actual-run:first' }, task), /may already have started/);
  const duplicate = await c.recover({ ...error, incidentId: 'actual-run:first' }, task);
  assert.equal(duplicate.result.status, 'dispatch-uncertain');
  assert.equal((await c.recover({ ...error, incidentId: 'actual-run:second' }, task)).dispatched, true);
  assert.equal((await c.recover({ ...error, incidentId: 'actual-run:second' }, task)).duplicate, true);
  assert.deepEqual(calls, ['actual-run:first', 'actual-run:second']);
});

test('legacy uncertain recovery claims still suppress duplicates in their original task family', async t => {
  const f = await fixture(t);
  const subtask = (await f.bridge.send({ from: 'codex', to: 'claude', body: 'Same family after upgrade', correlationId: f.requestId })).message;
  const separate = (await f.bridge.send({ from: 'codex', to: 'claude', body: 'New family after upgrade' })).message;
  const error = { environment: 'fixture-machine', endpoint: '127.0.0.1:51993', code: 'ECONNREFUSED', phase: 'connect' };
  const fingerprint = recoveryFingerprint(error);
  await mkdir(f.coordinator.directory, { recursive: true });
  await writeFile(join(f.coordinator.directory, `recovery-${fingerprint}.json`), JSON.stringify({
    contract: 'recovery.v1', fingerprint, requestId: f.requestId, owner: 'original-worker', ...error,
  }));
  await writeFile(join(f.coordinator.directory, `recovery-${fingerprint}.result.json`), JSON.stringify({ status: 'dispatch-uncertain' }));
  let calls = 0;
  const c = createCoordinator({ bridge: f.bridge, recoveryDelegate: async () => { calls++; return { workerId: 'fixture-new-worker' }; } });
  const task = { owner: 'fix-transport', objective: 'Fix actual incident', writeScope: [f.root] };
  for (const requestId of [f.requestId, subtask.id]) {
    const result = await c.recover(error, { ...task, requestId });
    assert.equal(result.duplicate, true);
    assert.equal(result.result.status, 'dispatch-uncertain');
  }
  assert.equal(calls, 0);
  assert.equal((await c.recover(error, { ...task, requestId: separate.id })).dispatched, true);
  assert.equal(calls, 1);
});
