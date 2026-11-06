import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createBridge, makeEnvelope, createCoordinator } from '../src/index.mjs';
import { recipientFingerprint, transportDiagnosticError } from '../src/transport-runtime.mjs';

async function fixture(t, overrides={}) {
  const root=await mkdtemp(join(tmpdir(),'bridge-workflow-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(join(root,'.bridge'));
  const settings={home:root,agents:{codex:{threadId:randomUUID(),hostId:'local'},
    claude:{sessionId:randomUUID(),hostSessionId:'local_'+randomUUID()},gemini:{conversationId:randomUUID(),projectId:randomUUID()}}};
  const save=()=>writeFile(join(root,'.bridge/config.json'),JSON.stringify(settings));
  await save();
  const calls=[];
  const adapter=async(target,prompt,config,message)=>{calls.push({target,message,prompt});return{state:'native-accepted',transport:'fixture'};};
  const bridge=createBridge({root,adapters:{codex:adapter,claude:adapter,gemini:adapter,...overrides.adapters},inspectors:overrides.inspectors??{}});
  return {root,settings,save,calls,bridge};
}
const responseError=()=>Object.assign(new Error('response deadline'),{delivery:{submitted:true,phase:'response',retryable:false}});
const absent=async(target,settings,message)=>({state:'delivery-not-observed',transport:'codex-app-tools',messageId:message.id,
  observedAt:new Date().toISOString(),evidence:{complete:true,messageId:message.id,threadId:target.threadId}});

test('response timeout is resolved with complete observation and one same-ID guarded resubmission',async t=>{
  const ids=[];
  const f=await fixture(t,{adapters:{codex:async(target,prompt,settings,message)=>{
    ids.push(message.id);assert.match(prompt,/claim/);
    if(ids.length===1)throw responseError();return{state:'native-accepted',transport:'fixture'};
  }},inspectors:{codex:absent}});
  const first=await f.bridge.send({from:'claude',to:'codex',body:'original task'},{deferErrors:true});
  assert.equal(first.status.state,'pending-receipt');
  assert.equal(first.status.requiresAttention,false);
  const original=await readFile(join(f.root,'.bridge/messages',first.message.id+'.json'));
  const resumed=await f.bridge.resume(first.message.id,{deferErrors:true});
  assert.equal(resumed.resumed,true);assert.deepEqual(ids,[first.message.id,first.message.id]);
  assert.deepEqual(await readFile(join(f.root,'.bridge/messages',first.message.id+'.json')),original);
  assert.equal((await f.bridge.receipts(first.message.id)).filter(row=>row.redeliveryReason).length,1);
  await f.bridge.resume(first.message.id);assert.equal(ids.length,2);
});

test('late exact receipt after timeout prevents retransmission',async t=>{
  let calls=0;
  const f=await fixture(t,{adapters:{codex:async()=>{calls++;throw responseError();}},inspectors:{codex:async()=>({
    state:'recipient-observed',recipientObserved:true,transport:'codex-app-tools',executionState:'unknown'})}});
  const sent=await f.bridge.send({from:'claude',to:'codex',body:'late receipt'},{deferErrors:true});
  assert.equal(sent.status.receiptState,'recipient-observed');
  await f.bridge.resume(sent.message.id);assert.equal(calls,1);
});

test('repeated response uncertainty spends a single redelivery budget',async t=>{
  let calls=0;
  const f=await fixture(t,{adapters:{codex:async()=>{calls++;throw responseError();}},inspectors:{codex:absent}});
  const sent=await f.bridge.send({from:'claude',to:'codex',body:'bounded retry'},{deferErrors:true});
  await f.bridge.resume(sent.message.id,{deferErrors:true});
  await f.bridge.resume(sent.message.id,{deferErrors:true});
  assert.equal(calls,2);
});

test('reply days later stays pinned to actual requester and repeated reply is idempotent',async t=>{
  const f=await fixture(t);
  const sender={sessionId:randomUUID(),hostSessionId:'local_'+randomUUID()};
  const request=await f.bridge.send({from:'claude',to:'codex',body:'review',senderSession:sender});
  f.settings.agents.claude={sessionId:randomUUID(),hostSessionId:'local_'+randomUUID()};await f.save();
  const result=await f.bridge.reply('codex',request.message.id,{body:'finished'});
  assert.equal(f.calls.at(-1).target.hostSessionId,sender.hostSessionId);
  const duplicate=await f.bridge.reply('codex',request.message.id,{body:'finished'});
  assert.equal(duplicate.duplicate,true);assert.equal(duplicate.message.id,result.message.id);
  assert.equal(f.calls.length,2);
});

test('offline reply persists normally then startup flush resumes the original result to its requester',async t=>{
  let ready=false;const recipients=[];
  const f=await fixture(t,{adapters:{claude:async target=>{recipients.push(target.hostSessionId);
    if(!ready){const e=transportDiagnosticError('CLAUDE_SESSION_NOT_RUNNING');e.delivery={submitted:false,phase:'preflight'};throw e;}
    return{state:'transport-written',transport:'fixture'};}}});
  const originalHost=f.settings.agents.claude.hostSessionId;
  const request=await f.bridge.send({from:'claude',to:'codex',body:'review'});
  const result=await f.bridge.reply('codex',request.message.id,{body:'finished',deferErrors:true});
  assert.equal(result.status.state,'queued');assert.equal(result.status.requiresAttention,false);
  f.settings.agents.claude={sessionId:randomUUID(),hostSessionId:'local_'+randomUUID()};await f.save();ready=true;
  const flushed=await f.bridge.flush({to:'claude'});
  assert.equal(flushed.results.length,1);assert.equal(flushed.results[0].messageId,result.message.id);
  assert.equal(flushed.results[0].resumed,true);assert.deepEqual(recipients,[originalHost,originalHost]);
  const pending=await f.bridge.inbox('claude',{pending:true,session:request.message.senderSession});
  assert.equal(pending.length,1);
  await f.bridge.receive('claude',result.message.id);
  assert.equal((await f.bridge.inbox('claude',{pending:true,session:request.message.senderSession})).length,0);
});

test('coordinator terminal reply uses deferred options and preserves one completion message',async t=>{
  const f=await fixture(t,{adapters:{claude:async()=>{
    const error=transportDiagnosticError('CLAUDE_SESSION_NOT_RUNNING');error.delivery={submitted:false,phase:'preflight'};throw error;
  }}});
  const request=await f.bridge.send({from:'claude',to:'codex',body:'work'});
  const coordinator=createCoordinator({bridge:f.bridge,deliveryOptions:{deferErrors:true}});
  await coordinator.register({requestId:request.message.id,runId:'offline-finish'});
  const report={runId:'offline-finish',status:'completed',summary:'done'};
  const result=await coordinator.finish(report);
  assert.equal(result.status.state,'queued');assert.equal(result.requiresAttention,false);
  const repeated=await coordinator.finish(report);assert.equal(repeated.messageId,result.messageId);
});

test('terminal replay recovers uncertain completion once through the same-ID guard',async t=>{
  const ids=[];
  const f=await fixture(t,{adapters:{codex:async(target,prompt,settings,message)=>{
    ids.push(message.id);throw responseError();
  }},inspectors:{codex:absent}});
  const request=await f.bridge.send({from:'codex',to:'claude',body:'work'});
  const coordinator=createCoordinator({bridge:f.bridge,deliveryOptions:{deferErrors:true}});
  await coordinator.register({requestId:request.message.id,runId:'uncertain-finish'});
  const report={runId:'uncertain-finish',status:'completed',summary:'original result'};
  const first=await coordinator.finish(report);
  assert.equal(first.status.state,'pending-receipt');
  const repeated=await coordinator.finish({...report,summary:'must preserve the original result'});
  assert.deepEqual(ids,[first.messageId,first.messageId]);
  assert.equal(repeated.terminal.summary,report.summary);
  assert.equal(repeated.requiresAttention,false);
  await coordinator.finish(report);
  assert.equal(ids.length,2);
});

async function flushCli(root,{autoWake=false}={}) {
  return new Promise((resolve,reject)=>{
    execFile(process.execPath,[fileURLToPath(new URL('../bin/agent-bridge.mjs',import.meta.url)),
      'flush','--root',root,'--auto-wake',String(autoWake)],{windowsHide:true,timeout:10000},(error,stdout,stderr)=>{
      if(error&&typeof error.code!=='number')return reject(error);
      try{resolve({exitCode:error?.code??0,result:JSON.parse(stdout),stderr});}catch(parseError){reject(parseError);}
    });
  });
}

test('flush and CLI distinguish ordinary waiting from actionable delivery failures',async t=>{
  for(const state of ['queued','pending-receipt','recipient-changed'])await t.test(state,async t=>{
    const f=await fixture(t,{adapters:{codex:async()=>{throw responseError();},claude:async()=>{
      const error=transportDiagnosticError('CLAUDE_SESSION_STORE_MISSING');
      error.delivery={submitted:false,phase:'preflight'};throw error;
    }},inspectors:{codex:absent}});
    if(state==='recipient-changed'){
      await legacyTimeout(f);f.settings.agents.codex.threadId=randomUUID();await f.save();
    }else{
      const sent=await f.bridge.send({from:state==='queued'?'codex':'claude',
        to:state==='queued'?'claude':'codex',body:'waiting task'},{deferErrors:true});
      if(state==='pending-receipt')await f.bridge.resume(sent.message.id,{deferErrors:true});
    }
    const attention=state==='recipient-changed';
    const flushed=await f.bridge.flush();
    assert.equal(flushed.requiresAttention,attention);
    assert.equal(flushed.results.length,1);
    assert.equal(flushed.results[0].status.requiresAttention,attention);
    const cli=await flushCli(f.root);
    assert.equal(cli.exitCode,attention?2:0);assert.equal(cli.stderr,'');
    assert.equal(cli.result.requiresAttention,attention);
    assert.equal(cli.result.results.length,1);
    assert.equal(attention?cli.result.results[0].reason:cli.result.results[0].status.state,state);
  });
});

test('CLI automatic wake reports a missing saved destination instead of silent permanent queueing',async t=>{
  const f=await fixture(t,{adapters:{claude:async()=>{
    const error=transportDiagnosticError('CLAUDE_SESSION_STORE_MISSING');
    error.delivery={submitted:false,phase:'preflight'};throw error;
  }}});
  await f.bridge.send({from:'codex',to:'claude',body:'missing saved chat'},{deferErrors:true});
  const cli=await flushCli(f.root,{autoWake:true});
  assert.equal(cli.exitCode,2);
  assert.equal(cli.result.requiresAttention,true);
  assert.equal(cli.result.results[0].status.wake.reasonCode,'claude-wake-conversation-missing');
});

test('flush aggregates credential failures as requiring attention',async t=>{
  const f=await fixture(t,{adapters:{claude:async()=>{
    const error=transportDiagnosticError('CLAUDE_CREDENTIAL_MISSING');
    error.delivery={submitted:false,phase:'preflight'};throw error;
  }}});
  await f.bridge.send({from:'codex',to:'claude',body:'credential failure'},{deferErrors:true});
  const flushed=await f.bridge.flush();
  assert.equal(flushed.requiresAttention,true);
  assert.equal(flushed.results[0].status.transportFailure.code,'CLAUDE_CREDENTIAL_MISSING');
});

async function legacyTimeout(f) {
  const message=makeEnvelope({from:'claude',to:'codex',body:'legacy task'});
  await mkdir(join(f.root,'.bridge/messages'));await mkdir(join(f.root,'.bridge/receipts'));
  await writeFile(join(f.root,'.bridge/messages',message.id+'.json'),JSON.stringify(message));
  const attemptId=randomUUID();
  for(const row of [{state:'delivery-attempt',attemptNumber:1,recipientFingerprint:recipientFingerprint('codex',f.settings.agents.codex,f.settings)},
    {state:'delivery-error',failure:{phase:'response',retrySafe:false,code:'TRANSPORT_ERROR'}}]) {
    const record={...row,id:randomUUID(),attemptId,messageId:message.id,createdAt:'2026-10-28T00:00:00Z'};
    await writeFile(join(f.root,'.bridge/receipts',record.id+'.json'),JSON.stringify(record));
  }
  return message;
}

test('legacy migration is explicit, bounded, preserves original bytes and labels its at-least-once semantics',async t=>{
  const f=await fixture(t,{inspectors:{codex:absent}});
  const message=await legacyTimeout(f);
  const original=await readFile(join(f.root,'.bridge/messages',message.id+'.json'));
  assert.equal((await f.bridge.resume(message.id)).resumed,false);
  assert.equal(f.calls.length,0);
  const result=await f.bridge.resume(message.id,{adoptClaim:true});
  assert.equal(result.resumed,true);assert.equal(result.legacyConsumerUnfenced,true);
  assert.equal(result.redeliverySemantics,'at-least-once-legacy-migration');
  assert.match(f.calls[0].prompt,/claim/);assert.equal(f.calls[0].message.id,message.id);
  assert.deepEqual(await readFile(join(f.root,'.bridge/messages',message.id+'.json')),original);
  await f.bridge.resume(message.id,{adoptClaim:true});assert.equal(f.calls.length,1);
});

test('legacy changed recipient remains blocked and old waiting date stays visible',async t=>{
  const f=await fixture(t,{inspectors:{codex:absent}});const message=await legacyTimeout(f);
  f.settings.agents.codex.threadId=randomUUID();await f.save();
  const result=await f.bridge.resume(message.id,{adoptClaim:true});
  assert.equal(result.reason,'recipient-changed');assert.equal(f.calls.length,0);
  const state=await f.bridge.status({id:message.id,includeBodies:false});
  assert.equal(state.messages[0].delivery.waitingSince,'2026-10-28T00:00:00Z');
  assert.equal(state.messages[0].body,undefined);
});
