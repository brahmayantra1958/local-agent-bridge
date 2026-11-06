import { readFile, writeFile, rename, mkdir, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { AGENTS } from './protocol.mjs';
import { powershell } from './runtime.mjs';
import { resolveClaudeSession } from './claude-session.mjs';
import { discoverClaude } from './adapters/claude.mjs';
import { delivered } from './verification.mjs';

// The adapters depend on app-internal interfaces, so an app update is a reason
// to re-verify that app's inbound route, not evidence that delivery broke.
// Readers use metadata only (MSIX package version, executable file version,
// the live Claude runtime's discovery record). They never start, focus or
// message an application, read credentials, or collect command lines.

export const APP_VERSIONS_FILE = 'verified-app-versions.json';
export const APP_VERSION_SOURCES = Object.freeze({ codex: 'appx-package', claude: 'claude-runtime-discovery',
  gemini: 'antigravity-executable' });
const VERSION = /^\d{1,6}(?:\.\d{1,9}){1,3}$/;
const TOKEN = /^[a-z0-9-]{1,60}$/;
// docs/verification.json records the last documented six-direction run.
const DOCUMENTED_KEYS = Object.freeze({ codex: 'codexDesktop', claude: 'claudeCode', gemini: 'antigravity' });
const documentedVerification = fileURLToPath(new URL('../docs/verification.json', import.meta.url));
const acceptedStates = new Set(['native-accepted', 'transport-written']);
const quote = value => "'" + String(value).replaceAll("'", "''") + "'";
const validTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const unread = (agent, reason) => ({ agent, version: null, source: APP_VERSION_SOURCES[agent], reason });

/** Accept only a dotted numeric version; any other value is an unknown reading. */
export function normalizeAppVersionReading(agent, value) {
  if (!AGENTS.includes(agent)) throw new Error('Unknown agent: ' + agent);
  const source = typeof value?.source === 'string' && TOKEN.test(value.source) ? value.source : APP_VERSION_SOURCES[agent];
  const version = typeof value?.version === 'string' ? value.version.trim() : null;
  if (version && VERSION.test(version)) return { agent, version, source };
  const reason = typeof value?.reason === 'string' && TOKEN.test(value.reason) ? value.reason
    : version ? 'version-format-unrecognized' : 'version-unavailable';
  return { agent, version: null, source, reason };
}

/** Installed Codex (MSIX package) or Antigravity (executable file version) in
 * one PowerShell process. The Antigravity path is the one the Gemini wake uses. */
export async function readWindowsAppVersion(agent, settings = {}, { runPowerShell = powershell,
  platform = process.platform } = {}) {
  if (agent !== 'codex' && agent !== 'gemini') throw new Error('Windows app version reader supports codex and gemini');
  if (platform !== 'win32') return unread(agent, 'platform-unsupported');
  const executable = join(settings.home ?? homedir(), 'AppData', 'Local', 'Programs', 'antigravity', 'Antigravity.exe');
  const values = agent === 'codex'
    ? "@(Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction SilentlyContinue | ForEach-Object { [string]$_.Version })"
    : '@(if (Test-Path -LiteralPath ' + quote(executable) + ') { [string](Get-Item -LiteralPath '
      + quote(executable) + ').VersionInfo.FileVersion })';
  let parsed;
  try {
    parsed = JSON.parse(await runPowerShell('$bridgeVersions = ' + values
      + '; ConvertTo-Json -InputObject $bridgeVersions -Compress', { timeoutMs: 15000 }));
  } catch { return unread(agent, 'version-read-failed'); }
  const found = [...new Set((Array.isArray(parsed) ? parsed : parsed == null ? [] : [parsed])
    .filter(value => typeof value === 'string' && value.trim()).map(value => value.trim()))];
  if (!found.length) return unread(agent, 'app-not-installed');
  if (found.length > 1) return unread(agent, 'app-version-ambiguous');
  return normalizeAppVersionReading(agent, { version: found[0], source: APP_VERSION_SOURCES[agent] });
}

/** Version published by the live Claude Code runtime of the registered chat.
 * Resolution follows the transport's identity rules; unresolved means unknown. */
export async function readClaudeVersion(target, settings = {}, { discover = discoverClaude } = {}) {
  let sessions, session;
  try { sessions = await discover({ home: settings.home ?? homedir() }); }
  catch { return unread('claude', 'claude-session-store-unavailable'); }
  try { ({ session } = resolveClaudeSession(target ?? {}, sessions)); }
  catch { return unread('claude', 'claude-runtime-unresolved'); }
  return normalizeAppVersionReading('claude', { version: session.version, source: APP_VERSION_SOURCES.claude });
}

export const defaultAppVersionReaders = Object.freeze({
  codex: (target, settings) => readWindowsAppVersion('codex', settings),
  claude: (target, settings) => readClaudeVersion(target, settings),
  gemini: (target, settings) => readWindowsAppVersion('gemini', settings),
});

async function readJson(path) {
  try { return JSON.parse((await readFile(path, 'utf8')).replace(/^﻿/, '')); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

function baselineEntry(value) {
  if (typeof value?.version !== 'string' || !VERSION.test(value.version)) return undefined;
  const messageIds = Array.isArray(value.messageIds) ? value.messageIds
    .filter(id => typeof id === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)).slice(0, 20) : [];
  return { version: value.version, ...(validTime(value.verifiedAt) ? { verifiedAt: value.verifiedAt } : {}),
    ...(typeof value.source === 'string' && TOKEN.test(value.source) ? { source: value.source } : {}),
    ...(messageIds.length ? { messageIds } : {}) };
}

/** The baseline recorded in this state root, else the documented verification
 * shipped with this code. A damaged record is reported, never guessed around. */
export async function loadVerifiedAppVersions(root, { documentedPath = documentedVerification } = {}) {
  let stored;
  try { stored = await readJson(join(root, '.bridge', APP_VERSIONS_FILE)); }
  catch { return { source: 'invalid', apps: {} }; }
  if (stored !== undefined) {
    if (stored?.version !== 1 || !stored.apps || typeof stored.apps !== 'object') return { source: 'invalid', apps: {} };
    const apps = {};
    for (const agent of AGENTS) {
      const entry = baselineEntry(stored.apps[agent]);
      if (entry) apps[agent] = entry;
    }
    return { source: 'recorded', ...(validTime(stored.updatedAt) ? { updatedAt: stored.updatedAt } : {}), apps };
  }
  let documented;
  try { documented = await readJson(documentedPath); } catch { documented = undefined; }
  const environment = documented?.environment;
  if (!environment || typeof environment !== 'object') return { source: 'none', apps: {} };
  const apps = {};
  for (const agent of AGENTS) {
    const entry = baselineEntry({ version: environment[DOCUMENTED_KEYS[agent]], verifiedAt: documented.generatedAt });
    if (entry) apps[agent] = entry;
  }
  return { source: 'documented-verification', ...(validTime(documented.generatedAt) ? { updatedAt: documented.generatedAt } : {}), apps };
}

/** Atomically replace the recorded baseline. Agents not re-verified keep their
 * current entry, including one carried over from the documented verification. */
export async function recordVerifiedAppVersions(root, entries, options = {}) {
  const apps = { ...(await loadVerifiedAppVersions(root, options)).apps };
  const verifiedAt = new Date().toISOString();
  for (const entry of entries) {
    if (!AGENTS.includes(entry?.agent) || typeof entry.version !== 'string' || !VERSION.test(entry.version)) {
      throw new Error('Invalid verified app version');
    }
    apps[entry.agent] = baselineEntry({ version: entry.version, verifiedAt, source: entry.source, messageIds: entry.messageIds });
  }
  const value = { version: 1, updatedAt: verifiedAt, apps };
  const directory = join(root, '.bridge'), path = join(directory, APP_VERSIONS_FILE);
  await mkdir(directory, { recursive: true });
  const temp = path + '.' + randomUUID() + '.tmp';
  await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  try { await rename(temp, path); }
  catch (error) { await unlink(temp).catch(() => {}); throw error; }
  return { source: 'recorded', updatedAt: verifiedAt, apps };
}

/** verified | changed | unverified (no baseline entry) | unknown (unreadable now). */
export function compareAppVersion(reading, baselineApp) {
  const current = reading?.version ?? null, verified = baselineApp?.version ?? null;
  const state = !current ? 'unknown' : !verified ? 'unverified' : current === verified ? 'verified' : 'changed';
  return { agent: reading.agent, state, current, verified,
    ...(reading.source ? { source: reading.source } : {}),
    ...(reading.reason ? { reason: reading.reason } : {}),
    ...(baselineApp?.verifiedAt ? { verifiedAt: baselineApp.verifiedAt } : {}) };
}

export const APP_REVERIFY_ACTION = 'Send one ping to each listed app from each other registered app; '
  + 'after it replies pong to both, run agent-bridge verify --record-versions true.';

/** Warning only: delivery proceeds and its status/requiresAttention is unchanged. */
export function appVersionWarning(check) {
  return { code: 'app-version-unverified', agent: check.agent, state: check.state,
    current: check.current, verified: check.verified, ...(check.reason ? { reason: check.reason } : {}),
    action: check.state === 'unknown'
      ? 'Delivery continued without a version comparison. Run agent-bridge versions to inspect the installed app.'
      : `Delivery continued on an unverified ${check.agent} version. ${APP_REVERIFY_ACTION}` };
}

/** Recipient app version recorded with the attempt whose own outcome was transport acceptance. */
export function recipientVersionOf(message) {
  const accepted = (message.receipts ?? []).filter(row => acceptedStates.has(row.state)
    && row.agent === message.from && row.attemptId).at(-1);
  if (!accepted) return null;
  const attempt = message.receipts.find(row => row.state === 'delivery-attempt' && row.attemptId === accepted.attemptId);
  const version = attempt?.recipientApp?.version;
  return typeof version === 'string' && VERSION.test(version) ? version : null;
}

/** An app is verified at a version when each other registered app delivered a
 * message to it, and the app recorded receipt, while that exact version was recorded. */
export function evaluateAppVersionEvidence(messages, current, registered = AGENTS) {
  return Object.fromEntries(AGENTS.map(agent => {
    const version = registered.includes(agent) ? current?.[agent] ?? null : null;
    const routes = AGENTS.filter(from => from !== agent && registered.includes(from)).map(from => {
      const evidence = version ? messages.filter(message => message.from === from && message.to === agent
        && delivered(message) && recipientVersionOf(message) === version) : [];
      return { from, to: agent, passed: evidence.length > 0, messageIds: evidence.map(message => message.id) };
    });
    return [agent, { version, passed: Boolean(version) && routes.length > 0 && routes.every(route => route.passed), routes }];
  }));
}
