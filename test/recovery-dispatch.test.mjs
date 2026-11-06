import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createBridge } from '../src/index.mjs';
import { createCoordinator } from '../src/coordination.mjs';
import { createRecoveryDispatcher } from '../src/recovery-dispatch.mjs';

test('a repeated real recovery claim dispatches one scoped request with original correlation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-recovery-dispatch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.bridge'));
  await writeFile(join(root, '.bridge/config.json'), JSON.stringify({ agents: { codex: {}, claude: {} } }));
  const calls = [];
  const send = async (_target, _prompt, _config, message) => { calls.push(message); return { state: 'native-accepted', transport: 'fixture' }; };
  const bridge = createBridge({ root, adapters: { codex: send, claude: send }, inspectors: {} });
  const original = await bridge.send({ from: 'codex', to: 'claude', body: 'Implement scoped example' });
  const c = createCoordinator({ bridge, recoveryDelegate: createRecoveryDispatcher({ bridge, from: 'claude', to: 'codex' }) });
  const error = { environment: 'fixture-local', endpoint: '127.0.0.1:53842', phase: 'connect', code: 'ECONNREFUSED' };
  const task = { requestId: original.message.id, owner: 'fix-connection', objective: 'Fix the fixture connection', writeScope: [root] };
  await Promise.all([c.recover(error, task), c.recover(error, task)]);
  assert.equal(calls.length, 2);
  const recovery = calls[1], body = JSON.parse(recovery.body);
  assert.equal(recovery.correlationId, original.message.correlationId);
  assert.equal(body.originalRequestId, original.message.id);
  assert.deepEqual(body.writeScope, [root]);
  assert.match(body.instructions, /native subagent/);
});

test('local recovery demands an actual native host capability and calls it with the task', async () => {
  const bridge = { send() {}, get: async () => ({ correlationId: 'parent' }) };
  assert.throws(() => createRecoveryDispatcher({ bridge, from: 'codex' }), /native-subagent/);
  let called = 0;
  const run = createRecoveryDispatcher({ bridge, from: 'codex', nativeDelegate: async task => {
    called++; assert.equal(task.originalRequestId, 'request'); return { workerId: 'actual-host-child' };
  } });
  const result = await run({ requestId: 'request', fingerprint: 'f', writeScope: ['/fixture'] });
  assert.equal(called, 1);
  assert.equal(result.route, 'native-subagent');
});

test('recovery preserves blocked and uncertain outcomes instead of claiming a dispatched worker', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-recovery-dispatch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const requestId = '610dcd65-f2f6-4d9a-b680-5fc78dc0bd48';
  for (const state of ['send-blocked', 'execution-failed', 'delivery-unconfirmed']) {
    const status = { state, transportState: state === 'send-blocked' ? 'not-submitted' : 'uncertain',
      receiptState: 'unconfirmed', requiresAttention: true };
    const bridge = { root, receive() {}, get: async () => ({ correlationId: requestId }),
      send: async () => ({ status, duplicate: false }) };
    const dispatcher = createRecoveryDispatcher({ bridge, from: 'claude', to: 'codex' });
    const c = createCoordinator({ bridge, recoveryDelegate: dispatcher });
    const error = { environment: 'fixture', endpoint: 'fixture-local', phase: state, code: 'FIXTURE' };
    const task = { requestId, owner: 'fix-fixture', objective: 'Repair fixture', writeScope: [root] };
    const first = await c.recover(error, task);
    assert.equal(first.dispatched, false);
    assert.equal(first.state, state);
    assert.deepEqual(first.status, status);
    const duplicate = await c.recover(error, task);
    assert.equal(duplicate.result.dispatched, false);
    assert.equal(duplicate.result.status, state);
  }
});
