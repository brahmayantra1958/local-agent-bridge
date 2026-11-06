import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { normalizeSession, buildMessageRoutes, selectMessageTarget, sessionMatches } from '../src/session-routing.mjs';
import { makeEnvelope, validateEnvelope, renderPrompt } from '../src/protocol.mjs';

const codex = () => ({threadId:randomUUID(),hostId:'local'});
const claude = () => ({sessionId:randomUUID(),hostSessionId:'local_' + randomUUID()});

test('portable identity normalization accepts supported routes and excludes credentials', () => {
  const threadId = randomUUID();
  assert.deepEqual(normalizeSession('codex',{threadId}),{threadId,hostId:'local'});
  assert.deepEqual(normalizeSession('claude',{hostSessionId:'local_' + threadId}),{hostSessionId:'local_' + threadId});
  assert.deepEqual(normalizeSession('gemini',{conversationId:threadId}),{conversationId:threadId});
  assert.equal(normalizeSession('claude',undefined),undefined);
  for (const value of [{threadId,token:'secret'}, {threadId,permissionClass:'bypass'}, {threadId:'../escape'}, {}]) {
    assert.throws(() => normalizeSession('codex',value));
  }
});

test('new envelopes capture registered identifiers and actual explicit sender without permissions', () => {
  const configured = claude(), actual = claude(), recipient = codex();
  const input = {from:'claude',to:'codex',body:'task',senderSession:actual};
  const settings = {agents:{claude:{...configured,permissionClass:'bypass',title:'old'},codex:{...recipient,responseTimeoutMs:120000}}};
  const routes = buildMessageRoutes(input, settings);
  assert.deepEqual(routes,{senderSession:actual,recipientSession:recipient});
  const envelope = makeEnvelope({...input,...routes,guardedDelivery:'claim-v1'});
  assert.deepEqual(envelope.senderSession,actual);
  assert.deepEqual(envelope.recipientSession,recipient);
  assert.equal(JSON.stringify(envelope).includes('permissionClass'),false);
  assert.equal(JSON.stringify(envelope).includes('responseTimeoutMs'),false);
});

test('replies days later retain original sender despite changed default target or offline runtime', () => {
  const original = claude(), requester = codex(), otherChat = claude();
  const parent = makeEnvelope({from:'claude',to:'codex',body:'original task',senderSession:original,recipientSession:requester});
  parent.createdAt = '2026-10-29T01:00:00.000Z';
  const settings = {agents:{codex:{...requester},claude:{...otherChat,responseTimeoutMs:130000,deliveryEventsPath:'unrelated-events.jsonl'}}};
  const input = {from:'codex',to:'claude',body:'result',replyTo:parent.id,correlationId:parent.correlationId};
  const reply = makeEnvelope({...input,...buildMessageRoutes(input,settings,parent)});
  assert.deepEqual(reply.recipientSession,original);
  assert.deepEqual(selectMessageTarget(reply,settings),{...original,responseTimeoutMs:130000});
  assert.throws(() => buildMessageRoutes({...input,recipientSession:otherChat},settings,parent),/original sender/);
  assert.throws(() => buildMessageRoutes({...input,senderSession:codex()},settings,parent),/original recipient/);
  assert.deepEqual(settings.agents.claude,{...otherChat,responseTimeoutMs:130000,deliveryEventsPath:'unrelated-events.jsonl'});
});

test('Claude stable host identity survives runtime replacement without matching a different host', () => {
  const original = claude(), changed = {...original,sessionId:randomUUID()};
  assert(sessionMatches('claude',original,changed));
  assert(!sessionMatches('claude',original,{...original,hostSessionId:'local_other'}));
  const target = selectMessageTarget({to:'claude',recipientSession:{hostSessionId:original.hostSessionId}},
    {agents:{claude:{sessionId:'unrelated-runtime',hostSessionId:'local_other',permissionClass:'prompting'}}});
  assert.deepEqual(target,{hostSessionId:original.hostSessionId,permissionClass:'prompting'});
});

test('inbox identity matching separates chats and preserves explicit host/project boundaries', () => {
  const c = codex(), g = {conversationId:randomUUID(),projectId:randomUUID()};
  assert(sessionMatches('codex',c,{threadId:c.threadId}));
  assert(!sessionMatches('codex',c,{...c,hostId:'remote'}));
  assert(!sessionMatches('codex',c,codex()));
  assert(sessionMatches('gemini',g,{conversationId:g.conversationId}));
  assert(!sessionMatches('gemini',g,{...g,projectId:randomUUID()}));
  assert(!sessionMatches('claude',undefined,claude()));
});

test('legacy envelopes omit routes and retain configured fallback', () => {
  const m = makeEnvelope({from:'codex',to:'claude',body:'legacy'});
  const target = {...claude(),permissionClass:'bypass'};
  assert.equal(validateEnvelope(m),m);
  assert(!Object.hasOwn(m,'senderSession'));
  assert(!Object.hasOwn(m,'recipientSession'));
  assert.deepEqual(selectMessageTarget(m,{agents:{claude:target}}),target);
  assert.deepEqual(buildMessageRoutes(m,{agents:{codex:{},claude:{}}}),{});
});

test('guarded prompts use absolute current runtime and library CLI with explicit state root', () => {
  const root = "C:/work/owner's project";
  const m = makeEnvelope({from:'claude',to:'codex',kind:'task',body:'review',guardedDelivery:'claim-v1'});
  const prompt = renderPrompt(m,root);
  assert(prompt.includes(process.execPath.replaceAll("'","''")));
  assert(prompt.includes(fileURLToPath(new URL('../bin/agent-bridge.mjs',import.meta.url)).replaceAll("'","''")));
  assert(prompt.includes("--root 'C:/work/owner''s project'"));
  assert(prompt.includes(' claim --root '));
  assert(prompt.includes(' reply --root '));
  assert(prompt.includes('claimed:false'));
  assert(!prompt.includes('node bin/'));
  assert.throws(() => makeEnvelope({...m,guardedDelivery:'ignore-duplicates'}),/delivery guard/);
});
