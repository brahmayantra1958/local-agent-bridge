import { readdir } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { pipeRequest, powershell } from '../runtime.mjs';
import { inspectCodexRollout } from '../codex-observation.mjs';
import { transportDiagnosticError } from '../transport-runtime.mjs';
export function selectCodexPipe(names, preferred) {
  const candidates=names.filter(name=>name.startsWith('codex-app-tools-')).map(name=>'\\\\.\\pipe\\'+name);
  if(preferred&&candidates.some(value=>value.toLowerCase()===preferred.toLowerCase()))return preferred;
  if(candidates.length===1)return candidates[0];
  throw transportDiagnosticError(candidates.length===0?'CODEX_APP_NOT_RUNNING':'CODEX_PIPE_AMBIGUOUS');
}
export async function discoverCodexPipe() {
  if(process.platform!=='win32'){
    if(process.env.CODEX_APP_TOOLS_PIPE_PATH)return process.env.CODEX_APP_TOOLS_PIPE_PATH;
    throw new Error('Set CODEX_APP_TOOLS_PIPE_PATH on this platform');
  }
  // A launcher may retain yesterday's pipe name. Reuse it only while it exists;
  // after restart a sole current app pipe is sufficient, multiple apps need a selection.
  return selectCodexPipe(await readdir('\\\\.\\pipe\\'),process.env.CODEX_APP_TOOLS_PIPE_PATH);
}
export function codexResponseTimeout(target = {}, config = {}, options = {}) {
  const value = options.responseTimeoutMs ?? target.responseTimeoutMs ?? config.transport?.codex?.responseTimeoutMs ?? 120000;
  if (!Number.isSafeInteger(value) || value < 1 || value > 600000) {
    const error = new Error('Invalid Codex responseTimeoutMs: expected integer 1..600000');
    error.delivery = { submitted: false, phase: 'preflight', retryable: false };
    throw error;
  }
  return value;
}
export async function callCodexTool(name,args,{callerThreadId,pipePath,responseTimeoutMs = 120000,request = pipeRequest}={}) {
  let endpoint;
  try{if(!callerThreadId)throw new Error('Codex callerThreadId required');codexResponseTimeout({}, {}, {responseTimeoutMs});endpoint=pipePath??await discoverCodexPipe();}
  catch(error){error.delivery={submitted:false,phase:'preflight',retryable:false};throw error;}
  const result=await request(endpoint,'tools/call',{arguments:args,callerSource:'codex',callId:'agent-bridge-'+randomUUID(),hostId:'local',namespace:'codex_app',threadId:callerThreadId,tool:name,turnId:'agent-bridge-'+randomUUID()},{timeoutMs:responseTimeoutMs});
  const text=(result.contentItems??[]).filter(c=>c.type==='inputText').map(c=>c.text).join('\n');
  if(!result.success)throw new Error('Codex rejected request: '+text);
  try{return JSON.parse(text);}catch{return {text};}
}
export async function sendCodex(target,prompt,config,message,options={}) { const result=await (options.call??callCodexTool)('send_message_to_thread',{threadId:target.threadId,hostId:target.hostId??'local',prompt},{callerThreadId:config.codexCallerThreadId,responseTimeoutMs:codexResponseTimeout(target,config,options)});return {state:'native-accepted',transport:'codex-app-tools',result}; }
export async function readCodex(target,config) {const result=await callCodexTool('read_thread',{threadId:target.threadId,hostId:target.hostId??'local',turnLimit:1,includeOutputs:false,maxOutputCharsPerItem:1000},{callerThreadId:config.codexCallerThreadId,responseTimeoutMs:codexResponseTimeout(target,config)});return {thread:result.thread,turns:result.turns?.map(t=>({id:t.id,status:t.status,messages:t.items?.filter(i=>i.type==='agentMessage'||i.type==='userMessage')}))};}

/** Connect without sending a frame to identify the current local pipe owner.
 * These process facts are not by themselves evidence of an empty request queue. */
export async function readCodexRuntimeEvidence({pipePath,runPowerShell=powershell}={}) {
  if(process.platform!=='win32')return null;
  const endpoint=pipePath??await discoverCodexPipe();
  if(!/^\\\\\.\\pipe\\codex-app-tools-[A-Za-z0-9_-]+$/.test(endpoint))return null;
  const pipeName=endpoint.slice('\\\\.\\pipe\\'.length);
  const script=`Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class BridgePipeOwner { [DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetNamedPipeServerProcessId(IntPtr pipe, out uint pid); }';
$bridgePipe = [System.IO.Pipes.NamedPipeClientStream]::new('.', '${pipeName}', [System.IO.Pipes.PipeDirection]::InOut);
try { $bridgePipe.Connect(300); [uint32]$bridgeOwnerPid = 0; if (-not [BridgePipeOwner]::GetNamedPipeServerProcessId($bridgePipe.SafePipeHandle.DangerousGetHandle(), [ref]$bridgeOwnerPid)) { throw 'Pipe owner unavailable' }; $bridgeOwner = Get-Process -Id $bridgeOwnerPid -ErrorAction Stop; [pscustomobject]@{pid=[int]$bridgeOwnerPid; startedAt=$bridgeOwner.StartTime.ToUniversalTime().ToString('o')} | ConvertTo-Json -Compress } finally { $bridgePipe.Dispose() }`;
  const result=JSON.parse(await runPowerShell(script));
  if(!Number.isSafeInteger(result.pid)||result.pid<1||!Number.isFinite(Date.parse(result.startedAt)))return null;
  return {source:'windows-named-pipe-server',pid:result.pid,startedAt:new Date(result.startedAt).toISOString(),
    endpointDigest:createHash('sha256').update(endpoint).digest('hex'),observedAt:new Date().toISOString()};
}

export async function inspectCodex(target,config,message,options={}) {
  const result=await inspectCodexRollout(target,config,message,options);
  if(result.state!=='delivery-not-observed'||(target.hostId&&target.hostId!=='local'))return result;
  try {
    const runtime=await (options.readRuntimeEvidence??readCodexRuntimeEvidence)();
    if(runtime)result.evidence.runtime=runtime;
  } catch { /* Read access may be unavailable; complete transcript evidence stands alone. */ }
  return result;
}
