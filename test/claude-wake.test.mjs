import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { readClaudeWakeTarget, wakeClaude, inspectClaudeUiReceipt, sendClaudeDesktopUi } from '../src/claude-wake.mjs';

const sessionId=randomUUID(),hostSessionId='local_'+randomUUID(),target={sessionId,hostSessionId};
const message={id:randomUUID(),from:'codex'};
const text='[agent-bridge original '+message.id+']\nExact original task.';
const attempt={attemptedAt:'2026-11-04T04:00:00.000Z',promptSha256:createHash('sha256').update(text).digest('hex')};
const row={type:'user',uuid:randomUUID(),sessionId,timestamp:'2026-11-04T04:00:00.010Z',message:{role:'user',content:text}};

async function fixture(t) {
  const directory=await mkdtemp(join(tmpdir(),'claude-wake-test-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const path=join(directory,'record.jsonl');
  const inspect=async(records,options={})=>{await writeFile(path,records.map(x=>JSON.stringify(x)).join('\n')+'\n');return inspectClaudeUiReceipt(target,{},message,{uiReceipt:attempt,findTranscript:async()=>({path}),...options});};
  return {directory,path,inspect};
}

test('UI receipt binds full prompt hash, native session, post-attempt timestamp and original bridge ID',async t=>{
  const {inspect}=await fixture(t);const result=await inspect([row]);
  assert.equal(result.state,'recipient-observed');assert.equal(result.transport,'claude-desktop-ui');
  assert.equal(result.evidence.messageId,message.id);assert.equal(result.evidence.recordUuid,row.uuid);
  assert.equal(result.evidence.hostSessionId,hostSessionId);assert.equal(JSON.stringify(result).includes(text),false);
});
test('UI quoted IDs, another session, old records, assistant and peer records never prove UI receipt',async t=>{
  const {inspect}=await fixture(t);
  for(const wrong of [
    {...row,type:'assistant'}, {...row,sessionId:randomUUID()}, {...row,session_id:randomUUID()},
    {...row,timestamp:'2026-11-04T03:59:59.999Z'}, {...row,message:{content:'Quote '+text}},
    {...row,origin:{kind:'peer'}}, {...row,uuid:'not-a-native-uuid'},
  ])assert.equal(await inspect([wrong]),null);
  assert.equal(await inspect([row],{uiReceipt:undefined}),null);
  assert.equal(await inspect([row],{uiReceipt:{...attempt,promptSha256:'z'.repeat(64)}}),null);
});
test('UI exact text blocks accepted, mixed non-text content refused',async t=>{
  const {inspect}=await fixture(t);
  assert.equal((await inspect([{...row,message:{content:[{type:'text',text}]}}])).state,'recipient-observed');
  assert.equal(await inspect([{...row,message:{content:[{type:'text',text},{type:'image',source:{}}]}}]),null);
});
test('saved host must exist uniquely and must not be archived; no new conversation manufactured',async t=>{
  const {directory}=await fixture(t);
  assert.equal((await readClaudeWakeTarget(target,{home:directory})).reasonCode,'claude-wake-conversation-missing');
  const parent=join(directory,'AppData','Roaming','Claude','claude-code-sessions',randomUUID(),randomUUID());await mkdir(parent,{recursive:true});
  const path=join(parent,hostSessionId+'.json');const saved={sessionId:hostSessionId,cliSessionId:sessionId,title:'Same conversation',isArchived:false};
  await writeFile(path,JSON.stringify(saved));assert.equal((await readClaudeWakeTarget(target,{home:directory})).ready,true);
  await writeFile(path,JSON.stringify({...saved,isArchived:true}));assert.equal((await readClaudeWakeTarget(target,{home:directory})).reasonCode,'claude-wake-conversation-archived');
  assert.equal((await readClaudeWakeTarget({sessionId},{home:directory})).reasonCode,'claude-wake-host-required');
});
test('wake preparation requires an exact stored target and registered Codex executor without sending',async()=>{
  const options={readTarget:async()=>({ready:true,...target,title:'Original'})};
  assert.equal((await wakeClaude(target,{},options)).reasonCode,'claude-wake-codex-executor-unavailable');
  assert.deepEqual(await wakeClaude(target,{agents:{codex:{threadId:'original'}},codexCallerThreadId:'original'},options),
    {ready:true,method:'claude-desktop-ui',reasonCode:'claude-ui-recovery-dispatch-ready'});
});
test('UI transport enqueues once with persisted exact hash and never claims Claude receipt',async()=>{
  let sends=0;const options={uiReceipt:attempt,readTarget:async()=>({ready:true,...target,title:'Original'}),findExecutable:async()=>'/existing/claude.exe',
    enqueue:async(t,p)=>{sends++;assert.equal(t.hostSessionId,hostSessionId);assert.equal(p,text);return {state:'ui-handoff-queued',transport:'codex-ui-recovery'};}};
  const result=await sendClaudeDesktopUi(target,text,{},message,options);
  assert.equal(sends,1);assert.equal(result.runtimeResolution.resolvedSessionId,sessionId);
  assert.equal(result.state,'ui-handoff-queued');assert.equal(result.observation,undefined);
  await assert.rejects(sendClaudeDesktopUi(target,text+' changed',{},message,options),/persisted Claude UI attempt/);
  assert.equal(sends,1);
});
