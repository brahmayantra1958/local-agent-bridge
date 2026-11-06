#!/usr/bin/env node
import { runClaudeUiRecovery } from '../src/claude-ui-recovery.mjs';
const args=process.argv.slice(2),command=args.shift(),options={};
try {
  for(let i=0;i<args.length;i+=2){if(!args[i].startsWith('--')||args[i+1]===undefined||Object.hasOwn(options,args[i]))throw new Error('Expected unique option/value pairs');options[args[i]]=args[i+1];}
  if(!options['--root']||!options['--id']||!options['--consumer-id'])throw new Error('Use prepare|arm|finish|fail --root ABS --id UUID --consumer-id STABLE');
  const result=await runClaudeUiRecovery(command,{root:options['--root'],id:options['--id'],consumerId:options['--consumer-id'],reason:options['--reason']});
  process.stdout.write(JSON.stringify(result,null,2)+'\n');
}catch(error){process.stderr.write(JSON.stringify({error:error.message})+'\n');process.exitCode=1;}
