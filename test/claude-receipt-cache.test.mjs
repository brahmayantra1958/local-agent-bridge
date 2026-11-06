import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createBridge} from '../src/index.mjs';
import {inspectClaude} from '../src/adapters/claude.mjs';
import {transportDiagnosticError} from '../src/transport-runtime.mjs';

async function fixture(t,{claude,inspect}={}) {
  const root=await mkdtemp(join(tmpdir(),'bridge-receipt-cache-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(join(root,'.bridge'));
  const hostSessionId='local_'+randomUUID();
  const settings={home:root,agents:{codex:{threadId:randomUUID(),hostId:'local'},
    claude:{hostSessionId},gemini:{conversationId:randomUUID()}}};
  const save=()=>writeFile(join(root,'.bridge','config.json'),JSON.stringify(settings));await save();
  const calls=[];let inspections=0;
  const bridge=createBridge({root,adapters:{
    codex:async()=>({state:'native-accepted',transport:'isolated-fixture'}),
    claude:async(...args)=>{calls.push({target:args[0],message:args[3]});return claude?claude(...args):{state:'transport-written',transport:'isolated-fixture'};}
  },inspectors:{claude:async(...args)=>{inspections++;return inspect?inspect(...args):inspectClaude(...args);}}});
  const receipt=(message,sessionId)=>({type:'user',uuid:message.id,sessionId,
    timestamp:new Date().toISOString(),origin:{kind:'peer',from:'bridge:agent-bridge-'+message.from,msg_id:message.id}});
  return {root,hostSessionId,settings,save,bridge,calls,receipt,inspectionCount:()=>inspections};
}

test('host-only route observes a delayed receipt in the historical runtime after exit and caches it across truncation',async t=>{
  const runtime=randomUUID();
  const f=await fixture(t,{claude:async(target,prompt,config,message)=>({
    state:'transport-written',transport:'claude-peer-pipe',
    observation:{state:'delivery-unconfirmed',transport:'claude-peer-pipe',sessionId:runtime,
      evidence:{messageId:message.id,runtimeResolution:{resolvedSessionId:runtime,hostSessionId:target.hostSessionId,matchedBy:'host-session-id'}}}
  })});
  const sent=await f.bridge.send({from:'codex',to:'claude',body:'delayed receipt'});
  const original=await readFile(join(f.root,'.bridge','messages',sent.message.id+'.json'),'utf8');
  assert.deepEqual(sent.message.recipientSession,{hostSessionId:f.hostSessionId});
  const project=join(f.root,'.claude','projects','historical');await mkdir(project,{recursive:true});
  const path=join(project,runtime+'.jsonl');await writeFile(path,JSON.stringify(f.receipt(sent.message,runtime))+'\n');
  // No session metadata or running runtime exists. A changed default must not redirect observation.
  f.settings.agents.claude={sessionId:randomUUID(),hostSessionId:'local_'+randomUUID()};await f.save();
  const found=await f.bridge.check(sent.message.id);
  assert.equal(found.observation.state,'recipient-observed');
  assert.equal(found.observation.sessionId,runtime);
  assert.equal(f.inspectionCount(),1);
  await writeFile(path,'');
  const cached=await f.bridge.check(sent.message.id);
  assert.equal(cached.cached,true);assert.equal(cached.status.receiptState,'recipient-observed');
  assert.equal(f.inspectionCount(),1);
  assert.equal(f.calls.length,1);
  assert.equal(await readFile(join(f.root,'.bridge','messages',sent.message.id+'.json'),'utf8'),original);
});

test('local claim and a late correlated reply survive runtime exit without native rereads or acknowledgement turns',async t=>{
  for(const action of ['claim','reply'])await t.test(action,async t=>{
    const f=await fixture(t,{inspect:async()=>{throw new Error('A durable receipt must avoid native observation');}});
    const sent=await f.bridge.send({from:'codex',to:'claude',body:'owned task'});
    if(action==='claim') {
      assert.equal((await f.bridge.claim('claude',sent.message.id,{consumerId:'existing-worker'})).claimed,true);
    } else {
      const reply=await f.bridge.reply('claude',sent.message.id,{body:'completed later'});
      assert.equal(reply.message.replyTo,sent.message.id);
    }
    const checked=await f.bridge.check(sent.message.id);
    assert.equal(checked.cached,true);
    assert.equal(checked.status.receiptState,'received');
    assert.equal(f.inspectionCount(),0);
    assert.equal(f.calls.length,1);
  });
});

test('generic transcript quotations cannot seed durable receipt cache',async t=>{
  const runtime=randomUUID(),f=await fixture(t);
  f.settings.agents.claude.sessionId=runtime;await f.save();
  const sent=await f.bridge.send({from:'codex',to:'claude',body:'must be native receipt'});
  const project=join(f.root,'.claude','projects','fixture');await mkdir(project,{recursive:true});
  await writeFile(join(project,runtime+'.jsonl'),[
    {type:'assistant',sessionId:runtime,message:{content:JSON.stringify(f.receipt(sent.message,runtime))}},
    {...f.receipt(sent.message,runtime),uuid:randomUUID(),origin:undefined},
    {...f.receipt(sent.message,runtime),origin:{kind:'peer',from:'bridge:agent-bridge-gemini',msg_id:sent.message.id}}
  ].map(row=>JSON.stringify(row)+'\n').join(''));
  const first=await f.bridge.check(sent.message.id),second=await f.bridge.check(sent.message.id);
  assert.equal(first.observation.state,'delivery-unconfirmed');assert.equal(second.cached,undefined);
  assert.equal(second.status.receiptState,'unconfirmed');assert.equal(f.inspectionCount(),2);
  assert.equal((await f.bridge.receipts(sent.message.id)).some(row=>row.state==='recipient-observed'),false);
});

test('an explicitly refreshed receipt check may reread without erasing previous delivery proof',async t=>{
  let observed=true;
  const f=await fixture(t,{inspect:async(target,config,message)=>observed?
    {state:'recipient-observed',transport:'claude-peer-pipe',evidence:{messageId:message.id,recordUuid:message.id}}:
    {state:'delivery-unconfirmed',transport:'claude-peer-pipe',evidence:{messageId:message.id}}});
  const sent=await f.bridge.send({from:'codex',to:'claude',body:'retained evidence'});
  await f.bridge.check(sent.message.id);observed=false;
  const fresh=await f.bridge.check(sent.message.id,{refresh:true});
  assert.equal(fresh.cached,undefined);assert.equal(fresh.observation.state,'delivery-unconfirmed');
  assert.equal(fresh.status.receiptState,'recipient-observed');assert.equal(f.inspectionCount(),2);
});

test('lifecycle flush selects only the exact host and known-unsubmitted requests, including concurrent duplicate events',async t=>{
  let online=false;
  const f=await fixture(t,{claude:async(target,prompt,config,message)=>{
    if(!online) {
      if(message.body==='uncertain')throw Object.assign(new Error('response timeout'),{delivery:{submitted:true,phase:'response'}});
      const error=transportDiagnosticError('CLAUDE_SESSION_NOT_RUNNING');error.delivery={submitted:false,phase:'preflight'};throw error;
    }
    return {state:'transport-written',transport:'isolated-fixture'};
  },inspect:async()=>({state:'delivery-unconfirmed',executionState:'unknown'})});
  const a=await f.bridge.send({from:'codex',to:'claude',body:'queued exact host'},{deferErrors:true});
  const b=await f.bridge.send({from:'codex',to:'claude',body:'queued other host',recipientSession:{hostSessionId:'local_'+randomUUID()}},{deferErrors:true});
  const uncertain=await f.bridge.send({from:'codex',to:'claude',body:'uncertain'},{deferErrors:true});
  const before=f.calls.length;online=true;
  const flush=()=>f.bridge.flush({to:'claude',session:{hostSessionId:f.hostSessionId},onlyUnsubmitted:true});
  await Promise.all([flush(),flush()]);
  assert.deepEqual(f.calls.slice(before).map(row=>row.message.id),[a.message.id]);
  assert.equal((await f.bridge.status({id:b.message.id})).messages[0].delivery.state,'queued');
  assert.equal((await f.bridge.status({id:uncertain.message.id})).messages[0].delivery.state,'pending-receipt');
  assert.equal((await flush()).inspected,0);
});

test('session-filtered flush never substitutes a hostless runtime for a pinned Desktop host',async t=>{
  const runtime=randomUUID();let online=false;
  const f=await fixture(t,{claude:async()=>{
    if(!online){const error=transportDiagnosticError('CLAUDE_SESSION_NOT_RUNNING');
      error.delivery={submitted:false,phase:'preflight'};throw error;}
    return {state:'transport-written',transport:'isolated-fixture'};
  }});
  f.settings.agents.claude.sessionId=runtime;await f.save();
  const sent=await f.bridge.send({from:'codex',to:'claude',body:'Desktop host remains pinned'},{deferErrors:true});
  const before=f.calls.length;online=true;
  assert.equal((await f.bridge.flush({to:'claude',session:{sessionId:runtime},onlyUnsubmitted:true})).inspected,0);
  assert.equal((await f.bridge.flush({to:'claude',session:{sessionId:runtime,hostSessionId:'local_'+randomUUID()},onlyUnsubmitted:true})).inspected,0);
  assert.equal(f.calls.length,before);
  const resolved=await f.bridge.flush({to:'claude',session:{sessionId:runtime,hostSessionId:f.hostSessionId},onlyUnsubmitted:true});
  assert.equal(resolved.results[0].messageId,sent.message.id);
  assert.equal(f.calls.length,before+1);
});
