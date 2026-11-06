const fields = Object.freeze({
  codex: ['threadId', 'hostId'],
  claude: ['sessionId', 'hostSessionId'],
  gemini: ['conversationId', 'projectId'],
});
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function sessionFields(agent) {
  if (!Object.hasOwn(fields, agent)) throw new Error('Unknown session agent: ' + agent);
  return fields[agent];
}

/** Envelope routes contain identities only, never pipe names, credentials or permissions. */
export function normalizeSession(agent, value) {
  const allowed = sessionFields(agent);
  if (value == null) return undefined;
  if (!object(value)) throw new Error('Session identity must be an object');
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error('Unexpected session identity field');
  const result = {};
  for (const key of allowed) {
    if (value[key] === undefined) continue;
    if (!identifier(value[key])) throw new Error('Invalid session identity ' + key);
    result[key] = value[key];
  }
  if (agent === 'codex' && !result.threadId
      || agent === 'claude' && !result.sessionId && !result.hostSessionId
      || agent === 'gemini' && !result.conversationId) throw new Error('Missing ' + agent + ' session identity');
  if (agent === 'codex') result.hostId ??= 'local';
  return result;
}

function configuredSession(agent, settings) {
  const current = settings?.agents?.[agent];
  if (!current) return undefined;
  const selected = Object.fromEntries(sessionFields(agent).filter(key => current[key] !== undefined)
    .map(key => [key, current[key]]));
  // Legacy mock adapters and registrations may not have session metadata.
  if (!Object.keys(selected).length) return undefined;
  return normalizeSession(agent, selected);
}

/** Compare logical chats, allowing Claude's runtime sessionId to change within one host. */
export function sessionMatches(agent, left, right) {
  const a = normalizeSession(agent, left), b = normalizeSession(agent, right);
  if (!a || !b) return false;
  if (agent === 'codex') return a.threadId === b.threadId && a.hostId === b.hostId;
  if (agent === 'claude') {
    if (a.hostSessionId && b.hostSessionId) return a.hostSessionId === b.hostSessionId;
    return Boolean(a.sessionId && b.sessionId && a.sessionId === b.sessionId);
  }
  return a.conversationId === b.conversationId
    && (!a.projectId || !b.projectId || a.projectId === b.projectId);
}

/** Capture routes when first persisting a request. A reply pins the original sender. */
export function buildMessageRoutes(input, settings, parent = null) {
  const explicitSender = normalizeSession(input.from, input.senderSession);
  const explicitRecipient = normalizeSession(input.to, input.recipientSession);
  if (parent && (input.from !== parent.to || input.to !== parent.from)) {
    throw new Error('Reply endpoints do not match parent');
  }
  const parentSender = parent && normalizeSession(parent.from, parent.senderSession);
  const parentRecipient = parent && normalizeSession(parent.to, parent.recipientSession);
  if (explicitRecipient && parentSender && !sessionMatches(input.to, explicitRecipient, parentSender)) {
    throw new Error('Reply recipient session does not match original sender');
  }
  if (explicitSender && parentRecipient && !sessionMatches(input.from, explicitSender, parentRecipient)) {
    throw new Error('Reply sender session does not match original recipient');
  }
  const senderSession = explicitSender || parentRecipient || configuredSession(input.from, settings);
  const recipientSession = parentSender || explicitRecipient || configuredSession(input.to, settings);
  return { ...(senderSession ? { senderSession } : {}), ...(recipientSession ? { recipientSession } : {}) };
}

/** Runtime policy stays current; a persisted recipient never falls back to another chat. */
export function selectMessageTarget(message, settings) {
  const configured = settings?.agents?.[message.to];
  if (!configured) throw new Error('Recipient is not registered');
  const pinned = normalizeSession(message.to, message.recipientSession);
  if (!pinned) return configured;
  const target = { ...configured };
  for (const key of sessionFields(message.to)) delete target[key];
  // File evidence tied to a different configured chat must not be reused.
  const currentIdentity = configuredSession(message.to, settings);
  if (!currentIdentity || !sessionMatches(message.to, pinned, currentIdentity)) {
    delete target.rolloutPath;
    delete target.deliveryEventsPath;
  }
  return { ...target, ...pinned };
}
