import { readFile, writeFile, readdir, mkdir, copyFile, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, dirname, relative, sep } from 'node:path';

// The public skill is rendered per installation (paths, connected apps, roles)
// and installed with its own manifest: a file the installer did not write, or
// one edited since, is a conflict unless --replace-skills is given, and every
// overwritten file is backed up first.

export const SKILL_NAME = 'agent-bridge';
export const SKILL_MANIFEST = '.agent-bridge-skill.json';
export const skillTargets = home => ({ codex: join(home, '.agents', 'skills'), claude: join(home, '.claude', 'skills'),
  gemini: join(home, '.gemini', 'config', 'skills') });
const sha = value => createHash('sha256').update(value).digest('hex');

async function listFiles(root, base = root) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(path, base));
    else if (entry.isFile()) files.push(relative(base, path).split(sep).join('/'));
  }
  return files.sort();
}

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

/** `<!--if:app-->…<!--end:app-->` keeps text only when the app is connected,
 * `<!--ifnot:app-->…<!--end:app-->` only when it is not; `{{NAME}}` is replaced. */
export function renderTemplate(text, { vars, apps }) {
  let output = text, previous;
  do {
    previous = output;
    output = output.replace(/<!--(if|ifnot):(codex|claude|gemini)-->([\s\S]*?)<!--end:\2-->/g,
      (match, kind, app, body) => (kind === 'if') === apps.includes(app) ? body : '');
  } while (output !== previous);
  return output.replace(/\{\{([A-Z_]+)\}\}/g, (match, key) => {
    if (!Object.hasOwn(vars, key)) throw new Error('Unknown skill template variable: ' + key);
    return vars[key];
  });
}

export async function renderSkillFiles(templateRoot, context) {
  const root = join(templateRoot, SKILL_NAME), files = new Map();
  for (const file of await listFiles(root)) files.set(file, renderTemplate(await readFile(join(root, file), 'utf8'), context));
  return files;
}

/** Read-only plan for one app's skills folder. */
export async function planSkillInstall({ target, files, replace = false }) {
  const destination = join(target, SKILL_NAME), manifestPath = join(target, SKILL_MANIFEST);
  const manifest = await readJson(manifestPath, null);
  const managed = manifest?.skill === SKILL_NAME && manifest.files && typeof manifest.files === 'object' ? manifest.files : {};
  let existing = [];
  try { existing = await listFiles(destination); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const changes = [], removals = [], conflicts = [];
  const inspect = (file, before) => {
    if (before !== null && managed[file] !== before && !replace) conflicts.push({ file, reason: managed[file] ? 'locally-modified' : 'unmanaged' });
  };
  for (const [file, content] of files) {
    let before = null;
    try { before = sha(await readFile(join(destination, file))); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (before === sha(content)) continue;
    inspect(file, before);
    changes.push({ file, before });
  }
  for (const file of existing.filter(file => !files.has(file))) {
    inspect(file, sha(await readFile(join(destination, file))));
    removals.push(file);
  }
  return { target, destination, manifestPath, changes, removals, conflicts,
    manifestCurrent: Object.keys(managed).length === files.size && [...files].every(([file, content]) => managed[file] === sha(content)) };
}

/** Back up, write, record the manifest, verify; restore everything on failure. */
export async function applySkillInstall(plan, files, { backupDir, now = () => new Date() }) {
  if (plan.conflicts.length) throw new Error('Skill install has unresolved conflicts');
  const restored = [];
  const backup = async path => {
    const copy = join(backupDir, relative(plan.target, path));
    try { await mkdir(dirname(copy), { recursive: true }); await copyFile(path, copy); restored.push({ path, copy }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; restored.push({ path, copy: null }); }
  };
  try {
    for (const { file } of plan.changes) {
      const path = join(plan.destination, file);
      await backup(path);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, files.get(file));
    }
    for (const file of plan.removals) {
      const path = join(plan.destination, file);
      await backup(path);
      await unlink(path);
    }
    await backup(plan.manifestPath);
    const recorded = Object.fromEntries([...files].map(([file, content]) => [file, sha(content)]));
    await mkdir(plan.target, { recursive: true });
    await writeFile(plan.manifestPath, JSON.stringify({ version: 1, skill: SKILL_NAME, installedAt: now().toISOString(), files: recorded }, null, 2) + '\n');
    for (const [file, hash] of Object.entries(recorded)) {
      if (sha(await readFile(join(plan.destination, file))) !== hash) throw new Error('Skill parity failed: ' + file);
    }
    return { written: plan.changes.length, removed: plan.removals.length, files: recorded };
  } catch (error) {
    for (const { path, copy } of restored.reverse()) {
      if (copy) await copyFile(copy, path).catch(() => {});
      else await unlink(path).catch(() => {});
    }
    throw error;
  }
}
