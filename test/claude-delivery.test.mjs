import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import net from 'node:net';
import { inspectClaude, sendClaude } from '../src/adapters/claude.mjs';

const target={sessionId:'target-session'};
const message={id:'original-message',from:'codex',body:'PRIVATE CASE BODY'};
const peer='bridge:agent-bridge-codex';
const received={type:'user',uuid:message.id,sessionId:target.sessionId,
  timestamp:'2026-10-28T01:38:13.408Z',permissionMode:'bypassPermissions',
  origin:{kind:'peer',from:peer,msg_id:message.id,body:message.body},
  message:{content:message.body}};
const held={type:'system',subtype:'peer_message_hold',state:'held',
  message_uuid:message.id,lane:'socket',from:peer,cause:'mode-mismatch',
  uuid:'hold-notification',session_id:target.sessionId,body:message.body};
function inspect(records=[],events=[]){
  return inspectClaude(target,{agents:{codex:{permissionClass:'bypass'}}},message,{
    readEvidence:async()=>({transcript:{records,truncated:false},hostEvents:{records:events,truncated:false}})
  });
}

test('exact peer user record confirms receipt without claiming execution or exposing text',async()=>{
  const result=await inspect([received]);
  assert.equal(result.state,'recipient-observed');
  assert.equal(result.executionState,'unknown');
  assert.equal(result.evidence.messageId,message.id);
  assert.equal(result.evidence.timestamp,received.timestamp);
  assert.equal(result.nextAction,'none');
  assert.equal(JSON.stringify(result).includes(message.body),false);
});

test('quoted IDs, another peer/session and unrelated busy history do not confirm this message',async()=>{
  const result=await inspect([
    {...received,type:'assistant'},
    {...received,uuid:'unrelated-user',origin:undefined},
    {...received,origin:{...received.origin,from:'bridge:agent-bridge-gemini'}},
    {...received,sessionId:'another-session'},
    {...received,session_id:'another-session'},
    {...received,origin:{...received.origin,msg_id:'different-message'}}
  ]);
  assert.equal(result.state,'delivery-unconfirmed');
  assert.equal(result.reasonCode,'claude-recipient-not-observed');
});

test('permission mismatch alone is unconfirmed; correlated native hold is approval pending',async()=>{
  const missing=await inspectClaude({...target,permissionClass:'prompting'},
    {agents:{codex:{permissionClass:'bypass'}}},message,{readEvidence:async()=>({})});
  assert.equal(missing.state,'delivery-unconfirmed');
  const result=await inspect([],[held]);
  assert.equal(result.state,'approval-pending');
  assert.equal(result.reasonCode,'claude-peer-mode-mismatch');
  assert.equal(result.evidence.holdCause,'mode-mismatch');
  assert.equal(result.executionState,'not-started');
  assert.equal(JSON.stringify(result).includes(message.body),false);
});

test('host hold requires native shape, socket lane, exact session and peer identity',async()=>{
  for(const event of [
    {messageId:message.id,held:true,reason:'permission mismatch'},
    {...held,lane:'stdin'}, {...held,session_id:'other-session'},
    {...held,message_uuid:'other-message'}, {...held,from:'bridge:other'},
    {...held,cause:'PRIVATE UNKNOWN REASON'}
  ]) assert.equal((await inspect([],[event])).state,'delivery-unconfirmed');
});

test('receipt supersedes earlier hold; release is queued and is not receipt',async()=>{
  assert.equal((await inspect([received],[held])).state,'recipient-observed');
  const released=await inspect([],[held,{...held,state:'released'}]);
  assert.equal(released.state,'delivery-unconfirmed');
  assert.equal(released.reasonCode,'claude-held-message-released');
});

test('native terminal drop distinguishes expired, refused, dropped, discarded without echoing raw payload',async()=>{
  for(const outcome of ['expired','refused','dropped','discarded']){
    const result=await inspect([],[held,{...held,state:'dropped',outcome}]);
    assert.equal(result.state,'delivery-rejected');
    assert.equal(result.reasonCode,'claude-peer-'+outcome);
    assert.equal(JSON.stringify(result).includes(message.body),false);
  }
});

test('inspection errors remain unconfirmed and cannot leak raw exception details',async()=>{
  const result=await inspectClaude(target,{},message,{readEvidence:async()=>{throw new Error(message.body);}});
  assert.equal(result.state,'delivery-unconfirmed');
  assert.equal(result.reasonCode,'claude-observation-unavailable');
  assert.equal(JSON.stringify(result).includes(message.body),false);
});

async function fixture(t){
  const home=await mkdtemp(join(tmpdir(),'bridge-claude-delivery-'));
  t.after(()=>rm(home,{recursive:true,force:true}));
  const project=join(home,'.claude','projects','project');
  await mkdir(project,{recursive:true});
  return {home,path:join(project,target.sessionId+'.jsonl')};
}

test('filesystem inspection reads bounded exact records and optional native host event journal',async t=>{
  const f=await fixture(t),eventsPath=join(f.home,'events.jsonl');
  await writeFile(f.path,JSON.stringify({type:'user',uuid:'other',message:{content:message.body}})+'\n');
  await writeFile(eventsPath,JSON.stringify(held)+'\n');
  assert.equal((await inspectClaude({...target,deliveryEventsPath:eventsPath},{home:f.home},message)).state,'approval-pending');
  await writeFile(f.path,JSON.stringify(received)+'\n');
  const found=await inspectClaude({...target,deliveryEventsPath:join(f.home,'missing-events')},{home:f.home},message);
  assert.equal(found.state,'recipient-observed');
  assert.equal(found.evidence.hostEventsUnavailable,true);
  assert.equal((await inspectClaude(target,{home:f.home},message,{maxBytes:10})).state,'delivery-unconfirmed');
});

test('adapter finds old exact receipt beyond the former tail and keeps bounded scan metadata',async t=>{
  const f=await fixture(t);
  const padding=JSON.stringify({type:'assistant',message:{content:'x'.repeat(64*1024)}})+'\n';
  await writeFile(f.path,JSON.stringify(received)+'\n'+padding.repeat(130));
  const observed=await inspectClaude(target,{home:f.home},message);
  assert.equal(observed.state,'recipient-observed');
  assert.equal(observed.evidence.transcriptTruncated,false);
  assert.equal(observed.evidence.transcriptScan.complete,true);
  assert.ok(observed.evidence.transcriptScan.bytesScanned>8*1024*1024);
  assert.equal(JSON.stringify(observed).includes(message.body),false);
});

test('later observation finds an asynchronously persisted receipt without another pipe send',async t=>{
  const f=await fixture(t);await writeFile(f.path,'');
  const before=await inspectClaude(target,{home:f.home},message);
  assert.equal(before.state,'delivery-unconfirmed');
  assert.equal(before.evidence.transcriptScan.complete,true);
  await appendFile(f.path,JSON.stringify(received)+'\n');
  const after=await inspectClaude(target,{home:f.home},message);
  assert.equal(after.state,'recipient-observed');
  assert.equal(after.evidence.recordUuid,message.id);
  assert.equal(after.executionState,'unknown');
});

test('custom evidence reader keeps its argument contract and cannot leak arbitrary scan fields',async()=>{
  const options={maxBytes:19,readEvidence:async(actualTarget,config,passedOptions)=>{
    assert.equal(actualTarget,target);assert.equal(config.marker,'same-config');assert.equal(passedOptions,options);
    return {transcript:{records:[received],scan:{bytesScanned:19,complete:true,body:message.body}},
      discovery:{complete:true,path:message.body}};
  }};
  const found=await inspectClaude(target,{marker:'same-config'},message,options);
  assert.equal(found.state,'recipient-observed');
  assert.deepEqual(found.evidence.transcriptScan,{bytesScanned:19,complete:true});
  assert.equal(JSON.stringify(found).includes(message.body),false);
});

test('pipe write remains transport-written if the single observation fails',{skip:process.platform!=='win32'},async t=>{
  const f=await fixture(t),sessionDir=join(f.home,'.claude','sessions');
  await mkdir(sessionDir);
  const socketPath='\\\\.\\pipe\\cc-msg-'+randomUUID().replaceAll('-','');
  const keyName=process.pid+'.'+createHash('sha256').update(socketPath.toLowerCase()).digest('hex')+'.key';
  await writeFile(join(sessionDir,process.pid+'.json'),JSON.stringify({pid:process.pid,sessionId:target.sessionId,
    peerProtocol:1,procStart:'fixture-start',messagingSocketPath:socketPath}));
  await writeFile(join(sessionDir,keyName),JSON.stringify({procStart:'fixture-start',peerToken:'a'.repeat(32)}));
  let writes=0,inspections=0;
  const server=net.createServer(socket=>{writes++;socket.resume();});
  await new Promise(resolve=>server.listen(socketPath,resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const result=await sendClaude(target,'fixture prompt',{home:f.home,agents:{codex:{permissionClass:'bypass'}}},message,
    {inspect:async()=>{inspections++;throw new Error(message.body);}});
  assert.equal(writes,1);
  assert.equal(inspections,1);
  assert.equal(result.state,'transport-written');
  assert.equal(result.observation.state,'delivery-unconfirmed');
  assert.equal(JSON.stringify(result).includes(message.body),false);
  const deferred=await sendClaude(target,'isolated deferred observation',{home:f.home,agents:{codex:{permissionClass:'bypass'}}},
    {...message,id:randomUUID()},{skipImmediateObservation:true,inspect:async()=>{inspections++;throw new Error('must not inspect');}});
  assert.equal(deferred.state,'transport-written');
  assert.equal(deferred.observation,undefined);
  assert.equal(deferred.runtimeResolution.resolvedSessionId,target.sessionId);
  assert.equal(inspections,1);
  assert.equal(writes,2);
});
