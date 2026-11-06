import test from 'node:test';
import assert from 'node:assert/strict';
import { resumeDecision, transportOptions } from '../src/transport-runtime.mjs';
import { summarizeDelivery, diagnosticObservation } from '../src/delivery.mjs';

const messageId = '0301afb4-4bf0-467d-b82f-bf94f89383ca';
const threadId = '01a19d5c-06c0-7273-a06d-e12cde8857d4';
const options = { guardedDelivery: 'claim-v1', recipientAgent: 'codex', recipientThreadId: threadId };
const attempt = (number, extra = {}) => ({ messageId, state: 'delivery-attempt', attemptId: `attempt-${number}`,
  attemptNumber: number, recipientFingerprint: 'same-recipient', createdAt: `2026-11-04T00:00:0${number}Z`, ...extra });
const failure = (number, extra = {}) => ({ messageId, state: 'delivery-error', attemptId: `attempt-${number}`,
  createdAt: `2026-11-04T00:01:0${number}Z`, failure: { code: 'TRANSPORT_ERROR', phase: 'response', retrySafe: false, ...extra } });
const absence = (number, extra = {}) => ({ messageId, state: 'delivery-not-observed', attemptId: `attempt-${number}`,
  createdAt: `2026-11-04T00:02:0${number}Z`, observation: {
    state: 'delivery-not-observed', transport: 'codex-app-tools', messageId, observedAt: `2026-11-04T00:02:0${number}Z`,
    evidence: { complete: true, messageId, threadId }, ...extra } });
const decide = (events, overrides = {}) => resumeDecision(events, 'same-recipient', { ...options, ...overrides });

test('response timeout plus complete same-attempt absence permits one guarded same-ID redelivery', () => {
  const records = [attempt(1), failure(1), absence(1)];
  assert.deepEqual(decide(records), { allowed: true, reason: 'unobserved-guarded-redelivery', inspect: false });
  // Observation did not retroactively alter the native submission evidence.
  assert.equal(records[1].failure.retrySafe, false);
  assert.equal(summarizeDelivery(records).transportState, 'uncertain');
  const replay = attempt(2, { redeliveryReason: 'unobserved-guarded-redelivery' });
  assert.deepEqual(decide([...records, replay]), { allowed: false, reason: 'guarded-redelivery-pending', inspect: false });
  assert.equal(decide([...records, replay, failure(2), absence(2)]).allowed, false);
});

test('known-unsent redelivery attempt does not spend the guarded submission budget', () => {
  const records = [attempt(1), failure(1), absence(1),
    attempt(2, { redeliveryReason: 'unobserved-guarded-redelivery' }),
    failure(2, { code: 'ENOENT', phase: 'connect', retrySafe: true }), absence(2)];
  assert.equal(decide(records).allowed, true);
});

test('legacy, incomplete, stale, wrong-thread and unrelated absence never grant guarded redelivery', () => {
  const records = [attempt(1), failure(1), absence(1)];
  assert.equal(resumeDecision(records, 'same-recipient').allowed, false);
  assert.equal(decide(records, { guardedDelivery: undefined }).allowed, false);
  assert.equal(decide(records, { recipientAgent: 'claude' }).allowed, false);
  for (const observation of [
    absence(1, { evidence: { complete: false, messageId, threadId } }),
    absence(1, { evidence: { complete: true, messageId: 'other-message', threadId } }),
    absence(1, { evidence: { complete: true, messageId, threadId: 'other-thread' } }),
    absence(1, { state: 'delivery-unconfirmed' }),
    absence(1, { observedAt: '2026-11-03T23:00:00Z' }),
    absence(1, { transport: 'other-adapter' }),
    absence(2),
  ]) assert.equal(decide([attempt(1), failure(1), observation]).allowed, false);
  assert.equal(decide([attempt(1), absence(1)]).allowed, false, 'crash-in-flight has no response failure');
  assert.equal(decide([attempt(1), failure(1, { phase: 'write' }), absence(1)]).allowed, false);
  assert.equal(resumeDecision(records, 'different-recipient', options).reason, 'recipient-changed');
});

test('receipt, execution claim, handled result, supersession and native acceptance dominate negative scans', () => {
  for (const state of ['received', 'recipient-observed', 'work-claimed', 'handled', 'native-accepted',
    'transport-written', 'execution-running', 'execution-failed', 'approval-pending', 'delivery-rejected']) {
    assert.equal(decide([{ state }, attempt(1), failure(1), absence(1)]).reason, 'delivery-already-submitted');
  }
  assert.equal(decide([attempt(1), failure(1), absence(1), { state: 'superseded' }]).reason, 'message-superseded');
});

test('offline destination is durable queued work with original waiting date and no repetitive attention', () => {
  const events = [
    { state: 'persisted', createdAt: '2026-10-29T12:00:00Z' },
    attempt(1), failure(1, { code: 'CLAUDE_SESSION_NOT_RUNNING', phase: 'preflight', retrySafe: true }),
  ];
  const status = summarizeDelivery(events);
  assert.equal(status.state, 'queued');
  assert.equal(status.transportState, 'not-submitted');
  assert.equal(status.requiresAttention, false);
  assert.equal(status.waitingSince, '2026-10-29T12:00:00Z');
  assert.equal(status.lastAttemptAt, '2026-11-04T00:00:01Z');
  assert.equal(status.nextAction, 'resume-when-recipient-available');
  for (const [code, phase] of [['ECONNREFUSED', 'connect'], ['ENOENT', 'connect'], ['BRIDGE_ENDPOINT_BUSY', 'lock']]) {
    assert.equal(summarizeDelivery([attempt(1), failure(1, { code, phase, retrySafe: true })]).state, 'queued');
  }
});

test('response uncertainty waits for receipt while policy failures still need attention', () => {
  const pending = summarizeDelivery([attempt(1), failure(1), absence(1)]);
  assert.equal(pending.state, 'pending-receipt');
  assert.equal(pending.transportState, 'uncertain');
  assert.equal(pending.requiresAttention, false);
  assert.equal(pending.nextAction, 'resume-original-id');
  for (const code of ['CLAUDE_HOST_ID_CHANGED', 'CLAUDE_SESSION_AMBIGUOUS', 'CLAUDE_CREDENTIAL_INVALID']) {
    assert.equal(summarizeDelivery([attempt(1), failure(1, { code, phase: 'preflight', retrySafe: true })]).requiresAttention, true);
  }
  assert.equal(summarizeDelivery([failure(1, { phase: 'unknown' })]).requiresAttention, true);
});

test('late receipts and work claims resolve waiting without converting execution into success', () => {
  for (const state of ['received', 'work-claimed', 'handled', 'superseded']) {
    const result = summarizeDelivery([attempt(1), failure(1), absence(1), { state, createdAt: '2026-11-07T01:00:00Z' }]);
    assert.equal(result.state, state);
    assert.equal(result.waitingSince, null);
    assert.equal(result.requiresAttention, false);
    assert.equal(result.nextAction, 'none');
    assert.equal(result.executionState, 'unconfirmed');
  }
  const executed = summarizeDelivery([attempt(1), failure(1), { state: 'execution-failed', attemptId: 'attempt-1', observation: {
    state: 'execution-failed', recipientObserved: true, executionState: 'failed' } }]);
  assert.equal(executed.requiresAttention, true);
  assert.equal(executed.waitingSince, null);
});

test('native response timeout is optional and validated before transport', () => {
  assert.equal(transportOptions().responseTimeoutMs, undefined);
  assert.equal(transportOptions({ responseTimeoutMs: 120000 }).responseTimeoutMs, 120000);
  for (const responseTimeoutMs of [0, -1, 600001, '120000', Infinity]) {
    assert.throws(() => transportOptions({ responseTimeoutMs }), /Invalid transport option responseTimeoutMs/);
  }
  const safe = diagnosticObservation({ state: 'delivery-not-observed', threadId, secret: 'omit-me' });
  assert.equal(safe.threadId, threadId);
  assert.equal(Object.hasOwn(safe, 'secret'), false);
});
