import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createBridge, makeEnvelope, validateEnvelope } from '../src/index.mjs';
async function fixture(t,send){const root=await mkdtemp(join(tmpdir(),'agent-bridge-test-'));t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(join(root,'.bridge'));await writeFile(join(root,'.bridge','config.json'),JSON.stringify({agents:{codex:{},claude:{},gemini:{}}}));return createBridge({root,adapters:{codex:send,claude:send,gemini:send}});}
test('reject invalid endpoints, traversal IDs, oversized Unicode bodies and versions',()=>{
  assert.throws(()=>makeEnvelope({from:'x',to:'claude',body:'x'}));
  assert.throws(()=>makeEnvelope({from:'codex',to:'codex',body:'x'}));
  assert.throws(()=>makeEnvelope({id:'../escape',from:'codex',to:'claude',body:'x'}));
  assert.throws(()=>makeEnvelope({from:'codex',to:'claude',body:'가'.repeat(17000)}));
  assert.throws(()=>validateEnvelope({...makeEnvelope({from:'codex',to:'claude',body:'x'}),version:2}));
});
test('duplicate sends are persisted once and never redelivered, even concurrently',async t=>{
  let calls=0;const b=await fixture(t,async()=>{calls++;return {state:'native-accepted',transport:'test'};});
  const input={id:randomUUID(),from:'codex',to:'claude',body:'한글 🧪 통신'};
  const results=await Promise.all([b.send(input),b.send(input)]);
  assert.equal(calls,1);assert.equal(results.filter(x=>x.duplicate).length,1);assert.equal((await b.inbox('claude')).length,1);
  await assert.rejects(()=>b.send({...input,body:'changed'}),/different envelope/);
});
test('native acceptance never counts as receipt; only recipient may acknowledge',async t=>{
  const b=await fixture(t,async()=>({state:'native-accepted',transport:'test'}));const {message:m}=await b.send({from:'codex',to:'gemini',body:'ping',kind:'ping'});
  assert.equal((await b.receipts(m.id)).some(r=>r.state==='received'),false);
  await assert.rejects(()=>b.receive('claude',m.id),/recipient/);
  await Promise.all([b.receive('gemini',m.id),b.receive('gemini',m.id)]);
  assert.equal((await b.receipts(m.id)).filter(r=>r.state==='received').length,1);
});
test('replies preserve correlation and reverse endpoints; unrelated replies rejected',async t=>{
  const b=await fixture(t,async()=>({state:'transport-written',transport:'test'}));const {message:m}=await b.send({from:'codex',to:'claude',body:'ping',kind:'ping'});
  const {message:r}=await b.reply('claude',m.id,{kind:'pong',body:'PONG'});assert.equal(r.replyTo,m.id);assert.equal(r.correlationId,m.correlationId);assert.equal(r.to,'codex');
  await assert.rejects(()=>b.send({from:'gemini',to:'codex',kind:'pong',body:'wrong',replyTo:m.id,correlationId:m.correlationId}),/Reply endpoints/);
});
test('ambiguous transport failure is durable and never automatically retried',async t=>{
  let calls=0;const b=await fixture(t,async()=>{calls++;throw Error('timeout');});const input={id:randomUUID(),from:'codex',to:'claude',body:'x'};
  await assert.rejects(()=>b.send(input),/persisted/);assert.equal((await b.receipts(input.id)).at(-1).state,'delivery-error');
  assert.equal((await b.send(input)).duplicate,true);assert.equal(calls,1);
});
