import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, isAbsolute, resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const lifecycleEntry = fileURLToPath(new URL('../bin/agent-bridge-lifecycle.mjs', import.meta.url));
const events=['SessionStart','Stop','SessionEnd'];
const samePath=(a,b)=> typeof a==='string' && typeof b==='string'
  && (process.platform==='win32' ? resolve(a).toLowerCase()===resolve(b).toLowerCase() : resolve(a)===resolve(b));

async function readJson(path,fallback) {
  try{return JSON.parse((await readFile(path,'utf8')).replace(/^\uFEFF/,''));}
  catch(error){if(error.code==='ENOENT')return fallback;throw error;}
}
async function replaceJson(path,value) {
  await mkdir(dirname(path),{recursive:true});
  const temp=path+'.'+randomUUID()+'.tmp';
  await writeFile(temp,JSON.stringify(value,null,2)+'\n',{flag:'wx'});
  await rename(temp,path);
}
export function validateLifecycleRoots(value) {
  if(value?.version!==1 || !Array.isArray(value.roots) || value.roots.length>20
    || !value.roots.every(root=>typeof root==='string'&&isAbsolute(root))) throw new Error('Invalid lifecycle registry');
  return [...new Set(value.roots.map(root=>resolve(root)))];
}

/** Project-local install only. It does not write global Claude settings or
 * register other workspaces. Existing unrelated hooks and permissions survive. */
export async function installClaudeLifecycle({root,registryFile,uninstall=false}={}) {
  if(!root || !isAbsolute(root))throw new Error('Lifecycle installation requires an absolute project root');
  root=resolve(root); registryFile=resolve(registryFile??join(root,'.bridge','lifecycle-roots.json'));
  const path=join(root,'.claude','settings.local.json');
  const settings=await readJson(path,{});
  if(!settings || typeof settings!=='object' || Array.isArray(settings)
    || settings.hooks && (typeof settings.hooks!=='object'||Array.isArray(settings.hooks)))throw new Error('Invalid Claude project settings');
  const hooks={...settings.hooks};
  for(const event of events) {
    if(hooks[event]!==undefined && !Array.isArray(hooks[event]))throw new Error('Invalid Claude hook entries');
    const entries=(hooks[event]??[]).map(entry=>{
      if(!entry || !Array.isArray(entry.hooks))throw new Error('Invalid Claude hook group');
      return {...entry,hooks:entry.hooks.filter(hook=>!(hook.type==='command'
        && Array.isArray(hook.args) && samePath(hook.args[0],lifecycleEntry)
        && hook.args[1]==='--registry-file'))};
    }).filter(entry=>entry.hooks.length);
    if(!uninstall)entries.push({...(event==='SessionStart'?{matcher:'startup|resume'}:{}),hooks:[{
      type:'command',command:process.execPath,args:[lifecycleEntry,'--registry-file',registryFile],timeout:12
    }]});
    if(entries.length)hooks[event]=entries;else delete hooks[event];
  }
  const registry=await readJson(registryFile,{version:1,roots:[]});
  const roots=validateLifecycleRoots(registry).filter(value=>!samePath(value,root));
  if(!uninstall)roots.push(root);
  validateLifecycleRoots({version:1,roots});
  // Keep an exact pre-install settings backup once; never change app permissions.
  if(!uninstall) {
    const backup=join(root,'.bridge','lifecycle-settings.before.json');
    await mkdir(dirname(backup),{recursive:true});
    try{await writeFile(backup,JSON.stringify(settings,null,2)+'\n',{flag:'wx'});}
    catch(error){if(error.code!=='EEXIST')throw error;}
  }
  await replaceJson(registryFile,{version:1,roots});
  const result={...settings};
  if(Object.keys(hooks).length)result.hooks=hooks;else delete result.hooks;
  await replaceJson(path,result);
  const saved=await readJson(path,null),savedRoots=validateLifecycleRoots(await readJson(registryFile,null));
  if(JSON.stringify(saved)!==JSON.stringify(result) || !uninstall && !savedRoots.some(value=>samePath(value,root))) {
    throw new Error('Lifecycle installation readback mismatch');
  }
  return {installed:!uninstall,scope:'project',root,settingsPath:path,registryFile,events:uninstall?[]:events,
    desktopWakeSupported:false,backgroundProcessInstalled:false};
}
