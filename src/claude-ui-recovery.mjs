import { mkdir, readdir, readFile, writeFile, rename, link, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { assertId, validateEnvelope } from './protocol.mjs';
import { withEndpointLock } from './transport-runtime.mjs';
import { callCodexTool } from './adapters/codex.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
const consumer=value=>{if(typeof value!=='string'||!/^[-_a-zA-Z0-9]{1,100}$/.test(value))throw new Error('Stable UI recovery consumer ID required');return value;};
const paths=(root,id)=>{root=resolve(root);assertId(id);const dir=join(root,'.bridge','ui-recovery');return {root,dir,job:join(dir,id+'.json'),prompt:join(dir,id+'.prompt.txt')};};
const read=async path=>JSON.parse(await readFile(path,'utf8'));
const executorUnavailable=()=>Object.assign(new Error('Registered Codex UI executor is unavailable'),{
  code:'CLAUDE_UI_EXECUTOR_UNAVAILABLE',delivery:{submitted:false,phase:'preflight',retryable:false}});
const save=async(path,value)=>{const temporary=path+'.tmp-'+randomUUID();await writeFile(temporary,JSON.stringify(value,null,2)+'\n',{flag:'wx'});await rename(temporary,path);};
async function create(path,value){const temporary=path+'.tmp-'+randomUUID();await writeFile(temporary,value,{flag:'wx'});try{await link(temporary,path);return true;}catch(error){if(error.code==='EEXIST')return false;throw error;}finally{await unlink(temporary).catch(()=>{});}}

export function claudeUiRecoveryPrompt(job,root) {
  const cli=fileURLToPath(new URL('../bin/agent-bridge-ui.mjs',import.meta.url));
  return `[agent-bridge local UI recovery | original message ${job.messageId}]\n`+
    `The user asked agent-bridge to deliver to this existing dormant Claude conversation without manual restart/resend. This is local recovery coordination, not a new peer task. Preserve the original Claude host/session and bridge message ID.\n`+
    `Workspace: ${root}\nJob: ${paths(root,job.messageId).job}\nNode executable: ${process.execPath}\nRecovery CLI: ${cli}\n`+
    `1. Choose one stable consumer ID for this job. Run the CLI prepare --root <workspace> --id ${job.messageId} --consumer-id <ID>. Continue only when ready:true. It returns exact host, native session, title, app path, deep link, promptFile and promptSha256.\n`+
    `2. Use only the available Computer Use JS tools following their skill. If needed open the returned deep link through the returned installed app normally. Do not use direct PowerShell UI Automation, execution-policy bypass, debugging ports, token edits, permission changes, new chats or a different executor. Select the existing exact Claude conversation. After navigation obtain a fresh UI observation: documentUrl and title must equal prepare's values, the visible screenshot must agree, and the composer must be empty. Stale element indexes or mismatched screenshot/accessibility data require a new observation before any input. Preserve any existing draft.\n`+
    `3. Read promptFile as UTF-8 and type its exact full content into the verified composer. Do not paraphrase, add an activation message, or change the original Message ID. BEFORE arm or submit, reobserve the document URL and title and read the actual composer document_text through Computer Use. Require the same exact URL/title and SHA-256 of the entire actual composer UTF-8 text equal to promptSha256. Do not use a substring, visual abbreviation, or the source prompt as proof of the inserted content. If identity or content differs, do not submit: clear only an exact unchanged draft that equals the text you just inserted, reselect the original conversation once, and repeat these observations. Preserve any other draft; a second mismatch is claude-ui-target-mismatch.\n`+
    `4. Only after these checks run arm with the same root/id/consumer-id. Continue only when armed:true, submit once, refresh the exact UI, and run finish with the same arguments. Once armed, never type or submit again, including after a timeout, application restart, trust approval or failed finish; only finish/check may observe the original delivery. If prepare/arm says already armed, run finish once without resubmitting.\n`+
    `5. A native workspace trust/approval dialog, login request or locked app is a real blocker: do not approve it or change permission mode. Run fail --reason claude-workspace-trust-required, claude-native-approval-required, claude-login-required or claude-app-locked as appropriate, even if already armed, then ask the user for the indicated native action and release Computer Use. For other blockers use fail --reason <short-code>. After a user's native action, finish observes the existing original delivery; it does not authorize another submission. Never invent a receipt, send an ACK, or poll. Report only completion or a real blocker, then release Computer Use.\n`+
    `The queued Claude work keeps its original permission boundaries and claim-v1 guard. Actual receipt means an exact native user transcript record matching this job's full prompt hash, session, and attempt time; transport acceptance alone is not receipt.`;
}

/** One durable UI job per original bridge message. Dispatch intent is saved
 * before calling Codex so a response lost after queueing cannot redispatch it. */
export async function enqueueClaudeUiRecovery(target,prompt,config,message,options={}) {
  if(!options.bridgeRoot)throw new Error('Bridge root is required for UI recovery');
  const p=paths(options.bridgeRoot,message.id),attempt=options.uiReceipt;
  if(!attempt||attempt.promptSha256!==sha(prompt)||!Number.isFinite(Date.parse(attempt.attemptedAt)))throw new Error('Persisted exact UI attempt is required');
  const codex=config.agents?.codex;
  if(!codex?.threadId||!config.codexCallerThreadId)throw new Error('Registered Codex UI executor is unavailable');
  await mkdir(p.dir,{recursive:true});
  return withEndpointLock('claude-ui-job:'+p.root+':'+message.id,async()=>{
    let job;try{job=await read(p.job);}catch(error){if(error.code!=='ENOENT')throw error;}
    if(job){
      if(job.hostSessionId!==target.hostSessionId||job.promptSha256!==attempt.promptSha256)throw new Error('UI recovery identity mismatch');
      if(job.state==='dispatch-not-submitted')throw executorUnavailable();
      return {state:'ui-handoff-queued',transport:'codex-ui-recovery',messageId:message.id,jobState:job.state,reused:true};
    }
    const raw=await readFile(join(p.root,'.bridge','messages',message.id+'.json'),'utf8');
    const original=validateEnvelope(JSON.parse(raw));
    if(original.id!==message.id||original.to!=='claude'||original.recipientSession?.hostSessionId!==target.hostSessionId)throw new Error('UI job does not match original persisted route');
    if(!await create(p.prompt,prompt)){
      if(sha(await readFile(p.prompt,'utf8'))!==attempt.promptSha256)throw new Error('Existing recovery prompt differs');
    }
    job={version:1,messageId:message.id,hostSessionId:target.hostSessionId,sessionId:target.sessionId,
      title:target.title,promptSha256:attempt.promptSha256,attemptedAt:attempt.attemptedAt,
      envelopeSha256:sha(raw),createdAt:new Date().toISOString(),state:'dispatching',
      executor:{threadId:codex.threadId,hostId:codex.hostId??'local'}};
    await save(p.job,job);
    try {
      await(options.callCodex??callCodexTool)('send_message_to_thread',{...job.executor,prompt:claudeUiRecoveryPrompt(job,p.root)},
        {callerThreadId:config.codexCallerThreadId,responseTimeoutMs:options.responseTimeoutMs??120000});
      job.state='queued';job.dispatchedAt=new Date().toISOString();await save(p.job,job);
    }catch(error){
      job.state=error.delivery?.submitted===false?'dispatch-not-submitted':'dispatch-unconfirmed';
      job.dispatchError='codex-ui-handoff-unconfirmed';await save(p.job,job);
      if(job.state==='dispatch-not-submitted')throw executorUnavailable();
    }
    return {state:'ui-handoff-queued',transport:'codex-ui-recovery',messageId:message.id,jobState:job.state};
  });
}

/** The UI delivery owner is independent of the target model's work claim.
 * prepare/arm never claim or acknowledge the original Claude task. */
export async function runClaudeUiRecovery(command,{root,id,consumerId,reason}={},options={}) {
  const p=paths(root,id);consumer(consumerId);
  return withEndpointLock('claude-ui-job:'+p.root+':'+id,async()=>{
    const job=await read(p.job);
    if(job.version!==1||job.messageId!==id)throw new Error('Invalid UI job');
    const raw=await readFile(join(p.root,'.bridge','messages',id+'.json'),'utf8');
    const message=validateEnvelope(JSON.parse(raw));
    if(sha(raw)!==job.envelopeSha256||message.recipientSession?.hostSessionId!==job.hostSessionId
      ||sha(await readFile(p.prompt,'utf8'))!==job.promptSha256)throw new Error('UI job input or route changed');
    const config=await read(join(p.root,'.bridge','config.json'));
    const events=[];
    for(const name of await readdir(join(p.root,'.bridge','receipts'))) {
      if(!name.endsWith('.json'))continue;const event=await read(join(p.root,'.bridge','receipts',name));
      if(event.messageId===id)events.push(event);
    }
    if(!events.some(event=>event.state==='delivery-attempt'&&event.recoveryMethod==='claude-desktop-ui'
      &&event.promptSha256===job.promptSha256&&event.createdAt===job.attemptedAt))throw new Error('Persisted UI transport attempt no longer matches');
    if(['prepare','arm'].includes(command)&&events.some(event=>['received','work-claimed','handled','message-superseded','recipient-observed'].includes(event.state))) {
      job.state='complete';job.completedAt=new Date().toISOString();await save(p.job,job);
      return {ready:false,armed:false,reasonCode:'claude-ui-original-already-received-or-closed'};
    }
    const {readClaudeWakeTarget,findClaudeDesktopExecutable}=await import('./claude-wake.mjs');
    const target=await(options.readTarget??readClaudeWakeTarget)({hostSessionId:job.hostSessionId,sessionId:job.sessionId},config);
    if(!target.ready||target.sessionId!==job.sessionId)return {ready:false,reasonCode:target.reasonCode??'claude-ui-native-session-changed'};
    if(job.consumerId&&job.consumerId!==consumerId)return {ready:false,reasonCode:'claude-ui-owned-by-another-consumer'};
    const alreadyArmed=!!job.armedAt;
    if(command==='prepare') {
      if(job.state==='blocked')return {ready:false,reasonCode:job.reasonCode??'claude-ui-blocked',nextAction:'resolve-blocker-before-explicit-recovery'};
      if(alreadyArmed)return {ready:false,reasonCode:'claude-ui-already-armed',nextAction:'finish-without-resubmitting'};
      if(job.state==='complete')return {ready:false,reasonCode:'claude-ui-complete'};
      if(!job.consumerId){job.consumerId=consumerId;job.claimedAt=new Date().toISOString();job.state='preparing';await save(p.job,job);}
      const executable=await(options.findExecutable??findClaudeDesktopExecutable)(config);
      if(!executable)return {ready:false,reasonCode:'claude-ui-desktop-unavailable'};
      return {ready:true,messageId:id,consumerId,hostSessionId:job.hostSessionId,sessionId:job.sessionId,title:target.title,
        executable,deepLink:'claude://resume?session='+job.sessionId,
        documentUrl:'https://claude.ai/epitaxy/'+job.hostSessionId,promptFile:p.prompt,promptSha256:job.promptSha256};
    }
    if(command==='arm') {
      if(job.consumerId!==consumerId)throw new Error('Prepare before arming UI delivery');
      if(job.state==='blocked')return {armed:false,reasonCode:job.reasonCode??'claude-ui-blocked'};
      if(alreadyArmed)return {armed:false,reasonCode:'claude-ui-already-armed',nextAction:'finish-without-resubmitting'};
      job.state='armed';job.armedAt=new Date().toISOString();await save(p.job,job);
      return {armed:true,messageId:id,consumerId,promptSha256:job.promptSha256};
    }
    if(command==='finish') {
      if(!alreadyArmed)return {complete:false,reasonCode:'claude-ui-not-armed'};
      const bridge=options.bridge??(await import('./index.mjs')).createBridge({root:p.root});
      const result=await bridge.check(id,{refresh:true});
      const complete=['recipient-observed','received'].includes(result.observation?.state)
        ||['work-claimed','work-completed'].includes(result.observation?.reasonCode);
      job.state=complete?'complete':'submitted-unconfirmed';job.checkedAt=new Date().toISOString();
      if(complete)job.completedAt=job.checkedAt;await save(p.job,job);
      return {complete,messageId:id,state:job.state,observation:result.observation,status:result.status};
    }
    if(command==='fail') {
      if(job.state==='complete')return {complete:true,messageId:id,state:'complete'};
      if(!/^[a-z0-9-]{1,100}$/.test(reason??''))throw new Error('Use a short failure reason code');
      job.state=alreadyArmed?'submitted-unconfirmed':'blocked';job.reasonCode=reason;job.failedAt=new Date().toISOString();await save(p.job,job);
      const event={id:randomUUID(),messageId:id,createdAt:job.failedAt,state:alreadyArmed?'ui-recovery-blocked':'send-blocked',
        observation:{state:'send-blocked',transport:'codex-ui-recovery',executionState:alreadyArmed?'unknown':'not-started',
          transportState:alreadyArmed?'uncertain':'not-submitted',reasonCode:reason,nextAction:'resolve-ui-recovery-blocker',
          observedAt:job.failedAt,evidence:{source:'local-ui-recovery',messageId:id,submittedUncertain:alreadyArmed}}};
      await create(join(p.root,'.bridge','receipts',event.id+'.json'),JSON.stringify(event,null,2)+'\n');
      return {complete:false,messageId:id,state:job.state,reasonCode:reason,submittedUncertain:alreadyArmed};
    }
    throw new Error('Unknown UI recovery command');
  });
}
