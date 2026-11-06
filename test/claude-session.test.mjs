import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import net from 'node:net';
import { resolveClaudeSession } from '../src/claude-session.mjs';
import { createBridge } from '../src/index.mjs';
import { inspectClaude } from '../src/adapters/claude.mjs';
import { transportEndpointKey, recipientFingerprint, resumeDecision } from '../src/transport-runtime.mjs';

const target = { sessionId:'old-runtime',hostSessionId:'stable-desktop-chat' };
const current = { sessionId:'new-runtime',hostSessionId:target.hostSessionId };

test('runtime replacement requires a unique exact host identity, never a title/cwd heuristic', () => {
  const match = resolveClaudeSession(target,[current]);
  assert.equal(match.session,current);
  assert.equal(match.matchedBy,'host-session-id');
  assert.equal(target.sessionId,'old-runtime');
  assert.equal(resolveClaudeSession(target,[current,{...target}]).matchedBy,'session-id');
  assert.throws(() => resolveClaudeSession({sessionId:target.sessionId},[current]),{code:'CLAUDE_SESSION_NOT_RUNNING'});
  assert.throws(() => resolveClaudeSession(target,[{...current,hostSessionId:'other-chat',name:'same',cwd:'same'}]),{code:'CLAUDE_SESSION_NOT_RUNNING'});
  assert.throws(() => resolveClaudeSession(target,[current,{...current,sessionId:'newer-runtime'}]),{code:'CLAUDE_SESSION_AMBIGUOUS'});
  assert.throws(() => resolveClaudeSession(target,[{...target,hostSessionId:'other-chat'},current]),{code:'CLAUDE_HOST_ID_CHANGED'});
  assert.throws(() => resolveClaudeSession(target,[{...target},{...target}]),{code:'CLAUDE_SESSION_AMBIGUOUS'});
});

test('logical chat mutex follows runtime replacement while persisted recipient fingerprint stays unchanged', () => {
  const settings = {home:tmpdir()};
  assert.equal(transportEndpointKey('claude',target,settings),transportEndpointKey('claude',current,settings));
  assert.notEqual(transportEndpointKey('claude',target,settings),transportEndpointKey('claude',{...current,hostSessionId:'other-chat'},settings));
  assert.notEqual(recipientFingerprint('claude',target,settings),recipientFingerprint('claude',current,settings));
  const fingerprint = recipientFingerprint('claude',target,settings);
  const attempt = {state:'delivery-attempt',attemptId:'a',recipientFingerprint:fingerprint};
  assert.equal(resumeDecision([attempt],fingerprint).reason,'delivery-uncertain');
  assert.equal(resumeDecision([attempt,{state:'delivery-error',attemptId:'a',failure:{retrySafe:false}}],fingerprint).allowed,false);
  assert.equal(resumeDecision([attempt,{state:'transport-written',attemptId:'a'}],fingerprint).reason,'delivery-already-submitted');
  assert.equal(resumeDecision([attempt,{state:'delivery-error',attemptId:'a',failure:{retrySafe:true}}],fingerprint).allowed,true);
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(),'bridge-claude-runtime-'));
  t.after(() => rm(root,{recursive:true,force:true}));
  const sessionDir=join(root,'.claude','sessions'),project=join(root,'.claude','projects','fixture');
  await Promise.all([mkdir(join(root,'.bridge'),{recursive:true}),mkdir(sessionDir,{recursive:true}),mkdir(project,{recursive:true})]);
  const config = {home:root,agents:{codex:{permissionClass:'prompting'},claude:{...target}}};
  const configPath=join(root,'.bridge','config.json');
  await writeFile(configPath,JSON.stringify(config));
  const pipe='\\\\.\\pipe\\cc-msg-'+randomUUID().replaceAll('-','');
  const live={...current,pid:process.pid,procStart:'fixture-start',peerProtocol:1,messagingSocketPath:pipe};
  return {root,sessionDir,project,config,configPath,pipe,live,bridge:createBridge({root})};
}

test('real adapter resumes the persisted ID into a replacement runtime with no config or old receipt edits',
  {skip:process.platform!=='win32'},async t => {
    const f=await fixture(t),input={id:randomUUID(),from:'codex',to:'claude',body:'private fixture request'};
    await assert.rejects(() => f.bridge.send(input),/CLAUDE_SESSION_NOT_RUNNING/);
    const messagePath=join(f.root,'.bridge','messages',input.id+'.json');
    const originalMessage=await readFile(messagePath,'utf8'),originalConfig=await readFile(f.configPath,'utf8');
    const oldReceipts=await f.bridge.receipts(input.id);
    const before=new Map(await Promise.all(oldReceipts.map(async row => [row.id,await readFile(join(f.root,'.bridge','receipts',row.id+'.json'),'utf8')])));
    let count=0,resolveFrames;
    const framesReady=new Promise(resolve => {resolveFrames=resolve;});
    const server=net.createServer(socket=>{
      count++;let data='';socket.on('data',chunk=>{data+=chunk;});
      socket.on('end',()=>resolveFrames(data.trim().split('\n').map(line=>JSON.parse(line))));
    });
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(f.pipe,resolve);});
    t.after(()=>new Promise(resolve=>server.close(resolve)));
    await writeFile(join(f.sessionDir,process.pid+'.json'),JSON.stringify(f.live));
    const keyName=process.pid+'.'+createHash('sha256').update(f.pipe.toLowerCase()).digest('hex')+'.key';
    await writeFile(join(f.sessionDir,keyName),JSON.stringify({procStart:f.live.procStart,peerToken:'a'.repeat(32)}));
    const resumed=await f.bridge.resume(input.id);
    assert.equal(resumed.resumed,true);
    assert.equal(resumed.delivery.sessionId,current.sessionId);
    assert.equal(resumed.delivery.runtimeResolution.matchedBy,'host-session-id');
    const frames=await framesReady;
    assert.equal(frames[1].uuid,input.id);
    assert.equal(frames[1].session_id,current.sessionId);
    assert.equal(frames[1].msg_id,input.id);
    assert.equal(count,1);
    assert.equal(await readFile(messagePath,'utf8'),originalMessage);
    assert.equal(await readFile(f.configPath,'utf8'),originalConfig);
    for(const [id,bytes] of before) assert.equal(await readFile(join(f.root,'.bridge','receipts',id+'.json'),'utf8'),bytes);
    await writeFile(join(f.project,current.sessionId+'.jsonl'),JSON.stringify({type:'user',uuid:input.id,
      sessionId:current.sessionId,origin:{kind:'peer',from:'bridge:agent-bridge-codex',msg_id:input.id}})+'\n');
    const checked=await f.bridge.check(input.id);
    assert.equal(checked.status.receiptState,'recipient-observed');
    assert.equal(checked.status.transportFailure,undefined);
    assert.equal(checked.observation.evidence.runtimeResolution.resolvedSessionId,current.sessionId);
    assert.equal((await f.bridge.resume(input.id)).reason,'delivery-already-submitted');
    assert.equal(count,1);
  });

test('read-only check preserves historical exact receipt and rejects evidence in an unrelated runtime',async t=>{
  const f=await fixture(t),message={id:randomUUID(),from:'codex'};
  const received=sessionId=>({type:'user',uuid:message.id,sessionId,origin:{kind:'peer',from:'bridge:agent-bridge-codex',msg_id:message.id}});
  await writeFile(join(f.project,target.sessionId+'.jsonl'),JSON.stringify(received(target.sessionId))+'\n');
  assert.equal((await inspectClaude(target,f.config,message)).state,'recipient-observed');
  await writeFile(join(f.project,target.sessionId+'.jsonl'),'');
  await writeFile(join(f.sessionDir,process.pid+'.json'),JSON.stringify({...f.live,hostSessionId:'other-chat'}));
  await writeFile(join(f.project,current.sessionId+'.jsonl'),JSON.stringify(received(current.sessionId))+'\n');
  assert.equal((await inspectClaude(target,f.config,message)).state,'delivery-unconfirmed');
});

test('host-only reply routes resolve a current runtime for read-only receipt checks',async t=>{
  const f=await fixture(t),message={id:randomUUID(),from:'codex'};
  const hostOnly={hostSessionId:target.hostSessionId};
  const offline=await inspectClaude(hostOnly,f.config,message);
  assert.equal(offline.state,'delivery-unconfirmed');
  await writeFile(join(f.sessionDir,process.pid+'.json'),JSON.stringify(f.live));
  await writeFile(join(f.project,current.sessionId+'.jsonl'),JSON.stringify({type:'user',uuid:message.id,
    sessionId:current.sessionId,origin:{kind:'peer',from:'bridge:agent-bridge-codex',msg_id:message.id}})+'\n');
  const result=await inspectClaude(hostOnly,f.config,message);
  assert.equal(result.state,'recipient-observed');
  assert.equal(result.sessionId,current.sessionId);
  assert.equal(result.evidence.runtimeResolution.matchedBy,'host-session-id');
  assert.deepEqual(hostOnly,{hostSessionId:target.hostSessionId});
});
