import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import net from 'node:net';
import { sendClaude } from '../src/adapters/claude.mjs';
import { predictClaudeHold, effectiveInbound, claudePermissionClass, readClaudeRecipientMode,
  readClaudeInboundSetting } from '../src/claude-inbound.mjs';

test('documented inbound rule: only a dialog-less recipient with a certain hold is predicted', () => {
  const desktop = { entrypoint: 'claude-desktop' };
  assert.equal(predictClaudeHold({ ...desktop, recipientMode: 'bypassPermissions', senderClass: 'prompting' }).reasonCode,
    'claude-desktop-hold-predicted');
  assert.equal(predictClaudeHold({ ...desktop, recipientMode: 'default', senderClass: 'bypass' }).predicted, true);
  assert.equal(predictClaudeHold({ ...desktop, recipientMode: 'bypassPermissions', senderClass: 'bypass' }).predicted, false);
  assert.equal(predictClaudeHold({ ...desktop, recipientMode: 'acceptEdits', senderClass: 'prompting' }).predicted, false);
  assert.equal(predictClaudeHold({ ...desktop, recipientMode: 'plan', senderClass: 'prompting' }).reason, 'recipient-mode-unknown');
  assert.equal(predictClaudeHold({ ...desktop, senderClass: 'prompting' }).reason, 'recipient-mode-unknown');
  assert.equal(predictClaudeHold({ ...desktop, recipientMode: 'bypassPermissions', senderClass: 'prompting', inbound: 'accept' }).predicted, false);
  assert.equal(predictClaudeHold({ ...desktop, recipientMode: 'bypassPermissions', senderClass: 'bypass', inbound: 'hold' }).reasonCode,
    'claude-inbound-hold-by-setting');
  assert.equal(predictClaudeHold({ ...desktop, inbound: 'refuse' }).outcome, 'refused');
  assert.equal(predictClaudeHold({ ...desktop, recipientMode: 'bypassPermissions', inbound: 'unknown' }).predicted, false);
  assert.equal(predictClaudeHold({ entrypoint: 'cli', recipientMode: 'bypassPermissions', senderClass: 'prompting' }).predicted, false,
    'a terminal recipient can approve the held message itself');
  assert.equal(predictClaudeHold({ recipientMode: 'bypassPermissions', senderClass: 'prompting' }).predicted, false);
  assert.equal(claudePermissionClass('dontAsk'), 'prompting');
  assert.equal(claudePermissionClass('bypassPermissions'), 'bypass');
  assert.equal(claudePermissionClass('plan'), null);
});

test('crossSessionInbound precedence follows the settings reference', () => {
  assert.equal(effectiveInbound({}), undefined);
  assert.equal(effectiveInbound({ user: 'accept' }), 'accept');
  assert.equal(effectiveInbound({ user: 'accept', project: 'hold' }), 'hold', 'a stricter project value applies');
  assert.equal(effectiveInbound({ user: 'hold', project: 'accept' }), 'hold');
  assert.equal(effectiveInbound({ project: 'accept' }), undefined, 'a repository cannot force accept');
  assert.equal(effectiveInbound({ local: 'refuse' }), 'refuse');
  assert.equal(effectiveInbound({ managed: 'accept', user: 'refuse' }), 'accept', 'the first trusted value wins');
  assert.equal(effectiveInbound({ managed: 'accept', user: 'sometimes' }), 'hold', 'an unrecognized value holds');
  assert.equal(effectiveInbound({ managed: 'sometimes' }), 'refuse');
});

async function claudeFixture(t, { entrypoint = 'claude-desktop', mode = 'bypassPermissions', projectSetting } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'agent-bridge-inbound-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const sessionId = 'target-' + randomUUID(), project = join(home, 'project');
  const sessionDir = join(home, '.claude', 'sessions'), transcriptDir = join(home, '.claude', 'projects', 'C--project');
  await mkdir(sessionDir, { recursive: true });
  await mkdir(transcriptDir, { recursive: true });
  await mkdir(join(project, '.claude'), { recursive: true });
  if (projectSetting) await writeFile(join(project, '.claude', 'settings.json'), JSON.stringify({ crossSessionInbound: projectSetting }));
  await writeFile(join(transcriptDir, sessionId + '.jsonl'), [
    JSON.stringify({ type: 'user', sessionId, permissionMode: 'default', timestamp: '2026-11-05T00:00:00Z' }),
    JSON.stringify({ type: 'assistant', sessionId, permissionMode: 'default' }),
    JSON.stringify({ type: 'user', sessionId: 'another-session', permissionMode: 'default' }),
    JSON.stringify({ type: 'user', sessionId, permissionMode: mode, timestamp: '2026-11-05T01:00:00Z' }),
    '{"partial":', ''].join('\n'));
  const socketPath = '\\\\.\\pipe\\cc-msg-' + randomUUID().replaceAll('-', '');
  const keyName = process.pid + '.' + createHash('sha256').update(socketPath.toLowerCase()).digest('hex') + '.key';
  await writeFile(join(sessionDir, process.pid + '.json'), JSON.stringify({ pid: process.pid, sessionId, cwd: project,
    peerProtocol: 1, procStart: 'fixture-start', messagingSocketPath: socketPath, ...(entrypoint ? { entrypoint } : {}) }));
  await writeFile(join(sessionDir, keyName), JSON.stringify({ procStart: 'fixture-start', peerToken: 'a'.repeat(32) }));
  let writes = 0;
  const server = net.createServer(socket => { writes++; socket.resume(); });
  await new Promise(resolve => server.listen(socketPath, resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { home, project, target: { sessionId }, writes: () => writes };
}

const message = () => ({ id: randomUUID(), from: 'codex', body: 'PRIVATE BODY' });
const send = (f, senderClass, options = {}) => sendClaude(f.target, 'fixture prompt',
  { home: f.home, agents: { codex: { permissionClass: senderClass } } }, message(), { skipImmediateObservation: true, ...options });

test('recipient mode is the latest exact-session user record of a bounded tail', { skip: process.platform !== 'win32' }, async t => {
  const f = await claudeFixture(t);
  assert.deepEqual(await readClaudeRecipientMode(f.target, { home: f.home }),
    { mode: 'bypassPermissions', recordedAt: '2026-11-05T01:00:00Z' });
  assert.equal(await readClaudeRecipientMode({ sessionId: 'no-such-session' }, { home: f.home }), null);
  assert.equal(await readClaudeInboundSetting(f.home, f.project), undefined);
  await writeFile(join(f.project, '.claude', 'settings.local.json'), '{broken');
  assert.equal(await readClaudeInboundSetting(f.home, f.project), 'unknown');
});

test('a predicted Desktop hold is not submitted and can be resumed after the fix', { skip: process.platform !== 'win32' }, async t => {
  const f = await claudeFixture(t);
  const blocked = await send(f, 'prompting');
  assert.equal(f.writes(), 0);
  assert.equal(blocked.state, 'send-blocked');
  assert.equal(blocked.observation.transportState, 'not-submitted');
  assert.equal(blocked.observation.reasonCode, 'claude-desktop-hold-predicted');
  assert.deepEqual([blocked.observation.evidence.recipientMode, blocked.observation.evidence.senderClass], ['bypassPermissions', 'prompting']);
  assert.equal(JSON.stringify(blocked).includes('PRIVATE BODY'), false);
  const delivered = await send(f, 'bypass');
  assert.equal(delivered.state, 'transport-written');
  assert.equal(f.writes(), 1);
  const overridden = await send(f, 'prompting', { holdGuard: false });
  assert.equal(overridden.state, 'transport-written');
  assert.equal(f.writes(), 2);
});

test('a repository refuse setting blocks even matching classes; a terminal recipient is never blocked', { skip: process.platform !== 'win32' }, async t => {
  const refusing = await claudeFixture(t, { projectSetting: 'refuse' });
  const refused = await send(refusing, 'bypass');
  assert.equal(refused.observation.reasonCode, 'claude-inbound-refused-by-setting');
  assert.equal(refusing.writes(), 0);
  const terminal = await claudeFixture(t, { entrypoint: 'cli' });
  assert.equal((await send(terminal, 'prompting')).state, 'transport-written');
  const unknownEntry = await claudeFixture(t, { entrypoint: null });
  assert.equal((await send(unknownEntry, 'prompting')).state, 'transport-written');
});
