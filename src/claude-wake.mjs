import { readdir, readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { powershell } from './runtime.mjs';
import { findClaudeTranscript } from './claude-observation.mjs';
import { enqueueClaudeUiRecovery } from './claude-ui-recovery.mjs';

const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const host=value=>typeof value==='string'&&value.startsWith('local_')&&uuid(value.slice(6));
const hash=value=>createHash('sha256').update(value).digest('hex');
const failed=reasonCode=>({ready:false,reasonCode});

/** Only an existing, uniquely owned, nonarchived Desktop record is eligible.
 * No title lookup, fabricated local_<runtime> ID, settings write or CLI clone. */
export async function readClaudeWakeTarget(target,config={}) {
  if(!host(target?.hostSessionId))return failed('claude-wake-host-required');
  const base=join(config.home??homedir(),'AppData','Roaming','Claude','claude-code-sessions');
  const accounts=(await readdir(base,{withFileTypes:true}).catch(()=>[])).filter(x=>x.isDirectory()&&uuid(x.name));
  if(accounts.length>64)return failed('claude-wake-metadata-unavailable');
  const matches=[];let count=0;
  for(const account of accounts) {
    const orgs=(await readdir(join(base,account.name),{withFileTypes:true})).filter(x=>x.isDirectory()&&uuid(x.name));
    for(const org of orgs) {
      if(++count>256)return failed('claude-wake-metadata-unavailable');
      const path=join(base,account.name,org.name,target.hostSessionId+'.json');
      try {
        const info=await stat(path);if(info.size>2*1024*1024)return failed('claude-wake-metadata-unavailable');
        const row=JSON.parse(await readFile(path,'utf8'));
        if(row.sessionId!==target.hostSessionId||!uuid(row.cliSessionId)||typeof row.title!=='string'||!row.title.trim())return failed('claude-wake-metadata-unavailable');
        matches.push({hostSessionId:row.sessionId,sessionId:row.cliSessionId,title:row.title,isArchived:row.isArchived===true});
      }catch(error){if(error.code!=='ENOENT')return failed('claude-wake-metadata-unavailable');}
    }
  }
  if(matches.length!==1)return failed(matches.length?'claude-wake-metadata-ambiguous':'claude-wake-conversation-missing');
  if(matches[0].isArchived)return failed('claude-wake-conversation-archived');
  return {ready:true,...matches[0]};
}

export async function findClaudeDesktopExecutable(config={}) {
  const base=join(config.home??homedir(),'AppData','Local','AnthropicClaude');
  const expected=resolve(base).replaceAll('\\','/').toLowerCase()+'/';
  const valid=value=>typeof value==='string'&&value.replaceAll('\\','/').toLowerCase().startsWith(expected)
    &&/^app-\d+(?:\.\d+)*\/claude\.exe$/.test(value.replaceAll('\\','/').toLowerCase().slice(expected.length));
  try {
    const rows=JSON.parse(await powershell(`$rows=@(Get-CimInstance Win32_Process -Filter "Name = 'claude.exe'" | Select-Object -ExpandProperty ExecutablePath);ConvertTo-Json -InputObject $rows -Compress`));
    const paths=[...new Set(rows.filter(valid))];if(paths.length===1)return paths[0];if(paths.length>1)return null;
  }catch{/* An installed app can still be launched when it has no process. */}
  const versions=(await readdir(base).catch(()=>[])).filter(x=>/^app-\d+(?:\.\d+)*$/.test(x)).sort((a,b)=>b.localeCompare(a,undefined,{numeric:true}));
  for(const version of versions){const path=join(base,version,'claude.exe');if((await stat(path).catch(()=>null))?.isFile())return path;}
  return null;
}

/** Prepare an exact-session local recovery job for the registered Codex chat.
 * The native Codex tool wakes its existing chat, whose supported Computer Use
 * tools perform one UI delivery. This readiness is not Claude receipt. */
export async function wakeClaude(target,config={},options={}) {
  const stored=await (options.readTarget??readClaudeWakeTarget)(target,config);
  if(!stored.ready)return stored;
  if(!config.agents?.codex?.threadId||!config.codexCallerThreadId)return failed('claude-wake-codex-executor-unavailable');
  return {ready:true,method:'claude-desktop-ui',reasonCode:'claude-ui-recovery-dispatch-ready'};
}

/** Exact native user-record proof for an already persisted UI delivery attempt.
 * Hash equality is checked over the entire submitted prompt; neither a quoted
 * bridge ID nor assistant text is receipt. Native UUID is reported separately. */
export async function inspectClaudeUiReceipt(target,config,message,options={}) {
  const attempt=options.uiReceipt;
  if(!host(target?.hostSessionId)||!uuid(target?.sessionId)||!uuid(message?.id)
    ||!Number.isFinite(Date.parse(attempt?.attemptedAt))||! /^[a-f0-9]{64}$/.test(attempt?.promptSha256??''))return null;
  const location=await(options.findTranscript??findClaudeTranscript)(target,config);
  if(!location.path)return null;
  const before=await stat(location.path);if(before.size>256*1024*1024)return null;
  const stream=createReadStream(location.path,{start:0,end:Math.max(0,before.size-1),encoding:'utf8'});
  const lines=createInterface({input:stream,crlfDelay:Infinity});let found;
  try {
    for await(const line of lines) {
      if(line.length>8*1024*1024)continue;
      let row;try{row=JSON.parse(line);}catch{continue;}
      if(row.type!=='user'||!uuid(row.uuid)||row.origin?.kind==='peer')continue;
      const ids=[row.sessionId,row.session_id].filter(x=>x!==undefined);
      if(!ids.length||ids.some(x=>x!==target.sessionId))continue;
      const at=Date.parse(row.timestamp);if(!Number.isFinite(at)||at<Date.parse(attempt.attemptedAt))continue;
      const content=row.message?.content;
      const text=typeof content==='string'?content:Array.isArray(content)&&content.every(x=>x.type==='text')?content.map(x=>x.text).join(''):null;
      if(typeof text!=='string'||hash(text)!==attempt.promptSha256)continue;
      found={state:'recipient-observed',transport:'claude-desktop-ui',sessionId:target.sessionId,
        executionState:'unknown',reasonCode:'claude-ui-native-transcript-message-found',observedAt:new Date().toISOString(),
        evidence:{source:'claude-native-ui-transcript',messageId:message.id,recordUuid:row.uuid,hostSessionId:target.hostSessionId,
          timestamp:row.timestamp,promptSha256:attempt.promptSha256,
          ...(['bypassPermissions','default','plan','acceptEdits','dontAsk','auto'].includes(row.permissionMode)
            ?{recipientPermissionMode:row.permissionMode}:{})},nextAction:'none'};break;
    }
  }finally{lines.close();stream.destroy();}
  const after=await stat(location.path).catch(()=>null);
  return !after||after.ino!==before.ino||after.dev!==before.dev||after.size<before.size
    ||after.size===before.size&&after.mtimeMs!==before.mtimeMs?null:found??null;
}

export async function sendClaudeDesktopUi(target,prompt,config,message,options={}) {
  const stored=await(options.readTarget??readClaudeWakeTarget)(target,config);
  if(!stored.ready)throw Object.assign(new Error(stored.reasonCode),{code:'CLAUDE_UI_TARGET_NOT_READY',delivery:{submitted:false,phase:'preflight',retryable:false}});
  const attempt=options.uiReceipt;
  if(!attempt||attempt.promptSha256!==hash(prompt)||!Number.isFinite(Date.parse(attempt.attemptedAt)))throw new Error('Missing persisted Claude UI attempt');
  const result=await(options.enqueue??enqueueClaudeUiRecovery)(stored,prompt,config,message,options);
  return {...result,sessionId:stored.sessionId,
    runtimeResolution:{hostSessionId:stored.hostSessionId,requestedSessionId:target.sessionId,
      resolvedSessionId:stored.sessionId,matchedBy:'host-session-id',source:'desktop-stored-session'},
  };
}
