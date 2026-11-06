import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { renderTemplate, planSkillInstall, applySkillInstall, SKILL_NAME, SKILL_MANIFEST } from '../installer/skills.mjs';

const run = promisify(execFile);
const setup = fileURLToPath(new URL('../installer/setup.mjs', import.meta.url));
const exists = path => access(path).then(() => true, () => false);

async function temp(t) {
  const root = await mkdtemp(join(tmpdir(), 'agent-bridge-installer-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

// Setup never touches the real home here: --home and --state-root are temporary
// and app detection is a fixture file.
async function runSetup(t, args, { detected, prepare } = {}) {
  const root = await temp(t), home = join(root, 'home'), state = join(root, 'state'), detect = join(root, 'detect.json');
  await writeFile(detect, JSON.stringify(detected ?? { codex: { installed: true, version: '26.1.0.0' },
    claude: { installed: true, version: '4.1.0' }, gemini: { installed: false, version: null } }));
  if (prepare) await prepare({ home, state });
  try {
    const { stdout } = await run(process.execPath, [setup, '--home', home, '--state-root', state, '--detect-file', detect, ...args],
      { encoding: 'utf8', windowsHide: true });
    return { code: 0, stdout, home, state };
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr, home, state };
  }
}

test('templates keep only connected-app blocks and refuse unknown variables', () => {
  const text = 'A<!--if:codex-->C<!--end:codex--><!--ifnot:codex-->N<!--end:codex--><!--if:gemini-->G<!--end:gemini-->{{X}}';
  assert.equal(renderTemplate(text, { vars: { X: '!' }, apps: ['codex', 'claude'] }), 'AC!');
  assert.equal(renderTemplate(text, { vars: { X: '!' }, apps: ['claude', 'gemini'] }), 'ANG!');
  assert.throws(() => renderTemplate('{{Y}}', { vars: {}, apps: [] }), /Unknown skill template variable/);
});

test('skill install records a manifest, upgrades managed files, refuses edits and unmanaged files, and backs up on replace', async t => {
  const root = await temp(t), target = join(root, 'skills');
  const v1 = new Map([['SKILL.md', 'v1'], ['references/commands.md', 'c1'], ['old.md', 'gone later']]);
  const plan = await planSkillInstall({ target, files: v1 });
  assert.equal(plan.changes.length, 3);
  await applySkillInstall(plan, v1, { backupDir: join(root, 'backup-1') });
  assert.equal(JSON.parse(await readFile(join(target, SKILL_MANIFEST), 'utf8')).skill, SKILL_NAME);
  const same = await planSkillInstall({ target, files: v1 });
  assert.deepEqual([same.changes.length, same.removals.length, same.manifestCurrent], [0, 0, true]);

  const v2 = new Map([['SKILL.md', 'v2'], ['references/commands.md', 'c1']]);
  const upgrade = await planSkillInstall({ target, files: v2 });
  assert.deepEqual([upgrade.changes.map(row => row.file), upgrade.removals, upgrade.conflicts], [['SKILL.md'], ['old.md'], []]);
  await applySkillInstall(upgrade, v2, { backupDir: join(root, 'backup-2') });
  assert.equal(await exists(join(target, SKILL_NAME, 'old.md')), false);

  await writeFile(join(target, SKILL_NAME, 'SKILL.md'), 'user edit');
  const edited = await planSkillInstall({ target, files: v1 });
  assert.deepEqual(edited.conflicts.map(row => [row.file, row.reason]), [['SKILL.md', 'locally-modified']]);
  await assert.rejects(applySkillInstall(edited, v1, { backupDir: join(root, 'backup-3') }), /conflicts/);
  const replaced = await planSkillInstall({ target, files: v1, replace: true });
  await applySkillInstall(replaced, v1, { backupDir: join(root, 'backup-4') });
  assert.equal(await readFile(join(root, 'backup-4', SKILL_NAME, 'SKILL.md'), 'utf8'), 'user edit');
  assert.equal(await readFile(join(target, SKILL_NAME, 'SKILL.md'), 'utf8'), 'v1');

  const other = join(root, 'other');
  await mkdir(join(other, SKILL_NAME), { recursive: true });
  await writeFile(join(other, SKILL_NAME, 'SKILL.md'), 'someone else');
  assert.deepEqual((await planSkillInstall({ target: other, files: v1 })).conflicts.map(row => row.reason), ['unmanaged']);
});

test('non-interactive Setup connects the detected apps, renders the skill and prepares registration', async t => {
  const result = await runSetup(t, ['--non-interactive']);
  assert.equal(result.code, 0, result.stderr);
  const skill = await readFile(join(result.home, '.agents', 'skills', SKILL_NAME, 'SKILL.md'), 'utf8');
  assert.match(skill, /연결한 앱: Codex, Claude\./);
  assert.ok(skill.includes("$bridgeRoot = '" + result.state.replaceAll("'", "''") + "'"));
  assert.ok(skill.includes("$bridgeNode = '" + process.execPath.replaceAll("'", "''") + "'"));
  assert.match(skill, /`writing` \| 글쓰기 \| Claude \(원래 Antigravity\(Gemini\)\)/);
  assert.match(skill, /--agent codex/);
  assert.doesNotMatch(skill, /--agent gemini/);
  assert.doesNotMatch(skill, /\{\{|<!--(if|ifnot|end):/);
  assert.equal(await exists(join(result.home, '.claude', 'skills', SKILL_NAME, 'SKILL.md')), true);
  assert.equal(await exists(join(result.home, '.gemini', 'config', 'skills', SKILL_NAME)), false);
  const receipt = JSON.parse(await readFile(join(result.state, '.bridge', 'install-receipt.json'), 'utf8'));
  assert.equal(receipt.status, 'INSTALLED');
  assert.deepEqual(receipt.selected, ['codex', 'claude']);
  assert.deepEqual(receipt.next.map(row => row.app), ['codex', 'claude']);
  assert.deepEqual(JSON.parse(await readFile(join(result.state, '.bridge', 'config.json'), 'utf8')), { version: 1, agents: {} });
  const rerun = await runSetup(t, ['--non-interactive'], { prepare: async () => {} });
  assert.equal(rerun.code, 0, 'a second Setup on a fresh home also succeeds');
});

test('Setup with fewer than two apps installs nothing and exits 3; dry-run writes nothing', async t => {
  const single = await runSetup(t, ['--apps', 'claude']);
  assert.equal(single.code, 3);
  assert.equal(await exists(join(single.home, '.claude', 'skills', SKILL_NAME)), false);
  assert.equal(JSON.parse(await readFile(join(single.state, '.bridge', 'install-receipt.json'), 'utf8')).status, 'needs-two-apps');
  const dry = await runSetup(t, ['--apps', 'claude,antigravity', '--dry-run']);
  assert.equal(dry.code, 0, dry.stderr);
  assert.match(dry.stdout, /"status": "PLANNED"/);
  assert.equal(await exists(join(dry.home, '.claude', 'skills', SKILL_NAME)), false);
  assert.equal(await exists(join(dry.state, '.bridge')), false);
  assert.equal((await runSetup(t, ['--apps', 'claude,copilot'])).code, 1);
});

test('Setup refuses to overwrite an unmanaged agent-bridge skill unless replacement is requested', async t => {
  const mine = async ({ home }) => {
    await mkdir(join(home, '.claude', 'skills', SKILL_NAME), { recursive: true });
    await writeFile(join(home, '.claude', 'skills', SKILL_NAME, 'SKILL.md'), 'my own skill');
  };
  const refused = await runSetup(t, ['--non-interactive'], { prepare: mine });
  assert.equal(refused.code, 1);
  assert.equal(await readFile(join(refused.home, '.claude', 'skills', SKILL_NAME, 'SKILL.md'), 'utf8'), 'my own skill');
  assert.equal(await exists(join(refused.home, '.agents', 'skills', SKILL_NAME)), false, 'no app is changed when any conflicts');
  assert.equal(JSON.parse(await readFile(join(refused.state, '.bridge', 'install-receipt.json'), 'utf8')).status, 'CONFLICT');
  const replaced = await runSetup(t, ['--non-interactive', '--replace-skills'], { prepare: mine });
  assert.equal(replaced.code, 0, replaced.stderr);
  assert.match(await readFile(join(replaced.home, '.claude', 'skills', SKILL_NAME, 'SKILL.md'), 'utf8'), /에이전트 브리지/);
});
