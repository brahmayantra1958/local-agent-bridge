import { AGENTS } from './protocol.mjs';

const acceptedStates = new Set(['native-accepted', 'transport-written']);
export function delivered(message) {
  return message.receipts.some(r => acceptedStates.has(r.state) && r.agent === message.from)
    && message.receipts.some(r => r.state === 'received' && r.agent === message.to);
}

/** Summarize explicit recipient receipts; never infer receipt from transport success.
 * `agents` limits the matrix to the registered apps (two or three). */
export function verifyCommunication({ messages }, { agents = AGENTS } = {}) {
  agents = AGENTS.filter(agent => agents.includes(agent));
  const received = messages.filter(delivered).filter(m => agents.includes(m.from) && agents.includes(m.to));
  const routes = agents.flatMap(from => agents.filter(to => to !== from).map(to => {
    const evidence = received.filter(m => m.from === from && m.to === to);
    return { from, to, passed: evidence.length > 0, messageIds: evidence.map(m => m.id) };
  }));
  const roundTrips = [];
  for (const ping of received.filter(m => m.kind === 'ping')) {
    const pong = received.find(m => m.kind === 'pong' && m.replyTo === ping.id
      && m.correlationId === ping.correlationId && m.from === ping.to && m.to === ping.from);
    if (pong) roundTrips.push({ from: ping.from, to: ping.to, pingId: ping.id, pongId: pong.id,
      correlationId: ping.correlationId });
  }
  const pairs = new Set(roundTrips.map(r => [r.from, r.to].sort().join(':')));
  return {
    version: 1, generatedAt: new Date().toISOString(), agents,
    passed: agents.length >= 2 && routes.every(r => r.passed) && pairs.size === agents.length * (agents.length - 1) / 2,
    routes, roundTrips,
    evidence: received.map(m => ({ id: m.id, from: m.from, to: m.to, kind: m.kind,
      correlationId: m.correlationId, replyTo: m.replyTo, createdAt: m.createdAt,
      receipts: m.receipts.filter(r => acceptedStates.has(r.state) || r.state === 'received')
        .map(({ agent, state, transport, createdAt }) => ({ agent, state, transport, createdAt })) }))
  };
}
