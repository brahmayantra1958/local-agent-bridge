import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnvelope } from '../src/protocol.mjs';
import { verifyCommunication } from '../src/verification.mjs';
function accepted(input) {
  const m = makeEnvelope(input);
  return { ...m, receipts: [{ agent: m.from, state: 'native-accepted' },
    { agent: m.to, state: 'received' }] };
}
function fixture() {
  return [['codex','claude'], ['codex','gemini'], ['claude','gemini']].flatMap(([from,to]) => {
    const ping = accepted({ from, to, kind: 'ping', body: 'ping' });
    const pong = accepted({ from: to, to: from, kind: 'pong', body: 'pong',
      replyTo: ping.id, correlationId: ping.id });
    return [ping, pong];
  });
}
test('six received routes and three correlated round trips pass', () => {
  const result = verifyCommunication({ messages: fixture() });
  assert.equal(result.passed, true);
  assert.equal(result.routes.length, 6);
  assert.equal(result.roundTrips.length, 3);
  assert.equal(result.evidence[0].body, undefined);
});
test('transport acceptance alone and wrong-recipient receipts cannot pass', () => {
  const messages = fixture();
  messages[5].receipts[1].agent = 'codex';
  assert.equal(verifyCommunication({ messages }).passed, false);
  messages[5].receipts.pop();
  assert.equal(verifyCommunication({ messages }).routes.find(r => r.from === 'gemini' && r.to === 'claude').passed, false);
});
test('uncorrelated replies fail even when all six routes have receipts', () => {
  const messages = fixture();
  messages[5].replyTo = messages[0].id;
  const result = verifyCommunication({ messages });
  assert.equal(result.routes.every(r => r.passed), true);
  assert.equal(result.passed, false);
});
