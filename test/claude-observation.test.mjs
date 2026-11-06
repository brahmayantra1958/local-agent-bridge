import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,appendFile,rm,open,stat,rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {scanClaudeTranscript,readClaudeDeliveryEvidence,findClaudeTranscript} from '../src/claude-observation.mjs';

const target={sessionId:'claude-runtime'};
const message={id:'peer-message-id',from:'codex'};
const peer='bridge:agent-bridge-codex';
const privateText='PRIVATE TEXT / TOKEN / TOOL ARGUMENTS';
const received={type:'user',uuid:message.id,sessionId:target.sessionId,
  timestamp:'2026-11-04T03:18:10.600Z',permissionMode:'bypassPermissions',
  origin:{kind:'peer',from:peer,msg_id:message.id,body:privateText},message:{content:privateText}};
const held={type:'system',subtype:'peer_message_hold',state:'held',session_id:target.sessionId,
  lane:'socket',from:peer,message_uuid:message.id,cause:'mode-mismatch',body:privateText};
const line=row=>JSON.stringify(row)+'\n';
async function fixture(t) {
  const home=await mkdtemp(join(tmpdir(),'bridge-claude-stream-'));
  t.after(()=>rm(home,{recursive:true,force:true}));
  const project=join(home,'.claude','projects','project');
  await mkdir(project,{recursive:true});
  return {home,project,path:join(project,target.sessionId+'.jsonl')};
}

test('receipt older than the previous eight MiB tail is found without returning transcript contents',async t=>{
  const f=await fixture(t);
  const padding=line({type:'assistant',sessionId:target.sessionId,message:{content:'x'.repeat(64*1024)}});
  await writeFile(f.path,line(received)+padding.repeat(130));
  const data=await readClaudeDeliveryEvidence(target,{home:f.home},message);
  assert.equal(data.transcript.records[0].uuid,message.id);
  assert.equal(data.transcript.records.length,1);
  assert.equal(data.transcript.truncated,false);
  assert.equal(data.transcript.scan.complete,true);
  assert.ok(data.transcript.scan.bytesScanned>8*1024*1024);
  assert.equal(JSON.stringify(data).includes(privateText),false);
  assert.equal(data.transcript.records[0].message,undefined);
});

test('delayed exact receipt is found on the next event without counting a quoted ID or other runtime',async t=>{
  const f=await fixture(t);
  await writeFile(f.path,[
    {...received,type:'assistant'},
    {...received,uuid:'other',origin:undefined},
    {...received,sessionId:'other-runtime'},
    {...received,session_id:'other-runtime'},
    {...received,origin:{...received.origin,msg_id:'other'}},
    {...received,origin:{...received.origin,from:'bridge:agent-bridge-gemini'}},
    {type:'user',uuid:message.id,sessionId:target.sessionId,message:{content:line(received)}}
  ].map(line).join(''));
  assert.equal((await scanClaudeTranscript(f.path,target,message)).records.length,0);
  await appendFile(f.path,line(received));
  const result=await scanClaudeTranscript(f.path,target,message);
  assert.equal(result.records.length,1);
  assert.equal(result.records[0].origin.msg_id,message.id);
});

test('scan and line limits are explicit; oversized unrelated records do not hide a later exact receipt',async t=>{
  const f=await fixture(t);
  await writeFile(f.path,line({text:'x'.repeat(2048)})+line(received));
  const limited=await scanClaudeTranscript(f.path,target,message,{maxScanBytes:100});
  assert.equal(limited.records.length,0);
  assert.equal(limited.truncated,true);
  assert.equal(limited.scan.complete,false);
  const result=await scanClaudeTranscript(f.path,target,message,{maxLineBytes:1024});
  assert.equal(result.records[0].uuid,message.id);
  assert.equal(result.scan.oversizedRecords,1);
  assert.equal(result.scan.complete,false);
  assert.equal((await scanClaudeTranscript(f.path,target,message,{maxBytes:10})).records.length,0);
});

test('partial and malformed records cannot be promoted to exact receipt',async t=>{
  const f=await fixture(t);
  await writeFile(f.path,'{ malformed }\n'+JSON.stringify(received));
  const partial=await scanClaudeTranscript(f.path,target,message);
  assert.equal(partial.records.length,0);
  assert.equal(partial.scan.parseErrors,1);
  assert.equal(partial.scan.partialFinalLine,true);
  assert.equal(partial.scan.complete,false);
  await appendFile(f.path,'\n');
  const completed=await scanClaudeTranscript(f.path,target,message);
  assert.equal(completed.records[0].uuid,message.id);
  assert.equal(completed.scan.complete,false);
});

test('native held/released/dropped evidence keeps only the latest exact event and no private fields',async t=>{
  const f=await fixture(t),events=join(f.home,'events.jsonl');
  await writeFile(f.path,line({type:'assistant',text:message.id}));
  await writeFile(events,[held,{...held,lane:'stdin',state:'dropped',outcome:'refused'},
    {...held,session_id:'other-session'}, {...held,state:'released'}].map(line).join(''));
  let data=await readClaudeDeliveryEvidence({...target,deliveryEventsPath:events},{home:f.home},message);
  assert.equal(data.hostEvents.records.length,1);
  assert.equal(data.hostEvents.records[0].state,'released');
  assert.equal(JSON.stringify(data).includes(privateText),false);
  await appendFile(events,line({...held,state:'dropped',outcome:'expired'}));
  data=await readClaudeDeliveryEvidence({...target,deliveryEventsPath:events},{home:f.home},message);
  assert.equal(data.hostEvents.records[0].outcome,'expired');
});

test('missing and ambiguous transcript discovery do not silently select another project',async t=>{
  const f=await fixture(t);
  assert.equal((await findClaudeTranscript(target,{home:f.home})).missing,true);
  await writeFile(f.path,line(received));
  const other=join(f.home,'.claude','projects','other');await mkdir(other);
  await writeFile(join(other,target.sessionId+'.jsonl'),line(received));
  const data=await readClaudeDeliveryEvidence(target,{home:f.home},message);
  assert.equal(data.transcript,undefined);
  assert.equal(data.discovery.ambiguous,true);
  assert.equal((await findClaudeTranscript(target,{home:f.home},{maxDirectories:1})).complete,false);
});

test('a persisted receipt and a native hold remain distinct evidence without a model acknowledgement',async t=>{
  const f=await fixture(t);
  await writeFile(f.path,line(held)+line(received));
  const result=await scanClaudeTranscript(f.path,target,message);
  assert.equal(result.records.length,2);
  assert.equal(result.records[0].type,'user');
  assert.equal(result.records[1].state,'held');
  const data=await readClaudeDeliveryEvidence({...target,deliveryEventsPath:join(f.home,'missing')},{home:f.home},message);
  assert.equal(data.hostEventsUnavailable,true);
  assert.equal(data.transcript.records[0].uuid,message.id);
});

test('rotation during an open snapshot drops old-source evidence, while a plain append preserves exact receipt',async t=>{
  for(const mutation of ['rotate','truncate','append']) await t.test(mutation,async t=>{
    const f=await fixture(t);await writeFile(f.path,line(received));
    let changed=false;
    const io={stat,open:async(...args)=>{
      const handle=await open(...args);
      return {stat:()=>handle.stat(),close:()=>handle.close(),read:async(...readArgs)=>{
        const read=await handle.read(...readArgs);
        if(!changed) {
          changed=true;
          if(mutation==='rotate') {await rename(f.path,f.path+'.old');await writeFile(f.path,line({type:'assistant'}));}
          else if(mutation==='truncate') await writeFile(f.path,'');
          else await appendFile(f.path,line({type:'assistant'}));
        }
        return read;
      }};
    }};
    const result=await scanClaudeTranscript(f.path,target,message,{},io);
    assert.equal(result.scan.changedDuringScan,true);
    assert.equal(result.scan.complete,false);
    assert.equal(result.scan.sourceReplaced,mutation!=='append');
    assert.equal(result.records.length,mutation==='append'?1:0);
  });
});
