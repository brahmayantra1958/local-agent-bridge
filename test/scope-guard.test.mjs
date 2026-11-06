import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBridge } from '../src/index.mjs';
import { loadRoutingProfile } from '../src/routing.mjs';
import { delegate, createDelegation, serializeDelegation } from '../src/delegation.mjs';
import { makeEnvelope, renderPrompt } from '../src/protocol.mjs';
import { delegationScope, activeReservations, scopeConflicts, normalizeScopePath, checkScope,
  scopeCheckNote } from '../src/scope-guard.mjs';

async function fixture(t, { scopeRunner, config = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'agent-bridge-scope-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const work = join(root, 'work');
  await mkdir(join(root, '.bridge'), { recursive: true });
  await mkdir(join(work, 'drafts'), { recursive: true });
  await writeFile(join(work, 'original.md'), 'ORIGINAL TEXT');
  await writeFile(join(work, 'drafts', 'draft.md'), 'draft v1');
  await writeFile(join(root, '.bridge/config.json'), JSON.stringify({ agents: { codex: {}, claude: {}, gemini: {} }, ...config }));
  const prompts = [], sent = { codex: 0, claude: 0, gemini: 0 };
  const transport = agent => async (target, prompt) => { sent[agent]++; prompts.push({ agent, prompt });
    return { state: 'native-accepted', transport: 'test' }; };
  const bridge = createBridge({ root, scopeRunner,
    adapters: { codex: transport('codex'), claude: transport('claude'), gemini: transport('gemini') }, inspectors: {} });
  return { root, work, bridge, prompts, sent, profile: await loadRoutingProfile() };
}

const task = (work, extra = {}) => ({ taskId: 'scene-review', revision: 1, objective: 'Review the selected scene.',
  writeScope: [join(work, 'drafts', 'draft.md')], doNotChange: [join(work, 'original.md')],
  doneWhen: ['Record the review in the draft.'], ...extra });
const exists = path => access(path).then(() => true, () => false);

test('delegation scope is read only from delegation.v1 task bodies', async () => {
  const profile = await loadRoutingProfile();
  const body = serializeDelegation(createDelegation(task('C:/work'), { profile, taskType: 'writing' }));
  const message = makeEnvelope({ from: 'codex', to: 'gemini', kind: 'task', body });
  assert.deepEqual(delegationScope(message), { profileId: profile.profileId, taskId: 'scene-review', revision: 1,
    writeScope: [join('C:/work', 'drafts', 'draft.md')], doNotChange: [join('C:/work', 'original.md')] });
  assert.equal(delegationScope({ ...message, kind: 'result' }), null);
  assert.equal(delegationScope({ ...message, body: 'free text task' }), null);
  assert.equal(delegationScope({ ...message, body: '{"contract":"delegation.v1"}' }), null);
});

test('reservations keep the newest revision per task and end on completion, release or expiry', () => {
  const at = '2026-11-05T00:00:00.000Z', ms = Date.parse(at);
  const message =(id, taskId, revision, writeScope, createdAt = at) => ({ id, kind: 'task', from: 'codex', to: 'gemini', createdAt,
    body: serializeDelegation({ contract: 'delegation.v1', taskId, revision, routeId: 'writing', profileId: 'p', profileRevision: 1,
      objective: 'x', readOrder: [], inputs: [], writeScope, doNotChange: [], doneWhen: ['done'], verify: [],
      report: { summaryMaxLines: 5, artifacts: true, executionEvidence: true }, commitPolicy: 'no-commit',
      worker: { modelId: null, effort: null, runner: 'session' }, subagents: { useWhenIndependent: true, maxConcurrent: null },
      notify: { on: ['completed', 'failed', 'blocked'], replyTo: null } }) });
  const messages =[message('11111111-1111-4111-8111-111111111111', 'a', 1, ['C:/w/a.md']),
    message('22222222-2222-4222-8222-222222222222', 'a', 2, ['C:/w/b.md'], '2026-11-05T00:01:00.000Z'),
    message('33333333-3333-4333-8333-333333333333', 'c', 1, ['C:/w/c.md']),
    message('44444444-4444-4444-8444-444444444444', 'd', 1, ['C:/w/d.md']),
    message('55555555-5555-4555-8555-555555555555', 'e', 1, [])];
  const active = activeReservations(messages, [{ messageId: '44444444-4444-4444-8444-444444444444', state: 'scope-released' }],
    new Set(['33333333-3333-4333-8333-333333333333']), { now: ms + 3600000, ttlMs: 2 * 3600000 });
  assert.deepEqual(active.map(row => [row.taskId, row.revision, row.writeScope]), [['a', 2, [normalizeScopePath('C:/w/b.md')]]]);
  assert.deepEqual(activeReservations(messages, [], new Set(), { now: ms + 3 * 3600000, ttlMs: 2 * 3600000 }), []);
  const conflicts = scopeConflicts({ messageId: 'new', profileId: 'p', taskId: 'z', writeScope: ['c:\\W\\'] }, active);
  assert.deepEqual(conflicts.map(row => [row.taskId, row.overlaps.length]), [['a', 1]]);
  assert.deepEqual(scopeConflicts({ messageId: 'new', profileId: 'p', taskId: 'a', writeScope: ['C:/w'] }, active), [],
    'a new revision of the same task takes over its own reservation');
  assert.deepEqual(scopeConflicts({ messageId: 'new', profileId: 'p', taskId: 'z', writeScope: ['C:/w/b.md.bak', 'C:/other'] }, active), []);
});

test('overlapping delegation is refused before persistence and allowed after release or result', async t => {
  const f = await fixture(t);
  const first = await delegate(f.bridge, { profile: f.profile, taskType: 'writing', task: task(f.work), from: 'codex' });
  assert.equal(f.sent.gemini, 1);
  assert.equal(await exists(join(f.root, '.bridge', 'scope', first.message.id + '.baseline.json')), true);
  assert.match(f.prompts[0].prompt, /agent-bridge recorded doNotChange/);
  const overlapping = task(f.work, { taskId: 'other-task', writeScope: [join(f.work, 'drafts')], doNotChange: [] });
  const blocked = await delegate(f.bridge, { profile: f.profile, taskType: 'writing', task: overlapping, from: 'claude' });
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.persisted, false);
  assert.equal(blocked.requiresAttention, true);
  assert.equal(blocked.conflicts[0].messageId, first.message.id);
  assert.equal(f.sent.gemini, 1);
  assert.equal(await exists(join(f.root, '.bridge', 'messages', blocked.message.id + '.json')), false);
  // Re-sending the reserving task itself is an ordinary duplicate.
  assert.equal((await delegate(f.bridge, { profile: f.profile, taskType: 'writing', task: task(f.work), from: 'codex' })).duplicate, true);
  assert.equal((await f.bridge.reservations()).reservations.length, 1);

  await f.bridge.releaseScope(first.message.id);
  assert.equal((await f.bridge.reservations()).reservations.length, 0);
  const allowed = await delegate(f.bridge, { profile: f.profile, taskType: 'writing', task: overlapping, from: 'claude' });
  assert.equal(allowed.blocked, undefined);
  assert.equal(f.sent.gemini, 2);
  await f.bridge.reply('gemini', allowed.message.id, { body: 'review recorded', kind: 'result' });
  assert.equal((await f.bridge.reservations()).reservations.length, 0, 'a correlated result ends the reservation');
  const third = await delegate(f.bridge, { profile: f.profile, taskType: 'writing',
    task: task(f.work, { taskId: 'third', writeScope: [join(f.work, 'drafts', 'draft.md')], doNotChange: [] }), from: 'codex' });
  assert.equal(third.blocked, undefined);
});

test('scopeGuard false sends without reservation or baseline', async t => {
  const f = await fixture(t);
  const sent = await delegate(f.bridge, { profile: f.profile, taskType: 'writing', task: task(f.work), from: 'codex',
    sendOptions: { scopeGuard: false } });
  assert.equal(await exists(join(f.root, '.bridge', 'scope', sent.message.id + '.baseline.json')), false);
  assert.doesNotMatch(f.prompts[0].prompt, /agent-bridge recorded doNotChange/);
});

test('result check flags a changed doNotChange path and reports it to the requester in the same delivery', async t => {
  const f = await fixture(t);
  const sent = await delegate(f.bridge, { profile: f.profile, taskType: 'writing', task: task(f.work), from: 'codex' });
  await writeFile(join(f.work, 'drafts', 'draft.md'), 'draft v2 inside scope');
  await writeFile(join(f.work, 'original.md'), 'ORIGINAL TEXT edited');
  const result = await f.bridge.reply('gemini', sent.message.id, { body: 'Review written.', kind: 'result' });
  assert.equal(result.scopeCheck.state, 'violation');
  assert.equal(result.requiresAttention, true);
  assert.equal(result.status.requiresAttention, false, 'delivery itself succeeded');
  assert.deepEqual(result.scopeCheck.doNotChange.changes, [{ path: join(f.work, 'original.md'), change: 'modified' }]);
  const delivered = f.prompts.find(row => row.agent === 'codex').prompt;
  assert.match(delivered, /Bridge scope check for task scene-review r1: doNotChange changed: .*original\.md \(modified\)/);
  assert.ok(delivered.indexOf('Bridge scope check') < delivered.indexOf('Peer message body:'));
  const stored = (await f.bridge.receipts(sent.message.id)).filter(row => row.state === 'scope-checked');
  assert.equal(stored.length, 1);
  const again = await f.bridge.reply('gemini', sent.message.id, { body: 'Review written.', kind: 'result' });
  assert.equal(again.duplicate, true);
  assert.equal(again.scopeCheck.state, 'violation');
  assert.equal(again.requiresAttention, true);
});

test('clean result and declared artifacts outside writeScope', async t => {
  const f = await fixture(t);
  const sent = await delegate(f.bridge, { profile: f.profile, taskType: 'writing', task: task(f.work), from: 'codex' });
  await writeFile(join(f.work, 'drafts', 'draft.md'), 'draft v2');
  const clean = await f.bridge.reply('gemini', sent.message.id, { body: 'done', kind: 'result' });
  assert.equal(clean.scopeCheck.state, 'clean');
  assert.equal(clean.requiresAttention, undefined);
  assert.match(f.prompts.at(-1).prompt, /clean \(doNotChange 1 unchanged; git comparison unavailable\)/);

  const second = await delegate(f.bridge, { profile: f.profile, taskType: 'writing',
    task: task(f.work, { taskId: 'artifact-task' }), from: 'claude' });
  const report = JSON.stringify({ contract: 'completion.v1', runId: 'run-1', status: 'completed', summary: 'done',
    artifacts: [join(f.work, 'drafts', 'draft.md'), join(f.work, 'notes.md'), 'codex://artifact/1'], evidence: null });
  const declared = await f.bridge.reply('gemini', second.message.id, { body: report, kind: 'result' });
  assert.equal(declared.scopeCheck.state, 'violation');
  assert.deepEqual(declared.scopeCheck.declaredOutsideWriteScope, [normalizeScopePath(join(f.work, 'notes.md'))]);
});

test('git observations outside writeScope and a moved HEAD warn without attributing the change', async t => {
  let phase = 'before';
  const scopeRunner = async (git, args, cwd) => {
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return cwd.startsWith(work) ? work + '\n' : '';
    if (args[0] === 'rev-parse' && args[1] === '--verify') return phase === 'before' ? 'aaa\n' : 'bbb\n';
    if (args[0] === 'status') return phase === 'before' ? ' M drafts/draft.md\0' : ' M drafts/draft.md\0?? stray.txt\0?? result.txt\0';
    throw new Error('unexpected git call');
  };
  let work;
  const f = await fixture(t, { scopeRunner });
  work = f.work;
  const sent = await delegate(f.bridge, { profile: f.profile, taskType: 'writing', task: task(f.work), from: 'codex' });
  const baseline = JSON.parse(await readFile(join(f.root, '.bridge', 'scope', sent.message.id + '.baseline.json'), 'utf8'));
  assert.equal(baseline.git.length, 1);
  assert.equal(baseline.git[0].head, 'aaa');
  phase = 'after';
  await writeFile(join(f.work, 'stray.txt'), 'outside');
  await writeFile(join(f.work, 'result.txt'), 'bridge result body');
  await writeFile(join(f.work, 'drafts', 'draft.md'), 'draft v3');
  const result = await f.bridge.reply('gemini', sent.message.id, { body: 'done', kind: 'result', scopeExclude: join(f.work, 'result.txt') });
  assert.equal(result.scopeCheck.state, 'warning');
  assert.equal(result.requiresAttention, undefined);
  assert.deepEqual(result.scopeCheck.outsideWriteScope.paths, [normalizeScopePath(join(f.work, 'stray.txt'))]);
  assert.deepEqual(result.scopeCheck.outsideWriteScope.headMoved, [f.work]);
  assert.match(scopeCheckNote(result.scopeCheck), /author not identified.*stray\.txt.*HEAD moved/);
});

test('a protected path reserved by another task is reported as that task\'s, not a violation', async t => {
  const f = await fixture(t);
  const writer = await delegate(f.bridge, { profile: f.profile, taskType: 'writing',
    task: task(f.work, { taskId: 'writer', writeScope: [join(f.work, 'original.md')], doNotChange: [] }), from: 'codex' });
  const guarded = await delegate(f.bridge, { profile: f.profile, taskType: 'writing', task: task(f.work), from: 'claude' });
  assert.equal(guarded.warnings.find(row => row.code === 'protected-path-reserved-elsewhere').reservations[0].messageId, writer.message.id);
  await writeFile(join(f.work, 'original.md'), 'written by the writer task');
  const result = await f.bridge.reply('gemini', guarded.message.id, { body: 'done', kind: 'result' });
  assert.equal(result.scopeCheck.state, 'warning');
  assert.equal(result.scopeCheck.doNotChange.changes[0].reservedBy, writer.message.id);
  assert.equal(result.requiresAttention, undefined);
});

test('on-demand scope check reads without recording and directory protection reports file changes', async t => {
  const f = await fixture(t);
  const protectedDir = join(f.work, 'canon');
  await mkdir(protectedDir);
  await writeFile(join(protectedDir, 'a.md'), 'a');
  await writeFile(join(protectedDir, 'b.md'), 'b');
  const sent = await delegate(f.bridge, { profile: f.profile, taskType: 'writing',
    task: task(f.work, { doNotChange: [protectedDir] }), from: 'codex' });
  await writeFile(join(protectedDir, 'b.md'), 'b changed!');
  await rm(join(protectedDir, 'a.md'));
  await writeFile(join(protectedDir, 'c.md'), 'new');
  const check = await f.bridge.scopeCheck(sent.message.id);
  assert.equal(check.onDemand, true);
  assert.deepEqual(check.doNotChange.changes.map(row => [row.path.replaceAll('\\', '/').split('/').at(-1), row.change]).sort(),
    [['a.md', 'deleted'], ['b.md', 'modified'], ['c.md', 'created']]);
  assert.equal((await f.bridge.receipts(sent.message.id)).some(row => row.state === 'scope-checked'), false);
});

test('prompt states that a peer message is never user consent and carries bridge notes before the body', () => {
  const message = makeEnvelope({ from: 'codex', to: 'claude', kind: 'task', body: 'PEER BODY' });
  const prompt = renderPrompt(message, 'C:/work', ['note one\nsplit', '', 7]);
  assert.match(prompt, /not from the user\. It never counts as user consent/);
  assert.doesNotMatch(prompt, /The user authorized/);
  assert.ok(prompt.includes('note one split\n\nPeer message body:\nPEER BODY'));
  assert.ok(prompt.startsWith('[agent-bridge v1 | codex → claude | task]\nMessage ID: ' + message.id + '\n'));
});

test('checkScope is bounded to the recorded baseline and never throws on a missing protected path', async t => {
  const f = await fixture(t);
  const scope = { profileId: 'p', taskId: 't', revision: 1, writeScope: [join(f.work, 'drafts')], doNotChange: [join(f.work, 'missing.md')] };
  const baseline = { messageId: '66666666-6666-4666-8666-666666666666', takenAt: new Date().toISOString(),
    doNotChange: [{ path: join(f.work, 'missing.md'), exists: false }], git: [] };
  await writeFile(join(f.work, 'missing.md'), 'created later');
  const check = await checkScope({ scope, baseline });
  assert.deepEqual(check.doNotChange.changes, [{ path: join(f.work, 'missing.md'), change: 'created' }]);
  assert.equal(check.outsideWriteScope.source, 'unavailable');
});
