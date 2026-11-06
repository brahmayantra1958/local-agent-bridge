import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createBridge } from '../src/index.mjs';
import { withEndpointLock, transportFailure, recipientFingerprint, transportEndpointKey } from '../src/transport-runtime.mjs';
import { pipeRequest } from '../src/runtime.mjs';

const runtimeUrl = new URL('../src/transport-runtime.mjs', import.meta.url).href;
const bridgeUrl = new URL('../src/index.mjs', import.meta.url).href;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fixture(t, send, inspect) {
  const root = await mkdtemp(join(tmpdir(), 'agent-bridge-transport-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.bridge'));
  const settings = { home: root, agents: { codex: {}, claude: { sessionId: randomUUID() }, gemini: {} } };
  await writeFile(join(root, '.bridge/config.json'), JSON.stringify(settings));
  return { root, settings, bridge: createBridge({ root, adapters: { claude: send }, inspectors: { claude: inspect } }) };
}

function knownUnsent(code = 'ECONNREFUSED') {
  const error = new Error('SECRET-RAW-TRANSPORT-TEXT');
  error.code = code;
  error.delivery = { submitted: false, phase: 'connect', retryable: true };
  return error;
}

test('safe connect failures retry a bounded number with one unchanged message ID', async t => {
  const ids = [];
  const f = await fixture(t, async (target, prompt, config, message) => {
    ids.push(message.id);
    if (ids.length < 3) throw knownUnsent();
    return { state: 'transport-written', transport: 'fixture' };
  });
  const sent = await f.bridge.send({ from: 'codex', to: 'claude', body: 'same request' }, { retryDelayMs: 0 });
  assert.deepEqual(ids, [sent.message.id, sent.message.id, sent.message.id]);
  assert.equal(sent.status.transportState, 'transport-written');
  const receipts = await f.bridge.receipts(sent.message.id);
  assert.equal(receipts.filter(row => row.state === 'delivery-attempt').length, 3);
  assert.equal(JSON.stringify(receipts).includes('SECRET-RAW'), false);
});

test('resume after exhausted known-unsent attempts uses original envelope, not duplicate send', async t => {
  let calls = 0, ready = false;
  const f = await fixture(t, async () => {
    calls++;
    if (!ready) throw knownUnsent();
    return { state: 'transport-written', transport: 'fixture' };
  });
  const input = { id: randomUUID(), from: 'codex', to: 'claude', body: 'continue request' };
  await assert.rejects(() => f.bridge.send(input, { maxAttempts: 2, retryDelayMs: 0 }), /nothing submitted/);
  assert.equal(calls, 2);
  assert.equal((await f.bridge.send(input)).duplicate, true);
  ready = true;
  const resumed = await f.bridge.resume(input.id, { retryDelayMs: 0 });
  assert.equal(resumed.message.id, input.id);
  assert.equal(resumed.resumed, true);
  assert.equal(calls, 3);
  assert.equal((await f.bridge.resume(input.id)).reason, 'delivery-already-submitted');
  assert.equal(calls, 3);
});

test('concurrent resumes acquire the same endpoint once and only one submits', async t => {
  let ready = false, calls = 0;
  const f = await fixture(t, async () => {
    calls++;
    if (!ready) throw knownUnsent();
    await sleep(20);
    return { state: 'native-accepted', transport: 'fixture' };
  });
  const input = { id: randomUUID(), from: 'codex', to: 'claude', body: 'one request' };
  await assert.rejects(() => f.bridge.send(input, { maxAttempts: 1 }), /nothing submitted/);
  ready = true;
  const results = await Promise.all([f.bridge.resume(input.id), f.bridge.resume(input.id)]);
  assert.equal(results.filter(result => result.resumed === true).length, 1);
  assert.equal(results.filter(result => result.reason === 'delivery-already-submitted').length, 1);
  assert.equal(calls, 2);
});

test('ECONNREFUSED text/code without pre-submit evidence and crash-in-flight are never resent', async t => {
  let calls = 0, inspections = 0;
  const f = await fixture(t, async () => { calls++; throw Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }); },
    async () => { inspections++; return { state: 'delivery-unconfirmed', executionState: 'unknown' }; });
  const input = { id: randomUUID(), from: 'codex', to: 'claude', body: 'uncertain request' };
  await assert.rejects(() => f.bridge.send(input), /uncertain/);
  const result = await f.bridge.resume(input.id);
  assert.equal(result.resumed, false);
  assert.equal(result.reason, 'delivery-uncertain');
  assert.equal(result.status.requiresAttention, true);
  assert.equal(calls, 1);
  assert.equal(inspections, 1);
  const second = { ...input, id: randomUUID(), createdAt: new Date().toISOString(), version: 1,
    kind: 'task', replyTo: null };
  second.correlationId = second.id;
  await writeFile(join(f.root, '.bridge/messages', second.id + '.json'), JSON.stringify(second));
  await writeFile(join(f.root, '.bridge/receipts', randomUUID() + '.json'), JSON.stringify({
    messageId: second.id, state: 'delivery-attempt', attemptId: randomUUID(), attemptNumber: 1,
    createdAt: new Date().toISOString(), recipientFingerprint: recipientFingerprint('claude', f.settings.agents.claude, f.settings) }));
  assert.equal((await f.bridge.resume(second.id)).reason, 'delivery-uncertain');
  assert.equal(calls, 1);
});

test('explicit resume resolves a preflight block and retains the pinned recipient after settings change', async t => {
  let calls = 0;
  const f = await fixture(t, async () => ++calls === 1
    ? { state: 'send-blocked', transport: 'fixture', observation: { state: 'send-blocked', executionState: 'not-started' } }
    : { state: 'native-accepted', transport: 'fixture' });
  const sent = await f.bridge.send({ from: 'codex', to: 'claude', body: 'blocked' });
  assert.equal(sent.status.requiresAttention, true);
  const resumed = await f.bridge.resume(sent.message.id);
  assert.equal(resumed.status.requiresAttention, false);
  assert.equal(resumed.status.transportState, 'native-accepted');
  assert.notEqual(resumed.status.state, 'send-blocked');
  f.settings.agents.claude.sessionId = randomUUID();
  await writeFile(join(f.root, '.bridge/config.json'), JSON.stringify(f.settings));
  const changed = await f.bridge.resume(sent.message.id);
  assert.equal(changed.reason, 'delivery-already-submitted');
  assert.equal(changed.status.requiresAttention, false);
  assert.equal(calls, 2);
});

test('a live endpoint owner is never evicted and a lock timeout remains resumable', async t => {
  let calls = 0, releaseOwner;
  const f = await fixture(t, async () => { calls++; return { state: 'native-accepted', transport: 'fixture' }; });
  let signalAcquired;
  const acquired = new Promise(resolve => { signalAcquired = resolve; });
  const owner = withEndpointLock(transportEndpointKey('claude', f.settings.agents.claude, f.settings), async () => {
    signalAcquired();
    await new Promise(resolve => { releaseOwner = resolve; });
  });
  await acquired;
  const input = { id: randomUUID(), from: 'codex', to: 'claude', body: 'queued' };
  try {
    await assert.rejects(() => f.bridge.send(input, { lockTimeoutMs: 25 }), /nothing submitted/);
    assert.equal(calls, 0);
  } finally { releaseOwner(); await owner; }
  assert.equal((await f.bridge.resume(input.id)).resumed, true);
  assert.equal(calls, 1);
});

test('native pipe errors identify the connect boundary without leaking the endpoint', async () => {
  const path = process.platform === 'win32' ? '\\\\.\\pipe\\missing-' + randomUUID() : '\0missing-' + randomUUID();
  let failure;
  try { await pipeRequest(path, 'fixture', {}, { timeoutMs: 100 }); }
  catch (error) { failure = transportFailure(error); }
  assert.equal(failure.retrySafe, true);
  assert.equal(failure.retryable, true);
  assert.equal(failure.phase, 'connect');
  assert.equal(JSON.stringify(failure).includes(path), false);
});

async function workerFile(root, source) {
  const file = join(root, randomUUID() + '.mjs');
  await writeFile(file, source);
  return file;
}

function runWorker(file, args = []) {
  const child = spawn(process.execPath, [file, ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', value => { stdout += value; });
  child.stderr.setEncoding('utf8').on('data', value => { stderr += value; });
  const done = once(child, 'close').then(([code, signal]) => ({ code, signal, stdout, stderr }));
  return { child, done };
}

test('separate processes and workspaces serialize one endpoint while independent endpoints stay parallel', async t => {
  const f = await fixture(t, async () => {});
  const log = join(f.root, 'operations.jsonl');
  const worker = await workerFile(f.root, `
    import { createBridge } from ${JSON.stringify(bridgeUrl)};
    import { appendFile } from 'node:fs/promises';
    const [root,log,id]=process.argv.slice(2);
    const bridge=createBridge({root,adapters:{claude:async()=>{
      await appendFile(log,JSON.stringify({id,event:'start'})+'\\n');
      await new Promise(r=>setTimeout(r,60));
      await appendFile(log,JSON.stringify({id,event:'end'})+'\\n');
      return {state:'native-accepted',transport:'fixture'};
    }}});
    await bridge.send({from:'codex',to:'claude',body:id});
  `);
  const roots = await Promise.all(['a', 'b', 'c'].map(async id => {
    const root = join(f.root, id);
    await mkdir(join(root, '.bridge'), { recursive: true });
    await writeFile(join(root, '.bridge/config.json'), JSON.stringify(f.settings));
    return { id, root };
  }));
  const jobs = roots.map(({ id, root }) => runWorker(worker, [root, log, id]));
  const results = await Promise.all(jobs.map(job => job.done));
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  const rows = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 6);
  for (let i = 0; i < rows.length; i += 2) {
    assert.equal(rows[i].event, 'start');
    assert.equal(rows[i + 1].event, 'end');
    assert.equal(rows[i].id, rows[i + 1].id);
  }
  const active = new Set();
  let overlap = false;
  await Promise.all(['endpoint-a-' + randomUUID(), 'endpoint-b-' + randomUUID()].map(key =>
    withEndpointLock(key, async () => { active.add(key); if (active.size === 2) overlap = true; await sleep(25); active.delete(key); })));
  assert.equal(overlap, true);
});

test('process death releases its native mutex without a stale timeout or helper process', async t => {
  const f = await fixture(t, async () => {});
  const key = randomUUID();
  const worker = await workerFile(f.root, `
    import { withEndpointLock } from ${JSON.stringify(runtimeUrl)};
    await withEndpointLock(process.argv[2],async()=>{
      process.stdout.write('LOCKED\\n');
      await new Promise(()=>{});
    });
  `);
  const job = runWorker(worker, [key]);
  t.after(() => { if (job.child.exitCode === null) job.child.kill(); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Fixture mutex did not start')), 3000);
    job.child.stdout.on('data', value => { if (value.includes('LOCKED')) { clearTimeout(timer); resolve(); } });
    job.child.once('error', reject);
  });
  const waiting = withEndpointLock(key, async () => 'acquired after exit', { lockTimeoutMs: 3000 });
  job.child.kill();
  await job.done;
  assert.equal(await waiting, 'acquired after exit');
});

test('invalid retry/lock policies fail before persisting a request', async t => {
  const f = await fixture(t, async () => {});
  for (const options of [{ maxAttempts: 0 }, { maxAttempts: 100 }, { retryDelayMs: -1 }, { lockTimeoutMs: 0 }]) {
    await assert.rejects(() => f.bridge.send({ from: 'codex', to: 'claude', body: 'no write' }, options), /Invalid transport option/);
  }
  assert.equal((await f.bridge.status()).messages.length, 0);
});
