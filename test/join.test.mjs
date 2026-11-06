import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createBridge } from '../src/index.mjs';
import { joinChat, selfTest, syncStateRoutingProfile } from '../src/join.mjs';
import { verifyCommunication } from '../src/verification.mjs';
import { evaluateAppVersionEvidence } from '../src/app-versions.mjs';
import { loadRoutingProfile, routingProfileForApps, stateRoutingProfilePath } from '../src/routing.mjs';
import { delegate } from '../src/delegation.mjs';
import { dispatchImageTask } from '../src/images.mjs';
import { makeEnvelope, renderPrompt } from '../src/protocol.mjs';

async function workspace(t, config) {
  const root = await mkdtemp(join(tmpdir(), 'agent-bridge-join-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.bridge'), { recursive: true });
  if (config) await writeFile(join(root, '.bridge/config.json'), JSON.stringify(config));
  const sent = [];
  const transport = async (target, prompt, settings, message) => { sent.push(message); return { state: 'native-accepted', transport: 'test' }; };
  return { root, home: join(root, 'home'), sent,
    bridge: createBridge({ root, adapters: { codex: transport, claude: transport, gemini: transport }, inspectors: {} }) };
}
const readConfig = root => readFile(join(root, '.bridge/config.json'), 'utf8').then(JSON.parse);

test('a Claude chat registers itself from its session environment and transcript mode', async t => {
  const w = await workspace(t);
  const sessionId = randomUUID(), host = 'local_' + randomUUID();
  const transcripts = join(w.home, '.claude', 'projects', 'C--work');
  await mkdir(transcripts, { recursive: true });
  await writeFile(join(transcripts, sessionId + '.jsonl'), JSON.stringify({ type: 'user', sessionId, permissionMode: 'bypassPermissions' }) + '\n');
  const env = { CLAUDE_CODE_SESSION_ID: sessionId, CLAUDE_CODE_HOST_SESSION_ID: host, CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' };
  const result = await joinChat(w.bridge, { agent: 'claude', env, home: w.home, discover: async () => [{ sessionId, name: '작업 채팅' }] });
  assert.equal(result.status, 'registered');
  assert.deepEqual(result.chat, { sessionId, hostSessionId: host, title: '작업 채팅' });
  assert.equal(result.permissionClass, 'bypass');
  assert.equal((await readConfig(w.root)).agents.claude.hostSessionId, host);
  assert.deepEqual(result.registeredApps, ['claude']);
  assert.equal(result.routing.state, 'waiting-for-second-app');
  assert.equal((await joinChat(w.bridge, { agent: 'claude', env, home: w.home, discover: async () => [] })).status, 'updated');

  const other = { ...env, CLAUDE_CODE_SESSION_ID: randomUUID(), CLAUDE_CODE_HOST_SESSION_ID: 'local_' + randomUUID() };
  const refused = await joinChat(w.bridge, { agent: 'claude', env: other, home: w.home, discover: async () => [] });
  assert.equal(refused.status, 'already-registered');
  assert.equal(refused.requiresAttention, true);
  assert.equal((await readConfig(w.root)).agents.claude.hostSessionId, host, 'a refused join changes nothing');
  const replaced = await joinChat(w.bridge, { agent: 'claude', env: other, home: w.home, discover: async () => [], replace: true });
  assert.equal(replaced.status, 'replaced');
  assert.equal(replaced.permissionClass, 'prompting', 'an unknown mode stays prompting');
  await assert.rejects(joinChat(w.bridge, { agent: 'claude', env: {}, home: w.home }), /inside the Claude chat/);
});

test('a Codex chat is found by its one-time join code and regenerates two-app routing', async t => {
  const w = await workspace(t, { version: 1, agents: { claude: { sessionId: randomUUID() } } });
  const step = await joinChat(w.bridge, { agent: 'codex', home: w.home });
  assert.equal(step.status, 'confirm-required');
  assert.match(step.next, /join --agent codex --code ab-join-[a-f0-9]{16} --root /);
  const threadId = randomUUID(), day = join(w.home, '.codex', 'sessions', '2026', '11', '05');
  await mkdir(day, { recursive: true });
  await writeFile(join(day, `rollout-2026-11-05T00-00-00-${threadId}.jsonl`), [
    { type: 'session_meta', payload: { id: threadId, cwd: 'C:/work' } },
    { type: 'turn_context', payload: { approval_policy: 'never', sandbox_policy: { type: 'workspace-write' } } },
    { type: 'response_item', payload: { type: 'function_call', arguments: JSON.stringify({ command: step.next }) } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n');
  await writeFile(join(day, `rollout-2026-11-05T00-00-01-${randomUUID()}.jsonl`),
    JSON.stringify({ type: 'session_meta', payload: { id: randomUUID() } }) + '\n');
  const done = await joinChat(w.bridge, { agent: 'codex', code: step.code, home: w.home });
  assert.equal(done.status, 'registered');
  assert.deepEqual(done.chat, { threadId });
  assert.equal(done.permissionClass, 'bypass');
  const config = await readConfig(w.root);
  assert.equal(config.codexCallerThreadId, threadId);
  assert.equal(config.agents.codex.hostId, 'local');
  assert.deepEqual(done.registeredApps, ['codex', 'claude']);
  assert.equal(done.routing.state, 'generated');
  assert.deepEqual(done.routing.reassigned.map(row => [row.taskType, row.to]), [['writing', 'claude'], ['revision', 'claude']]);
  assert.equal((await loadRoutingProfile(undefined, { root: w.root })).routes.find(route => route.taskType === 'writing').app, 'claude');
  await assert.rejects(joinChat(w.bridge, { agent: 'codex', code: step.code, home: w.home }), /unknown or expired/);
  const fresh = await joinChat(w.bridge, { agent: 'codex', home: w.home });
  await assert.rejects(joinChat(w.bridge, { agent: 'codex', code: fresh.code, home: w.home }), /No recent Codex chat/);
  await assert.rejects(joinChat(w.bridge, { agent: 'codex', code: 'not-a-code', home: w.home }), /Invalid join code/);
});

test('an Antigravity conversation is found by the join code in its trajectory', async t => {
  const w = await workspace(t, { version: 1, agents: { codex: { threadId: randomUUID() }, claude: { sessionId: randomUUID() } } });
  await writeFile(stateRoutingProfilePath(w.root), JSON.stringify({ ...routingProfileForApps(await loadRoutingProfile(), ['codex', 'claude']),
    generatedBy: 'agent-bridge-join' }));
  const step = await joinChat(w.bridge, { agent: 'gemini', home: w.home });
  const conversations = join(w.home, '.gemini', 'antigravity', 'conversations');
  await mkdir(conversations, { recursive: true });
  const target = randomUUID(), other = randomUUID();
  for (const id of [target, other]) await writeFile(join(conversations, id + '.db'), '');
  const eager = { plannerConfig: { toolConfig: { runCommand: { autoCommandConfig: { autoExecutionPolicy: 'CASCADE_COMMANDS_AUTO_EXECUTION_EAGER' } } } } };
  const rpc = async (method, body) => ({ trajectory: { cascadeId: body.cascadeId, metadata: { projectId: 'project-1' },
    steps: body.cascadeId === target ? [{ type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { userConfig: eager } },
      { type: 'CORTEX_STEP_TYPE_RUN_COMMAND', runCommand: { commandLine: step.next } }] : [] } });
  const done = await joinChat(w.bridge, { agent: 'gemini', code: step.code, home: w.home, rpc,
    connection: { address: 'http://127.0.0.1:1', csrfToken: 'fixture' } });
  assert.deepEqual(done.chat, { conversationId: target, projectId: 'project-1' });
  assert.equal(done.permissionClass, 'bypass');
  assert.deepEqual(done.registeredApps, ['codex', 'claude', 'gemini']);
  assert.equal(done.routing.state, 'default');
  await assert.rejects(readFile(stateRoutingProfilePath(w.root)), /ENOENT/, 'three apps use the default profile again');
});

test('an active Antigravity chat is found through its fresh WAL file when the .db is hours old', async t => {
  // Live 2026-11-05: the active conversation's .db kept its 3-hour-old checkpoint
  // time while only <id>.db-wal changed, so a .db-only freshness check missed it.
  const w = await workspace(t, { version: 1, agents: { claude: { sessionId: randomUUID() } } });
  const step = await joinChat(w.bridge, { agent: 'gemini', home: w.home });
  const conversations = join(w.home, '.gemini', 'antigravity', 'conversations');
  await mkdir(conversations, { recursive: true });
  const active = randomUUID(), idle = randomUUID(), hoursAgo = new Date(Date.now() - 3 * 3600000);
  for (const name of [active + '.db', idle + '.db', idle + '.db-wal']) {
    await writeFile(join(conversations, name), '');
    await utimes(join(conversations, name), hoursAgo, hoursAgo);
  }
  await writeFile(join(conversations, active + '.db-wal'), 'fresh');
  const queried = [];
  const rpc = async (method, body) => { queried.push(body.cascadeId);
    return { trajectory: { cascadeId: body.cascadeId, metadata: { projectId: 'project-2' },
      steps: body.cascadeId === active ? [{ type: 'CORTEX_STEP_TYPE_RUN_COMMAND', runCommand: { commandLine: step.next } }] : [] } }; };
  const done = await joinChat(w.bridge, { agent: 'gemini', code: step.code, home: w.home, rpc,
    connection: { address: 'http://127.0.0.1:1', csrfToken: 'fixture' } });
  assert.deepEqual(done.chat, { conversationId: active, projectId: 'project-2' });
  assert.deepEqual(queried, [active], 'only the recently active conversation is searched');
});

test('issuing a join code removes expired codes left by failed joins and keeps live ones', async t => {
  // Live 2026-11-05: a failed step 2 left its code file behind for good; only a
  // successful join removed its own code.
  const w = await workspace(t);
  const pending = join(w.root, '.bridge', 'joins'), now = new Date('2026-11-05T12:00:00Z');
  await mkdir(pending, { recursive: true });
  const code = digit => 'ab-join-' + digit.repeat(16) + '.json';
  await writeFile(join(pending, code('0')), JSON.stringify({ version: 1, agent: 'gemini', createdAt: '2026-11-05T11:44:00Z' }));
  await writeFile(join(pending, code('1')), JSON.stringify({ version: 1, agent: 'codex', createdAt: '2026-11-05T11:50:00Z' }));
  for (const [digit, minutesAgo] of [['2', 1], ['3', 20]]) {
    await writeFile(join(pending, code(digit)), '');
    const at = new Date(now.getTime() - minutesAgo * 60000);
    await utimes(join(pending, code(digit)), at, at);
  }
  await writeFile(join(pending, 'notes.txt'), 'not a join code');
  const step = await joinChat(w.bridge, { agent: 'gemini', home: w.home, now: () => now });
  assert.deepEqual((await readdir(pending)).sort(), [code('1'), code('2'), step.code + '.json', 'notes.txt'].sort());
});

test('two-app routing moves missing roles and drops fixed models; a hand-written profile is kept', async t => {
  const base = await loadRoutingProfile();
  for (const [apps, expected] of [
    [['claude', 'gemini'], { logic: 'claude', coordination: 'claude', writing: 'gemini' }],
    [['codex', 'gemini'], { logic: 'codex', coordination: 'codex', writing: 'gemini' }],
    [['codex', 'claude'], { logic: 'codex', coordination: 'claude', writing: 'claude' }]]) {
    const profile = routingProfileForApps(base, apps);
    for (const [taskType, app] of Object.entries(expected)) assert.equal(profile.routes.find(route => route.taskType === taskType).app, app, apps + ':' + taskType);
    assert.ok(profile.routes.every(route => apps.includes(route.app)));
    assert.ok(profile.routes.filter(route => route.reassignedFrom)
      .every(route => route.worker.modelId === null && !route.allowedRunners.includes('ccb-worker')));
  }
  assert.equal(routingProfileForApps(base, ['codex', 'claude', 'gemini']), base);
  assert.throws(() => routingProfileForApps(base, ['claude']), /at least two/);
  const w = await workspace(t);
  await writeFile(stateRoutingProfilePath(w.root), JSON.stringify({ ...base, profileId: 'my-own' }));
  assert.deepEqual(await syncStateRoutingProfile(w.root, ['claude', 'gemini']), { state: 'custom-profile-kept', profileId: 'my-own' });
});

test('verification and version evidence count only the registered apps', () => {
  const message = (from, to, kind, extra = {}) => {
    const attemptId = 'attempt-' + randomUUID();
    return { id: randomUUID(), from, to, kind, correlationId: 'pair', replyTo: null, createdAt: '2026-11-05T00:00:00Z', ...extra,
      receipts: [{ state: 'delivery-attempt', attemptId, recipientApp: { version: '1.0.0' } },
        { agent: from, state: 'native-accepted', attemptId }, { agent: to, state: 'received' }] };
  };
  const ping = message('claude', 'gemini', 'ping');
  const pong = message('gemini', 'claude', 'pong', { replyTo: ping.id });
  assert.equal(verifyCommunication({ messages: [ping, pong] }, { agents: ['claude', 'gemini'] }).passed, true);
  assert.equal(verifyCommunication({ messages: [ping, pong] }).passed, false, 'the three-app default still needs every route');
  const evidence = evaluateAppVersionEvidence([ping, pong], { codex: null, claude: '1.0.0', gemini: '1.0.0' }, ['claude', 'gemini']);
  assert.deepEqual([evidence.claude.passed, evidence.gemini.passed, evidence.codex.passed], [true, true, false]);
  assert.equal(evaluateAppVersionEvidence([ping, pong], { codex: null, claude: '1.0.0', gemini: '1.0.0' }).gemini.passed, false);
});

test('delegation and image routes to an unregistered app fail clearly before sending', async t => {
  const w = await workspace(t, { version: 1, agents: { claude: {}, gemini: {} } });
  await assert.rejects(delegate(w.bridge, { profile: await loadRoutingProfile(), taskType: 'logic', from: 'claude',
    task: { taskId: 'logic-1', objective: 'Check the calculation.', doneWhen: ['The result is recorded.'] } }), /codex, which is not registered here/);
  const image = await dispatchImageTask(w.bridge, { from: 'claude', request: { taskId: 'image-1', prompt: 'A simple icon', projectRoot: w.root } });
  assert.equal(image.state, 'route-unavailable');
  assert.equal(w.sent.length, 0);
});

test('selftest pings each registered pair once per day', async t => {
  const w = await workspace(t, { version: 1, agents: { codex: {}, claude: {}, gemini: {} } });
  const first = await selfTest(w.bridge, { now: () => new Date('2026-11-05T10:00:00Z') });
  assert.deepEqual(first.pairs.map(pair => [pair.from, pair.to]), [['codex', 'claude'], ['codex', 'gemini'], ['claude', 'gemini']]);
  assert.equal(w.sent.length, 3);
  assert.ok(w.sent.every(message => message.kind === 'ping'));
  const again = await selfTest(w.bridge, { now: () => new Date('2026-11-05T11:00:00Z') });
  assert.ok(again.pairs.every(pair => pair.duplicate));
  assert.equal(w.sent.length, 3);
  assert.equal((await selfTest((await workspace(t, { version: 1, agents: { claude: {}, gemini: {} } })).bridge)).pairs.length, 1);
  assert.equal((await selfTest((await workspace(t, { version: 1, agents: { claude: {} } })).bridge)).status, 'needs-two-apps');
});

test('pong prompts ask the original sender to record receipt locally', () => {
  const ping = makeEnvelope({ from: 'codex', to: 'claude', kind: 'ping', body: 'ping' });
  const pong = makeEnvelope({ from: 'claude', to: 'codex', kind: 'pong', body: 'PONG', replyTo: ping.id, correlationId: ping.correlationId });
  const prompt = renderPrompt(pong, 'C:/work');
  assert.match(prompt, / receive --root 'C:\/work' --agent codex --id /);
  assert.match(prompt, /Do not send an automatic reply/);
});
