import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,isAbsolute} from 'node:path';
import {installClaudeLifecycle,validateLifecycleRoots,lifecycleEntry} from '../src/claude-hook-install.mjs';

async function fixture(t) {
  const base=await mkdtemp(join(tmpdir(),'bridge-hooks-'));
  t.after(()=>rm(base,{recursive:true,force:true}));
  const root=join(base,'한글 프로젝트 with spaces');await mkdir(root);
  return {root,path:join(root,'.claude','settings.local.json'),registry:join(root,'.bridge','lifecycle-roots.json')};
}
const readJson=async path=>JSON.parse((await readFile(path,'utf8')).replace(/^\uFEFF/,''));

test('project hook install preserves permissions, unrelated hooks and absolute paths with spaces',async t=>{
  const f=await fixture(t);
  const initial={permissions:{allow:['Read'],deny:['Bash(unsafe:*)'],defaultMode:'default'},
    env:{UNRELATED_SETTING:'retained'},hooks:{
      SessionStart:[{matcher:'startup',hooks:[{type:'command',command:'echo existing-start'}]}],
      Stop:[{matcher:'',hooks:[{type:'command',command:'echo existing-stop'}]}],
      PreToolUse:[{matcher:'Read',hooks:[{type:'command',command:'echo existing-read'}]}]
    }};
  await mkdir(join(f.root,'.claude'));await writeFile(f.path,JSON.stringify(initial));
  const installed=await installClaudeLifecycle({root:f.root});
  assert.equal(installed.installed,true);assert.equal(installed.scope,'project');
  assert.equal(installed.desktopWakeSupported,false);assert.equal(installed.backgroundProcessInstalled,false);
  assert.equal(installed.settingsPath,f.path);assert.equal(installed.registryFile,f.registry);
  const saved=await readJson(f.path),registry=await readJson(f.registry);
  assert.deepEqual(saved.permissions,initial.permissions);assert.deepEqual(saved.env,initial.env);
  assert.deepEqual(saved.hooks.PreToolUse,initial.hooks.PreToolUse);
  assert.deepEqual(saved.hooks.SessionStart[0],initial.hooks.SessionStart[0]);
  assert.deepEqual(saved.hooks.Stop[0],initial.hooks.Stop[0]);
  assert.deepEqual(registry,{version:1,roots:[resolve(f.root)]});
  for(const event of ['SessionStart','Stop','SessionEnd']) {
    const own=saved.hooks[event].flatMap(entry=>entry.hooks).find(hook=>hook.args?.[0]===lifecycleEntry);
    assert.equal(own.command,process.execPath);assert.equal(isAbsolute(own.command),true);
    assert.deepEqual(own.args,[lifecycleEntry,'--registry-file',f.registry]);
    assert.equal(isAbsolute(own.args[0]),true);assert.equal(own.timeout,12);
  }
  assert.deepEqual(await readJson(join(f.root,'.bridge','lifecycle-settings.before.json')),initial);
});

test('repeat installation is idempotent and uninstall preserves edits made after installation',async t=>{
  const f=await fixture(t);await installClaudeLifecycle({root:f.root});
  const first=await readFile(f.path,'utf8'),registry=await readFile(f.registry,'utf8');
  await installClaudeLifecycle({root:f.root});
  assert.equal(await readFile(f.path,'utf8'),first);assert.equal(await readFile(f.registry,'utf8'),registry);
  const edited=await readJson(f.path);edited.permissions={defaultMode:'plan'};
  edited.hooks.SessionStart[0].hooks.push({type:'command',command:'echo later-user-hook'});
  edited.hooks.Notification=[{matcher:'permission_prompt',hooks:[{type:'command',command:'echo notify'}]}];
  await writeFile(f.path,JSON.stringify(edited));
  const removed=await installClaudeLifecycle({root:f.root,uninstall:true});
  assert.equal(removed.installed,false);
  const saved=await readJson(f.path);
  assert.deepEqual(saved.permissions,edited.permissions);
  assert.deepEqual(saved.hooks.Notification,edited.hooks.Notification);
  assert.deepEqual(saved.hooks.SessionStart[0].hooks,[{type:'command',command:'echo later-user-hook'}]);
  assert.equal(saved.hooks.Stop,undefined);assert.equal(saved.hooks.SessionEnd,undefined);
  assert.deepEqual(await readJson(f.registry),{version:1,roots:[]});
  assert.deepEqual(await readJson(join(f.root,'.bridge','lifecycle-settings.before.json')),{});
});

test('registry changes are bounded to the installed project and removing it retains another explicitly registered project',async t=>{
  const f=await fixture(t),other=join(f.root,'another-project');await mkdir(other);
  await mkdir(join(f.root,'.bridge'));await writeFile(f.registry,JSON.stringify({version:1,roots:[other]}));
  await installClaudeLifecycle({root:f.root});
  assert.deepEqual((await readJson(f.registry)).roots,[other,f.root]);
  await installClaudeLifecycle({root:f.root,uninstall:true});
  assert.deepEqual((await readJson(f.registry)).roots,[other]);
});

test('invalid installation inputs fail before replacing existing settings',async t=>{
  const f=await fixture(t);await mkdir(join(f.root,'.claude'));
  const invalid=JSON.stringify({permissions:{defaultMode:'default'},hooks:{Stop:'not-an-array'}});
  await writeFile(f.path,invalid);
  await assert.rejects(()=>installClaudeLifecycle({root:f.root}),/Invalid Claude hook entries/);
  assert.equal(await readFile(f.path,'utf8'),invalid);
  await assert.rejects(()=>installClaudeLifecycle({root:'relative-project'}),/absolute project root/);
  assert.throws(()=>validateLifecycleRoots({version:1,roots:['relative']}),/Invalid lifecycle registry/);
  assert.throws(()=>validateLifecycleRoots({version:2,roots:[]}),/Invalid lifecycle registry/);
});
