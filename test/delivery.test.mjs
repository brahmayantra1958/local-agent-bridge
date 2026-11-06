import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createBridge } from '../src/index.mjs';
import { summarizeDelivery } from '../src/delivery.mjs';

async function fixture(t, { send, inspect }) {
  const root = await mkdtemp(join(tmpdir(), 'agent-bridge-delivery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.bridge'));
  await writeFile(join(root, '.bridge/config.json'), JSON.stringify({ agents: { codex: {}, claude: {}, gemini: {} } }));
  return createBridge({ root, adapters: { gemini: send, claude: send }, inspectors: { gemini: inspect, claude: inspect } });
}

test('executor failure after native acceptance is durable and requires attention without resending', async t => {
  let sends = 0;
  const b = await fixture(t, { send: async () => {
    sends++;
    return { state: 'native-accepted', transport: 'test', observation: {
      state: 'execution-failed', executionState: 'failed', reasonCode: 'plan-model-not-specified',
      evidence: { errorId: 'fixture-error' },
    } };
  } });
  const sent = await b.send({ from: 'codex', to: 'gemini', body: 'PRIVATE-CASE' });
  assert.equal(sent.status.transportState, 'native-accepted');
  assert.equal(sent.status.receiptState, 'unconfirmed');
  assert.equal(sent.status.executionState, 'failed');
  assert.equal(sent.status.requiresAttention, true);
  assert.equal((await b.send(sent.message)).duplicate, true);
  assert.equal(sends, 1);
  const safe = await b.status({ includeBodies: false });
  assert.equal(JSON.stringify(safe).includes('PRIVATE-CASE'), false);
  assert.equal(safe.messages[0].delivery.state, 'execution-failed');
});

test('explicit check observes hold release without a send or forged acknowledgement', async t => {
  let sends = 0, inspections = 0;
  const b = await fixture(t, {
    send: async () => { sends++; return { state: 'transport-written', transport: 'test' }; },
    inspect: async (target, config, message) => {
      inspections++;
      assert.equal(message.to, 'claude');
      return { state: inspections === 1 ? 'approval-pending' : 'recipient-observed',
        executionState: 'unknown', reasonCode: inspections === 1 ? 'confirmed-hold' : 'message-found',
        body: message.body, result: { private: message.body } };
    },
  });
  const { message } = await b.send({ from: 'codex', to: 'claude', body: 'PRIVATE-CASE' });
  const first = await b.check(message.id);
  assert.equal(first.status.requiresAttention, true);
  const second = await b.check(message.id);
  assert.equal(second.status.state, 'recipient-observed');
  assert.equal(second.status.requiresAttention, false);
  assert.equal(second.status.executionState, 'unknown');
  assert.equal(second.status.receiptState, 'recipient-observed');
  assert.equal(JSON.stringify(second).includes('PRIVATE-CASE'), false);
  assert.equal((await b.receipts(message.id)).some(r => r.state === 'received'), false);
  assert.equal(sends, 1);
  assert.equal(inspections, 2);
});

test('an explicit recipient receipt resolves hold but does not erase an executor failure', () => {
  const held = [{ state: 'approval-pending', observation: { state: 'approval-pending' } }, { state: 'received' }];
  assert.equal(summarizeDelivery(held).state, 'received');
  assert.equal(summarizeDelivery(held).requiresAttention, false);
  const failed = [{ state: 'execution-failed', observation: { state: 'execution-failed', executionState: 'failed' } }, { state: 'received' }];
  assert.equal(summarizeDelivery(failed).requiresAttention, true);
  assert.equal(summarizeDelivery(failed).receiptState, 'received');
});

test('transport acceptance and an unsupported inspector leave execution unconfirmed', async t => {
  const b = await fixture(t, { send: async () => ({ state: 'native-accepted', transport: 'test' }) });
  const { message, status } = await b.send({ from: 'codex', to: 'gemini', body: 'request' });
  assert.equal(status.state, 'delivery-unconfirmed');
  const result = await b.check(message.id);
  assert.equal(result.observation.reasonCode, 'inspection-unsupported');
  assert.equal(result.status.executionState, 'unconfirmed');
});

test('pre-submit blocking and uncertain CLI failure do not look like accepted successful delivery', async t => {
  const b = await fixture(t, { send: async () => ({ state: 'send-blocked', transport: 'test',
    observation: { state: 'send-blocked', executionState: 'not-started', transportState: 'not-submitted' } }) });
  const blocked = await b.send({ from: 'codex', to: 'gemini', body: 'request' });
  assert.equal(blocked.status.transportState, 'not-submitted');
  assert.equal(blocked.status.requiresAttention, true);
  const uncertain = summarizeDelivery([{ state: 'delivery-error' }, { state: 'delivery-unconfirmed',
    observation: { state: 'delivery-unconfirmed', executionState: 'unknown' } }]);
  assert.equal(uncertain.transportState, 'uncertain');
  assert.equal(uncertain.requiresAttention, true);
  const failed = summarizeDelivery([{ state: 'native-accepted' }, { state: 'execution-failed',
    observation: { state: 'execution-failed', executionState: 'failed', recipientObserved: true } }]);
  assert.equal(failed.receiptState, 'recipient-observed');
  assert.equal(failed.requiresAttention, true);
});

test('current preflight diagnostics survive an unconfirmed check and disappear after a successful resumed attempt', () => {
  const failure = { code: 'CLAUDE_SESSION_NOT_RUNNING', phase: 'preflight', retrySafe: true,
    retryable: false, reason: 'PRIVATE-RAW-REASON', action: 'PRIVATE-RAW-ACTION', summary: 'PRIVATE-RAW-TEXT' };
  const rows = [
    { state: 'delivery-attempt', attemptId: 'one', attemptNumber: 1, createdAt: '2026-10-28T04:46:00Z' },
    { state: 'delivery-error', attemptId: 'one', failure, createdAt: '2026-10-28T04:46:01Z' },
    { state: 'delivery-unconfirmed', createdAt: '2026-10-28T04:47:00Z', observation: {
      state: 'delivery-unconfirmed', reasonCode: 'claude-recipient-not-observed', executionState: 'unknown' } }
  ];
  const checked = summarizeDelivery(rows);
  assert.equal(checked.transportFailure.reason, 'claude-session-not-running');
  assert.match(checked.transportFailure.action, /current Claude session discovery/);
  assert.equal(checked.transportState, 'not-submitted');
  assert.equal(JSON.stringify(checked).includes('PRIVATE-RAW'), false);
  rows.push({ state: 'delivery-attempt', attemptId: 'two', attemptNumber: 2, createdAt: '2026-10-28T04:48:00Z' });
  rows.push({ state: 'native-accepted', attemptId: 'two', createdAt: '2026-10-28T04:48:01Z' });
  const resumed = summarizeDelivery(rows);
  assert.equal(resumed.transportState, 'native-accepted');
  assert.equal(resumed.transportFailure, undefined);
});

test('historical generic failures remain generic without leaking stored exception fields or inventing a cause', () => {
  const failure = { code: 'TRANSPORT_ERROR', phase: 'preflight', retrySafe: true, retryable: false,
    reason: 'CLAUDE_SESSION_NOT_RUNNING', action: 'SECRET-TOKEN', summary: 'PRIVATE-PATH', message: 'PRIVATE-EXCEPTION' };
  const status = summarizeDelivery([{ state: 'delivery-error', failure }]);
  assert.equal(status.transportFailure.code, 'TRANSPORT_ERROR');
  assert.equal(status.transportFailure.reason, undefined);
  assert.equal(status.transportFailure.action, undefined);
  assert.equal(JSON.stringify(status).includes('PRIVATE'), false);
  assert.equal(JSON.stringify(status).includes('SECRET'), false);
  assert.equal(JSON.stringify(status).includes('CLAUDE_SESSION_NOT_RUNNING'), false);
});

test('CLI check reports correlated native hold with exit 2 and no message body', async t => {
  const b = await fixture(t, { send: async () => ({ state: 'transport-written', transport: 'test' }) });
  const { message } = await b.send({ from: 'codex', to: 'claude', body: 'PRIVATE-CASE-MUST-NOT-PRINT' });
  const sessionId = randomUUID();
  const project = join(b.root, '.claude/projects/fixture');
  await mkdir(project, { recursive: true });
  await writeFile(join(b.root, '.bridge/config.json'), JSON.stringify({ home: b.root,
    agents: { codex: { permissionClass: 'bypass' }, claude: { sessionId } } }));
  await writeFile(join(project, sessionId + '.jsonl'), JSON.stringify({ type: 'system',
    subtype: 'peer_message_hold', session_id: sessionId, lane: 'socket',
    from: 'bridge:agent-bridge-codex', message_uuid: message.id, state: 'held', cause: 'mode-mismatch' }) + '\n');
  const command = promisify(execFile);
  await assert.rejects(() => command(process.execPath,
    [fileURLToPath(new URL('../bin/agent-bridge.mjs', import.meta.url)), 'check', '--root', b.root, '--id', message.id]),
  error => {
    assert.equal(error.code, 2);
    const result = JSON.parse(error.stdout);
    assert.equal(result.status.state, 'approval-pending');
    assert.equal(error.stdout.includes(message.body), false);
    assert.equal(error.stderr, '');
    return true;
  });
});
