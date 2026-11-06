import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeRequest } from '../src/runtime.mjs';
async function serve(t,handler){const path=process.platform==='win32'?'\\\\.\\pipe\\agent-bridge-test-'+randomUUID():join(tmpdir(),'ab-'+randomUUID()+'.sock');const sockets=new Set();const server=net.createServer(s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));handler(s);});await new Promise(r=>server.listen(path,r));t.after(async()=>{for(const s of sockets)s.destroy();await new Promise(r=>server.close(r));});return path;}
function frame(value){const b=Buffer.from(JSON.stringify(value));const h=Buffer.alloc(4);h.writeUInt32LE(b.length);return Buffer.concat([h,b]);}
test('pipe parser accepts fragmented UTF-8 replies and closes its connection',async t=>{
 const path=await serve(t,s=>s.once('data',()=>{const b=frame({id:1,jsonrpc:'2.0',result:{text:'응답 🧪'}});s.write(b.subarray(0,2));setTimeout(()=>{s.write(b.subarray(2,9));setTimeout(()=>s.end(b.subarray(9)),5);},5);}));
 assert.deepEqual(await pipeRequest(path,'test',{}),{text:'응답 🧪'});
});
test('oversized frames and mismatched IDs fail instead of hanging',async t=>{
 const path=await serve(t,s=>s.once('data',()=>{const h=Buffer.alloc(4);h.writeUInt32LE(99999);s.write(h);}));
 await assert.rejects(()=>pipeRequest(path,'test',{}, {maxBytes:1000}),/too large/);
 const wrong=await serve(t,s=>s.once('data',()=>s.write(frame({id:2,jsonrpc:'2.0',result:{}}))));
 await assert.rejects(()=>pipeRequest(wrong,'test',{}),/Mismatched/);
});
test('closed and silent pipes reject with an explicit uncertain timeout',async t=>{
 const closed=await serve(t,s=>s.once('data',()=>s.end()));await assert.rejects(()=>pipeRequest(closed,'test',{}),/closed/);
 const silent=await serve(t,()=>{});await assert.rejects(()=>pipeRequest(silent,'test',{}, {timeoutMs:30}),/uncertain/);
});
