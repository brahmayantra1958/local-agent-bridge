import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createBridge } from '../src/index.mjs';
import { shouldWakeRecipient, diagnosticWake } from '../src/recipient-wake.mjs';

function outage(code='CLAUDE_SESSION_NOT_RUNNING', phase='preflight', submitted=false) {
  return Object.assign(new Error('private native diagnostic'), {code,delivery:{phase,submitted,retryable:false}});
}
async function fixture(t, adapter, waker, inspector) {
  const root=await mkdtemp(join(tmpdir(),'bridge-wake-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(join(root,'.bridge'));
  const settings={home:root,agents:{codex:{threadId:randomUUID()},claude:{sessionId:randomUUID(),hostSessionId:'local_'+randomUUID()}}};
  await writeFile(join(root,'.bridge/config.json'),JSON.stringify(settings));
  return {root,settings,bridge:createBridge({root,adapters:{claude:adapter},wakers:{claude:waker},inspectors:{claude:inspector}})};
}

test('one automatic wake continues original ID and pinned routes even with maxAttempts one',async t=>{
  let awake=false,wakes=0;const deliveries=[];
  const f=await fixture(t,async(target,prompt,config,message)=>{
    deliveries.push({target:{...target},message:{...message},prompt});
    if(!awake)throw outage();
    return {state:'transport-written',transport:'fixture'};
  },async target=>{wakes++;assert.equal(target.hostSessionId,f.settings.agents.claude.hostSessionId);awake=true;return {ready:true,method:'fixture-resume'};});
  const result=await f.bridge.send({id:randomUUID(),from:'codex',to:'claude',body:'one task'},{maxAttempts:1});
  assert.equal(wakes,1);assert.equal(deliveries.length,2);
  assert.deepEqual(deliveries[0],deliveries[1]);
  assert.equal(result.status.transportState,'transport-written');
  assert.equal((await f.bridge.receipts(result.message.id)).filter(x=>x.state==='recipient-wake-ready').length,1);
  assert.deepEqual(JSON.parse(await readFile(join(f.root,'.bridge/config.json'),'utf8')),f.settings);
  await f.bridge.resume(result.message.id);
  assert.equal(wakes,1);assert.equal(deliveries.length,2);
});

test('wake failure retains unsent state without a manufactured receipt or repeated launch',async t=>{
  let wakes=0,calls=0;
  const f=await fixture(t,async()=>{calls++;throw outage();},async()=>{wakes++;throw new Error('secret-token');});
  const sent=await f.bridge.send({from:'codex',to:'claude',body:'queued'},{deferErrors:true});
  assert.equal(wakes,1);assert.equal(calls,1);assert.equal(sent.status.state,'queued');
  const rows=await f.bridge.receipts(sent.message.id);
  assert.equal(rows.some(r=>['received','recipient-observed','transport-written'].includes(r.state)),false);
  assert.equal(JSON.stringify(rows).includes('secret-token'),false);
});

test('uncertain writes and permission failures never wake or resend',async t=>{
  for(const error of [outage('ECONNRESET','response',true),outage('CLAUDE_CREDENTIAL_MISSING')]) {
    let wakes=0,calls=0;
    const f=await fixture(t,async()=>{calls++;throw error;},async()=>{wakes++;return {ready:true};},async()=>({state:'delivery-unconfirmed'}));
    const sent=await f.bridge.send({from:'codex',to:'claude',body:'do not replay'},{deferErrors:true});
    assert.equal(wakes,0);assert.equal(calls,1);
    if(error.delivery.submitted) {await f.bridge.resume(sent.message.id);assert.equal(calls,1);}
  }
});

test('concurrent same-ID resumes serialize wake and submission once',async t=>{
  let wakes=0,calls=0,awake=false;
  const f=await fixture(t,async()=>{calls++;if(!awake)throw outage();return {state:'transport-written',transport:'fixture'};},
    async()=>{wakes++;await new Promise(r=>setTimeout(r,20));awake=true;return {ready:true};});
  const sent=await f.bridge.send({from:'codex',to:'claude',body:'resume'},{autoWake:false,deferErrors:true});
  const result=await Promise.all([f.bridge.resume(sent.message.id),f.bridge.resume(sent.message.id)]);
  assert.equal(wakes,1);assert.equal(calls,3);
  assert.equal(result.filter(x=>x.resumed===true).length,1);
});

test('wake disabled and invalid options have no recovery side effects',async t=>{
  let wakes=0;
  const f=await fixture(t,async()=>{throw outage();},async()=>{wakes++;return {ready:true};});
  await f.bridge.send({from:'codex',to:'claude',body:'lifecycle'},{autoWake:false,deferErrors:true});
  await assert.rejects(()=>f.bridge.send({from:'codex',to:'claude',body:'invalid'},{autoWake:'yes'}),/autoWake/);
  assert.equal(wakes,0);
});

test('wake eligibility excludes missing identities, ambiguity and uncertain connection failures',()=>{
  const failure={code:'CLAUDE_SESSION_NOT_RUNNING',phase:'preflight',retrySafe:true};
  assert.equal(shouldWakeRecipient('claude',failure,{sessionId:randomUUID()}),false);
  assert.equal(shouldWakeRecipient('claude',{...failure,code:'CLAUDE_SESSION_AMBIGUOUS'},{hostSessionId:'local_x'}),false);
  assert.equal(shouldWakeRecipient('gemini',{code:'ECONNREFUSED',phase:'connect',retrySafe:false},{conversationId:'x'}),false);
  assert.equal(shouldWakeRecipient('gemini',{code:'ECONNREFUSED',phase:'connect',retrySafe:true},{conversationId:'x'}),true);
  assert.deepEqual(diagnosticWake({ready:true,reasonCode:'ready',method:'app-link',token:'secret',error:'secret'}),
    {ready:true,reasonCode:'ready',method:'app-link'});
});

test('irrecoverable wake failures surface an action while transient readiness remains queued',async t=>{
  for(const [reasonCode,attention] of [['app-executable-unavailable',true],['conversation-project-mismatch',true],['app-readiness-timeout',false]]) {
    const f=await fixture(t,async()=>{throw outage();},async()=>({ready:false,reasonCode}));
    const result=await f.bridge.send({from:'codex',to:'claude',body:'wake result'},{deferErrors:true});
    assert.equal(result.status.requiresAttention,attention);
    if(attention)assert.equal(result.status.nextAction,reasonCode);
  }
});
