import { readFile, readdir, open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import net from 'node:net';
import { transportDiagnosticError, diagnosticTransportFailure } from '../transport-runtime.mjs';
import { resolveClaudeSession, claudeResolutionEvidence } from '../claude-session.mjs';
import { readClaudeDeliveryEvidence } from '../claude-observation.mjs';
import { inspectClaudeHost } from '../claude-host.mjs';
import { sendClaudeDesktopUi, inspectClaudeUiReceipt } from '../claude-wake.mjs';
import { predictClaudeInboundHold } from '../claude-inbound.mjs';
export async function discoverClaude({home=homedir()}={}) {
  const dir=join(home,'.claude','sessions');const rows=[];
  let names;
  try { names=await readdir(dir); }
  catch(error) { throw transportDiagnosticError(error.code==='ENOENT' ? 'CLAUDE_SESSION_STORE_MISSING' : 'CLAUDE_SESSION_STORE_UNREADABLE'); }
  for(const name of names){if(!/^\d+\.json$/.test(name))continue;try{const data=JSON.parse(await readFile(join(dir,name),'utf8'));if(!Number.isSafeInteger(data.pid)||data.pid<=0||String(data.pid)!==name.slice(0,-5))continue;process.kill(data.pid,0);rows.push(data);}catch{}}
  return rows;
}
export function buildClaudeFrame({target,prompt,from,sourceSessionId,senderMode='prompting',id=randomUUID()}) {
  if(!['bypass','prompting'].includes(senderMode))throw transportDiagnosticError('BRIDGE_SENDER_MODE_INVALID');
  if(!['codex','claude','gemini'].includes(from))throw transportDiagnosticError('BRIDGE_SENDER_INVALID');
  const address='bridge:agent-bridge-'+from;
  const safeSession=sourceSessionId&&/^[A-Za-z0-9_-]{1,80}$/.test(sourceSessionId)?' from-session="'+sourceSessionId+'"':'';
  // Escape every closing-tag prefix accepted by Claude 2.1.308's canonicalizer.
  // A backslash immediately after the opening bracket is its stable escape form.
  const opens = '<\uFF1C\uFE64\u2329\u27E8\u3008\u2039\u02C2\u1438\u276C\u276E\u2770\u29FC\u226E\u227A\u22D6';
  const closes = '>\uFF1E\uFE65\u232A\u27E9\u3009\u203A\u02C3\u1433\u276D\u276F\u2771\u29FD\u226F\u227B\u22D7';
  const slashes = '/\uFF0F\u2215\u2044';
  const closingPrefix = new RegExp('[' + opens + '](?!\\\\)(?=[^A-Za-z0-9_\\-' + opens + closes + ']*[' + slashes + '])', 'gu');
  const body = prompt.replace(closingPrefix, '<\\');
  const content='<cross-session-message from="'+address+'"'+safeSession+' from-name="agent-bridge '+from+'" from-mode="'+senderMode+'">\n'+body+'\n</cross-session-message>';
  return {type:'user',session_id:target.sessionId,uuid:id,msg_id:id,from:address,priority:'now',message:{role:'user',content}};
}
export async function sendClaude(target,prompt,config,message,options={}) {
  if(options.recipientWake?.method==='claude-desktop-ui')return sendClaudeDesktopUi(target,prompt,config,message,options);
  let submitted=false,phase='preflight';
  try {
  const timeoutMs=options.responseTimeoutMs??10000;
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>600000)throw new Error('Invalid Claude response timeout');
  const home=config.home??homedir();const sessions=await discoverClaude({home});
  const resolution=resolveClaudeSession(target,sessions),live=resolution.session;
  if(live.peerProtocol!==1)throw transportDiagnosticError('CLAUDE_PROTOCOL_UNSUPPORTED');
  if(target.hostSessionId&&live.hostSessionId!==target.hostSessionId)throw transportDiagnosticError('CLAUDE_HOST_ID_CHANGED');
  if(!/^\\\\\.\\pipe\\(?:LOCAL\\)?cc-msg-[a-f0-9]{32}$/i.test(live.messagingSocketPath??''))throw transportDiagnosticError('CLAUDE_PIPE_INVALID');
  const keyName = live.pid + '.' + createHash('sha256')
    .update(live.messagingSocketPath.toLowerCase()).digest('hex') + '.key';
  let keyText,key;
  try { keyText=await readFile(join(home, '.claude', 'sessions', keyName), 'utf8'); }
  catch(error) { throw transportDiagnosticError(error.code==='ENOENT' ? 'CLAUDE_CREDENTIAL_MISSING' : 'CLAUDE_CREDENTIAL_UNREADABLE'); }
  try { key=JSON.parse(keyText); }
  catch { throw transportDiagnosticError('CLAUDE_CREDENTIAL_INVALID'); }
  if (!key || typeof key!=='object' || !/^[a-f0-9]{32}$/.test(key.peerToken)) throw transportDiagnosticError('CLAUDE_CREDENTIAL_INVALID');
  if ((key.procStart ?? key.procStartFt) !== live.procStart) throw transportDiagnosticError('CLAUDE_CREDENTIAL_STALE');
  const sender=config.agents?.[message.from];
  if(!sender)throw transportDiagnosticError('BRIDGE_SENDER_UNREGISTERED');
  const frame=buildClaudeFrame({target:live,prompt,from:message.from,sourceSessionId:sender.threadId??sender.sessionId??sender.conversationId,senderMode:sender.permissionClass??'prompting',id:message.id});
  // Desktop cannot show the approval dialog, so a predicted hold would be
  // dropped at the dialog deadline. Keep the original message unsubmitted.
  if(options.holdGuard!==false){
    const hold=await (options.predictHold??predictClaudeInboundHold)(live,config,sender.permissionClass??'prompting');
    if(hold?.predicted)return claudeHoldBlocked(live,resolution,hold);
  }
  phase='connect';
  await new Promise((resolve,reject)=>{const socket=net.createConnection(live.messagingSocketPath);let settled=false;const timer=setTimeout(()=>finish(new Error('Claude pipe timeout; delivery uncertain')),timeoutMs);function finish(err){if(settled)return;settled=true;clearTimeout(timer);socket.destroy();if(err){err.delivery={submitted,phase,retryable:!submitted&&phase==='connect'&&['ECONNREFUSED','ENOENT','ETIMEDOUT'].includes(err.code)};reject(err);}else resolve();}socket.on('error',finish);socket.on('connect',()=>{submitted=true;phase='write';socket.end(JSON.stringify({type:'auth',token:key.peerToken})+'\n'+JSON.stringify(frame)+'\n',()=>finish());});});
  // A successful pipe write has no recipient acknowledgment. Observe once,
  // without polling or resending; observation failure must not erase the write.
  if(options.skipImmediateObservation===true)return {state:'transport-written',transport:'claude-peer-pipe',
    sessionId:live.sessionId,runtimeResolution:claudeResolutionEvidence(resolution)};
  let observation;
  const actualTarget={...target,sessionId:live.sessionId};
  try { observation=await (options.inspect??inspectClaudeTarget)(actualTarget,config,message,options); }
  catch { observation=unconfirmedClaude(actualTarget,'claude-observation-unavailable'); }
  observation={...observation,evidence:{...observation.evidence,runtimeResolution:claudeResolutionEvidence(resolution)}};
  return {state:'transport-written',transport:'claude-peer-pipe',sessionId:live.sessionId,
    runtimeResolution:claudeResolutionEvidence(resolution),observation};
  } catch(error) {
    error.delivery??={submitted,phase,retryable:false};
    if(options.diagnoseAvailability!==false && !submitted && ['CLAUDE_SESSION_NOT_RUNNING','CLAUDE_SESSION_STORE_MISSING'].includes(error.code)
      && /^local_[0-9a-f-]{36}$/i.test(target.hostSessionId??'')) {
      try{error.recipientAvailability=await (options.inspectHost??inspectClaudeHost)(target,config);}
      catch { /* Diagnostics never replace the original non-submission evidence. */ }
    }
    throw error;
  }
}

function claudeHoldBlocked(live,resolution,hold) {
  const nextAction=hold.outcome==='refused'
    ? 'The recipient refuses cross-session messages by setting. Nothing was sent; only the user can change crossSessionInbound.'
    : 'Claude Desktop cannot show the approval dialog and drops held messages at its deadline. Nothing was sent. Register the sender\'s actual permission class, or the user may set crossSessionInbound to accept for the recipient; then resume this message ID.';
  const runtimeResolution=claudeResolutionEvidence(resolution);
  return {state:'send-blocked',transport:'claude-peer-pipe',sessionId:live.sessionId,runtimeResolution,
    observation:{state:'send-blocked',transport:'claude-peer-pipe',sessionId:live.sessionId,transportState:'not-submitted',
      executionState:'not-started',reasonCode:hold.reasonCode,observedAt:new Date().toISOString(),
      evidence:{...hold.evidence,runtimeResolution},nextAction}};
}

const holdCauses = new Set(['explicit-setting','managed-setting','repo-setting','invalid-setting',
  'bypass-default','mode-unknown','mode-mismatch','no-mode-asserted']);
const dropOutcomes = new Set(['expired','refused','dropped','discarded']);
const permissionModes = new Set(['bypassPermissions','default','plan','acceptEdits','dontAsk','auto']);
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
const safeTimestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : undefined;

function unconfirmedClaude(target,reasonCode,evidence={}) {
  return {state:'delivery-unconfirmed',transport:'claude-peer-pipe',sessionId:target.sessionId,
    executionState:'unknown',reasonCode,observedAt:new Date().toISOString(),evidence,
    nextAction:'check-target-inbound-controls-without-resending'};
}

const metadataFields=['snapshotBytes','bytesScanned','lineCount','complete','partialFinalLine',
  'parseErrors','oversizedRecords','changedDuringScan','sourceReplaced','missing','ambiguous','directories'];
function observationScanMetadata(value) {
  return Object.fromEntries(metadataFields.filter(key=>typeof value?.[key]==='boolean'
    || Number.isSafeInteger(value?.[key])&&value[key]>=0).map(key=>[key,value[key]]));
}

/** Read-only, bounded observation of one original message; returns no prompt/body. */
export async function inspectClaude(target,config,message,options={}) {
  const original=target.sessionId ? await inspectClaudeTarget(target,config,message,options)
    : unconfirmedClaude(target,'claude-runtime-not-resolved');
  // Old-runtime receipts/holds remain authoritative evidence for the same ID.
  if(original.state!=='delivery-unconfirmed'||!target.hostSessionId)return original;
  try {
    const sessions=await discoverClaude({home:config.home??homedir()});
    const resolution=resolveClaudeSession(target,sessions);
    if(resolution.session.sessionId===target.sessionId)return original;
    const current=await inspectClaudeTarget({...target,sessionId:resolution.session.sessionId},config,message,options);
    return {...current,evidence:{...current.evidence,runtimeResolution:claudeResolutionEvidence(resolution)}};
  } catch(error) {
    const {code,reason,action}=diagnosticTransportFailure({code:error.code});
    // Discovery during check is not evidence of the message's submission state.
    return {...original,evidence:{...original.evidence,runtimeResolutionFailure:{code,reason,action}}};
  }
}

async function inspectClaudeTarget(target,config,message,options={}) {
  if(!safeId(target?.sessionId)||!safeId(message?.id)||!['codex','claude','gemini'].includes(message?.from)) {
    throw new Error('Invalid Claude delivery identity');
  }
  if(options.uiReceipt) {
    const observed=await inspectClaudeUiReceipt(target,config,message,options).catch(()=>null);
    if(observed)return observed;
  }
  let data;
  try{data=await (options.readEvidence ? options.readEvidence(target,config,options)
    : readClaudeDeliveryEvidence(target,config,message,options));}
  catch{return unconfirmedClaude(target,'claude-observation-unavailable');}
  const from='bridge:agent-bridge-'+message.from;
  const records=data.transcript?.records??[];
  const received=records.find(row=>row.type==='user'&&row.uuid===message.id
    &&(row.sessionId??row.session_id)===target.sessionId
    &&(row.sessionId===undefined||row.sessionId===target.sessionId)
    &&(row.session_id===undefined||row.session_id===target.sessionId)
    &&row.origin?.kind==='peer'&&row.origin.from===from&&row.origin.msg_id===message.id);
  const scan={transcriptAvailable:!!data.transcript,
    transcriptTruncated:data.transcript?.truncated??false,
    hostEventsAvailable:!!data.hostEvents,
    hostEventsUnavailable:data.hostEventsUnavailable??false,
    hostEventsTruncated:data.hostEvents?.truncated??false,
    ...(data.transcript?.scan?{transcriptScan:observationScanMetadata(data.transcript.scan)}:{}),
    ...(data.hostEvents?.scan?{hostEventsScan:observationScanMetadata(data.hostEvents.scan)}:{}),
    ...(data.discovery?{transcriptDiscovery:observationScanMetadata(data.discovery)}:{})};
  if(received){
    return {state:'recipient-observed',transport:'claude-peer-pipe',sessionId:target.sessionId,
      executionState:'unknown',reasonCode:'claude-transcript-message-found',observedAt:new Date().toISOString(),
      evidence:{source:'claude-transcript',messageId:message.id,recordUuid:received.uuid,
        timestamp:safeTimestamp(received.timestamp),
        recipientPermissionMode:permissionModes.has(received.permissionMode)?received.permissionMode:undefined,...scan},
      nextAction:'none'};
  }
  // Claude Code 2.1.309 SDK system/peer_message_hold schema. IDs on the socket
  // lane belong to the sender; require the target session and peer as well.
  const events=[...records,...(data.hostEvents?.records??[])].filter(row=>row.type==='system'
    &&row.subtype==='peer_message_hold'&&row.session_id===target.sessionId
    &&row.lane==='socket'&&row.from===from&&row.message_uuid===message.id);
  const event=events.at(-1);
  const evidence={source:event?'claude-peer-message-hold':'claude-transcript',messageId:message.id,...scan};
  if(event?.state==='held'&&holdCauses.has(event.cause)){
    return {state:'approval-pending',transport:'claude-peer-pipe',sessionId:target.sessionId,
      executionState:'not-started',reasonCode:'claude-peer-'+event.cause,observedAt:new Date().toISOString(),
      evidence:{...evidence,holdCause:event.cause},
      nextAction:'review-target-inbound-settings-or-approve-in-target-terminal'};
  }
  if(event?.state==='dropped'&&dropOutcomes.has(event.outcome)){
    return {state:'delivery-rejected',transport:'claude-peer-pipe',sessionId:target.sessionId,
      executionState:'not-started',reasonCode:'claude-peer-'+event.outcome,observedAt:new Date().toISOString(),
      evidence:{...evidence,outcome:event.outcome},nextAction:'review-target-before-any-resend'};
  }
  return unconfirmedClaude(target,event?.state==='released'?'claude-held-message-released':
    'claude-recipient-not-observed',evidence);
}
export async function readClaude(target,config,{maxBytes=512*1024}={}) {
  if(target.hostSessionId){
    try{const resolution=resolveClaudeSession(target,await discoverClaude({home:config.home??homedir()}));target={...target,sessionId:resolution.session.sessionId};}
    catch(error){if(error.code!=='CLAUDE_SESSION_NOT_RUNNING'&&error.code!=='CLAUDE_SESSION_STORE_MISSING')throw error;}
  }
  const base=join(config.home??homedir(),'.claude','projects');let path;
  for(const directory of await readdir(base)){const candidate=join(base,directory,target.sessionId+'.jsonl');try{const h=await open(candidate);await h.close();path=candidate;break;}catch{}}
  if(!path)throw new Error('Claude transcript not found');
  const handle=await open(path);try{const stat=await handle.stat(),start=Math.max(0,stat.size-maxBytes),buffer=Buffer.alloc(stat.size-start);await handle.read(buffer,0,buffer.length,start);const lines=buffer.toString('utf8').split('\n');if(start>0)lines.shift();const messages=[];for(const line of lines){try{const r=JSON.parse(line);if(r.type==='assistant'||r.type==='user'){const content=r.message?.content;const text=typeof content==='string'?content:Array.isArray(content)?content.filter(c=>c.type==='text').map(c=>c.text).join('\n'):'';if(text)messages.push({type:r.type,timestamp:r.timestamp,text});}}catch{}}return {sessionId:target.sessionId,path,byteOffset:stat.size,messages:messages.slice(-10)};}finally{await handle.close();}
}
