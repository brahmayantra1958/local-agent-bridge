import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import net from 'node:net';
export const execFileAsync = promisify(execFile);
export async function powershell(script, {timeoutMs=15000}={}) {
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>60000)throw new Error('Invalid PowerShell timeout');
  const exe = join(process.env.SystemRoot ?? 'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  const encoded = Buffer.from('[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); '+script,'utf16le').toString('base64');
  const {stdout} = await execFileAsync(exe,['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',encoded],{windowsHide:true,timeout:timeoutMs,maxBuffer:4*1024*1024});
  return stdout.replace(/^\uFEFF/,'').trim();
}
export function pipeRequest(pipePath, method, params, {timeoutMs=15000,maxBytes=8*1024*1024}={}) {
  return new Promise((resolve,reject)=>{
    const socket=net.createConnection(pipePath); let buffer=Buffer.alloc(0),settled=false,submitted=false,phase='connect';
    const timer=setTimeout(()=>finish(new Error('Native pipe timeout; delivery may be uncertain')),timeoutMs);
    function finish(err,value){if(settled)return;settled=true;clearTimeout(timer);socket.destroy();if(err){err.delivery={submitted,phase,retryable:!submitted&&phase==='connect'&&['ECONNREFUSED','ENOENT','ETIMEDOUT'].includes(err.code)};reject(err);}else resolve(value);}
    socket.on('error',e=>finish(e));socket.on('close',()=>{if(!settled)finish(new Error('Native pipe closed before response'));});
    socket.on('connect',()=>{phase='prepare';const body=Buffer.from(JSON.stringify({id:1,jsonrpc:'2.0',method,params}));if(body.length>maxBytes)return finish(new Error('Frame too large'));const header=Buffer.alloc(4);header.writeUInt32LE(body.length);submitted=true;phase='response';socket.write(Buffer.concat([header,body]));});
    socket.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);if(buffer.length<4)return;const n=buffer.readUInt32LE(0);if(n>maxBytes)return finish(new Error('Response frame too large'));if(buffer.length>=4+n){try{const value=JSON.parse(buffer.subarray(4,4+n).toString('utf8'));if(value.id!==1)return finish(new Error('Mismatched response ID'));finish(value.error?new Error(value.error.message):null,value.result);}catch(e){finish(e);}}});
  });
}
