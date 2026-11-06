import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertAgent, assertId } from './protocol.mjs';
import { normalizeSession, sessionMatches } from './session-routing.mjs';
import { withEndpointLock } from './transport-runtime.mjs';

const consumerIdentity = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(value);

export function completedMessageIds(messages, events) {
  const byId = new Map(messages.map(message => [message.id, message]));
  const completed = new Set();
  for (const row of events) {
    if (['handled', 'message-superseded'].includes(row.state)
        || row.state === 'received' && byId.get(row.messageId)?.kind !== 'task') completed.add(row.messageId);
  }
  for (const reply of messages) {
    const parent = byId.get(reply.replyTo);
    if (!parent || reply.from !== parent.to || reply.to !== parent.from
        || reply.correlationId !== parent.correlationId) continue;
    if (parent.kind === 'task' && reply.kind === 'result' || parent.kind === 'ping' && reply.kind === 'pong') {
      completed.add(parent.id);
    }
  }
  return completed;
}

/** Durable local consumption. No lease expiry, timer, AI turn or remote ACK. */
export function createMailbox({ state, atomicCreate, get, receipts, receipt, listMessages }) {
  const namespace = process.platform === 'win32' ? resolve(state).toLowerCase() : resolve(state);
  const locked = (id, operation) => withEndpointLock(JSON.stringify(['agent-bridge-mailbox', namespace, id.toLowerCase()]), operation);
  const inventory = async fallback => typeof listMessages === 'function' ? listMessages() : fallback;
  const claimPath = id => join(state, 'claims', id + '.json');
  async function readClaim(id) {
    try { return JSON.parse(await readFile(claimPath(id), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }

  async function claim(agent, id, { session, consumerId, resume = false } = {}) {
    assertAgent(agent);
    const message = await get(assertId(id));
    if (message.to !== agent) throw new Error('Only intended recipient may claim');
    if (typeof resume !== 'boolean') throw new Error('Claim resume must be boolean');
    if (consumerId !== undefined && !consumerIdentity(consumerId)) throw new Error('Invalid claim consumerId');
    if (resume && !consumerId) throw new Error('Resuming work requires the stored consumerId');
    const actual = session === undefined ? undefined : normalizeSession(agent, session);
    if (actual && message.recipientSession && !sessionMatches(agent, actual, message.recipientSession)) {
      throw new Error('Claim session does not match intended recipient');
    }
    return locked(id, async () => {
      const events = await receipts(id), messages = await inventory([message]);
      if (completedMessageIds(messages, events).has(id)) {
        return { messageId: id, claimed: false, reason: events.some(row => row.state === 'message-superseded')
          ? 'message-superseded' : 'already-handled', nextAction: 'use-existing-result' };
      }
      let existing = await readClaim(id), created = false;
      if (resume && !existing) throw new Error('Cannot resume work without an existing claim');
      if (!existing) {
        await mkdir(join(state, 'claims'), { recursive: true });
        const value = { messageId: id, agent, consumerId: consumerId ?? randomUUID(), claimedAt: new Date().toISOString(),
          ...(actual ?? message.recipientSession ? { session: actual ?? message.recipientSession } : {}) };
        created = await atomicCreate(claimPath(id), value);
        existing = created ? value : await readClaim(id);
      }
      if (resume) {
        if (!consumerIdentity(existing.consumerId) || existing.consumerId !== consumerId || existing.agent !== agent) {
          throw new Error('Resume consumerId does not match the stored work owner');
        }
        if (actual && existing.session && !sessionMatches(agent, actual, existing.session)) {
          throw new Error('Resume session does not match the stored work owner');
        }
      }
      // Repair a crash after the atomic claim and before its diagnostic receipt.
      await receipt({ messageId: id, agent, state: 'work-claimed', claimedAt: existing.claimedAt,
        ...(existing.consumerId ? { consumerId: existing.consumerId } : {}) }, id + '.claim');
      return { messageId: id, claimed: created || resume, resumed: resume, claim: existing,
        reason: resume ? 'existing-work-resumed' : created ? 'work-owned' : 'already-claimed',
        nextAction: resume ? 'continue-existing-work' : created ? 'perform-work-once' : 'continue-existing-run-or-use-existing-result' };
    });
  }

  async function supersede(id, replacementId) {
    if (id === replacementId) throw new Error('A replacement must have a different ID');
    const [original, replacement] = await Promise.all([get(id), get(replacementId)]);
    if (original.from !== replacement.from || original.to !== replacement.to || original.kind !== replacement.kind
        || (original.recipientSession && replacement.recipientSession
          && !sessionMatches(original.to, original.recipientSession, replacement.recipientSession))) {
      throw new Error('Replacement must have the same endpoints and kind');
    }
    return locked(id, async () => {
      const events = await receipts(id);
      const previous = events.find(row => row.state === 'message-superseded');
      if (previous) {
        if (previous.replacementId !== replacementId) throw new Error('Message already has a different replacement');
        return previous;
      }
      const workAlreadyClaimed = Boolean(await readClaim(id)) || events.some(row => row.state === 'work-claimed');
      const completed = completedMessageIds(await inventory([original, replacement]), events).has(id);
      return receipt({ messageId: id, agent: original.from, state: 'message-superseded', replacementId,
        workAlreadyClaimed, runningWorkCancellation: workAlreadyClaimed && !completed ? 'not-guaranteed' : 'not-needed' }, id + '.superseded');
    });
  }

  async function pendingRows(messages, events, { agent, session, includeBodies = true } = {}) {
    assertAgent(agent);
    const actual = session === undefined ? undefined : normalizeSession(agent, session);
    const handled = completedMessageIds(await inventory(messages), events);
    return messages.filter(message => message.to === agent && !handled.has(message.id)
      && (!actual || !message.recipientSession || sessionMatches(agent, actual, message.recipientSession)))
      .map(message => {
        const { body, ...metadata } = message;
        return { ...(includeBodies ? message : metadata), waitingSince: message.createdAt,
          workClaimed: events.some(row => row.messageId === message.id && row.state === 'work-claimed'),
          ...(actual && !message.recipientSession ? { legacyRouteUnspecified: true } : {}) };
      });
  }
  return { claim, supersede, pendingRows };
}
