import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { inspectClaudeHost } from '../src/claude-host.mjs';

const cliId = 'ba8c2e09-b773-4767-9d26-b9720a1430e8';
const target = { hostSessionId: 'local_' + cliId, sessionId: cliId };

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'bridge-claude-host-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const base = join(home, 'AppData', 'Roaming', 'Claude', 'claude-code-sessions');
  const account = randomUUID(), organization = randomUUID();
  const folder = join(base, account, organization);
  await mkdir(folder, { recursive: true });
  const desktop = { ProcessId: 123, ExecutablePath: join(home, 'AppData', 'Local', 'AnthropicClaude', 'app-4.16336.0', 'claude.exe') };
  const options = { sessions: [], readDesktopProcesses: async () => [desktop] };
  const metadata = { sessionId: target.hostSessionId, cliSessionId: cliId, cwd: 'secret-project-path',
    isArchived: false, title: 'secret-title', remoteMcpServersConfig: { token: 'secret-value' } };
  const path = join(folder, target.hostSessionId + '.json');
  const save = async (value = metadata, selectedPath = path) => writeFile(selectedPath, JSON.stringify(value));
  const inspect = (overrides = {}, selectedTarget = target) => inspectClaudeHost(selectedTarget, { home }, { ...options, ...overrides });
  return { home, base, folder, path, metadata, desktop, save, inspect, options };
}

test('Desktop running, saved chat and absent runtime are distinct; diagnostic never returns private metadata', async t => {
  const f = await fixture(t); await f.save();
  const before = await readFile(f.path);
  const result = await f.inspect();
  assert.deepEqual(result, { appState: 'running', conversationState: 'stored', runtimeState: 'absent',
    hostSessionId: target.hostSessionId, wake: { supported: false, reason: 'desktop-no-supported-unattended-runtime-wake' } });
  assert.equal(JSON.stringify(result).includes('secret'), false);
  assert.equal(JSON.stringify(result).includes(f.home), false);
  assert.deepEqual(await readFile(f.path), before);
});

test('unique same-host runtime replacement is running; multiple runtimes stay ambiguous even with exact ID', async t => {
  const f = await fixture(t); await f.save();
  const nextId = randomUUID();
  const live = { sessionId: nextId, hostSessionId: target.hostSessionId, peerToken: 'do-not-expose' };
  const current = await f.inspect({ sessions: [live] });
  assert.equal(current.runtimeState, 'running'); assert.equal(current.sessionId, nextId);
  assert.equal(JSON.stringify(current).includes('peerToken'), false);
  const ambiguous = await f.inspect({ sessions: [live, { ...live, sessionId: cliId }] });
  assert.equal(ambiguous.runtimeState, 'ambiguous'); assert.equal(ambiguous.sessionId, undefined);
  const wrong = await f.inspect({ sessions: [{ sessionId: cliId, hostSessionId: 'local_' + randomUUID() }] });
  assert.equal(wrong.runtimeState, 'unknown');
  const conflicting = await f.inspect({ sessions: [live, { sessionId: cliId, hostSessionId: 'local_' + randomUUID() }] });
  assert.equal(conflicting.runtimeState, 'unknown');
});

test('embedded CLI process alone is not Desktop; inaccessible and unfamiliar executable paths remain unknown', async t => {
  const f = await fixture(t);
  const embedded = { ProcessId: 123, ExecutablePath: join(f.home, 'AppData', 'Roaming', 'Claude', 'claude-code', '2.1.317', 'hash', 'claude.exe') };
  assert.equal((await f.inspect({ readDesktopProcesses: async () => [embedded] })).appState, 'not-running');
  assert.equal((await f.inspect({ readDesktopProcesses: async () => [] })).appState, 'not-running');
  assert.equal((await f.inspect({ readDesktopProcesses: async () => [{ ProcessId: 123, ExecutablePath: null }] })).appState, 'unknown');
  assert.equal((await f.inspect({ readDesktopProcesses: async () => [{ ProcessId: 123, ExecutablePath: 'C:/WindowsApps/Claude/claude.exe' }] })).appState, 'unknown');
  assert.equal((await f.inspect({ readDesktopProcesses: async () => { throw new Error('secret process error'); } })).appState, 'unknown');
});

test('missing, archived and duplicate saved conversations are distinguished without selecting an account', async t => {
  const f = await fixture(t);
  assert.equal((await f.inspect()).conversationState, 'missing');
  await f.save({ ...f.metadata, isArchived: true });
  assert.equal((await f.inspect()).conversationState, 'archived');
  const other = join(f.base, randomUUID(), randomUUID());
  await mkdir(other, { recursive: true });
  await f.save(f.metadata, join(other, target.hostSessionId + '.json'));
  assert.equal((await f.inspect()).conversationState, 'ambiguous');
});

test('filename is insufficient identity evidence; invalid and oversized metadata are unknown', async t => {
  const f = await fixture(t);
  await f.save({ ...f.metadata, sessionId: 'local_' + randomUUID() });
  assert.equal((await f.inspect()).conversationState, 'unknown');
  await f.save({ ...f.metadata, cliSessionId: '../not-a-session' });
  assert.equal((await f.inspect()).conversationState, 'unknown');
  await f.save();
  assert.equal((await f.inspect({ maxMetadataBytes: 32 })).conversationState, 'unknown');
  await writeFile(f.path, '{');
  assert.equal((await f.inspect()).conversationState, 'unknown');
});

test('bounded account and organization scans never turn incomplete discovery into missing or unique', async t => {
  const f = await fixture(t); await f.save();
  await mkdir(join(f.base, randomUUID(), randomUUID()), { recursive: true });
  assert.equal((await f.inspect({ maxAccounts: 1 })).conversationState, 'unknown');
  assert.equal((await f.inspect({ maxOrganizations: 1 })).conversationState, 'unknown');
  await assert.rejects(() => f.inspect({ maxAccounts: 0 }), /limit/);
});

test('only native local host identities select Desktop files; unsafe path identities fail before inspection', async t => {
  const f = await fixture(t); await f.save();
  assert.equal((await f.inspect({}, { sessionId: cliId })).conversationState, 'unknown');
  assert.equal((await f.inspect({}, { hostSessionId: 'ssh_' + cliId })).conversationState, 'unknown');
  let called = false;
  await assert.rejects(() => f.inspect({ readDesktopProcesses: async () => { called = true; return []; } },
    { hostSessionId: '../escape' }), /Invalid session identity/);
  assert.equal(called, false);
});

test('default runtime discovery uses live PID records, ignores credentials and reports unreadable inventory honestly', async t => {
  const f = await fixture(t), sessions = join(f.home, '.claude', 'sessions');
  await mkdir(sessions, { recursive: true });
  await writeFile(join(sessions, process.pid + '.json'), JSON.stringify({ pid: process.pid,
    sessionId: cliId, hostSessionId: target.hostSessionId }));
  await writeFile(join(sessions, 'do-not-read.key'), 'secret credentials');
  assert.equal((await f.inspect({ sessions: undefined })).runtimeState, 'running');
  await writeFile(join(sessions, process.pid + '.json'), '{');
  assert.equal((await f.inspect({ sessions: undefined })).runtimeState, 'unknown');
});
