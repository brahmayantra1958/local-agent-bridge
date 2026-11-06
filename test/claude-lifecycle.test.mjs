import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createBridge } from '../src/index.mjs';
import { transportDiagnosticError } from '../src/transport-runtime.mjs';
import { handleClaudeLifecycle } from '../src/claude-lifecycle.mjs';

async function fixture(t, { defaultOther = false, uncertain = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'bridge-lifecycle-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.bridge'));
  const identity = { sessionId: randomUUID(), hostSessionId: 'local_' + randomUUID() };
  const settings = { home: root, agents: { codex: { threadId: randomUUID(), permissionClass: 'prompting' },
    claude: { ...(defaultOther ? { sessionId: randomUUID(), hostSessionId: 'local_' + randomUUID() } : identity),
      permissionClass: 'prompting', responseTimeoutMs: 1500 } } };
  await writeFile(join(root, '.bridge', 'config.json'), JSON.stringify(settings));
  const f = { root, identity, settings, online: false, seen: false, calls: [], inspections: 0 };
  const adapter = async (target, prompt, config, message, options) => {
    if (!f.online) {
      const error = transportDiagnosticError('CLAUDE_SESSION_NOT_RUNNING');
      error.delivery = { submitted: false, phase: 'preflight', retryable: false }; throw error;
    }
    f.calls.push({ id: message.id, target, prompt, options });
    if (uncertain) throw Object.assign(new Error('private native failure'),
      { delivery: { submitted: true, phase: 'write', retryable: false } });
    return { state: 'transport-written', transport: 'fixture' };
  };
  const inspector = async (target, config, message) => {
    f.inspections++;
    return { state: f.seen ? 'recipient-observed' : 'delivery-unconfirmed',
      recipientObserved: f.seen, messageId: message.id, sessionId: target.sessionId,
      transport: 'fixture', executionState: 'unknown' };
  };
  f.bridge = createBridge({ root, adapters: { claude: adapter }, inspectors: { claude: inspector } });
  f.start = { hook_event_name: 'SessionStart', source: 'resume', session_id: identity.sessionId };
  f.stop = { hook_event_name: 'Stop', session_id: identity.sessionId };
  f.end = { hook_event_name: 'SessionEnd', session_id: identity.sessionId };
  f.options = { roots: [root], readyWaitMs: 0, bridgeFactory: () => f.bridge, discover: async () => [identity] };
  f.send = (recipient = identity) => f.bridge.send({ from: 'codex', to: 'claude',
    body: 'private body never emitted by hooks', recipientSession: recipient }, { deferErrors: true });
  return f;
}

test('duplicate concurrent lifecycle events flush one original ID and never manufacture receive or claim', async t => {
  const f = await fixture(t), queued = await f.send();
  assert.equal(queued.status.state, 'queued');
  const messagePath = join(f.root, '.bridge', 'messages', queued.message.id + '.json');
  const originalBytes = await readFile(messagePath);
  f.online = true; f.seen = true;
  const results = await Promise.all([handleClaudeLifecycle({ ...f.options, event: f.start }),
    handleClaudeLifecycle({ ...f.options, event: f.start })]);
  assert.deepEqual(f.calls.map(call => call.id), [queued.message.id]);
  assert.equal(f.calls[0].options.diagnoseAvailability, false);
  assert.equal(f.calls[0].options.skipImmediateObservation, true);
  assert.equal(f.calls[0].options.autoWake, false);
  assert.equal(JSON.stringify(results).includes('private body'), false);
  assert.deepEqual(await readFile(messagePath), originalBytes);
  let receipts = await f.bridge.receipts(queued.message.id);
  assert.equal(receipts.some(row => row.state === 'recipient-observed'), true);
  assert.equal(receipts.some(row => ['work-claimed', 'received'].includes(row.state)), false);
  const priorInspections = f.inspections;
  await handleClaudeLifecycle({ ...f.options, event: f.stop });
  assert.equal(f.calls.length, 1); assert.equal(f.inspections, priorInspections);
  const mapping = JSON.parse(await readFile(join(f.root, '.bridge/lifecycle', f.identity.sessionId + '.json'), 'utf8'));
  assert.deepEqual(mapping.identity, f.identity);
  await f.bridge.claim('claude', queued.message.id, { session: f.identity, consumerId: 'actual-recipient' });
  assert.equal((await f.bridge.claim('claude', queued.message.id)).claimed, false);
  receipts = await f.bridge.receipts(queued.message.id);
  assert.equal(receipts.filter(row => row.state === 'work-claimed').length, 1);
});

test('actual pinned reply host is flushed while a different configured default host stays queued', async t => {
  const f = await fixture(t, { defaultOther: true });
  const pinned = await f.send({ hostSessionId: f.identity.hostSessionId });
  const other = await f.send({ sessionId: f.settings.agents.claude.sessionId,
    hostSessionId: f.settings.agents.claude.hostSessionId });
  f.online = true;
  const result = await handleClaudeLifecycle({ ...f.options, event: f.start });
  assert.deepEqual(f.calls.map(call => call.id), [pinned.message.id]);
  assert.equal(result.roots[0].flushed.inspected, 1);
  assert.equal(result.roots[0].observed.some(row => row.messageId === other.message.id), false);
  const state = await f.bridge.status({ id: other.message.id, includeBodies: false });
  assert.equal(state.messages[0].delivery.state, 'queued');
});

test('a different session or multiple runtimes of one host cannot trigger a send', async t => {
  const f = await fixture(t); await f.send(); f.online = true;
  const wrong = await handleClaudeLifecycle({ ...f.options, event: { ...f.start, session_id: randomUUID() } });
  assert.equal(wrong.roots[0].reason, 'runtime-not-ready');
  const ambiguous = await handleClaudeLifecycle({ ...f.options, event: f.start,
    discover: async () => [f.identity, { ...f.identity, sessionId: randomUUID() }] });
  assert.equal(ambiguous.roots[0].reason, 'runtime-ambiguous');
  assert.equal(ambiguous.requiresAttention, true);
  assert.equal(f.calls.length, 0);
});

test('SessionEnd uses retained exact identity after runtime exit for late receipt only', async t => {
  const f = await fixture(t); const queued = await f.send(); f.online = true;
  await handleClaudeLifecycle({ ...f.options, event: f.start });
  assert.equal(f.calls.length, 1);
  f.seen = true;
  const before = f.inspections;
  const result = await handleClaudeLifecycle({ ...f.options, event: f.end, discover: async () => [] });
  assert.equal(result.roots[0].flushed.inspected, 0);
  assert.deepEqual(result.roots[0].identity, f.identity);
  assert.equal(result.roots[0].observed[0].messageId, queued.message.id);
  assert.equal(result.roots[0].observed[0].receiptState, 'recipient-observed');
  assert.equal(f.inspections, before + 1); assert.equal(f.calls.length, 1);
  await handleClaudeLifecycle({ ...f.options, event: f.end, discover: async () => [] });
  assert.equal(f.inspections, before + 1);
});

test('restart with a new runtime for the same host resumes the queued original once and ignores old runtime events', async t => {
  const f = await fixture(t);
  await handleClaudeLifecycle({ ...f.options, event: f.start });
  const oldMappingPath = join(f.root, '.bridge/lifecycle', f.identity.sessionId + '.json');
  const oldMapping = await readFile(oldMappingPath);
  const queued = await f.send();
  const messagePath = join(f.root, '.bridge/messages', queued.message.id + '.json');
  const originalMessage = await readFile(messagePath);
  const originalConfig = await readFile(join(f.root, '.bridge/config.json'));

  const ended = await handleClaudeLifecycle({ ...f.options, event: f.end, discover: async () => [] });
  assert.equal(ended.roots[0].flushed.inspected, 0);
  assert.deepEqual(ended.roots[0].identity, f.identity);
  assert.equal(f.calls.length, 0);

  const replacementRuntime = { sessionId: randomUUID(), hostSessionId: f.identity.hostSessionId };
  const resumedEvent = { hook_event_name: 'SessionStart', source: 'resume', session_id: replacementRuntime.sessionId };
  const resumedOptions = { ...f.options, discover: async () => [replacementRuntime] };
  f.online = true; f.seen = true;
  const resumed = await handleClaudeLifecycle({ ...resumedOptions, event: resumedEvent });
  assert.deepEqual(resumed.roots[0].identity, replacementRuntime);
  assert.deepEqual(f.calls.map(call => call.id), [queued.message.id]);
  assert.equal(f.calls[0].target.hostSessionId, f.identity.hostSessionId);
  assert.equal(resumed.roots[0].observed[0].receiptState, 'recipient-observed');

  const oldEvent = await handleClaudeLifecycle({ ...resumedOptions, event: f.start });
  assert.equal(oldEvent.roots[0].reason, 'runtime-not-ready');
  await handleClaudeLifecycle({ ...resumedOptions, event: resumedEvent });
  assert.equal(f.calls.length, 1);
  assert.deepEqual(await readFile(messagePath), originalMessage);
  assert.deepEqual(await readFile(join(f.root, '.bridge/config.json')), originalConfig);
  assert.deepEqual(await readFile(oldMappingPath), oldMapping);
  const newMapping = JSON.parse(await readFile(join(f.root, '.bridge/lifecycle', replacementRuntime.sessionId + '.json'), 'utf8'));
  assert.deepEqual(newMapping.identity, replacementRuntime);
});

test('uncertain writes are observed on Stop and never replayed by lifecycle delivery', async t => {
  const f = await fixture(t, { uncertain: true }); f.online = true;
  const sent = await f.send(); assert.equal(sent.status.transportState, 'uncertain');
  await handleClaudeLifecycle({ ...f.options, event: f.start });
  assert.equal(f.calls.length, 1);
  f.seen = true;
  const stopped = await handleClaudeLifecycle({ ...f.options, event: f.stop });
  assert.equal(stopped.roots[0].observed[0].receiptState, 'recipient-observed');
  assert.equal(f.calls.length, 1);
});

test('readiness retries are bounded and shared across homes, then one exact runtime is used', async t => {
  const f = await fixture(t); await f.send(); f.online = true;
  let clock = Date.now(), discoveries = 0;
  const waited = [];
  const result = await handleClaudeLifecycle({ ...f.options, event: f.start, readyWaitMs: 250, budgetMs: 1000,
    now: () => clock, wait: async delay => { waited.push(delay); clock += delay; },
    discover: async () => ++discoveries < 3 ? [] : [f.identity] });
  assert.deepEqual(waited, [100, 100]); assert.equal(discoveries, 3);
  assert.deepEqual(result.roots[0].identity, f.identity); assert.equal(f.calls.length, 1);

  let missingClock = 0;
  const missing = await handleClaudeLifecycle({ ...f.options, event: f.start, readyWaitMs: 250,
    now: () => missingClock, wait: async delay => { missingClock += delay; }, discover: async () => [] });
  assert.equal(missingClock, 250); assert.equal(missing.roots[0].reason, 'runtime-not-ready');
});

test('a matching home prevents unnecessary readiness waits for another configured home', async t => {
  const first = await fixture(t), second = await fixture(t);
  let waits = 0;
  const result = await handleClaudeLifecycle({ roots: [first.root, second.root], event: first.start,
    discover: async ({ home }) => home === first.root ? [first.identity] : [],
    bridgeFactory: ({ root }) => root === first.root ? first.bridge : second.bridge,
    wait: async () => { waits++; } });
  assert.equal(waits, 0);
  assert.equal(result.roots.find(row => row.root === second.root).reason, 'runtime-not-ready');
});

test('deadline stops between operations and prevents later root work without abandoning an in-flight call', async t => {
  const first = await fixture(t), second = await fixture(t);
  let clock = 0, factories = 0, statuses = 0;
  const result = await handleClaudeLifecycle({ roots: [first.root, second.root], event: first.start,
    now: () => clock, budgetMs: 10, discover: async () => [first.identity],
    bridgeFactory: () => {
      factories++;
      return { flush: async options => { assert.equal(options.deadlineAt, 10); clock = 20;
        return { inspected: 0, results: [], requiresAttention: false }; },
      status: async () => { statuses++; return { messages: [] }; } };
    } });
  assert.equal(factories, 1); assert.equal(statuses, 0);
  assert.equal(result.roots.every(row => row.reason === 'deadline-reached'), true);
});

test('retained host identity cannot be replaced by a different host under the same runtime ID', async t => {
  const f = await fixture(t);
  await handleClaudeLifecycle({ ...f.options, event: f.start });
  const result = await handleClaudeLifecycle({ ...f.options, event: f.end,
    discover: async () => [{ ...f.identity, hostSessionId: 'local_' + randomUUID() }] });
  assert.equal(result.roots[0].reason, 'historical-identity-conflict');
  assert.equal(result.requiresAttention, true);
  assert.equal(f.calls.length, 0);
});

test('unknown events, subagents and malformed identities do not touch message delivery', async t => {
  const f = await fixture(t);
  const options = { ...f.options, discover: async () => { throw new Error('must not discover'); } };
  assert.equal((await handleClaudeLifecycle({ ...options, event: { ...f.start, source: 'fork' } })).reason, 'unsupported-event');
  assert.equal((await handleClaudeLifecycle({ ...options, event: { ...f.stop, agent_id: 'subagent' } })).reason, 'unsupported-event');
  assert.equal((await handleClaudeLifecycle({ ...options, event: { ...f.start, session_id: '../wrong' } })).reason, 'invalid-session-id');
  await assert.rejects(() => handleClaudeLifecycle({ ...options, roots: ['relative'], event: f.start }), /absolute paths/);
  assert.equal(f.calls.length, 0);
});

test('discovery failures use a fixed diagnostic without exposing raw native error text', async t => {
  const f = await fixture(t);
  const result = await handleClaudeLifecycle({ ...f.options, event: f.start,
    discover: async () => { throw new Error('secret native log'); } });
  assert.equal(result.roots[0].reason, 'discovery-unavailable');
  assert.equal(result.requiresAttention, true);
  assert.equal(JSON.stringify(result).includes('secret'), false);
});
