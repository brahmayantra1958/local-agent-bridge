import test from 'node:test';
import { selectCodexPipe } from '../src/adapters/codex.mjs';

test('stale pipe names refresh to the sole current app without guessing among multiple instances',()=>{
  const old='\\\\.\\pipe\\codex-app-tools-old';
  assert.equal(selectCodexPipe(['codex-app-tools-current','unrelated'],old),'\\\\.\\pipe\\codex-app-tools-current');
  assert.equal(selectCodexPipe(['codex-app-tools-old','codex-app-tools-other'],old),old);
  assert.throws(()=>selectCodexPipe(['codex-app-tools-one','codex-app-tools-two'],old),{code:'CODEX_PIPE_AMBIGUOUS'});
  assert.throws(()=>selectCodexPipe([],old),{code:'CODEX_APP_NOT_RUNNING'});
});
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { inspectCodex, callCodexTool, sendCodex, codexResponseTimeout, readCodexRuntimeEvidence } from '../src/adapters/codex.mjs';
import { findCodexRollout } from '../src/codex-observation.mjs';

const threadId = '01a19d5c-06c0-7273-a06d-e12cde8857d4';
const message = { id: '0301afb4-4bf0-467d-b82f-bf94f89383ca', correlationId: '0301afb4-4bf0-467d-b82f-bf94f89383ca',
  from: 'claude', to: 'codex', kind: 'task', createdAt: '2026-11-03T22:17:55.000Z' };
const header = value => `[agent-bridge v1 | ${value.from} → codex | ${value.kind}]\nMessage ID: ${value.id}\nCorrelation ID: ${value.correlationId}\nPRIVATE BODY SHOULD NOT LEAK`;
const metadata = (id = threadId) => ({ type: 'session_meta', timestamp: '2026-11-03T02:43:36.000Z', payload: { id } });
const user = value => ({ type: 'event_msg', timestamp: '2026-11-03T23:10:00.000Z', payload: { type: 'user_message', message: header(value) } });
const delegation = value => `<codex_delegation>\n  <source_thread_id>${threadId}</source_thread_id>\n  <input>${header(value)}</input>\n</codex_delegation>`;
const native = value => ({ type: 'response_item', timestamp: '2026-11-03T23:10:01.000Z', payload: {
  type: 'function_call_output', namespace: 'codex_app', name: 'send_message_to_thread', output: delegation(value) } });
const jsonl = rows => rows.map(row => JSON.stringify(row)+'\n').join('');

async function fixture(t, rows = [metadata()]) {
  const home = await mkdtemp(join(tmpdir(), 'bridge-codex-observer-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const directory = join(home, '.codex/sessions/2026/11/03');
  await mkdir(directory, { recursive: true });
  const path = join(directory, `rollout-2026-11-03T02-43-36-${threadId}.jsonl`);
  await writeFile(path, jsonl(rows));
  const target = { threadId, hostId: 'local' }, config = { home };
  const inspect = (options = {}) => inspectCodex(target, config, message, { readRuntimeEvidence: async () => null, ...options });
  return { home, path, target, config, inspect };
}

test('exact native Codex delegation output confirms the received request without returning text', async t => {
  const f = await fixture(t, [metadata(), native(message)]);
  const result = await f.inspect();
  assert.equal(result.state, 'recipient-observed');
  assert.equal(result.recipientObserved, true);
  assert.equal(result.evidence.threadId, threadId);
  assert.equal(result.evidence.messageId, message.id);
  assert.equal(result.evidence.complete, true);
  assert.equal(result.executionState, 'unknown');
  assert.equal(result.evidence.line, 2);
  assert(!JSON.stringify(result).includes('PRIVATE BODY'));
});

test('user message forms and native item-completed receipts work, unrelated tools and quoted IDs do not', async t => {
  const rows = [metadata(),
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: header(message) }] } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `Quoted report: ${header(message)}` }] } },
    { ...native(message), payload: { ...native(message).payload, name: 'read_thread' } },
    { ...native(message), payload: { ...native(message).payload, namespace: 'other_tool' } },
    native({ ...message, id: randomUUID() }), native({ ...message, correlationId: randomUUID() }),
    native({ ...message, from: 'gemini' })];
  const f = await fixture(t, rows);
  assert.equal((await f.inspect()).state, 'delivery-not-observed');
  for (const row of [user(message),
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: header(message) }] } },
    { type: 'event_msg', payload: { type: 'item_completed', thread_id: threadId, item: { ...native(message).payload, type: 'FunctionCallOutput' } } }]) {
    await writeFile(f.path, jsonl([metadata(), row]));
    assert.equal((await f.inspect()).state, 'recipient-observed');
  }
});

test('53MB rollout is streamed completely and an early receipt is not lost to tail-only inspection', async t => {
  const f = await fixture(t, [metadata(), native(message)]);
  const padding = JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', output: 'x'.repeat(256 * 1024) } })+'\n';
  for (let index = 0; index < 216; index++) await appendFile(f.path, padding);
  const result = await f.inspect();
  assert.equal(result.state, 'recipient-observed');
  assert.equal(result.evidence.complete, true);
  assert(result.evidence.bytesScanned > 53 * 1024 * 1024);
  assert.equal(result.evidence.bytesScanned, result.evidence.snapshotBytes);
  assert.equal(result.evidence.line, 2);
});

test('complete negative observation is scoped to exact thread and carries optional local runtime facts', async t => {
  const f = await fixture(t, [metadata(), user({ ...message, id: randomUUID() })]);
  const runtime = { source: 'windows-named-pipe-server', pid: 123, startedAt: '2026-11-04T00:17:00.000Z',
    endpointDigest: 'a'.repeat(64), observedAt: '2026-11-04T00:18:00.000Z' };
  const result = await f.inspect({ readRuntimeEvidence: async () => runtime });
  assert.equal(result.state, 'delivery-not-observed');
  assert.equal(result.recipientObserved, false);
  assert.equal(result.evidence.complete, true);
  assert.deepEqual(result.evidence.runtime, runtime);
  const remote = await inspectCodex({ ...f.target, hostId: 'remote' }, f.config, message,
    { readRuntimeEvidence: async () => { throw new Error('must not run'); } });
  assert.equal(remote.state, 'delivery-unconfirmed');
  assert.equal(remote.evidence.complete, false);
});

test('partial, malformed and skipped large records never prove absence', async t => {
  const f = await fixture(t);
  for (const text of [jsonl([metadata()])+JSON.stringify(user(message)).slice(0, -3),
    jsonl([metadata()])+'invalid JSON\n', jsonl([metadata(), { type: 'huge', payload: 'x'.repeat(2000) }])]) {
    await writeFile(f.path, text);
    const result = await f.inspect({ maxLineBytes: 1024 });
    assert.equal(result.state, 'delivery-unconfirmed');
    assert.equal(result.evidence.complete, false);
  }
  await writeFile(f.path, jsonl([metadata(), user(message)]));
  const truncated = await f.inspect({ maxScanBytes: 100 });
  assert.equal(truncated.state, 'delivery-unconfirmed');
  assert.equal(truncated.evidence.complete, false);
});

test('missing or wrong-session rollout cannot be interpreted as missing delivery', async t => {
  const f = await fixture(t, [metadata(randomUUID()), native(message)]);
  assert.equal((await f.inspect()).state, 'delivery-unconfirmed');
  assert.equal((await f.inspect()).reasonCode, 'codex-rollout-session-mismatch');
  const missing = await inspectCodex({ ...f.target, rolloutPath: join(f.home, 'missing.jsonl') }, f.config, message);
  assert.equal(missing.state, 'delivery-unconfirmed');
  assert.equal(missing.reasonCode, 'codex-rollout-missing');
  await writeFile(f.path, jsonl([native(message), metadata()]));
  const outOfOrder = await f.inspect();
  assert.equal(outOfOrder.state, 'delivery-unconfirmed');
  assert.equal(outOfOrder.evidence.recordsBeforeMetadata, 1);
});

test('UUIDv7 date finds the exact file without scanning other dates; ambiguous files are unconfirmed', async t => {
  const f = await fixture(t);
  const located = await findCodexRollout(f.target, f.config);
  assert.equal(located.path, f.path);
  assert(located.directories <= 3);
  await writeFile(join(f.home, '.codex/sessions/2026/11/03', `rollout-other-${threadId}.jsonl`), jsonl([metadata()]));
  const result = await f.inspect();
  assert.equal(result.reasonCode, 'codex-rollout-ambiguous');
  assert.equal(result.evidence.complete, false);
});

test('timeout selection is bounded, target-specific and carried to the native request', async () => {
  assert.equal(codexResponseTimeout(), 120000);
  assert.equal(codexResponseTimeout({}, { transport: { codex: { responseTimeoutMs: 210000 } } }), 210000);
  assert.equal(codexResponseTimeout({ responseTimeoutMs: 90000 }, { transport: { codex: { responseTimeoutMs: 210000 } } }), 90000);
  assert.equal(codexResponseTimeout({ responseTimeoutMs: 90000 }, {}, { responseTimeoutMs: 45000 }), 45000);
  for (const responseTimeoutMs of [0, 600001, '120000', 1.5]) {
    assert.throws(() => codexResponseTimeout({ responseTimeoutMs }), error => error.delivery.submitted === false);
  }
  let captured;
  await sendCodex({ threadId, responseTimeoutMs: 190000 }, 'private prompt', { codexCallerThreadId: threadId }, message,
    { call: async (name, args, options) => { captured = { name, args, options }; return { ok: true }; } });
  assert.equal(captured.options.responseTimeoutMs, 190000);
  assert.equal(captured.args.threadId, threadId);
  await callCodexTool('send_message_to_thread', {}, { callerThreadId: threadId, pipePath: 'fixture', responseTimeoutMs: 180000,
    request: async (endpoint, method, params, options) => {
      assert.equal(endpoint, 'fixture'); assert.equal(options.timeoutMs, 180000);
      return { success: true, contentItems: [{ type: 'inputText', text: '{"ok":true}' }] };
    } });
});

test('native request failure preserves uncertain submission evidence', async () => {
  const failure = Object.assign(new Error('timeout'), { delivery: { submitted: true, phase: 'response', retryable: false } });
  await assert.rejects(() => callCodexTool('send_message_to_thread', {}, { callerThreadId: threadId, pipePath: 'fixture',
    request: async () => { throw failure; } }), error => error === failure && error.delivery.phase === 'response');
});

test('Windows runtime proof exposes only process and digest metadata', { skip: process.platform !== 'win32' }, async () => {
  const result = await readCodexRuntimeEvidence({ pipePath: '\\\\.\\pipe\\codex-app-tools-fixture', runPowerShell: async script => {
    assert(script.includes('GetNamedPipeServerProcessId'));
    assert(!script.includes('.Write('));
    return JSON.stringify({ pid: 1234, startedAt: '2026-11-04T00:17:00Z', ignoredSecret: 'never-return-this' });
  } });
  assert.equal(result.pid, 1234);
  assert.equal(result.startedAt, '2026-11-04T00:17:00.000Z');
  assert.equal(result.endpointDigest.length, 64);
  assert(!JSON.stringify(result).includes('fixture'));
  assert(!JSON.stringify(result).includes('never-return-this'));
});
