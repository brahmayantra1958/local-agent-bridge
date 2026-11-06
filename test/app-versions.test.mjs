import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBridge } from '../src/index.mjs';
import { APP_VERSIONS_FILE, loadVerifiedAppVersions, recordVerifiedAppVersions, compareAppVersion,
  normalizeAppVersionReading, readWindowsAppVersion, readClaudeVersion, evaluateAppVersionEvidence,
  recipientVersionOf } from '../src/app-versions.mjs';

const verifiedOld = { version: 1, apps: { codex: { version: '26.1013.4894.0' }, claude: { version: '2.1.308' },
  gemini: { version: '2.27.0' } } };

async function tempRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'agent-bridge-versions-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.bridge'));
  return root;
}

async function fixture(t, { recorded = verifiedOld, versionReaders, send } = {}) {
  const root = await tempRoot(t);
  await writeFile(join(root, '.bridge/config.json'), JSON.stringify({ agents: { codex: {}, claude: {}, gemini: {} } }));
  if (recorded) await writeFile(join(root, '.bridge', APP_VERSIONS_FILE), JSON.stringify(recorded));
  const transport = send ?? (async () => ({ state: 'native-accepted', transport: 'test' }));
  const bridge = createBridge({ root, versionReaders,
    adapters: { codex: transport, claude: transport, gemini: transport }, inspectors: {} });
  return { root, bridge };
}

const fixed = values => Object.fromEntries(Object.entries(values)
  .map(([agent, version]) => [agent, async () => ({ version: version(), source: 'test-reader' })]));

test('changed recipient version warns without blocking delivery or raising attention', async t => {
  let sends = 0, reads = 0;
  const { bridge } = await fixture(t, {
    versionReaders: { gemini: async () => { reads++; return { version: '2.29.0', source: 'test-reader' }; } },
    send: async () => { sends++; return { state: 'native-accepted', transport: 'test' }; } });
  const sent = await bridge.send({ from: 'codex', to: 'gemini', body: 'version case' });
  assert.equal(sends, 1);
  assert.equal(reads, 1);
  assert.equal(sent.status.transportState, 'native-accepted');
  assert.equal(sent.status.requiresAttention, false);
  assert.deepEqual(sent.warnings.map(w => [w.code, w.agent, w.state, w.current, w.verified]),
    [['app-version-unverified', 'gemini', 'changed', '2.29.0', '2.27.0']]);
  assert.match(sent.warnings[0].action, /verify --record-versions true/);
  const attempt = (await bridge.receipts(sent.message.id)).find(row => row.state === 'delivery-attempt');
  assert.deepEqual(attempt.recipientApp, { version: '2.29.0', state: 'changed', source: 'test-reader' });
});

test('verified recipient version adds no warning and the reading is reused briefly', async t => {
  let reads = 0;
  const { bridge } = await fixture(t, { recorded: { version: 1, apps: { claude: { version: '2.1.317' } } },
    versionReaders: { claude: async () => { reads++; return { version: '2.1.317' }; } } });
  for (const body of ['first', 'second']) {
    const sent = await bridge.send({ from: 'codex', to: 'claude', body });
    assert.equal(sent.warnings, undefined);
    const attempt = (await bridge.receipts(sent.message.id)).find(row => row.state === 'delivery-attempt');
    assert.equal(attempt.recipientApp.state, 'verified');
  }
  assert.equal(reads, 1);
});

test('failing or malformed readings are unknown and delivery continues', async t => {
  for (const [reader, reason] of [[async () => { throw new Error('PRIVATE reader failure'); }, 'version-read-failed'],
    [async () => ({ version: 'beta-7' }), 'version-format-unrecognized'],
    [async () => ({ reason: 'claude-runtime-unresolved' }), 'claude-runtime-unresolved']]) {
    let sends = 0;
    const { bridge } = await fixture(t, { versionReaders: { claude: reader },
      send: async () => { sends++; return { state: 'transport-written', transport: 'test' }; } });
    const sent = await bridge.send({ from: 'gemini', to: 'claude', body: 'unknown case' });
    assert.equal(sends, 1);
    assert.deepEqual(sent.warnings.map(w => [w.state, w.current, w.reason]), [['unknown', null, reason]]);
    assert.equal(JSON.stringify(sent).includes('PRIVATE'), false);
    const attempt = (await bridge.receipts(sent.message.id)).find(row => row.state === 'delivery-attempt');
    assert.equal(attempt.recipientApp.version, undefined);
    assert.equal(attempt.recipientApp.state, 'unknown');
  }
});

test('versionCheck false and injected transports without readers never inspect apps', async t => {
  let reads = 0;
  const { bridge } = await fixture(t, { versionReaders: { codex: async () => { reads++; return { version: '9.9.9.9' }; } } });
  const skipped = await bridge.send({ from: 'gemini', to: 'codex', body: 'skip' }, { versionCheck: false });
  assert.equal(reads, 0);
  assert.equal(skipped.warnings, undefined);
  assert.equal((await bridge.receipts(skipped.message.id)).find(row => row.state === 'delivery-attempt').recipientApp, undefined);
  const plain = (await fixture(t)).bridge;
  const sent = await plain.send({ from: 'gemini', to: 'codex', body: 'injected transport' });
  assert.equal(sent.warnings, undefined);
  assert.equal((await plain.receipts(sent.message.id)).find(row => row.state === 'delivery-attempt').recipientApp, undefined);
  const report = await plain.appVersions();
  assert.deepEqual(Object.values(report.apps).map(app => [app.state, app.reason]),
    [['unknown', 'version-check-disabled'], ['unknown', 'version-check-disabled'], ['unknown', 'version-check-disabled']]);
});

test('queued delivery and its later flush both carry the version warning', async t => {
  let attempts = 0;
  const { bridge } = await fixture(t, { versionReaders: { codex: async () => ({ version: '26.1029.7803.0' }) },
    send: async () => {
      if (++attempts === 1) throw Object.assign(new Error('closed'), { code: 'CODEX_APP_NOT_RUNNING',
        delivery: { submitted: false, phase: 'preflight', retryable: false } });
      return { state: 'native-accepted', transport: 'test' };
    } });
  const queued = await bridge.send({ from: 'claude', to: 'codex', body: 'queued case' }, { deferErrors: true });
  assert.equal(queued.status.state, 'queued');
  assert.equal(queued.warnings[0].state, 'changed');
  const flushed = await bridge.flush({ to: 'codex' });
  assert.equal(flushed.results.length, 1);
  assert.equal(flushed.results[0].status.transportState, 'native-accepted');
  assert.equal(flushed.results[0].warnings[0].current, '26.1029.7803.0');
  assert.equal(flushed.requiresAttention, false);
});

test('only deliveries recorded at the current version verify an app; recording is per app', async t => {
  const current = { codex: '26.1029.7803.0', claude: '2.1.317', gemini: '2.29.0' };
  const readers = fixed({ codex: () => current.codex, claude: () => current.claude, gemini: () => current.gemini });
  const { root, bridge } = await fixture(t, { versionReaders: readers });
  const deliverReceived = async (from, to, kind = 'ping') => {
    const sent = await bridge.send({ from, to, kind, body: 'PING ' + from + ' to ' + to });
    await bridge.receive(to, sent.message.id);
    return sent.message.id;
  };
  const intoGemini = [await deliverReceived('codex', 'gemini'), await deliverReceived('claude', 'gemini')];
  await deliverReceived('gemini', 'codex', 'task');
  // Transport acceptance without the recipient's receipt is not evidence.
  await bridge.send({ from: 'claude', to: 'codex', body: 'unreceived' });

  const preview = await bridge.verifyAppVersions();
  assert.deepEqual(preview.verifiable, ['gemini']);
  assert.deepEqual(preview.recorded, []);
  assert.equal(preview.apps.gemini.state, 'changed');
  assert.deepEqual(preview.apps.codex.inboundRoutes.map(route => [route.from, route.passed]), [['claude', false], ['gemini', true]]);
  assert.equal(preview.allVerified, false);

  const recorded = await bridge.verifyAppVersions({ record: true });
  assert.deepEqual(recorded.recorded, ['gemini']);
  assert.equal(recorded.apps.gemini.state, 'verified');
  assert.equal(recorded.apps.gemini.verified, '2.29.0');
  assert.equal(recorded.apps.codex.state, 'changed');
  assert.deepEqual(recorded.pending, ['codex', 'claude']);
  const stored = JSON.parse(await readFile(join(root, '.bridge', APP_VERSIONS_FILE), 'utf8'));
  assert.equal(stored.apps.gemini.version, '2.29.0');
  assert.deepEqual(stored.apps.gemini.messageIds.sort(), [...intoGemini].sort());
  assert.equal(stored.apps.codex.version, '26.1013.4894.0', 'unverified apps keep their previous entry');
  assert.equal((await bridge.appVersions()).apps.gemini.state, 'verified');

  // A later update invalidates evidence gathered at the previous version.
  current.gemini = '2.30.0';
  const updated = createBridge({ root, versionReaders: readers, adapters: { gemini: async () => ({ state: 'native-accepted' }) } });
  const after = await updated.verifyAppVersions({ record: true });
  assert.equal(after.apps.gemini.state, 'changed');
  assert.equal(after.apps.gemini.verified, '2.29.0');
  assert.deepEqual(after.recorded, []);
});

test('baseline prefers the recorded state, falls back to documented verification, and reports damage', async t => {
  const root = await tempRoot(t);
  const documentedPath = join(root, 'verification.json');
  await writeFile(documentedPath, JSON.stringify({ generatedAt: '2026-10-28T00:35:24.243Z',
    environment: { codexDesktop: '26.1013.4894.0', claudeCode: '2.1.308', antigravity: 'not-a-version' } }));
  const documented = await loadVerifiedAppVersions(root, { documentedPath });
  assert.equal(documented.source, 'documented-verification');
  assert.deepEqual(documented.apps, { codex: { version: '26.1013.4894.0', verifiedAt: '2026-10-28T00:35:24.243Z' },
    claude: { version: '2.1.308', verifiedAt: '2026-10-28T00:35:24.243Z' } });
  assert.deepEqual(await loadVerifiedAppVersions(root, { documentedPath: join(root, 'missing.json') }), { source: 'none', apps: {} });

  const saved = await recordVerifiedAppVersions(root, [{ agent: 'gemini', version: '2.29.0', source: 'antigravity-executable',
    messageIds: ['8b91c340-263c-4832-bb98-b040a59e81fd', 'not-an-id'] }], { documentedPath });
  assert.equal(saved.apps.codex.version, '26.1013.4894.0');
  assert.deepEqual(saved.apps.gemini.messageIds, ['8b91c340-263c-4832-bb98-b040a59e81fd']);
  const loaded = await loadVerifiedAppVersions(root, { documentedPath });
  assert.equal(loaded.source, 'recorded');
  assert.equal(loaded.apps.gemini.version, '2.29.0');
  await assert.rejects(recordVerifiedAppVersions(root, [{ agent: 'gemini', version: '2.29;rm' }]), /Invalid verified app version/);
  await assert.rejects(recordVerifiedAppVersions(root, [{ agent: 'other', version: '1.0.0' }]), /Invalid verified app version/);

  for (const damaged of ['{not json', JSON.stringify({ version: 2, apps: {} }), JSON.stringify({ version: 1 })]) {
    await writeFile(join(root, '.bridge', APP_VERSIONS_FILE), damaged);
    assert.deepEqual(await loadVerifiedAppVersions(root, { documentedPath }), { source: 'invalid', apps: {} });
  }
});

test('comparison states and reading normalization', () => {
  const reading = version => normalizeAppVersionReading('gemini', { version, source: 'test-reader' });
  assert.equal(compareAppVersion(reading('2.29.0'), { version: '2.29.0' }).state, 'verified');
  assert.equal(compareAppVersion(reading('2.29.0'), { version: '2.27.0' }).state, 'changed');
  assert.equal(compareAppVersion(reading('2.29.0'), undefined).state, 'unverified');
  assert.equal(compareAppVersion(reading(undefined), { version: '2.27.0' }).state, 'unknown');
  assert.deepEqual(normalizeAppVersionReading('codex', { version: ' 26.1029.7803.0 ', source: 'Bad Source!' }),
    { agent: 'codex', version: '26.1029.7803.0', source: 'appx-package' });
  assert.equal(normalizeAppVersionReading('codex', { version: '26.1029.7803.0.1' }).reason, 'version-format-unrecognized');
  assert.equal(normalizeAppVersionReading('codex', { reason: 'Free text with spaces' }).reason, 'version-unavailable');
  assert.throws(() => normalizeAppVersionReading('other', {}), /Unknown agent/);
});

test('Windows reader parses one PowerShell JSON array and quotes the install path', async () => {
  const scripts = [];
  const run = output => async script => { scripts.push(script); if (output instanceof Error) throw output; return output; };
  assert.deepEqual(await readWindowsAppVersion('codex', {}, { runPowerShell: run('["26.1029.7803.0"]'), platform: 'win32' }),
    { agent: 'codex', version: '26.1029.7803.0', source: 'appx-package' });
  assert.match(scripts.at(-1), /Get-AppxPackage -Name 'OpenAI\.Codex'/);
  assert.equal((await readWindowsAppVersion('codex', {}, { runPowerShell: run('["1.0.0.0","2.0.0.0"]'), platform: 'win32' })).reason,
    'app-version-ambiguous');
  assert.equal((await readWindowsAppVersion('gemini', { home: "C:\\Users\\O'Brien" },
    { runPowerShell: run('[]'), platform: 'win32' })).reason, 'app-not-installed');
  assert.ok(scripts.at(-1).includes("'C:\\Users\\O''Brien\\AppData\\Local\\Programs\\antigravity\\Antigravity.exe'"));
  assert.equal((await readWindowsAppVersion('gemini', {}, { runPowerShell: run('"2.29.0"'), platform: 'win32' })).version, '2.29.0');
  for (const output of ['not json', '', new Error('PowerShell failed')]) {
    assert.equal((await readWindowsAppVersion('gemini', {}, { runPowerShell: run(output), platform: 'win32' })).reason,
      'version-read-failed');
  }
  const before = scripts.length;
  assert.equal((await readWindowsAppVersion('codex', {}, { runPowerShell: run('[]'), platform: 'linux' })).reason,
    'platform-unsupported');
  assert.equal(scripts.length, before);
  await assert.rejects(readWindowsAppVersion('claude', {}, { runPowerShell: run('[]') }), /supports codex and gemini/);
});

test('Claude reader follows runtime identity resolution and reads only the version', async () => {
  const host = 'local_116b44ac-33ee-43e8-aaf6-417f6c5a1f8d';
  const sessions = [{ sessionId: 'replacement-runtime', hostSessionId: host, version: '2.1.317', peerToken: 'PRIVATE' }];
  const discover = async () => sessions;
  assert.deepEqual(await readClaudeVersion({ sessionId: 'old-runtime', hostSessionId: host }, {}, { discover }),
    { agent: 'claude', version: '2.1.317', source: 'claude-runtime-discovery' });
  assert.equal((await readClaudeVersion({ sessionId: 'other' }, {}, { discover })).reason, 'claude-runtime-unresolved');
  assert.equal((await readClaudeVersion({ sessionId: 'replacement-runtime' }, {},
    { discover: async () => [{ sessionId: 'replacement-runtime' }] })).reason, 'version-unavailable');
  assert.equal((await readClaudeVersion({ sessionId: 'x' }, {}, { discover: async () => { throw new Error('denied'); } })).reason,
    'claude-session-store-unavailable');
});

test('evidence uses the version of the attempt that was actually accepted', () => {
  const message = (receipts, extra = {}) => ({ id: '8b91c340-263c-4832-bb98-b040a59e81fd', from: 'codex', to: 'gemini', receipts, ...extra });
  const attempt = (id, version) => ({ state: 'delivery-attempt', attemptId: id, ...(version ? { recipientApp: { version } } : {}) });
  const accepted = id => ({ state: 'native-accepted', agent: 'codex', attemptId: id });
  const received = { state: 'received', agent: 'gemini' };
  assert.equal(recipientVersionOf(message([attempt('a', '2.29.0'), { state: 'delivery-error', attemptId: 'a' },
    attempt('b', '2.30.0'), accepted('b'), received])), '2.30.0');
  assert.equal(recipientVersionOf(message([attempt('a'), accepted('a'), received])), null, 'legacy attempt');
  assert.equal(recipientVersionOf(message([attempt('a', '2.29.0'), received])), null, 'never accepted');
  const evidence = evaluateAppVersionEvidence([message([attempt('b', '2.30.0'), accepted('b'), received])],
    { gemini: '2.30.0', codex: null, claude: '2.1.317' });
  assert.deepEqual(evidence.gemini.routes.map(route => [route.from, route.passed]), [['codex', true], ['claude', false]]);
  assert.equal(evidence.gemini.passed, false);
  assert.equal(evidence.codex.passed, false);
});
