import { readdir, lstat, open } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileAsync } from './runtime.mjs';
import { validateDelegation } from './delegation.mjs';

// Delegated write scope, enforced without model turns, watchers or polling:
// - reservations are derived from the persisted delegation messages themselves
//   (exclusive writeScope per task, newest revision wins, lazy expiry);
// - a baseline of doNotChange and the git working state is recorded before the
//   first delivery and compared once, when the delegate sends its result.
// Git observations cannot attribute a change to the delegate, so they warn;
// a changed doNotChange path or a declared artifact outside writeScope is a
// contract violation that requires attention.

export const SCOPE_RESERVATION_HOURS = 24;
const MAX_DIRECTORY_ENTRIES = 20000;
const MAX_HASH_BYTES = 64 * 1024 * 1024;
const MAX_GIT_HASH_BYTES = 8 * 1024 * 1024;
const MAX_GIT_ENTRIES = 5000;
const MAX_GIT_ROOTS = 5;
const LISTED = 20;

export function normalizeScopePath(value) {
  const full = resolve(value).replaceAll('\\', '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? full.toLowerCase() : full;
}
export const pathsOverlap = (a, b) => a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
export const insideAny = (path, roots) => roots.some(root => path === root || path.startsWith(root + '/'));

/** Only delegation.v1 task bodies carry a machine-readable scope. */
export function delegationScope(message) {
  if (message?.kind !== 'task' || typeof message.body !== 'string' || !message.body.trimStart().startsWith('{')) return null;
  let body;
  try { body = validateDelegation(JSON.parse(message.body)); } catch { return null; }
  return { profileId: body.profileId, taskId: body.taskId, revision: body.revision,
    writeScope: body.writeScope, doNotChange: body.doNotChange };
}

export function reservationTtlMs(settings = {}) {
  const hours = settings.scopeGuard?.reservationHours ?? SCOPE_RESERVATION_HOURS;
  if (!Number.isSafeInteger(hours) || hours < 1 || hours > 168) {
    throw new Error('Invalid scopeGuard.reservationHours: expected integer 1..168');
  }
  return hours * 3600000;
}

/** Active = the newest revision of a delegated task that is unfinished,
 * unreleased and unexpired. Completion (a correlated result, handled or
 * superseded) releases the reservation without any extra write. */
export function activeReservations(messages, events, completed, { now = Date.now(), ttlMs = SCOPE_RESERVATION_HOURS * 3600000 } = {}) {
  const released = new Set(events.filter(row => row.state === 'scope-released').map(row => row.messageId));
  const latest = new Map();
  for (const message of messages) {
    const scope = delegationScope(message), createdAt = Date.parse(message.createdAt);
    if (!scope || !Number.isFinite(createdAt)) continue;
    const key = JSON.stringify([scope.profileId, scope.taskId]), prior = latest.get(key);
    if (!prior || scope.revision > prior.scope.revision
        || scope.revision === prior.scope.revision && createdAt > prior.createdAt) latest.set(key, { message, scope, createdAt });
  }
  return [...latest.values()].filter(({ message, scope, createdAt }) => scope.writeScope.length
      && !completed.has(message.id) && !released.has(message.id) && now - createdAt < ttlMs)
    .map(({ message, scope, createdAt }) => ({ messageId: message.id, profileId: scope.profileId,
      taskId: scope.taskId, revision: scope.revision, holder: message.to, requester: message.from,
      writeScope: scope.writeScope.map(normalizeScopePath), createdAt: message.createdAt,
      expiresAt: new Date(createdAt + ttlMs).toISOString() }));
}

function overlapsWith(paths, reservations, candidate) {
  const normalized = paths.map(normalizeScopePath);
  return reservations.filter(row => row.messageId !== candidate.messageId
      && !(row.profileId === candidate.profileId && row.taskId === candidate.taskId))
    .map(row => ({ messageId: row.messageId, taskId: row.taskId, revision: row.revision, holder: row.holder,
      expiresAt: row.expiresAt, overlaps: normalized.flatMap(path => row.writeScope
        .filter(reserved => pathsOverlap(path, reserved)).map(reserved => ({ path, reserved }))).slice(0, 5) }))
    .filter(row => row.overlaps.length);
}

/** Another unfinished task already reserved an overlapping writeScope. */
export const scopeConflicts = (candidate, reservations) => overlapsWith(candidate.writeScope, reservations, candidate);

/** doNotChange paths that another task may legitimately write (warning only). */
export const protectedPathsReservedElsewhere = (candidate, reservations) => overlapsWith(candidate.doNotChange, reservations, candidate);

async function hashFile(path, limit) {
  const hash = createHash('sha256'), handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    let position = 0;
    while (position < limit + 1) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally { await handle.close(); }
  return hash.digest('hex');
}

/** Metadata plus content hash for bounded regular files; links are not followed. */
async function fingerprint(path, maxHashBytes = MAX_HASH_BYTES) {
  let info;
  try { info = await lstat(path); }
  catch (error) { return ['ENOENT', 'ENOTDIR'].includes(error.code) ? { exists: false } : { unreadable: true }; }
  if (info.isSymbolicLink()) return { kind: 'link', size: info.size, mtimeMs: info.mtimeMs };
  if (info.isDirectory()) return { kind: 'directory' };
  if (!info.isFile()) return { kind: 'other', size: info.size, mtimeMs: info.mtimeMs };
  if (info.size > maxHashBytes) return { kind: 'file', size: info.size, mtimeMs: info.mtimeMs };
  try { return { kind: 'file', size: info.size, sha256: await hashFile(path, info.size) }; }
  catch { return { kind: 'file', unreadable: true }; }
}

async function directoryManifest(root) {
  const files = {}, pending = [''];
  let count = 0, truncated = false;
  while (pending.length && !truncated) {
    const relative = pending.pop();
    let rows;
    try { rows = await readdir(join(root, relative), { withFileTypes: true }); }
    catch { files[relative || '.'] = { unreadable: true }; continue; }
    for (const row of rows) {
      if (++count > MAX_DIRECTORY_ENTRIES) { truncated = true; break; }
      const child = relative ? relative + '/' + row.name : row.name;
      if (row.isDirectory() && !row.isSymbolicLink()) { pending.push(child); continue; }
      try { const info = await lstat(join(root, child)); files[child] = { size: info.size, mtimeMs: info.mtimeMs }; }
      catch { files[child] = { unreadable: true }; }
    }
  }
  return { files, truncated };
}

/** Files are hashed; directories record each file's size and mtime. */
export async function snapshotPaths(paths) {
  const rows = [];
  for (const path of paths) {
    const state = await fingerprint(path);
    rows.push(state.kind === 'directory' ? { path, kind: 'directory', ...await directoryManifest(path) } : { path, ...state });
  }
  return rows;
}

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function compareSnapshot(before, after) {
  const path = before.path;
  if (before.unreadable || after.unreadable) return [{ path, change: 'unverifiable' }];
  if (before.exists === false) return after.exists === false ? [] : [{ path, change: 'created' }];
  if (after.exists === false) return [{ path, change: 'deleted' }];
  if (before.kind !== after.kind) return [{ path, change: 'replaced' }];
  if (before.kind !== 'directory') {
    const { path: ignoredBefore, ...left } = before, { path: ignoredAfter, ...right } = after;
    return same(left, right) ? [] : [{ path, change: 'modified' }];
  }
  const changes = [];
  for (const name of new Set([...Object.keys(before.files), ...Object.keys(after.files)])) {
    const child = path.replace(/[\\/]+$/, '') + '/' + name;
    if (!(name in after.files)) changes.push({ path: child, change: before.truncated || after.truncated ? 'unverifiable' : 'deleted' });
    else if (!(name in before.files)) changes.push({ path: child, change: before.truncated ? 'unverifiable' : 'created' });
    else if (!same(before.files[name], after.files[name])) changes.push({ path: child, change: 'modified' });
  }
  return changes;
}

async function runGit(git, args, cwd) {
  const { stdout } = await execFileAsync(git, ['-C', cwd, ...args], { windowsHide: true, timeout: 15000,
    maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' });
  return stdout;
}

async function nearestDirectory(path) {
  let current = resolve(path);
  for (let depth = 0; depth < 64; depth++) {
    const info = await lstat(current).catch(() => null);
    if (info?.isDirectory()) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

export async function gitWorkTrees(paths, { git = 'git', run = runGit } = {}) {
  const roots = new Map();
  for (const path of paths) {
    const directory = await nearestDirectory(path);
    if (!directory) continue;
    try {
      const top = (await run(git, ['rev-parse', '--show-toplevel'], directory)).trim();
      if (top) roots.set(normalizeScopePath(top), resolve(top));
    } catch { /* Not a work tree, or git is unavailable. */ }
    if (roots.size >= MAX_GIT_ROOTS) break;
  }
  return [...roots.values()];
}

/** Dirty and untracked files with content fingerprints, plus HEAD. */
export async function gitWorkingState(root, { git = 'git', run = runGit } = {}) {
  let head = null;
  try { head = (await run(git, ['rev-parse', '--verify', 'HEAD'], root)).trim() || null; } catch { /* Unborn branch. */ }
  const output = await run(git, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], root);
  const parts = output.split('\0'), files = {};
  let count = 0, truncated = false;
  for (let index = 0; index < parts.length; index++) {
    const entry = parts[index];
    if (entry.length < 4) continue;
    const status = entry.slice(0, 2);
    if (status[0] === 'R' || status[0] === 'C') index++;
    if (++count > MAX_GIT_ENTRIES) { truncated = true; break; }
    const absolute = join(root, entry.slice(3));
    files[normalizeScopePath(absolute)] = { status, ...await fingerprint(absolute, MAX_GIT_HASH_BYTES) };
  }
  return { root, head, files, truncated };
}

/** Recorded once, before the first delivery of a delegated task. */
export async function takeScopeBaseline(message, scope, { git = 'git', run, now = () => new Date() } = {}) {
  const roots = await gitWorkTrees(scope.writeScope, { git, run });
  const states = [];
  for (const root of roots) {
    try { states.push(await gitWorkingState(root, { git, run })); }
    catch { states.push({ root, unavailable: true }); }
  }
  return { version: 1, messageId: message.id, profileId: scope.profileId, taskId: scope.taskId,
    revision: scope.revision, takenAt: now().toISOString(), doNotChange: await snapshotPaths(scope.doNotChange), git: states };
}

function declaredArtifacts(body) {
  if (typeof body !== 'string' || !body.trimStart().startsWith('{')) return [];
  let value;
  try { value = JSON.parse(body); } catch { return []; }
  const artifacts = value?.contract === 'completion.v1' && Array.isArray(value.artifacts) ? value.artifacts : [];
  return artifacts.filter(item => typeof item === 'string' && /^(?:[A-Za-z]:[\\/]|\/)/.test(item));
}

/** One comparison when the delegate reports. `exclude` lists bridge-owned
 * paths such as the result body file and the state root. */
export async function checkScope({ scope, baseline, messages = [], resultBody, exclude = [], git = 'git', run,
  now = () => new Date() }) {
  const writeScope = scope.writeScope.map(normalizeScopePath);
  const protectedPaths = scope.doNotChange.map(normalizeScopePath);
  const excluded = exclude.filter(Boolean).map(normalizeScopePath);
  // Another task can explain a protected-path change only if it was unfinished
  // at some point after this baseline was taken.
  const since = Date.parse(baseline.takenAt);
  const finishedBefore = id => messages.some(message => message.replyTo === id && message.kind === 'result'
    && Date.parse(message.createdAt) < since);
  const others = messages.map(message => ({ message, other: delegationScope(message) }))
    .filter(({ message, other }) => other && message.id !== baseline.messageId
      && !(other.profileId === scope.profileId && other.taskId === scope.taskId) && !finishedBefore(message.id));
  const ownerOf = path => others.find(({ other }) => other.writeScope.some(item => pathsOverlap(path, normalizeScopePath(item))))?.message.id;

  const after = await snapshotPaths(baseline.doNotChange.map(row => row.path));
  const protectedChanges = baseline.doNotChange.flatMap((row, index) => compareSnapshot(row, after[index]))
    .map(change => { const owner = ownerOf(normalizeScopePath(change.path)); return owner ? { ...change, reservedBy: owner } : change; });

  const observed = [], headMoved = [], gitUnavailable = [];
  for (const before of baseline.git ?? []) {
    if (before.unavailable) { gitUnavailable.push(before.root); continue; }
    let current;
    try { current = await gitWorkingState(before.root, { git, run }); }
    catch { gitUnavailable.push(before.root); continue; }
    if (before.head !== current.head) headMoved.push(before.root);
    for (const path of new Set([...Object.keys(before.files), ...Object.keys(current.files)])) {
      if (same(before.files[path], current.files[path]) || insideAny(path, writeScope) || insideAny(path, excluded)
        || insideAny(path, protectedPaths)) continue;
      observed.push(path);
    }
    if (before.truncated || current.truncated) gitUnavailable.push(before.root + ' (partial)');
  }
  const declaredOutside = declaredArtifacts(resultBody).map(normalizeScopePath)
    .filter(path => !insideAny(path, writeScope) || insideAny(path, protectedPaths));
  const violations = protectedChanges.filter(row => !row.reservedBy && row.change !== 'unverifiable');
  const requiresAttention = violations.length > 0 || declaredOutside.length > 0;
  const warnings = protectedChanges.length - violations.length + observed.length + headMoved.length;
  return { version: 1, taskMessageId: baseline.messageId, taskId: scope.taskId, revision: scope.revision,
    checkedAt: now().toISOString(), baselineTakenAt: baseline.takenAt,
    state: requiresAttention ? 'violation' : warnings ? 'warning' : 'clean',
    doNotChange: { checked: baseline.doNotChange.length, changes: protectedChanges.slice(0, LISTED),
      ...(protectedChanges.length > LISTED ? { omitted: protectedChanges.length - LISTED } : {}) },
    outsideWriteScope: { source: (baseline.git ?? []).length ? 'git' : 'unavailable', paths: observed.slice(0, LISTED),
      ...(observed.length > LISTED ? { omitted: observed.length - LISTED } : {}),
      ...(headMoved.length ? { headMoved } : {}), ...(gitUnavailable.length ? { unavailable: gitUnavailable } : {}) },
    declaredOutsideWriteScope: declaredOutside.slice(0, LISTED), requiresAttention };
}

/** One line for the requester, rendered into the same result delivery. */
export function scopeCheckNote(check) {
  const list = paths => paths.slice(0, 3).join(', ') + (paths.length > 3 ? ` (+${paths.length - 3} more)` : '');
  const changes = check.doNotChange.changes;
  const confirmed = changes.filter(row => !row.reservedBy && row.change !== 'unverifiable');
  const reserved = changes.filter(row => row.reservedBy), unverifiable = changes.filter(row => row.change === 'unverifiable');
  const parts = [];
  if (confirmed.length) parts.push('doNotChange changed: ' + list(confirmed.map(row => `${row.path} (${row.change})`)));
  if (check.declaredOutsideWriteScope.length) parts.push('result artifacts outside writeScope: ' + list(check.declaredOutsideWriteScope));
  if (reserved.length) parts.push('doNotChange changed where another task holds the write reservation: ' + list(reserved.map(row => row.path)));
  if (check.outsideWriteScope.paths.length) parts.push('changed outside writeScope during the task (git, author not identified): ' + list(check.outsideWriteScope.paths));
  if (check.outsideWriteScope.headMoved?.length) parts.push('git HEAD moved during a no-commit task: ' + list(check.outsideWriteScope.headMoved));
  if (unverifiable.length) parts.push('not verifiable: ' + list(unverifiable.map(row => row.path)));
  const head = `Bridge scope check for task ${check.taskId} r${check.revision}: `;
  if (parts.length) return head + parts.join('; ') + '. Review these paths before accepting the result.';
  return head + `clean (doNotChange ${check.doNotChange.checked} unchanged; `
    + (check.outsideWriteScope.source === 'git' ? 'no git changes outside writeScope).' : 'git comparison unavailable).');
}
