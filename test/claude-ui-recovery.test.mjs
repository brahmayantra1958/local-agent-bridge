import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { makeEnvelope, renderPrompt } from '../src/protocol.mjs';
import { enqueueClaudeUiRecovery, runClaudeUiRecovery } from '../src/claude-ui-recovery.mjs';
import { summarizeDelivery } from '../src/delivery.mjs';
import { createBridge } from '../src/index.mjs';
import { readdir } from 'node:fs/promises';

async function fixture(t) {
  const root=await mkdtemp(join(tmpdir(),'claude-ui-recovery-test-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const sessionId=randomUUID(),hostSessionId='local_'+randomUUID(),target={sessionId,hostSessionId,title:'Exact original chat'};
  const config={agents:{codex:{threadId:randomUUID(),hostId:'local'}},codexCallerThreadId:randomUUID()};
  const message=makeEnvelope({from:'codex',to:'claude',body:'One original task',guardedDelivery:'claim-v1',recipientSession:{sessionId,hostSessionId}});
  const prompt=renderPrompt(message,root),uiReceipt={attemptedAt:new Date().toISOString(),promptSha256:createHash('sha256').update(prompt).digest('hex')};
  await mkdir(join(root,'.bridge','messages'),{recursive:true});await mkdir(join(root,'.bridge','receipts'));
  await writeFile(join(root,'.bridge','messages',message.id+'.json'),JSON.stringify(message));
  await writeFile(join(root,'.bridge','config.json'),JSON.stringify(config));
  await writeFile(join(root,'.bridge','receipts','attempt.json'),JSON.stringify({messageId:message.id,state:'delivery-attempt',recoveryMethod:'claude-desktop-ui',createdAt:uiReceipt.attemptedAt,promptSha256:uiReceipt.promptSha256}));
  const options={bridgeRoot:root,uiReceipt,callCodex:async()=>({threadId:config.agents.codex.threadId})};
  const input={root,id:message.id,consumerId:'owner-A'};
  const recovery={readTarget:async()=>({ready:true,...target}),findExecutable:async()=>'/installed/claude.exe'};
  return {root,target,config,message,prompt,uiReceipt,options,input,recovery};
}
test('concurrent same-ID UI recovery dispatches once to the registered Codex chat and preserves original envelope',async t=>{
  const f=await fixture(t);let calls=0;const before=await readFile(join(f.root,'.bridge','messages',f.message.id+'.json'),'utf8');
  f.options.callCodex=async(name,args)=>{calls++;assert.equal(name,'send_message_to_thread');assert.equal(args.threadId,f.config.agents.codex.threadId);assert.match(args.prompt,/local UI recovery/);assert.ok(args.prompt.includes(f.message.id));};
  const results=await Promise.all([1,2].map(()=>enqueueClaudeUiRecovery(f.target,f.prompt,f.config,f.message,f.options)));
  assert.equal(calls,1);assert.ok(results.every(x=>x.state==='ui-handoff-queued'));assert.equal(results.filter(x=>x.reused).length,1);
  assert.equal(await readFile(join(f.root,'.bridge','messages',f.message.id+'.json'),'utf8'),before);
});
test('lost Codex dispatch response is durable and does not create another handoff',async t=>{
  const f=await fixture(t);let calls=0;f.options.callCodex=async()=>{calls++;throw Error('lost response');};
  assert.equal((await enqueueClaudeUiRecovery(f.target,f.prompt,f.config,f.message,f.options)).jobState,'dispatch-unconfirmed');
  assert.equal((await enqueueClaudeUiRecovery(f.target,f.prompt,f.config,f.message,f.options)).reused,true);assert.equal(calls,1);
});
test('proven unsent Codex dispatch reports a real blocker instead of claiming queued delivery',async t=>{
  const f=await fixture(t);let calls=0;f.options.callCodex=async()=>{calls++;throw Object.assign(Error('no app'),{delivery:{submitted:false,phase:'preflight'}});};
  for(let index=0;index<2;index++)await assert.rejects(enqueueClaudeUiRecovery(f.target,f.prompt,f.config,f.message,f.options),error=>error.code==='CLAUDE_UI_EXECUTOR_UNAVAILABLE'&&error.delivery.submitted===false);
  assert.equal(calls,1);
});
test('delivery ownership and armed-before-Enter gate prevent duplicate UI submissions',async t=>{
  const f=await fixture(t);await enqueueClaudeUiRecovery(f.target,f.prompt,f.config,f.message,f.options);
  const prepared=await runClaudeUiRecovery('prepare',f.input,f.recovery);
  assert.equal(prepared.ready,true);assert.equal(prepared.sessionId,f.target.sessionId);assert.equal(prepared.promptSha256,f.uiReceipt.promptSha256);
  assert.equal((await runClaudeUiRecovery('prepare',{...f.input,consumerId:'owner-B'},f.recovery)).ready,false);
  assert.equal((await runClaudeUiRecovery('arm',f.input,f.recovery)).armed,true);
  assert.equal((await runClaudeUiRecovery('arm',f.input,f.recovery)).armed,false);
  assert.equal((await runClaudeUiRecovery('prepare',f.input,f.recovery)).nextAction,'finish-without-resubmitting');
  const finished=await runClaudeUiRecovery('finish',f.input,{...f.recovery,bridge:{check:async id=>({observation:{state:'recipient-observed',evidence:{messageId:id,recordUuid:randomUUID()}},status:{state:'received'}})}});
  assert.equal(finished.complete,true);assert.equal(finished.messageId,f.message.id);
});
test('already claimed/received originals never get typed through the UI',async t=>{
  const f=await fixture(t);await enqueueClaudeUiRecovery(f.target,f.prompt,f.config,f.message,f.options);
  await writeFile(join(f.root,'.bridge','receipts','claim.json'),JSON.stringify({messageId:f.message.id,state:'work-claimed'}));
  assert.equal((await runClaudeUiRecovery('prepare',f.input,f.recovery)).ready,false);
  assert.equal((await runClaudeUiRecovery('arm',f.input,f.recovery)).armed,false);
});
test('UI blockers become visible delivery status and prepare does not silently re-enter blocked job',async t=>{
  const f=await fixture(t);await enqueueClaudeUiRecovery(f.target,f.prompt,f.config,f.message,f.options);
  await runClaudeUiRecovery('prepare',f.input,f.recovery);
  await runClaudeUiRecovery('fail',{...f.input,reason:'existing-draft'},f.recovery);
  assert.equal((await runClaudeUiRecovery('prepare',f.input,f.recovery)).ready,false);
  const events=[];for(const name of await readdir(join(f.root,'.bridge','receipts')))events.push(JSON.parse(await readFile(join(f.root,'.bridge','receipts',name),'utf8')));
  assert.equal(summarizeDelivery(events).requiresAttention,true);
});
test('armed workspace trust blocker survives checks, then exact native receipt completes without resubmission',async t=>{
  const f=await fixture(t);let handoffs=0;
  f.config.home=f.root;f.config.agents.claude=f.target;
  await writeFile(join(f.root,'.bridge','config.json'),JSON.stringify(f.config));
  f.options.callCodex=async()=>{handoffs++;return {threadId:f.config.agents.codex.threadId};};
  const original=await readFile(join(f.root,'.bridge','messages',f.message.id+'.json'),'utf8');
  await enqueueClaudeUiRecovery(f.target,f.prompt,f.config,f.message,f.options);
  const bridge=createBridge({root:f.root,adapters:{claude:async()=>{throw new Error('Recovery must never resubmit');}}});
  const recovery={...f.recovery,bridge};
  assert.equal((await runClaudeUiRecovery('prepare',f.input,recovery)).ready,true);
  assert.equal((await runClaudeUiRecovery('arm',f.input,recovery)).armed,true);
  const blocked=await runClaudeUiRecovery('fail',{...f.input,reason:'claude-workspace-trust-required'},recovery);
  assert.equal(blocked.submittedUncertain,true);
  assert.equal((await bridge.status({id:f.message.id})).messages[0].delivery.requiresAttention,true);
  assert.equal((await runClaudeUiRecovery('prepare',f.input,recovery)).nextAction,'finish-without-resubmitting');
  assert.equal((await runClaudeUiRecovery('arm',f.input,recovery)).armed,false);
  const awaitingTrust=await runClaudeUiRecovery('finish',f.input,recovery);
  assert.equal(awaitingTrust.complete,false);
  assert.equal(awaitingTrust.status.requiresAttention,true,'a receipt check cannot resolve an unanswered native trust prompt');
  const directory=join(f.root,'.claude','projects','existing-desktop');await mkdir(directory,{recursive:true});
  const nativeUuid=randomUUID();
  await writeFile(join(directory,f.target.sessionId+'.jsonl'),JSON.stringify({type:'user',uuid:nativeUuid,
    sessionId:f.target.sessionId,timestamp:new Date().toISOString(),permissionMode:'default',message:{role:'user',content:f.prompt}})+'\n');
  const finished=await runClaudeUiRecovery('finish',f.input,recovery);
  assert.equal(finished.complete,true);assert.equal(finished.status.requiresAttention,false);
  assert.equal(finished.status.receiptState,'recipient-observed');
  assert.equal(finished.observation.evidence.messageId,f.message.id);
  assert.equal(finished.observation.evidence.recordUuid,nativeUuid);
  assert.equal(finished.observation.evidence.recipientPermissionMode,'default');
  assert.equal((await runClaudeUiRecovery('prepare',f.input,recovery)).ready,false);
  assert.equal((await runClaudeUiRecovery('arm',f.input,recovery)).armed,false);
  assert.equal(handoffs,1);
  assert.equal(await readFile(join(f.root,'.bridge','messages',f.message.id+'.json'),'utf8'),original);
});
test('changed prompt, original envelope, missing attempt or native session mapping stops UI delivery',async t=>{
  const f=await fixture(t);await enqueueClaudeUiRecovery(f.target,f.prompt,f.config,f.message,f.options);
  const changed=await runClaudeUiRecovery('prepare',f.input,{...f.recovery,readTarget:async()=>({ready:true,...f.target,sessionId:randomUUID()})});
  assert.equal(changed.ready,false);assert.equal(changed.reasonCode,'claude-ui-native-session-changed');
  await writeFile(join(f.root,'.bridge','ui-recovery',f.message.id+'.prompt.txt'),f.prompt+' changed');
  await assert.rejects(runClaudeUiRecovery('prepare',f.input,f.recovery),/changed/);
});
