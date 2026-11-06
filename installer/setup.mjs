#!/usr/bin/env node
// agent-bridge Setup: detect the installed apps, let the user pick which to
// connect (two or three), install the rendered skill into each picked app and
// prepare the registration folder. Chats are registered afterwards, from each
// chat, with `join`. Nothing here changes an app's settings or permissions.
import { readFile, writeFile, readdir, mkdir, access } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENTS } from '../src/protocol.mjs';
import { readWindowsAppVersion } from '../src/app-versions.mjs';
import { loadRoutingProfile, routingProfileForApps, DEFAULT_ROUTING_PROFILE } from '../src/routing.mjs';
import { SKILL_NAME, skillTargets, renderSkillFiles, planSkillInstall, applySkillInstall } from './skills.mjs';

const LABEL = Object.freeze({ codex: 'Codex', claude: 'Claude', gemini: 'Antigravity(Gemini)' });
const installRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const exists = path => access(path).then(() => true, () => false);
const psQuote = value => String(value).replaceAll("'", "''");
const USAGE = `Usage: setup.mjs [--apps codex,claude,gemini] [--non-interactive] [--replace-skills] [--dry-run]
                [--home DIR] [--state-root DIR] [--detect-file JSON]`;

function parseArgs(argv) {
  const flags = new Set(['--non-interactive', '--replace-skills', '--dry-run', '--help']);
  const valued = new Set(['--apps', '--home', '--state-root', '--detect-file']);
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (flags.has(arg)) options[arg.slice(2)] = true;
    else if (valued.has(arg) && argv[index + 1] !== undefined) options[arg.slice(2)] = argv[++index];
    else throw new Error('Unknown or incomplete argument: ' + arg + '\n' + USAGE);
  }
  return options;
}

function parseApps(text) {
  const apps = text.split(',').map(value => value.trim().toLowerCase()).filter(Boolean)
    .map(value => ({ antigravity: 'gemini', 'claude-desktop': 'claude' }[value] ?? value));
  const unknown = apps.filter(app => !AGENTS.includes(app));
  if (unknown.length) throw new Error('Unknown app: ' + unknown.join(', ') + ' (use codex, claude, gemini)');
  return AGENTS.filter(app => apps.includes(app));
}

/** Installed apps via metadata only: Codex MSIX package, Claude Desktop install
 * folder, Antigravity executable. */
async function detectApps(home) {
  const [codex, gemini] = await Promise.all([readWindowsAppVersion('codex', { home }), readWindowsAppVersion('gemini', { home })]);
  const claudeVersions = (await readdir(join(home, 'AppData', 'Local', 'AnthropicClaude')).catch(() => []))
    .filter(name => /^app-\d+(?:\.\d+)*$/.test(name)).map(name => name.slice(4))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  return { codex: { installed: Boolean(codex.version), version: codex.version },
    claude: { installed: claudeVersions.length > 0, version: claudeVersions[0] ?? null },
    gemini: { installed: Boolean(gemini.version), version: gemini.version } };
}

async function chooseApps(detected, options) {
  if (options.apps) return parseApps(options.apps);
  const installed = AGENTS.filter(app => detected[app]?.installed);
  if (options['non-interactive']) return installed;
  console.log('\n설치된 앱');
  AGENTS.forEach((app, index) => console.log(`  ${index + 1}. ${LABEL[app]}  ${detected[app]?.installed
    ? '(설치됨' + (detected[app].version ? ' ' + detected[app].version : '') + ')' : '(찾지 못함)'}`));
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await prompt.question(`\n연결할 앱 번호를 쉼표로 입력하세요 (Enter = 설치된 앱 모두: ${installed.map(app => LABEL[app]).join(', ') || '없음'}): `)).trim();
    if (!answer) return installed;
    const picked = answer.split(/[,\s]+/).filter(Boolean).map(value => AGENTS[Number(value) - 1]);
    if (picked.some(app => !app)) throw new Error('1, 2, 3 중에서 고르세요.');
    return AGENTS.filter(app => picked.includes(app));
  } finally { prompt.close(); }
}

function rolesTable(profile) {
  const name = { logic: '논리·코딩', backend: '백엔드', analysis: '분석', coordination: '조율', supervision: '감독·검토',
    writing: '글쓰기', revision: '개고·다듬기' };
  return ['| task-type | 하는 일 | 맡는 앱 |', '|---|---|---|', ...profile.routes.map(route =>
    `| \`${route.taskType}\` | ${name[route.taskType] ?? route.taskType} | ${LABEL[route.app]}${route.reassignedFrom ? ` (원래 ${LABEL[route.reassignedFrom]})` : ''} |`)].join('\n');
}

function missingNotes(apps) {
  const notes = [];
  if (!apps.includes('codex')) notes.push('Codex가 없어 논리·코딩·분석은 다른 앱이 맡는다. 닫힌 Claude 채팅을 자동으로 다시 여는 기능도 쓸 수 없다. 메시지는 대기했다가 그 채팅을 다시 열면 전달된다.');
  if (!apps.includes('claude')) notes.push('Claude가 없어 조율·감독은 Codex가 맡는다.');
  if (!apps.includes('gemini')) notes.push('Antigravity가 없어 글쓰기·개고는 Claude(없으면 Codex)가 맡는다.');
  return notes.length ? notes.map(note => '- ' + note).join('\n') : '- 세 앱이 모두 연결되어 기본 분업을 그대로 쓴다.';
}

function joinCommand(stateRoot, app) {
  return `& '${psQuote(process.execPath)}' '${psQuote(join(installRoot, 'bin', 'agent-bridge.mjs'))}' join --root '${psQuote(stateRoot)}' --agent ${app}`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { console.log(USAGE); return 0; }
  if (process.platform !== 'win32' && !options.home) throw new Error('agent-bridge는 Windows용입니다.');
  const home = resolve(options.home ?? homedir());
  const stateRoot = resolve(options['state-root'] ?? installRoot);
  const detected = options['detect-file'] ? JSON.parse(await readFile(options['detect-file'], 'utf8')) : await detectApps(home);
  const apps = await chooseApps(detected, options);
  const receiptPath = join(stateRoot, '.bridge', 'install-receipt.json');
  const receipt = { version: 1, at: new Date().toISOString(), installRoot, stateRoot, node: process.execPath, nodeVersion: process.version,
    detected, selected: apps };
  const save = async value => { await mkdir(dirname(receiptPath), { recursive: true }); await writeFile(receiptPath, JSON.stringify(value, null, 2) + '\n'); };

  if (apps.length < 2) {
    console.log('\n에이전트 브리지는 서로 다른 앱 두 개 이상(Codex·Claude·Antigravity 중)을 이어 줄 때 쓸 수 있습니다.');
    console.log(`지금 고른 앱: ${apps.map(app => LABEL[app]).join(', ') || '없음'}. 다른 앱을 하나 더 설치한 뒤 Setup을 다시 실행하세요.`);
    console.log('한 앱 안에서 여러 일을 나누려면 그 앱의 서브에이전트 기능을 쓰면 됩니다.');
    if (!options['dry-run']) await save({ ...receipt, status: 'needs-two-apps' });
    return 3;
  }
  const notInstalled = apps.filter(app => !detected[app]?.installed);
  if (notInstalled.length) console.log(`\n주의: ${notInstalled.map(app => LABEL[app]).join(', ')}을(를) 찾지 못했습니다. 설치 후 그 앱에서 새 채팅을 열면 스킬이 보입니다.`);

  const profile = routingProfileForApps(await loadRoutingProfile(DEFAULT_ROUTING_PROFILE), apps);
  const cli = join(installRoot, 'bin', 'agent-bridge.mjs');
  const files = await renderSkillFiles(join(installRoot, 'installer', 'skill-template'), { apps, vars: {
    APPS: apps.map(app => LABEL[app]).join(', '), NODE_PS: psQuote(process.execPath), CLI_PS: psQuote(cli),
    ROOT_PS: psQuote(stateRoot), ROLES: rolesTable(profile), MISSING: missingNotes(apps) } });
  const targets = skillTargets(home), plans = [];
  for (const app of apps) plans.push({ app, ...await planSkillInstall({ target: targets[app], files, replace: options['replace-skills'] === true }) });
  const conflicts = plans.flatMap(plan => plan.conflicts.map(conflict => ({ app: plan.app, target: plan.destination, ...conflict })));
  const summary = plans.map(plan => ({ app: plan.app, target: plan.destination, write: plan.changes.length, remove: plan.removals.length }));
  if (conflicts.length) {
    console.log('\n이미 있는 스킬 파일과 충돌해 아무것도 바꾸지 않았습니다. 내용을 확인한 뒤 바꿔도 되면 -ReplaceSkills로 다시 실행하세요.');
    for (const conflict of conflicts) console.log(`  ${LABEL[conflict.app]}: ${conflict.target}\\${conflict.file} (${conflict.reason})`);
    if (!options['dry-run']) await save({ ...receipt, status: 'CONFLICT', conflicts });
    return 1;
  }
  if (options['dry-run']) { console.log(JSON.stringify({ status: 'PLANNED', apps, skills: summary }, null, 2)); return 0; }

  const stamp = receipt.at.replace(/[:.]/g, '-'), installed = [];
  for (const plan of plans) {
    const result = await applySkillInstall(plan, files, { backupDir: join(stateRoot, '.bridge', 'skill-backups', stamp, plan.app) });
    installed.push({ app: plan.app, target: plan.destination, written: result.written, removed: result.removed, files: Object.keys(result.files).length });
  }
  const configPath = join(stateRoot, '.bridge', 'config.json');
  const configCreated = !await exists(configPath);
  if (configCreated) {
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, JSON.stringify({ version: 1, agents: {} }, null, 2) + '\n', { flag: 'wx' });
  }
  const registration = JSON.parse(await readFile(configPath, 'utf8'));
  const registered = AGENTS.filter(app => registration.agents?.[app]);
  const next = apps.map(app => ({ app, say: '에이전트 브리지에 이 채팅을 등록해줘', command: joinCommand(stateRoot, app) }));
  await save({ ...receipt, status: 'INSTALLED', skill: SKILL_NAME, skills: installed, configCreated, registered,
    roles: profile.routes.map(route => ({ taskType: route.taskType, app: route.app })), next });

  console.log(`\n설치를 마쳤습니다. 연결할 앱: ${apps.map(app => LABEL[app]).join(', ')}`);
  for (const item of installed) console.log(`  스킬: ${LABEL[item.app]} → ${item.target}`);
  console.log('\n다음 단계');
  console.log('  1. 각 앱에서 함께 일할 채팅을 새로 엽니다. 스킬은 새로 연 채팅부터 보입니다.');
  console.log('  2. 그 채팅에 이렇게 말합니다: "에이전트 브리지에 이 채팅을 등록해줘"');
  console.log('  3. 모든 앱을 등록했으면 아무 채팅에서나: "브리지 연결 시험해줘"');
  console.log('\n채팅이 스킬을 못 찾으면, 그 채팅에 아래 명령을 실행하라고 말하세요.');
  for (const item of next) console.log(`  ${LABEL[item.app]}: ${item.command}`);
  console.log('  (Codex·Antigravity는 출력에 나온 next 명령을 한 번 더 실행합니다.)');
  return 0;
}

main().then(code => { process.exitCode = code; }, error => {
  console.error(JSON.stringify({ error: error.message }));
  process.exitCode = 1;
});
