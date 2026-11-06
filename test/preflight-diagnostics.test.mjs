import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createBridge } from '../src/index.mjs';
import { sendClaude } from '../src/adapters/claude.mjs';
import { transportFailure, transportDiagnosticError, diagnosticTransportFailure } from '../src/transport-runtime.mjs';

const secret = 'PRIVATE-PROMPT-KEY-AND-ERROR';
async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'bridge-preflight-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const dir = join(home, '.claude', 'sessions');
  await mkdir(dir, { recursive: true });
  const live = { pid: process.pid, sessionId: randomUUID(), hostSessionId: randomUUID(),
    peerProtocol: 1, procStart: 'fixture-process-start',
    messagingSocketPath: '\\\\.\\pipe\\cc-msg-' + 'a'.repeat(32) };
  const target = { sessionId: live.sessionId, hostSessionId: live.hostSessionId };
  const config = { home, agents: { codex: { permissionClass: 'prompting' }, claude: target } };
  const keyPath = join(dir, live.pid + '.' + createHash('sha256')
    .update(live.messagingSocketPath.toLowerCase()).digest('hex') + '.key');
  return { home, dir, live, target, config, keyPath,
    descriptor: value => writeFile(join(dir, process.pid + '.json'), JSON.stringify(value)) };
}

async function failureOf(f) {
  let failure;
  await assert.rejects(() => sendClaude(f.target, secret, f.config,
    { id: randomUUID(), from: 'codex', body: secret }), error => {
    failure = transportFailure(error);
    return true;
  });
  assert.equal(failure.phase, 'preflight');
  assert.equal(failure.retrySafe, true);
  assert.equal(failure.retryable, false);
  assert.equal(JSON.stringify(failure).includes(secret), false);
  assert.equal(JSON.stringify(failure).includes(f.home), false);
  assert.equal(JSON.stringify(failure).includes(f.target.sessionId), false);
  assert.ok(failure.action);
  return failure;
}

test('real missing-session preflight persists its safe cause and check preserves it without submitting', async t => {
  const f = await fixture(t);
  await mkdir(join(f.home, '.bridge'));
  await writeFile(join(f.home, '.bridge', 'config.json'), JSON.stringify(f.config));
  let calls = 0;
  const bridge = createBridge({ root: f.home,
    adapters: { claude: (...args) => { calls++; return sendClaude(...args); } },
    inspectors: { claude: async () => ({ state: 'delivery-unconfirmed',
      executionState: 'unknown', reasonCode: 'claude-recipient-not-observed' }) } });
  const input = { id: randomUUID(), from: 'codex', to: 'claude', body: secret };
  await assert.rejects(() => bridge.send(input), error => {
    assert.match(error.message, /CLAUDE_SESSION_NOT_RUNNING/);
    assert.match(error.message, /Inspect current Claude session discovery/);
    assert.equal(error.message.includes(f.home), false);
    assert.equal(error.message.includes(secret), false);
    return true;
  });
  assert.equal(calls, 1);
  const checked = await bridge.check(input.id);
  assert.equal(checked.status.transportFailure.reason, 'claude-session-not-running');
  assert.equal(checked.status.transportState, 'not-submitted');
  assert.equal(checked.status.requiresAttention, false);
  assert.equal(checked.status.state, 'queued');
  const receipts = await bridge.receipts(input.id);
  assert.equal(receipts.filter(row => row.state === 'delivery-attempt').length, 1);
  assert.equal(receipts.find(row => row.state === 'delivery-error').failure.code, 'CLAUDE_SESSION_NOT_RUNNING');
  assert.equal(JSON.stringify(receipts).includes(secret), false);
});

test('session discovery, protocol, identity and endpoint guards retain different safe causes', async t => {
  const f = await fixture(t);
  assert.equal((await failureOf(f)).code, 'CLAUDE_SESSION_NOT_RUNNING');
  await f.descriptor({ ...f.live, peerProtocol: 2 });
  assert.equal((await failureOf(f)).code, 'CLAUDE_PROTOCOL_UNSUPPORTED');
  await f.descriptor({ ...f.live, hostSessionId: 'private-other-host' });
  assert.equal((await failureOf(f)).code, 'CLAUDE_HOST_ID_CHANGED');
  await f.descriptor({ ...f.live, messagingSocketPath: secret });
  assert.equal((await failureOf(f)).code, 'CLAUDE_PIPE_INVALID');
  await rm(f.dir, { recursive: true });
  assert.equal((await failureOf(f)).code, 'CLAUDE_SESSION_STORE_MISSING');
});

test('credential missing, malformed, invalid and stale failures are classified without retaining file contents', async t => {
  const f = await fixture(t);
  await f.descriptor(f.live);
  assert.equal((await failureOf(f)).code, 'CLAUDE_CREDENTIAL_MISSING');
  await writeFile(f.keyPath, secret);
  assert.equal((await failureOf(f)).code, 'CLAUDE_CREDENTIAL_INVALID');
  await writeFile(f.keyPath, 'null');
  assert.equal((await failureOf(f)).code, 'CLAUDE_CREDENTIAL_INVALID');
  await writeFile(f.keyPath, JSON.stringify({ peerToken: 'b'.repeat(32), procStart: 'old-process' }));
  assert.equal((await failureOf(f)).code, 'CLAUDE_CREDENTIAL_STALE');
});

test('diagnostic labels never become submission evidence or expose arbitrary error fields', () => {
  const error = transportDiagnosticError('CLAUDE_SESSION_NOT_RUNNING');
  error.message = error.action = error.reason = error.stack = secret;
  error.delivery = { submitted: true, phase: 'write', retryable: true };
  const result = transportFailure(error);
  assert.equal(result.retrySafe, false);
  assert.equal(result.retryable, false);
  assert.equal(JSON.stringify(result).includes(secret), false);
  const unknown = transportFailure({ code: 'SECRET_UPPERCASE_TOKEN', message: secret,
    delivery: { submitted: false, phase: 'preflight', retryable: false } });
  assert.equal(unknown.code, 'TRANSPORT_ERROR');
  assert.equal(unknown.reason, undefined);
  assert.equal(unknown.action, undefined);
  assert.equal(JSON.stringify(unknown).includes('SECRET'), false);
});

test('missing Desktop runtime retains only availability enums across transport and durable diagnostic boundaries', async t => {
  const f = await fixture(t);
  f.target.hostSessionId = 'local_' + randomUUID();
  const safe = { appState: 'running', conversationState: 'stored', runtimeState: 'absent',
    wake: { supported: false, reason: 'desktop-no-supported-unattended-runtime-wake' } };
  const privateAvailability = { ...safe, sessionId: f.target.sessionId,
    hostSessionId: f.target.hostSessionId, cwd: f.home, account: secret, token: secret,
    transcript: { body: secret }, wake: { ...safe.wake, command: secret, token: secret } };
  let calls = 0, failure;
  await assert.rejects(() => sendClaude(f.target, secret, f.config,
    { id: randomUUID(), from: 'codex', body: secret },
    { inspectHost: async () => { calls++; return privateAvailability; } }), error => {
    failure = transportFailure(error);
    return true;
  });
  assert.equal(calls, 1);
  assert.equal(failure.code, 'CLAUDE_SESSION_NOT_RUNNING');
  assert.equal(failure.retrySafe, true);
  assert.deepEqual(failure.recipientAvailability, safe);
  // Stored diagnostics are sanitized again, including formerly valid nested values.
  const reread = diagnosticTransportFailure({ ...failure, recipientAvailability: privateAvailability });
  assert.deepEqual(reread.recipientAvailability, safe);
  for (const value of [secret, f.home, f.target.sessionId, f.target.hostSessionId]) {
    assert.equal(JSON.stringify([failure, reread]).includes(value), false);
  }
  assert.equal(diagnosticTransportFailure({ ...failure, code: 'ECONNREFUSED',
    recipientAvailability: privateAvailability }).recipientAvailability, undefined);
  assert.equal(diagnosticTransportFailure({ ...failure, recipientAvailability: {
    appState: secret, conversationState: {}, runtimeState: ['running'],
    wake: { supported: true, reason: safe.wake.reason }, token: secret
  } }).recipientAvailability, undefined);
});

test('bounded lifecycle delivery records missing runtime without waiting for optional host diagnostics',async t=>{
  const f=await fixture(t);f.target.hostSessionId='local_'+randomUUID();let inspections=0;
  await assert.rejects(()=>sendClaude(f.target,secret,f.config,{id:randomUUID(),from:'codex'},
    {diagnoseAvailability:false,inspectHost:async()=>{inspections++;throw new Error('must not start');}}),error=>{
      const failure=transportFailure(error);
      assert.equal(failure.code,'CLAUDE_SESSION_NOT_RUNNING');assert.equal(failure.retrySafe,true);
      assert.equal(failure.recipientAvailability,undefined);return true;
    });
  assert.equal(inspections,0);
});
