import { readFile, writeFile, rename, mkdir, readdir, stat, open, copyFile, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { AGENTS, assertAgent, bridgeCliCommand } from './protocol.mjs';
import { withEndpointLock } from './transport-runtime.mjs';
import { discoverClaude } from './adapters/claude.mjs';
import { antigravityRpc, discoverAntigravity } from './adapters/antigravity.mjs';
import { readClaudeRecipientMode, claudePermissionClass } from './claude-inbound.mjs';
import { loadRoutingProfile, routingProfileForApps, stateRoutingProfilePath, DEFAULT_ROUTING_PROFILE } from './routing.mjs';
import { delegationMessageId } from './delegation.mjs';

// `join` registers the chat it is run from, so nobody copies chat IDs by hand.
// Claude publishes its session to tool commands; Codex and Antigravity are found
// by a one-time code that appears in the chat's own command history. Only local
// metadata is read; no message is sent and no app setting is changed.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HOST = /^local_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE = /^ab-join-[a-f0-9]{16}$/;
const RECENT_MS = 30 * 60 * 1000, PENDING_MS = 15 * 60 * 1000;
const EAGER = 'CASCADE_COMMANDS_AUTO_EXECUTION_EAGER';
const GENERATED_BY = 'agent-bridge-join';

const joinError = (code, message) => Object.assign(new Error(message), { code });
const configPath = root => join(root, '.bridge', 'config.json');

async function readJsonFile(path, fallback) {
  try { return JSON.parse((await readFile(path, 'utf8')).replace(/^﻿/, '')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

async function replaceJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temp = path + '.' + randomUUID() + '.tmp';
  await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  try { await rename(temp, path); } catch (error) { await unlink(temp).catch(() => {}); throw error; }
}

async function readSlice(path, fromEnd, maxBytes) {
  const handle = await open(path, 'r');
  try {
    const { size } = await handle.stat(), length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, fromEnd ? size - length : 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally { await handle.close(); }
}

async function recentFiles(directory, match, since, depth, limit) {
  const found = [];
  async function walk(current, level) {
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) { if (level < depth) await walk(path, level + 1); continue; }
      if (!entry.isFile() || !match(entry.name)) continue;
      const info = await stat(path).catch(() => null);
      if (info && info.mtimeMs >= since) found.push({ path, mtimeMs: info.mtimeMs });
    }
  }
  await walk(directory, 0);
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit);
}

/** Claude Code exposes its own session to commands it runs. */
export async function identifyClaudeChat({ env = process.env, home = homedir(), discover = discoverClaude } = {}) {
  const sessionId = env.CLAUDE_CODE_SESSION_ID, hostSessionId = env.CLAUDE_CODE_HOST_SESSION_ID;
  if (!UUID.test(sessionId ?? '')) {
    throw joinError('claude-session-not-visible', 'Run join as a tool command inside the Claude chat to register (its session is not visible here).');
  }
  let row;
  try { row = (await discover({ home })).find(item => item.sessionId === sessionId); } catch { row = undefined; }
  const mode = (await readClaudeRecipientMode({ sessionId }, { home }))?.mode;
  return { agent: 'claude',
    entry: { sessionId, ...(HOST.test(hostSessionId ?? '') ? { hostSessionId } : {}),
      ...(typeof row?.name === 'string' && row.name ? { title: row.name.slice(0, 200) } : {}),
      permissionClass: claudePermissionClass(mode) === 'bypass' ? 'bypass' : 'prompting' },
    evidence: { source: 'claude-session-environment', permissionMode: mode ?? 'unknown',
      entrypoint: env.CLAUDE_CODE_ENTRYPOINT ?? row?.entrypoint ?? 'unknown' } };
}

/** The Codex chat whose recent rollout contains this join code. */
export async function identifyCodexChat(code, { home = homedir(), now = Date.now() } = {}) {
  const files = await recentFiles(join(home, '.codex', 'sessions'), name => /^rollout-.*\.jsonl$/.test(name), now - RECENT_MS, 3, 64);
  const found = new Map();
  for (const file of files) {
    let tail;
    try { tail = await readSlice(file.path, true, 8 * 1024 * 1024); } catch { continue; }
    if (!tail.includes(code)) continue;
    let meta;
    try { meta = JSON.parse((await readSlice(file.path, false, 1024 * 1024)).split('\n')[0]); } catch { continue; }
    const threadId = meta?.type === 'session_meta' ? meta.payload?.id : undefined;
    if (!UUID.test(threadId ?? '')) continue;
    const context = tail.split('\n').map(line => { try { return JSON.parse(line); } catch { return null; } })
      .filter(row => row?.type === 'turn_context').at(-1)?.payload;
    found.set(threadId, { threadId, approvalPolicy: typeof context?.approval_policy === 'string' ? context.approval_policy : 'unknown',
      sandbox: typeof context?.sandbox_policy?.type === 'string' ? context.sandbox_policy.type : 'unknown' });
  }
  if (found.size !== 1) {
    throw joinError(found.size ? 'codex-chat-ambiguous' : 'codex-chat-not-found', found.size
      ? 'More than one Codex chat contains this join code. Run join again in the chat to register.'
      : 'No recent Codex chat contains this join code. Run the printed command from the same Codex chat.');
  }
  const chat = [...found.values()][0];
  // Codex never asking for approval is the counterpart of a bypass session.
  return { agent: 'codex', entry: { threadId: chat.threadId, hostId: 'local', permissionClass: chat.approvalPolicy === 'never' ? 'bypass' : 'prompting' },
    evidence: { source: 'codex-rollout', approvalPolicy: chat.approvalPolicy, sandbox: chat.sandbox } };
}

function autoExecutionPolicy(result) {
  const steps = result?.trajectory?.steps ?? [];
  for (let index = steps.length - 1; index >= 0; index--) {
    const user = steps[index]?.userInput, config = user?.userConfig ?? user?.lastUserConfig;
    const value = config?.plannerConfig?.toolConfig?.runCommand?.autoCommandConfig?.autoExecutionPolicy;
    if (typeof value === 'string') return value;
  }
  return undefined;
}

/** Conversations by latest activity. Antigravity keeps each conversation in
 * SQLite WAL mode: an active chat updates `<id>.db-wal`, while `<id>.db` keeps
 * its last checkpoint time, so activity is the newest of the three files. */
async function antigravityConversationsByActivity(home) {
  const directory = join(home, '.gemini', 'antigravity', 'conversations'), latest = new Map();
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch { return []; }
  for (const entry of entries) {
    const match = entry.isFile() && /^([0-9a-f-]{36})\.db(?:-wal|-shm)?$/i.exec(entry.name);
    if (!match || !UUID.test(match[1])) continue;
    const info = await stat(join(directory, entry.name)).catch(() => null);
    if (info) latest.set(match[1], Math.max(latest.get(match[1]) ?? 0, info.mtimeMs));
  }
  return [...latest].map(([conversationId, mtimeMs]) => ({ conversationId, mtimeMs })).sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** The loaded Antigravity conversation whose trajectory contains this join code. */
export async function identifyAntigravityChat(code, { home = homedir(), now = Date.now(), rpc = antigravityRpc, connection } = {}) {
  const byActivity = await antigravityConversationsByActivity(home);
  const recent = byActivity.filter(row => row.mtimeMs >= now - RECENT_MS).slice(0, 12);
  // The code identifies the chat by itself; the window only bounds the search.
  const candidates = recent.length ? recent : byActivity.slice(0, 5);
  if (!candidates.length) throw joinError('gemini-chat-not-found', 'No Antigravity conversation was found. Run the printed command from the same Antigravity chat.');
  const link = connection ?? await discoverAntigravity();
  const found = new Map();
  for (const { conversationId } of candidates) {
    let result;
    try { result = await rpc('GetCascadeTrajectory', { cascadeId: conversationId, disableRehydration: true }, { connection: link }); }
    catch { continue; }
    if (!JSON.stringify(result).includes(code)) continue;
    const projectId = result?.trajectory?.metadata?.projectId;
    found.set(conversationId, { conversationId, projectId: typeof projectId === 'string' && projectId ? projectId : undefined,
      policy: autoExecutionPolicy(result) });
  }
  if (found.size !== 1) {
    throw joinError(found.size ? 'gemini-chat-ambiguous' : 'gemini-chat-not-found', found.size
      ? 'More than one Antigravity conversation contains this join code. Run join again in the chat to register.'
      : 'No loaded Antigravity conversation contains this join code. Run the printed command from the same Antigravity chat.');
  }
  const chat = [...found.values()][0];
  let policy = chat.policy;
  if (!policy) policy = (await readJsonFile(join(home, '.gemini', 'config', 'config.json'), null).catch(() => null))?.userSettings?.autoExecutionPolicy;
  return { agent: 'gemini', entry: { conversationId: chat.conversationId, ...(chat.projectId ? { projectId: chat.projectId } : {}),
    permissionClass: policy === EAGER ? 'bypass' : 'prompting' },
    evidence: { source: 'antigravity-trajectory', autoExecutionPolicy: policy ?? 'unknown' } };
}

function sameChat(agent, left, right) {
  if (!left || !right) return false;
  if (agent === 'codex') return left.threadId === right.threadId;
  if (agent === 'gemini') return left.conversationId === right.conversationId;
  return left.hostSessionId && right.hostSessionId ? left.hostSessionId === right.hostSessionId : left.sessionId === right.sessionId;
}

function chatSummary(agent, entry) {
  const keys = { codex: ['threadId'], claude: ['sessionId', 'hostSessionId', 'title'], gemini: ['conversationId', 'projectId'] }[agent];
  return Object.fromEntries(keys.filter(key => entry?.[key] !== undefined).map(key => [key, entry[key]]));
}

/** Keep the state root's routing aligned with its registered apps. A profile the
 * user wrote by hand (no generatedBy marker) is never replaced. */
export async function syncStateRoutingProfile(root, registered) {
  const path = stateRoutingProfilePath(root);
  const existing = await readJsonFile(path, null);
  if (existing && existing.generatedBy !== GENERATED_BY) return { state: 'custom-profile-kept', profileId: existing.profileId };
  if (registered.length < 2) return { state: 'waiting-for-second-app' };
  const base = await loadRoutingProfile(DEFAULT_ROUTING_PROFILE);
  if (registered.length === AGENTS.length) {
    if (existing) await unlink(path);
    return { state: 'default', profileId: base.profileId };
  }
  const profile = { ...routingProfileForApps(base, registered), generatedBy: GENERATED_BY };
  await replaceJson(path, profile);
  return { state: 'generated', profileId: profile.profileId,
    reassigned: profile.routes.filter(route => route.reassignedFrom).map(route => ({ taskType: route.taskType, from: route.reassignedFrom, to: route.app })) };
}

/** A success spends its own code at once. Codes left by a failed or abandoned
 * join are removed after they expire, the next time any code is issued. A file
 * without a readable time (one still being written) is judged by its mtime. */
async function pruneExpiredJoinCodes(pending, nowMs) {
  let names;
  try { names = await readdir(pending); } catch { return; }
  for (const name of names) {
    if (!name.endsWith('.json') || !CODE.test(name.slice(0, -5))) continue;
    const path = join(pending, name);
    const request = await readJsonFile(path, null).catch(() => null);
    let created = Date.parse(request?.createdAt);
    if (!Number.isFinite(created)) created = (await stat(path).catch(() => null))?.mtimeMs ?? nowMs;
    if (nowMs - created > PENDING_MS) await unlink(path).catch(() => {});
  }
}

export async function joinChat(bridge, { agent, code, replace = false, env = process.env, home = homedir(), rpc, connection, discover,
  now = () => new Date() } = {}) {
  assertAgent(agent);
  const root = bridge.root, pending = join(root, '.bridge', 'joins');
  if (agent !== 'claude' && code === undefined) {
    const value = 'ab-join-' + randomBytes(8).toString('hex');
    await mkdir(pending, { recursive: true });
    await pruneExpiredJoinCodes(pending, now().getTime());
    await writeFile(join(pending, value + '.json'), JSON.stringify({ version: 1, agent, createdAt: now().toISOString() }) + '\n', { flag: 'wx' });
    return { status: 'confirm-required', agent, code: value, expiresInMinutes: PENDING_MS / 60000,
      next: bridgeCliCommand(root, `join --agent ${agent} --code ${value}`),
      nextAction: 'Run the next command once, from this same chat. It finds this chat by the code in its own command history.' };
  }
  if (agent !== 'claude') {
    if (!CODE.test(code ?? '')) throw joinError('join-code-invalid', 'Invalid join code. Run join without --code to get one.');
    const request = await readJsonFile(join(pending, code + '.json'), null);
    if (!request || request.agent !== agent || now() - Date.parse(request.createdAt) > PENDING_MS) {
      throw joinError('join-code-expired', 'This join code is unknown or expired. Run join without --code to get a new one.');
    }
  }
  const identified = agent === 'claude' ? await identifyClaudeChat({ env, home, ...(discover ? { discover } : {}) })
    : agent === 'codex' ? await identifyCodexChat(code, { home, now: now().getTime() })
    : await identifyAntigravityChat(code, { home, now: now().getTime(), ...(rpc ? { rpc } : {}), ...(connection ? { connection } : {}) });
  const key = JSON.stringify(['agent-bridge-config', process.platform === 'win32' ? resolve(root).toLowerCase() : resolve(root)]);
  const outcome = await withEndpointLock(key, async () => {
    const settings = await readJsonFile(configPath(root), null) ?? { version: 1, agents: {} };
    const existing = settings.agents?.[agent], same = sameChat(agent, existing, identified.entry);
    if (existing && !same && !replace) {
      return { status: 'already-registered', agent, registered: chatSummary(agent, existing), candidate: chatSummary(agent, identified.entry),
        requiresAttention: true, nextAction: 'This app already has a registered chat. Re-run join with --replace true only if the user wants this chat instead.' };
    }
    const entry = { ...(same ? existing : {}), ...identified.entry,
      permissionEvidence: { ...identified.evidence, checkedAt: now().toISOString() } };
    const next = { ...settings, version: settings.version ?? 1, agents: { ...settings.agents, [agent]: entry } };
    if (agent === 'codex' && (!settings.codexCallerThreadId || settings.codexCallerThreadId === existing?.threadId)) {
      next.codexCallerThreadId = identified.entry.threadId;
    }
    try { await copyFile(configPath(root), join(root, '.bridge', `config.backup-${now().toISOString().replace(/[:.]/g, '-')}.json`)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await replaceJson(configPath(root), next);
    return { status: !existing ? 'registered' : same ? 'updated' : 'replaced', settings: next };
  });
  if (outcome.status === 'already-registered') return outcome;
  if (code) await unlink(join(pending, code + '.json')).catch(() => {});
  const registered = AGENTS.filter(app => outcome.settings.agents?.[app]);
  return { status: outcome.status, agent, chat: chatSummary(agent, identified.entry), permissionClass: identified.entry.permissionClass,
    permissionEvidence: identified.evidence, registeredApps: registered, missingApps: AGENTS.filter(app => !registered.includes(app)),
    routing: await syncStateRoutingProfile(root, registered),
    nextAction: registered.length < 2 ? 'Register a chat of at least one other app with join.'
      : 'When every app you use is registered, run selftest once from any registered chat.' };
}

/** One ping per registered pair; each recipient replies pong and each sender
 * records receipt. Same-day reruns reuse the IDs and send nothing new. */
export async function selfTest(bridge, { now = () => new Date() } = {}) {
  const registered = await bridge.registeredAgents();
  if (registered.length < 2) return { status: 'needs-two-apps', registeredApps: registered, requiresAttention: true,
    nextAction: 'Register chats of at least two apps with join first.' };
  const day = now().toISOString().slice(0, 10), pairs = [];
  for (let i = 0; i < registered.length; i++) for (let j = i + 1; j < registered.length; j++) {
    const from = registered[i], to = registered[j];
    const id = delegationMessageId({ profileId: 'agent-bridge-selftest', taskId: `${from}-${to}-${day}`, revision: 1 });
    const sent = await bridge.send({ id, from, to, kind: 'ping', body: `agent-bridge selftest: ${from} → ${to} (${day}). Reply pong once.` },
      { deferErrors: true });
    pairs.push({ from, to, messageId: id, duplicate: sent.duplicate === true, state: sent.status?.state ?? null,
      requiresAttention: sent.requiresAttention === true || sent.status?.requiresAttention === true,
      ...(sent.warnings ? { warnings: sent.warnings.map(warning => warning.code) } : {}) });
  }
  return { status: 'sent', registeredApps: registered, pairs, requiresAttention: pairs.some(pair => pair.requiresAttention),
    nextAction: 'Each recipient replies pong and each sender records receipt from its prompt. Then run verify --record-versions true.' };
}
