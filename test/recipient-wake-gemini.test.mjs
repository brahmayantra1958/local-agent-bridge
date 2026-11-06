import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createBridge } from '../src/index.mjs';
import { wakeAntigravity } from '../src/antigravity-wake.mjs';
import { sendAntigravity, inspectAntigravity } from '../src/adapters/antigravity.mjs';

test('Gemini cold recovery preserves the original envelope and a late uncertain native receipt prevents replay',async t=>{
  const root=await mkdtemp(join(tmpdir(),'bridge-gemini-wake-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(join(root,'.bridge'));
  const target={conversationId:randomUUID(),projectId:randomUUID()};
  const config={home:root,agents:{codex:{threadId:randomUUID(),hostId:'local'},gemini:target}};
  const configBytes=JSON.stringify(config);
  await writeFile(join(root,'.bridge/config.json'),configBytes);
  const outage=()=>Object.assign(new Error('PRIVATE native path'),{code:'ANTIGRAVITY_APP_NOT_RUNNING',
    delivery:{submitted:false,phase:'preflight',retryable:false}});
  const connection={exe:'installed-language-server.exe',address:'http://127.0.0.1:12345',csrfToken:'SECRET'};
  let awake=false,launches=0,wakes=0,clock=0,nativeSends=0,latePrompt;
  const transportCalls=[],nativeInputs=[];
  const history=()=>({status:'CASCADE_RUN_STATUS_IDLE',numTotalSteps:1+nativeInputs.length,trajectory:{
    cascadeId:target.conversationId,metadata:{projectId:target.projectId},steps:[
      {type:'CORTEX_STEP_TYPE_USER_INPUT',userInput:{userResponse:'prior work',
        userConfig:{plannerConfig:{planModel:'MODEL_PLACEHOLDER_M417'}}}},
      ...nativeInputs.map(content=>({type:'CORTEX_STEP_TYPE_SYSTEM_MESSAGE',systemMessage:{agentMessage:{content}}}))
    ]}});
  const rpc=async(method,body)=>{
    assert.equal(method,'GetCascadeTrajectory');assert.equal(body.cascadeId,target.conversationId);return history();
  };
  const adapter=async(route,prompt,settings,message,options)=>{
    transportCalls.push({route:{...route},prompt,id:message.id});
    if(!awake)throw outage();
    return sendAntigravity(route,prompt,settings,message,{...options,connection,rpc,
      runAgentApi:async(exe,args)=>{
        nativeSends++;assert.equal(exe,connection.exe);
        assert.deepEqual(args.slice(0,3),['agentapi','send-message',target.conversationId]);
        if(nativeSends===2){latePrompt=args[3];throw Object.assign(new Error('SECRET PRIVATE argv'),{killed:true});}
        nativeInputs.push(args[3]);return {stdout:'accepted'};
      }});
  };
  const bridge=createBridge({root,adapters:{gemini:adapter},inspectors:{gemini:(route,settings,message)=>
    inspectAntigravity(route,settings,message,{connection,rpc})},wakers:{gemini:(route,settings,options)=>{
      wakes++;
      return wakeAntigravity(route,settings,{...options,now:()=>clock,wait:async ms=>{clock+=ms;},
        discover:async()=>{if(!awake)throw outage();return connection;},isFile:async()=>true,
        launchApplication:async()=>{launches++;awake=true;},readMetadata:async()=>({projectId:target.projectId}),rpc});
    }}});
  const originalId=randomUUID();
  const delivered=await bridge.send({id:originalId,from:'codex',to:'gemini',body:'original task'},{maxAttempts:1});
  assert.equal(delivered.status.receiptState,'recipient-observed');
  assert.equal(delivered.status.wake.method,'app-launch-and-rehydrate');
  assert.equal(launches,1);assert.equal(wakes,1);assert.equal(nativeSends,1);
  assert.deepEqual(transportCalls[0],transportCalls[1]);
  const originalFile=join(root,'.bridge/messages',originalId+'.json'),originalBytes=await readFile(originalFile);
  assert.equal(JSON.parse(originalBytes).recipientSession.conversationId,target.conversationId);
  assert.equal(JSON.parse(originalBytes).id,originalId);

  // The native CLI times out after invocation. Its input appears later; this
  // is evidence to observe, never authorization to make a second native send.
  const uncertain=await bridge.send({from:'codex',to:'gemini',body:'late native receipt'},{maxAttempts:1});
  assert.equal(uncertain.status.transportState,'uncertain');
  assert.equal(uncertain.status.receiptState,'unconfirmed');
  assert.equal(nativeSends,2);
  nativeInputs.push(latePrompt);
  const late=await bridge.resume(uncertain.message.id,{maxAttempts:1});
  assert.equal(late.resumed,false);assert.equal(late.reason,'delivery-already-submitted');
  assert.equal(late.status.receiptState,'recipient-observed');
  assert.equal(nativeSends,2);assert.equal(launches,1);assert.equal(wakes,1);
  assert.equal((await readFile(originalFile)).equals(originalBytes),true);
  assert.equal(await readFile(join(root,'.bridge/config.json'),'utf8'),configBytes);
  assert.doesNotMatch(JSON.stringify(await bridge.receipts()),/SECRET|PRIVATE/);
});
