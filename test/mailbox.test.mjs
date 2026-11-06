import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createMailbox } from '../src/mailbox.mjs';
import { makeEnvelope } from '../src/protocol.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise,resolve}; };

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(),'agent-bridge-mailbox-'));
  t.after(() => { assert(resolve(root).startsWith(resolve(tmpdir()) + sep)); return rm(root,{recursive:true,force:true}); });
  const state = join(root,'.bridge');
  await mkdir(state);
  const messages = new Map(), events = [], stable = new Map(), hooks = {};
  const atomicCreate = async (file, value) => {
    await hooks.beforeCreate?.(value);
    try { await writeFile(file,JSON.stringify(value),{flag:'wx'}); return true; }
    catch (error) { if (error.code === 'EEXIST') return false; throw error; }
  };
  const receipt = async (data, name) => {
    await hooks.beforeReceipt?.(data);
    if (name && stable.has(name)) return stable.get(name);
    const row = {...data,id:randomUUID(),createdAt:new Date().toISOString()};
    events.push(row); if (name) stable.set(name,row); return row;
  };
  const get = async id => { assert(messages.has(id)); return messages.get(id); };
  const receipts = async id => events.filter(row => !id || row.messageId === id);
  const listMessages = async () => [...messages.values()];
  const create = input => { const message=makeEnvelope({from:'codex',to:'claude',body:'task',...input}); messages.set(message.id,message); return message; };
  const mailbox = () => createMailbox({state,atomicCreate,get,receipts,receipt,listMessages});
  return {state,messages,events,hooks,receipt,create,mailbox};
}

test('task receipt remains pending and claimable; terminal correlated result completes it', async t => {
  const f=await fixture(t), m=f.create(), box=f.mailbox();
  await f.receipt({messageId:m.id,agent:'claude',state:'received'});
  assert.equal((await box.pendingRows([m],f.events,{agent:'claude'})).length,1);
  assert.equal((await box.claim('claude',m.id)).claimed,true);
  f.create({from:'claude',to:'codex',kind:'result',body:'done',replyTo:m.id,correlationId:m.correlationId});
  assert.equal((await box.pendingRows([m],f.events,{agent:'claude'})).length,0);
  assert.equal((await box.claim('claude',m.id)).claimed,false);
});

test('received results are read, while unrelated or nonterminal replies do not complete tasks', async t => {
  const f=await fixture(t), m=f.create(), result=f.create({kind:'result'}), box=f.mailbox();
  f.create({from:'claude',to:'codex',kind:'progress',body:'running',replyTo:m.id,correlationId:m.correlationId});
  f.create({from:'claude',to:'codex',kind:'result',body:'different correlation',replyTo:m.id});
  await f.receipt({messageId:result.id,agent:'claude',state:'received'});
  const pending=await box.pendingRows([m,result],f.events,{agent:'claude',includeBodies:false});
  assert.deepEqual(pending.map(row=>row.id),[m.id]);
  assert(!Object.hasOwn(pending[0],'body'));
  assert.equal((await box.claim('claude',result.id)).claimed,false);
});

test('concurrent claims create one durable consumer, and restart resumes only that owner', async t => {
  const f=await fixture(t), session={sessionId:randomUUID(),hostSessionId:'local_' + randomUUID()};
  const m=f.create({recipientSession:session}), box=f.mailbox();
  const claims=await Promise.all([box.claim('claude',m.id,{session}),box.claim('claude',m.id,{session})]);
  assert.equal(claims.filter(row=>row.claimed).length,1);
  const owner=claims.find(row=>row.claimed).claim;
  assert.equal(typeof owner.consumerId,'string');
  const restarted=f.mailbox();
  assert.equal((await restarted.claim('claude',m.id,{session,consumerId:owner.consumerId})).claimed,false);
  await assert.rejects(()=>restarted.claim('claude',m.id,{session,resume:true,consumerId:'another-owner'}),/work owner/);
  await assert.rejects(()=>restarted.claim('claude',m.id,{session,resume:true}),/stored consumerId/);
  await assert.rejects(()=>restarted.claim('claude',m.id,{session:{sessionId:randomUUID(),hostSessionId:'other'},resume:true,consumerId:owner.consumerId}),/intended recipient/);
  const resumed=await restarted.claim('claude',m.id,{session:{...session,sessionId:randomUUID()},resume:true,consumerId:owner.consumerId});
  assert.equal(resumed.claimed,true);
  assert.equal(resumed.resumed,true);
  assert.equal(resumed.claim.consumerId,owner.consumerId);
  assert.equal(f.events.filter(row=>row.state==='work-claimed').length,1);
});

test('resume cannot create a new claim, and a claim persists across receipt-write interruption', async t => {
  const f=await fixture(t), m=f.create(), box=f.mailbox();
  await assert.rejects(()=>box.claim('claude',m.id,{resume:true,consumerId:'known-owner'}),/existing claim/);
  f.hooks.beforeReceipt=()=>{ throw new Error('interrupted after durable claim'); };
  await assert.rejects(()=>box.claim('claude',m.id,{consumerId:'known-owner'}),/interrupted/);
  delete f.hooks.beforeReceipt;
  const resumed=await f.mailbox().claim('claude',m.id,{resume:true,consumerId:'known-owner'});
  assert.equal(resumed.claimed,true);
  assert.equal(resumed.resumed,true);
  assert.equal(f.events.filter(row=>row.state==='work-claimed').length,1);
});

test('supersede wins before a concurrent claim and blocks later resume', async t => {
  const f=await fixture(t), original=f.create(), replacement=f.create(), box=f.mailbox();
  const entered=deferred(), release=deferred();
  f.hooks.beforeReceipt=async row=>{ if(row.state==='message-superseded'){entered.resolve();await release.promise;} };
  const superseding=box.supersede(original.id,replacement.id);
  await entered.promise;
  const claiming=box.claim('claude',original.id);
  release.resolve();
  const [superseded,claimed]=await Promise.all([superseding,claiming]);
  assert.equal(claimed.claimed,false);
  assert.equal(claimed.reason,'message-superseded');
  assert.equal(superseded.workAlreadyClaimed,false);
  assert.equal((await box.claim('claude',original.id,{resume:true,consumerId:'any-owner'})).claimed,false);
  assert.equal((await box.pendingRows([original,replacement],f.events,{agent:'claude'})).length,1);
});

test('claim wins before supersede: record ongoing-work limitation and block future claims', async t => {
  const f=await fixture(t), original=f.create(), replacement=f.create(), box=f.mailbox();
  const entered=deferred(), release=deferred();
  f.hooks.beforeCreate=async()=>{entered.resolve();await release.promise;};
  const claiming=box.claim('claude',original.id);
  await entered.promise;
  const superseding=box.supersede(original.id,replacement.id);
  release.resolve();
  const [claimed,superseded]=await Promise.all([claiming,superseding]);
  assert.equal(claimed.claimed,true);
  assert.equal(superseded.workAlreadyClaimed,true);
  assert.equal(superseded.runningWorkCancellation,'not-guaranteed');
  assert.equal((await box.claim('claude',original.id,{resume:true,consumerId:claimed.claim.consumerId})).claimed,false);
  assert.equal((await box.supersede(original.id,replacement.id)).id,superseded.id);
  await assert.rejects(()=>box.supersede(original.id,f.create().id),/different replacement/);
});
