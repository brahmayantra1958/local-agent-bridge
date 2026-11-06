#!/usr/bin/env node
import { createBridge } from '../src/index.mjs';
import { verifyCommunication } from '../src/verification.mjs';
import { loadRoutingProfile } from '../src/routing.mjs';
import { delegate } from '../src/delegation.mjs';
import { dispatchImageTask } from '../src/images.mjs';
import { createCoordinator } from '../src/coordination.mjs';
import { createRecoveryDispatcher } from '../src/recovery-dispatch.mjs';
import { joinChat, selfTest } from '../src/join.mjs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const args=process.argv.slice(2),command=args.shift();const options={};
try{
  for(let i=0;i<args.length;i+=2){if(!args[i].startsWith('--')||args[i+1]===undefined)throw new Error('Expected --option value');if(options[args[i].slice(2)]!==undefined)throw new Error('Duplicate option');options[args[i].slice(2)]=args[i+1];}
  const bridge=createBridge({root:options.root??fileURLToPath(new URL('..',import.meta.url))});
  const bool=(name,fallback=false)=>{if(options[name]===undefined)return fallback;if(!['true','false'].includes(options[name]))throw new Error('--'+name+' must be true or false');return options[name]==='true';};
  const sessionFile=async name=>options[name]?JSON.parse(await readFile(options[name],'utf8')):undefined;
  const execution={deferErrors:true,autoWake:bool('auto-wake',true),versionCheck:bool('version-check',true),scopeGuard:bool('scope-guard',true),holdGuard:bool('hold-guard',true),...(options['response-timeout-ms']?{responseTimeoutMs:Number(options['response-timeout-ms'])}:{})};
  const routes={senderSession:await sessionFile('sender-session-file'),recipientSession:await sessionFile('recipient-session-file')};
  let result;const body=options['body-file']?await readFile(options['body-file'],'utf8'):options.body;
  switch(command){
    case 'send':result=await bridge.send({from:options.from,to:options.to,body,kind:options.kind,id:options.id,replyTo:options['reply-to'],correlationId:options.correlation,...routes},execution);break;
    case 'reply':result=await bridge.reply(options.agent,options.id,{body,kind:options.kind,...routes,...execution,
      // The result file is the bridge's own input, not a delegated write.
      ...(options['body-file']?{scopeExclude:resolve(options['body-file'])}:{})});break;
    case 'receive':result=await bridge.receive(options.agent,options.id);break;
    case 'claim':result=await bridge.claim(options.agent,options.id,{session:await sessionFile('session-file'),consumerId:options['consumer-id'],resume:bool('resume')});break;
    case 'supersede':result=await bridge.supersede(options.id,options.by);break;
    case 'flush':result=await bridge.flush({to:options.to,limit:Number(options.limit??20),...execution});break;
    case 'inbox':result=await bridge.inbox(options.agent,{pending:bool('pending',true),session:await sessionFile('session-file'),includeBodies:bool('include-bodies',true)});break;
    case 'read':result=await bridge.read(options.agent);break;
    case 'status':result=await bridge.status({includeBodies:bool('include-bodies'),id:options.id});break;
    case 'check':result=await bridge.check(options.id);break;
    case 'resume':result=await bridge.resume(options.id,{...execution,adoptClaim:bool('adopt-claim')});break;
    case 'delegate':result=await delegate(bridge,{from:options.from,profile:await loadRoutingProfile(options.profile,{root:bridge.root}),taskType:options['task-type'],task:JSON.parse(await readFile(options['task-file'],'utf8')),runner:options.runner,sessionId:options['session-id'],evidence:options['evidence-file']?JSON.parse(await readFile(options['evidence-file'],'utf8')):undefined,
      sendOptions:{scopeGuard:execution.scopeGuard,holdGuard:execution.holdGuard,versionCheck:execution.versionCheck}});break;
    case 'image':result=await dispatchImageTask(bridge,{from:options.from,request:JSON.parse(await readFile(options['request-file'],'utf8')),webSkillPath:options['skill-path']});break;
    case 'bind':result=await createCoordinator({bridge}).register({requestId:options.id,runId:options['run-id'],source:options.source??'external',eventAvailable:options['event-available']!=='false'});break;
    case 'finish':result=await createCoordinator({bridge,deliveryOptions:execution}).finish(JSON.parse(await readFile(options['report-file'],'utf8')));break;
    case 'recover':result=await createCoordinator({bridge,recoveryDelegate:createRecoveryDispatcher({bridge,from:options.from,to:options.to??'codex'})}).recover(JSON.parse(await readFile(options['error-file'],'utf8')),JSON.parse(await readFile(options['task-file'],'utf8')));break;
    case 'verify':{const record=bool('record-versions');result=verifyCommunication(await bridge.status(),{agents:await bridge.registeredAgents()});if(!result.passed)process.exitCode=1;
      // Opt-in: evidence restricted to the currently installed app versions; record stores verified apps.
      if(record||bool('versions')){result.currentVersions=await bridge.verifyAppVersions({record});if(record&&!result.currentVersions.allVerified)process.exitCode=1;}break;}
    case 'versions':result=await bridge.appVersions();break;
    case 'join':result=await joinChat(bridge,{agent:options.agent,code:options.code,replace:bool('replace')});break;
    case 'selftest':result=await selfTest(bridge);break;
    case 'reservations':result=await bridge.reservations();break;
    case 'release':result=await bridge.releaseScope(options.id);break;
    case 'scope-check':result=await bridge.scopeCheck(options.id);break;
    case 'discover':result=await bridge.discover();break;
    case 'diagnose':result=await bridge.diagnose(options.agent,{session:await sessionFile('session-file')});break;
    default:throw new Error('Usage: agent-bridge send|reply|claim|receive|inbox|flush|supersede|read|status|check|resume|delegate|image|bind|finish|recover|discover|diagnose|verify|versions|join|selftest|reservations|release|scope-check [--root PATH] [--id UUID] [--from AGENT --to AGENT --body TEXT]');
  }
  if(result?.requiresAttention===true||result?.status?.requiresAttention===true)process.exitCode=2;
  process.stdout.write(JSON.stringify(result,null,2)+'\n');
}catch(e){process.stderr.write(JSON.stringify({error:e.message})+'\n');process.exitCode=1;}
