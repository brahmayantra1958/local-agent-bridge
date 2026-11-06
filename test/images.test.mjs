import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { selectImageRoute, createImageTask, dispatchImageTask, recordImageResult } from '../src/images.mjs';

test('image routing respects explicit requests and compound constraints, not image count', () => {
  assert.equal(selectImageRoute({ count: 20 }).route, 'codex-imagegen');
  assert.equal(selectImageRoute({ count: 1, constraints: { identityPreservation: true } }).route, 'chatgpt-pro-web');
  assert.equal(selectImageRoute({ route: 'codex-imagegen', constraints: { sceneContinuity: true } }).route, 'codex-imagegen');
  assert.throws(() => selectImageRoute({ constraints: { identityPreservation: 'yes' } }), /constraint/);
  assert.throws(() => selectImageRoute({ route: 'paid-api' }), /Unsupported/);
});

test('remote image work has a stable ID and carries required tool/skill instructions', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-images-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sent = [], bridge = { root, send: async message => { sent.push(message); return { message }; } };
  const request = { taskId: 'three-views', prompt: 'Same library robot in three views', projectRoot: root,
    constraints: { identityPreservation: true } };
  await dispatchImageTask(bridge, { from: 'codex', request, webSkillPath: join(root, 'SKILL.md') });
  await dispatchImageTask(bridge, { from: 'codex', request, webSkillPath: join(root, 'SKILL.md') });
  assert.equal(sent[0].id, sent[1].id);
  const task = JSON.parse(sent[0].body);
  assert.equal(sent[0].to, 'claude');
  assert.match(task.execution, /Pro mode/);
  assert.equal(task.skillPath, join(root, 'SKILL.md'));
  assert.match(task.promptSha256, /^[a-f0-9]{64}$/);
});

test('remote image outcomes retain blocked, failed, uncertain and duplicate transport state', async () => {
  for (const state of ['send-blocked', 'execution-failed', 'delivery-unconfirmed', 'recipient-observed']) {
    for (const duplicate of [false, true]) {
      const status = { state, transportState: state === 'send-blocked' ? 'not-submitted' : 'native-accepted',
        requiresAttention: ['send-blocked', 'execution-failed'].includes(state) };
      const result = await dispatchImageTask({ send: async () => ({ status, duplicate }) }, {
        from: 'claude', request: { taskId: 'remote-result', prompt: 'A book', projectRoot: tmpdir() },
      });
      assert.equal(result.state, state);
      assert.deepEqual(result.status, status);
      assert.equal(result.duplicate, duplicate);
    }
  }
});

test('local tool callback runs once and missing tools yield an honest execution contract', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-images-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bridge = { root }, request = { taskId: 'icon', prompt: 'A blue book', projectRoot: root };
  const pending = await dispatchImageTask(bridge, { from: 'codex', request });
  assert.equal(pending.state, 'local-execution-required');
  let runs = 0;
  const handlers = { 'codex-imagegen': async () => { runs++; return { artifacts: [{ nativeRef: 'tool-output:123' }] }; } };
  const first = await dispatchImageTask(bridge, { from: 'codex', request, handlers });
  const second = await dispatchImageTask(bridge, { from: 'codex', request, handlers });
  assert.equal(first.state, 'completed');
  assert.equal(second.state, 'already-completed');
  assert.equal(runs, 1);
  assert.equal(first.result.artifacts[0].sha256, null);
  await assert.rejects(dispatchImageTask(bridge, { from: 'codex', request: { ...request, prompt: 'changed' }, handlers }), /identity/);
});

test('ambiguous tool failures never silently generate again', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-images-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const request = { taskId: 'uncertain', prompt: 'A book', projectRoot: root }, bridge = { root };
  let runs = 0;
  const handlers = { 'codex-imagegen': async () => { runs++; throw new Error('Connection lost after submit'); } };
  await assert.rejects(dispatchImageTask(bridge, { from: 'codex', request, handlers }), /Connection lost/);
  const second = await dispatchImageTask(bridge, { from: 'codex', request, handlers });
  assert.equal(second.state, 'execution-uncertain');
  assert.equal(runs, 1);
});

test('result proof calculates real hashes and requires Pro observations for the web route', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-images-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const task = createImageTask({ taskId: 'web', prompt: 'A book', route: 'chatgpt-pro-web', projectRoot: root }, { webSkillPath: join(root, 'SKILL.md') });
  const path = join(root, 'fixture.png'), logPath = join(root, 'chatgpt-log.jsonl');
  const bytes = Buffer.alloc(33);
  Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes); bytes.writeUInt32BE(13,8); bytes.write('IHDR',12);
  bytes.writeUInt32BE(100,16); bytes.writeUInt32BE(80,20);
  await writeFile(path, bytes); await writeFile(logPath, '{}\n');
  const result = { artifacts: [{ path }], conversationUrl: 'https://chatgpt.com/c/1111-2222', logPath, modelObserved: 'Pro', imageModeObserved: true };
  const proof = await recordImageResult(task, result);
  assert.equal(proof.artifacts[0].width, 100);
  assert.equal(proof.artifacts[0].height, 80);
  assert.equal(proof.artifacts[0].validation, 'raster-header-only');
  assert.match(proof.artifacts[0].sha256, /^[a-f0-9]{64}$/);
  await assert.rejects(recordImageResult(task, { ...result, modelObserved: 'Medium' }), /observed Pro/);
  await assert.rejects(recordImageResult(task, { ...result, artifacts: [{ path: join(root, 'missing.png') }] }), /ENOENT/);
});

test('a text file or malformed PNG cannot complete an image task even with a claimed MIME', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-images-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const task = createImageTask({ taskId: 'bad-output', prompt: 'A book', projectRoot: root });
  const path = join(root, 'output.png');
  await writeFile(path, 'This is a text response, not a generated image.');
  const result = { artifacts: [{ path, mime: 'image/png' }] };
  await assert.rejects(recordImageResult(task, result), /raster header/);
  const malformed = Buffer.alloc(33);
  Buffer.from([137,80,78,71,13,10,26,10]).copy(malformed);
  await writeFile(path, malformed);
  await assert.rejects(recordImageResult(task, result), /raster header/);
  const dispatched = dispatchImageTask({ root }, { from: 'codex', request: {
    taskId: 'callback-bad-output', prompt: 'A book', projectRoot: root,
  }, handlers: { 'codex-imagegen': async () => result } });
  await assert.rejects(dispatched, /raster header/);
});

test('GIF, JPEG and WebP evidence uses detected raster types rather than caller MIME', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-images-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const gif = Buffer.alloc(10); gif.write('GIF89a'); gif.writeUInt16LE(1,6); gif.writeUInt16LE(2,8);
  const webp = Buffer.alloc(20); webp.write('RIFF'); webp.writeUInt32LE(12,4); webp.write('WEBPVP8 ',8);
  for (const [mime, bytes] of [['image/gif', gif], ['image/jpeg', Buffer.from([255,216,255,224])], ['image/webp', webp]]) {
    const path = join(root, 'output'); await writeFile(path, bytes);
    const result = await recordImageResult({ route: 'codex-imagegen' }, { artifacts: [{ path, mime: 'text/plain' }] });
    assert.equal(result.artifacts[0].mime, mime);
    assert.equal(result.artifacts[0].validation, 'raster-header-only');
  }
});
