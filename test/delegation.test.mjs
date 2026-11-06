import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRoutingProfile } from '../src/routing.mjs';
import { createDelegation, serializeDelegation, validateDelegation, delegate } from '../src/delegation.mjs';
import { createBridge } from '../src/index.mjs';

const task = { taskId: 'story-1', objective: '선택한 장면의 인과를 개고한다.', readOrder: [{ path: 'C:/fixture/INDEX.md' }],
  writeScope: ['C:/fixture/draft.md'], doNotChange: ['C:/fixture/original.md'], doneWhen: ['원래 두 대사를 보존한다.'] };
const sessionId = '11111111-1111-4111-a111-111111111111';
const evidence = { app: 'codex', sessionId, evidenceStatus: 'observed', observedModel: 'gpt-6-astra', observedEffort: 'xhigh',
  observedAt: '2026-10-28T01:00:00Z', source: { type: 'codex-rollout', path: '/fixture/rollout.jsonl' } };

test('delegation preserves bounded instructions and current-session model choice', async () => {
  const profile = await loadRoutingProfile();
  const body = createDelegation(task, { profile, taskType: 'writing' });
  assert.equal(body.worker.modelId, null);
  assert.equal(body.commitPolicy, 'no-commit');
  assert.deepEqual(body.writeScope, task.writeScope);
  assert.equal(body.report.summaryMaxLines, 5);
  assert.deepEqual(JSON.parse(serializeDelegation(body)), body);
  assert.throws(() => validateDelegation({ ...body, commitPolicy: 'commit' }), /no-commit/);
  assert.throws(() => validateDelegation({ ...body, doneWhen: [] }), /completion criteria/);
  assert.throws(() => validateDelegation({ ...body, writeScope: ['relative/file'] }), /writeScope/);
  assert.throws(() => validateDelegation({ ...body, objective: '가'.repeat(17000) }), /48 KiB/);
});

test('same logical delegation has a stable envelope ID and never retries a failing send', async () => {
  const profile = await loadRoutingProfile();
  const messages = [];
  const bridge = { async send(message) { messages.push(message); return { message }; } };
  await delegate(bridge, { profile, taskType: 'writing', task, from: 'codex' });
  await delegate(bridge, { profile, taskType: 'writing', task, from: 'codex' });
  assert.equal(messages[0].id, messages[1].id);
  await delegate(bridge, { profile, taskType: 'writing', task, from: 'claude' });
  assert.equal(messages[0].id, messages[2].id); // A real bridge rejects a second owner under the same ID.
  assert.equal(JSON.parse(messages[0].body).notify.replyTo, messages[0].id);
  let calls = 0;
  await assert.rejects(() => delegate({ send: async () => { calls++; throw Error('uncertain'); } },
    { profile, taskType: 'writing', task, from: 'codex' }), /uncertain/);
  assert.equal(calls, 1);
  await assert.rejects(() => delegate(bridge, { profile, taskType: 'writing', task, from: 'gemini' }), /must differ/);
  assert.equal(messages.length, 3);
});

test('exact-model evidence must belong to the bridge registered target before any send', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-delegation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.bridge'));
  const config = join(root, '.bridge/config.json');
  await writeFile(config, JSON.stringify({ agents: { codex: { threadId: sessionId } } }));
  const profile = await loadRoutingProfile();
  let calls = 0;
  const bridge = { root, async send(message) { calls++; return { message }; } };
  await delegate(bridge, { profile, taskType: 'logic', task, from: 'claude', sessionId, evidence });
  assert.equal(calls, 1);
  await writeFile(config, JSON.stringify({ agents: { codex: { threadId: '22222222-2222-4222-a222-222222222222' } } }));
  await assert.rejects(() => delegate(bridge, { profile, taskType: 'logic', task, from: 'claude', sessionId, evidence }), /registered recipient/);
  assert.equal(calls, 1);
});

test('policy edits and recipient changes cannot submit the same task revision twice', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-delegation-route-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.bridge'));
  await writeFile(join(root, '.bridge/config.json'), JSON.stringify({ agents: { codex: {}, claude: {}, gemini: {} } }));
  let sends = 0;
  const send = async () => { sends++; return { state: 'native-accepted', transport: 'fixture' }; };
  const bridge = createBridge({ root, adapters: { claude: send, gemini: send } });
  const profile = await loadRoutingProfile();
  await delegate(bridge, { profile, taskType: 'writing', task, from: 'codex' });
  profile.revision++;
  await assert.rejects(() => delegate(bridge, { profile, taskType: 'writing', task, from: 'codex' }), /different envelope/);
  profile.routes.find(row => row.taskType === 'writing').app = 'claude';
  await assert.rejects(() => delegate(bridge, { profile, taskType: 'writing', task, from: 'codex' }), /different envelope/);
  assert.equal(sends, 1);
  await delegate(bridge, { profile, taskType: 'writing', task: { ...task, revision: 2 }, from: 'codex' });
  assert.equal(sends, 2);
});
