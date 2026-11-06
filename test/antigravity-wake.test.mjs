import test from 'node:test';
import assert from 'node:assert/strict';
import { wakeAntigravity } from '../src/antigravity-wake.mjs';

const target = { conversationId: '1852506e-17f6-4b9e-a47c-4ef0f27e8b54' };
const connection = { address: 'http://127.0.0.1:12345', csrfToken: 'SECRET', exe: 'native.exe' };
const unloaded = () => Object.assign(new Error('PRIVATE PROCESS DATA'), { code: 'ANTIGRAVITY_APP_NOT_RUNNING' });
const trajectory = { status: 'CASCADE_RUN_STATUS_IDLE', trajectory: { cascadeId: target.conversationId, steps: [] } };

test('dormant exact App conversation is rehydrated without a prompt, model override or new cascade', async () => {
  const calls = [];
  const result = await wakeAntigravity(target, {}, {
    discover: async () => connection,
    launchApplication: async () => assert.fail('running application must not be relaunched'),
    rpc: async (method, body, options) => { calls.push({method, body}); assert.equal(options.connection, connection); return trajectory; }
  });
  assert.deepEqual(calls, [{method:'GetCascadeTrajectory', body:{cascadeId:target.conversationId,disableRehydration:false}}]);
  assert.equal(result.ready,true);
  assert.equal(result.appStarted,false);
  assert.equal(result.rehydrated,true);
  assert.doesNotMatch(JSON.stringify(result),/SECRET|PRIVATE/);
});

test('absent App is launched once and discovers current endpoint before exact history verification', async () => {
  let discovered=0, launched=0, tick=0; const paths=[];
  const result=await wakeAntigravity(target,{home:'C:/owner'},{
    now:()=>tick, wait:async ms=>{tick+=ms;},
    isFile:async path=>{paths.push(path);return true;},
    discover:async()=>{if(++discovered<3)throw unloaded();return connection;},
    launchApplication:async path=>{launched++;assert.match(path,/Antigravity\.exe$/);},
    rpc:async()=>trajectory
  });
  assert.equal(result.ready,true);assert.equal(result.appStarted,true);
  assert.equal(launched,1);assert.equal(discovered,3);
  assert.equal(paths.length,2);assert.match(paths[0],new RegExp(target.conversationId+'\\.db$'));
});

test('missing original history or executable never opens an application or allocates another conversation', async () => {
  for(const missing of ['history','app']){
    let checks=0;
    const result=await wakeAntigravity(target,{}, {discover:async()=>{throw unloaded();},
      isFile:async()=>++checks===1?missing!=='history':false,
      launchApplication:async()=>assert.fail('nothing should launch'), rpc:async()=>assert.fail('nothing should be queried')});
    assert.equal(result.ready,false);
    assert.equal(result.reasonCode,missing==='history'?'stored-conversation-unavailable':'app-executable-unavailable');
  }
});

test('ambiguous endpoint, credential failure, mismatched cascade and malformed ID do not fall back', async () => {
  for(const code of ['ANTIGRAVITY_ENDPOINT_AMBIGUOUS','ANTIGRAVITY_CREDENTIAL_UNAVAILABLE','UNKNOWN']){
    const result=await wakeAntigravity(target,{}, {discover:async()=>{throw Object.assign(new Error('SECRET'),{code});},
      launchApplication:async()=>assert.fail('no fallback')});
    assert.equal(result.ready,false);assert.equal(result.reasonCode,'endpoint-not-recoverable');
  }
  for(const id of [undefined,'00000000-0000-4000-8000-000000000001']){
    const result=await wakeAntigravity(target,{}, {discover:async()=>connection,
      rpc:async()=>({trajectory:{cascadeId:id,steps:[]}})});
    assert.equal(result.reasonCode,'conversation-identity-unconfirmed');
  }
  assert.equal((await wakeAntigravity({conversationId:'../bad'}, {}, {discover:()=>assert.fail()})).reasonCode,'invalid-conversation-id');
});

test('unready backend waits only a bounded request and is not relaunched', async () => {
  let tick=0, discovery=0;
  const result=await wakeAntigravity(target,{}, {wakeTimeoutMs:1000,now:()=>tick,wait:async ms=>{tick+=ms;},
    discover:async()=>{discovery++;throw Object.assign(new Error('PRIVATE'),{code:'ANTIGRAVITY_ENDPOINT_UNAVAILABLE'});},
    launchApplication:async()=>assert.fail('existing backend must not be replaced')});
  assert.equal(result.ready,false);assert.equal(result.reasonCode,'app-readiness-timeout');
  assert.equal(tick,1000);assert.equal(discovery,3);
});

test('launch and RPC errors return fixed diagnostics without argv, tokens or error bodies', async () => {
  const failed=await wakeAntigravity(target,{}, {discover:async()=>connection,rpc:async()=>{throw new Error('SECRET PRIVATE');}});
  assert.equal(failed.reasonCode,'conversation-rehydration-failed');
  assert.doesNotMatch(JSON.stringify(failed),/SECRET|PRIVATE/);
  const launched=await wakeAntigravity(target,{}, {discover:async()=>{throw unloaded();},isFile:async()=>true,
    launchApplication:async()=>{throw new Error('SECRET PRIVATE');}});
  assert.equal(launched.reasonCode,'app-launch-failed');
  assert.doesNotMatch(JSON.stringify(launched),/SECRET|PRIVATE/);
});

test('pinned project mismatch is rejected before conversation rehydration', async () => {
  const result=await wakeAntigravity({...target,projectId:'pinned-project'}, {}, {
    discover:async()=>connection,readMetadata:async()=>({projectId:'different-project'}),
    rpc:async()=>assert.fail('mismatched project must not be rehydrated')});
  assert.equal(result.ready,false);assert.equal(result.reasonCode,'conversation-project-mismatch');
});

test('discovery receives remaining budget and cannot launch after expiration', async () => {
  let tick=0;
  const result=await wakeAntigravity(target,{}, {wakeTimeoutMs:1000,now:()=>tick,
    discover:async options=>{assert.equal(options.timeoutMs,1000);tick=1200;throw unloaded();},
    isFile:async()=>assert.fail('expired work must stop'),launchApplication:async()=>assert.fail('no late launch')});
  assert.equal(result.reasonCode,'app-readiness-timeout');
});
