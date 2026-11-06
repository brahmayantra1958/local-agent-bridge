import { open, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : undefined;
const modes = new Set(['bypassPermissions','default','plan','acceptEdits','dontAsk','auto']);
const causes = new Set(['explicit-setting','managed-setting','repo-setting','invalid-setting',
  'bypass-default','mode-unknown','mode-mismatch','no-mode-asserted']);
const outcomes = new Set(['expired','refused','dropped','discarded']);
const integer = (value, fallback, max, name) => {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > max) throw new Error(`Invalid Claude ${name}`);
  return result;
};

function validate(target, message) {
  if (!safeId(target?.sessionId) || !safeId(message?.id)
      || !['codex','claude','gemini'].includes(message?.from)) throw new Error('Invalid Claude delivery identity');
}

function exactSession(row, sessionId) {
  const identities = [row.sessionId, row.session_id].filter(value => value !== undefined);
  return identities.length > 0 && identities.every(value => value === sessionId);
}

/** Keep only the native envelope fields needed by the delivery classifier. The
 * transcript's text, tool arguments, origin body and arbitrary fields never
 * leave the scanner. A quoted UUID or bridge prompt is not native receipt. */
function matchingRecord(row, target, message) {
  if (!row || typeof row !== 'object' || !exactSession(row, target.sessionId)) return null;
  const peer = 'bridge:agent-bridge-' + message.from;
  if (row.type === 'user' && row.uuid === message.id && row.origin?.kind === 'peer'
      && row.origin.from === peer && row.origin.msg_id === message.id) {
    return { type: 'user', uuid: message.id, sessionId: target.sessionId,
      origin: {kind:'peer', from:peer, msg_id:message.id},
      ...(timestamp(row.timestamp) ? {timestamp:row.timestamp} : {}),
      ...(modes.has(row.permissionMode) ? {permissionMode:row.permissionMode} : {}) };
  }
  if (row.type === 'system' && row.subtype === 'peer_message_hold' && row.lane === 'socket'
      && row.from === peer && row.message_uuid === message.id && ['held','released','dropped'].includes(row.state)) {
    return {type:'system', subtype:'peer_message_hold', session_id:target.sessionId,
      lane:'socket', from:peer, message_uuid:message.id, state:row.state,
      ...(timestamp(row.timestamp) ? {timestamp:row.timestamp} : {}),
      ...(causes.has(row.cause) ? {cause:row.cause} : {}),
      ...(outcomes.has(row.outcome) ? {outcome:row.outcome} : {})};
  }
  return null;
}

/** Scan a finite initial-size snapshot from the beginning. Retain at most one
 * exact user receipt and the last matching native hold event. Memory is bounded
 * by maxLineBytes, not transcript length. Missing/partial/oversized records never
 * imply non-delivery. Positive receipt can survive append activity, but records
 * from a replaced or truncated source are discarded conservatively. */
export async function scanClaudeTranscript(path, target, message, options = {}, io = {open,stat}) {
  validate(target, message);
  const maxScanBytes = integer(options.maxScanBytes ?? options.maxBytes, 256 * 1024 * 1024, 1024 * 1024 * 1024, 'scan byte limit');
  const maxLineBytes = integer(options.maxLineBytes, 8 * 1024 * 1024, 64 * 1024 * 1024, 'line byte limit');
  const handle = await io.open(path, 'r');
  try {
    const before = await handle.stat(), snapshotBytes = before.size;
    const limit = Math.min(snapshotBytes, maxScanBytes);
    const chunk = Buffer.alloc(Math.min(256 * 1024, Math.max(limit, 1)));
    let bytesScanned=0, lineCount=0, parseErrors=0, oversizedRecords=0;
    let pieces=[], lineBytes=0, skipping=false, received, hold;
    function consume(line) {
      lineCount++;
      if (!line.length) return;
      let row;
      try { row=JSON.parse(line.toString('utf8')); } catch { parseErrors++; return; }
      const match=matchingRecord(row,target,message);
      if (!match) return;
      if (match.type==='user' && !received) received=match;
      if (match.type==='system') hold=match;
    }
    while (bytesScanned < limit) {
      const {bytesRead}=await handle.read(chunk,0,Math.min(chunk.length,limit-bytesScanned),bytesScanned);
      if (!bytesRead) break;
      bytesScanned+=bytesRead;
      let start=0;
      for(let offset=0;offset<bytesRead;offset++) {
        if(chunk[offset]!==10) continue;
        const part=chunk.subarray(start,offset);
        if(!skipping && lineBytes+part.length<=maxLineBytes) {
          consume(pieces.length ? Buffer.concat([...pieces,part],lineBytes+part.length) : part);
        } else {oversizedRecords++;lineCount++;}
        pieces=[];lineBytes=0;skipping=false;start=offset+1;
      }
      if(start<bytesRead && !skipping) {
        const part=chunk.subarray(start,bytesRead);
        if(lineBytes+part.length>maxLineBytes) {pieces=[];lineBytes=0;skipping=true;}
        else {pieces.push(Buffer.from(part));lineBytes+=part.length;}
      }
    }
    const partialFinalLine=skipping || lineBytes>0;
    let after;
    try {after=await io.stat(path);} catch { /* Removed source is not stable evidence. */ }
    const sourceReplaced=!after || before.dev!==after.dev || before.ino!==after.ino || after.size<before.size
      || after.size===before.size && after.mtimeMs!==before.mtimeMs;
    const changedDuringScan=sourceReplaced || before.size!==after?.size || before.mtimeMs!==after?.mtimeMs;
    const complete=!changedDuringScan && bytesScanned===snapshotBytes && !partialFinalLine && !parseErrors && !oversizedRecords;
    const records=sourceReplaced ? [] : [received,hold].filter(Boolean);
    return {records,start:0,byteOffset:bytesScanned,truncated:bytesScanned<snapshotBytes,
      scan:{source:'claude-transcript-stream',sessionId:target.sessionId,messageId:message.id,
        snapshotBytes,bytesScanned,lineCount,complete,partialFinalLine,parseErrors,oversizedRecords,
        changedDuringScan,sourceReplaced}};
  } finally {await handle.close();}
}

/** Filename-only discovery; one exact runtime transcript must be unambiguous. */
export async function findClaudeTranscript(target, config={}, options={}) {
  if(!safeId(target?.sessionId)) throw new Error('Invalid Claude session identity');
  const maxDirectories=integer(options.maxDirectories,4096,10000,'directory limit');
  const base=join(config.home??homedir(),'.claude','projects');
  let directories;
  try {directories=await readdir(base,{withFileTypes:true});}
  catch(error) {if(error.code==='ENOENT')return {path:null,missing:true,complete:true};throw error;}
  let checked=0,limited=false;const found=[];
  for(const entry of directories) {
    if(!entry.isDirectory())continue;
    if(++checked>maxDirectories) {limited=true;break;}
    const path=join(base,entry.name,target.sessionId+'.jsonl');
    try {if((await stat(path)).isFile())found.push(path);}
    catch(error) {if(!['ENOENT','ENOTDIR'].includes(error.code))throw error;}
  }
  return {path:found.length===1&&!limited?found[0]:null,missing:!found.length,
    ambiguous:found.length>1,complete:!limited,directories:Math.min(checked,maxDirectories)};
}

/** Compatible with the adapter's evidence classifier. This reader needs the
 * original message so it can discard all unrelated records while streaming.
 * Reuse the bridge's durable exact receipt/claim before calling it again. */
export async function readClaudeDeliveryEvidence(target, config, message, options={}) {
  validate(target,message);
  const location=await findClaudeTranscript(target,config,options);
  const transcript=location.path ? await scanClaudeTranscript(location.path,target,message,options) : undefined;
  let hostEvents,hostEventsUnavailable=false;
  if(target.deliveryEventsPath) {
    try {hostEvents=await scanClaudeTranscript(target.deliveryEventsPath,target,message,options);}
    catch {hostEventsUnavailable=true;}
  }
  const {path,...discovery}=location;
  return {transcript,hostEvents,hostEventsUnavailable,discovery};
}
