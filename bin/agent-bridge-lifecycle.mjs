#!/usr/bin/env node
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { handleClaudeLifecycle } from '../src/claude-lifecycle.mjs';
import { installClaudeLifecycle, validateLifecycleRoots } from '../src/claude-hook-install.mjs';

const args=process.argv.slice(2),command=args[0]?.startsWith('--')?'event':args.shift()??'event';
const options={};let timer;
try {
  for(let i=0;i<args.length;i+=2){
    if(!args[i].startsWith('--')||args[i+1]===undefined||Object.hasOwn(options,args[i].slice(2)))throw new Error('Expected unique --option value');
    options[args[i].slice(2)]=args[i+1];
  }
  if(command==='install'||command==='uninstall') {
    const result=await installClaudeLifecycle({root:options.root,registryFile:options['registry-file'],uninstall:command==='uninstall'});
    process.stdout.write(JSON.stringify(result,null,2)+'\n');
  } else if(command==='event') {
    if(!options['registry-file'])throw new Error('A lifecycle registry is required');
    // Hooks must never keep a host waiting indefinitely or cause a model loop.
    // Only same-ID, proven-unsubmitted delivery is attempted by the handler.
    timer=setTimeout(()=>process.exit(0),10000);
    const registryFile=resolve(options['registry-file']);
    const roots=validateLifecycleRoots(JSON.parse((await readFile(registryFile,'utf8')).replace(/^\uFEFF/,'')));
    let raw='';
    if(options['event-file'])raw=await readFile(options['event-file'],'utf8');
    else for await(const chunk of process.stdin){raw+=chunk;if(Buffer.byteLength(raw)>65536)throw new Error('Hook payload exceeds limit');}
    if(Buffer.byteLength(raw)>65536)throw new Error('Hook payload exceeds limit');
    const result=await handleClaudeLifecycle({event:JSON.parse(raw.replace(/^\uFEFF/,'')),roots});
    const report={...result,recordedAt:new Date().toISOString()};
    const reportDir=join(dirname(registryFile),'lifecycle-reports');
    await mkdir(reportDir,{recursive:true});
    const id=randomUUID(),temp=join(reportDir,id+'.tmp'),path=join(reportDir,id+'.json');
    await writeFile(temp,JSON.stringify(report,null,2)+'\n',{flag:'wx'});await rename(temp,path);
    // No output is added to the model context; errors remain local diagnostics.
  } else throw new Error('Usage: agent-bridge-lifecycle [install|uninstall] --root ABSOLUTE_PROJECT | --registry-file FILE');
} catch(error) {
  if(command==='event') {
    // Fixed diagnostic, no hook body, transcript, paths or arbitrary exception.
    process.stderr.write('agent-bridge lifecycle event could not be processed; queued messages remain durable.\n');
  } else {process.stderr.write(JSON.stringify({error:error.message})+'\n');process.exitCode=1;}
} finally {if(timer)clearTimeout(timer);}
