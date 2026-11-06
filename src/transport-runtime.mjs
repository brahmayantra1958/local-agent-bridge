import net from 'node:net';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

const digest = value => createHash('sha256').update(value).digest('hex');
// Diagnostics are selected at the failing guard, never inferred from exception
// text. Only these fixed strings can reach persisted receipts or CLI summaries.
const failureDiagnostics = new Map([
  ['CLAUDE_UI_TARGET_NOT_READY', ['claude-ui-target-not-ready', 'Original Claude Desktop conversation is unavailable for UI delivery',
    'Inspect the original UI recovery job without substituting another conversation.']],
  ['CLAUDE_UI_EXECUTOR_UNAVAILABLE', ['claude-ui-executor-unavailable', 'Registered Codex UI executor could not receive the recovery job',
    'Restore the registered Codex connection and continue the original recovery job.']],
  ['CLAUDE_UI_SUBMIT_UNCONFIRMED', ['claude-ui-submit-unconfirmed', 'Claude UI submission outcome is uncertain',
    'Observe the original native conversation; do not submit another copy.']],
  ['ANTIGRAVITY_APP_NOT_RUNNING', ['antigravity-app-not-running', 'Antigravity application backend is not running',
    'Automatically reopen the installed app and resume the same stored conversation.']],
  ['ANTIGRAVITY_ENDPOINT_UNAVAILABLE', ['antigravity-endpoint-unavailable', 'Antigravity backend endpoint is unavailable',
    'Rediscover the current local backend and continue the original message.']],
  ['ANTIGRAVITY_TARGET_UNAVAILABLE', ['antigravity-target-unavailable', 'Existing Antigravity conversation is not loaded',
    'Rehydrate the exact stored conversation before continuing the original message.']],
  ['ANTIGRAVITY_ENDPOINT_AMBIGUOUS', ['antigravity-endpoint-ambiguous', 'Multiple Antigravity backends match the target',
    'Resolve the backend ambiguity without selecting another conversation.']],
  ['ANTIGRAVITY_CREDENTIAL_UNAVAILABLE', ['antigravity-credential-unavailable', 'Antigravity backend credential is unavailable',
    'Restore the application connection without changing permissions or credentials.']],
  ['CODEX_APP_NOT_RUNNING', ['codex-app-not-running', 'Codex app tools pipe is not available',
    'Keep the original message queued and resume it when Codex starts.']],
  ['CODEX_PIPE_AMBIGUOUS', ['codex-pipe-ambiguous', 'Multiple Codex app tools pipes are available',
    'Select the intended current app pipe; the persisted recipient thread remains unchanged.']],
  ['CLAUDE_SESSION_STORE_MISSING', ['claude-session-store-missing', 'Claude session discovery store is missing',
    'Check the configured home and current Claude session discovery before explicitly resuming the original message.']],
  ['CLAUDE_SESSION_STORE_UNREADABLE', ['claude-session-store-unreadable', 'Claude session discovery store cannot be read',
    'Check access to the configured Claude session store before explicitly resuming the original message.']],
  ['CLAUDE_SESSION_NOT_RUNNING', ['claude-session-not-running', 'Registered Claude session is not running',
    'Inspect current Claude session discovery and match the intended registered session; do not redirect the message to another session automatically.']],
  ['CLAUDE_SESSION_AMBIGUOUS', ['claude-session-ambiguous', 'Multiple live runtimes match the configured Claude chat',
    'Resolve the duplicate live runtime registration before resuming the original message; do not guess by title or workspace.']],
  ['CLAUDE_PROTOCOL_UNSUPPORTED', ['claude-protocol-unsupported', 'Unsupported Claude peer protocol',
    'Check the installed Claude peer protocol compatibility before explicitly resuming the original message.']],
  ['CLAUDE_HOST_ID_CHANGED', ['claude-host-identity-changed', 'Claude host session identity changed',
    'Compare the intended session with current discovery and resolve the registration mismatch; do not bypass the identity check.']],
  ['CLAUDE_PIPE_INVALID', ['claude-pipe-invalid', 'Unexpected Claude pipe path',
    'Check current Claude discovery against the supported native pipe format; do not substitute an unverified endpoint.']],
  ['CLAUDE_CREDENTIAL_MISSING', ['claude-credential-missing', 'Current Claude peer credential is missing',
    'Check that the intended Claude session has published its current credential; do not create or copy credential files.']],
  ['CLAUDE_CREDENTIAL_UNREADABLE', ['claude-credential-unreadable', 'Current Claude peer credential cannot be read',
    'Check access to the current credential without exposing its contents, then explicitly resume the original message.']],
  ['CLAUDE_CREDENTIAL_INVALID', ['claude-credential-invalid', 'Current Claude peer credential has an invalid format',
    'Check the installed Claude credential format compatibility; do not modify credential contents.']],
  ['CLAUDE_CREDENTIAL_STALE', ['claude-credential-stale', 'Current Claude peer credential does not match the running process',
    'Rediscover the intended running Claude session and its current credential; do not reuse the stale credential.']],
  ['BRIDGE_SENDER_UNREGISTERED', ['bridge-sender-unregistered', 'Bridge sender is not registered',
    'Register the actual sending session before explicitly resuming the original message.']],
  ['BRIDGE_SENDER_MODE_INVALID', ['bridge-sender-mode-invalid', 'Invalid sender permission mode',
    'Use the actual current sender permission classification; do not change application permissions to deliver the message.']],
  ['BRIDGE_SENDER_INVALID', ['bridge-sender-invalid', 'Invalid bridge sender',
    'Use a supported registered bridge sender.']]
]);
const nativeFailureCodes = new Set(['TRANSPORT_ERROR', 'BRIDGE_ENDPOINT_BUSY',
  'ECONNREFUSED', 'ENOENT', 'ETIMEDOUT', 'ECONNRESET', 'EPIPE', 'EACCES', 'EPERM',
  'EADDRINUSE', 'ENOTDIR', 'E2BIG', 'EINVAL', 'ENOTFOUND', 'EHOSTUNREACH',
  'ENETUNREACH', 'ECONNABORTED', 'ERR_STREAM_DESTROYED', 'ABORT_ERR']);

/** Construct a classified error without accepting caller-provided diagnostic text. */
export function transportDiagnosticError(code) {
  const diagnostic = failureDiagnostics.get(code);
  return Object.assign(new Error(diagnostic?.[1] ?? 'Unclassified transport failure'),
    { code: diagnostic ? code : 'TRANSPORT_ERROR' });
}
const homeKey = settings => {
  const value = resolve(settings.home ?? homedir());
  return process.platform === 'win32' ? value.toLowerCase() : value;
};

/** Serialize the shared app endpoint, including calls from different workspaces. */
export function transportEndpointKey(agent, target, settings = {}) {
  const destination = agent === 'claude' ? target.hostSessionId ?? target.sessionId ?? 'unregistered' : 'app';
  // config.home selects Claude's session store; it does not select a different
  // running Codex app or Antigravity language server.
  return digest(JSON.stringify([homeKey(agent === 'claude' ? settings : {}), agent, destination]));
}

export function recipientFingerprint(agent, target, settings = {}) {
  return digest(JSON.stringify([homeKey(settings), agent, target.hostId ?? null,
    target.hostSessionId ?? null, target.threadId ?? target.sessionId ?? target.conversationId ?? null]));
}

export function transportOptions(options = {}) {
  const result = { maxAttempts: options.maxAttempts ?? 3,
    retryDelayMs: options.retryDelayMs ?? 200, lockTimeoutMs: options.lockTimeoutMs ?? 30000,
    autoWake: options.autoWake ?? true };
  if (typeof result.autoWake !== 'boolean') throw new Error('Invalid transport option autoWake: expected boolean');
  for (const [name, min, max] of [['maxAttempts', 1, 5], ['retryDelayMs', 0, 5000], ['lockTimeoutMs', 1, 120000]]) {
    if (!Number.isSafeInteger(result[name]) || result[name] < min || result[name] > max) {
      throw new Error(`Invalid transport option ${name}: expected integer ${min}..${max}`);
    }
  }
  if (options.responseTimeoutMs !== undefined) {
    if (!Number.isSafeInteger(options.responseTimeoutMs) || options.responseTimeoutMs < 1 || options.responseTimeoutMs > 600000) {
      throw new Error('Invalid transport option responseTimeoutMs: expected integer 1..600000');
    }
    result.responseTimeoutMs = options.responseTimeoutMs;
  }
  return result;
}

function lockAddress(key) {
  const name = 'agent-bridge-mutex-' + digest(key).slice(0, 48);
  if (process.platform === 'win32') return '\\\\.\\pipe\\' + name;
  if (process.platform === 'linux') return '\0' + name;
  throw new Error('Endpoint mutex requires Windows named pipes or Linux abstract sockets');
}

function lockTimeout() {
  const error = new Error('Endpoint is busy; lock wait deadline expired before submission');
  error.code = 'BRIDGE_ENDPOINT_BUSY';
  error.delivery = { submitted: false, phase: 'lock', retryable: false };
  return error;
}

async function tryBind(address) {
  const clients = new Set();
  const server = net.createServer(socket => {
    // A client waits only for closure; the lock endpoint accepts no commands/data.
    clients.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => clients.delete(socket));
    socket.on('data', () => socket.destroy());
    if (clients.size > 128) socket.destroy();
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen({ path: address, exclusive: true }, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
  } catch (error) {
    server.close();
    if (['EADDRINUSE', 'EACCES'].includes(error.code)) return null;
    throw error;
  }
  return async () => {
    // Stop accepting before waking contenders, so they can acquire immediately.
    const closed = new Promise(resolve => server.close(resolve));
    for (const client of clients) client.destroy();
    await closed;
  };
}

async function waitForOwner(address, remainingMs) {
  await new Promise((resolve, reject) => {
    const client = net.createConnection(address);
    let settled = false;
    const timer = setTimeout(() => finish(lockTimeout()), remainingMs);
    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.destroy();
      error ? reject(error) : resolve();
    }
    client.once('close', () => finish());
    client.once('error', () => finish());
  });
}

/** OS-owned mutex: process exit releases it; no lease stealing, watcher or disk lock. */
export async function withEndpointLock(key, operation, { lockTimeoutMs = 30000 } = {}) {
  if (!Number.isSafeInteger(lockTimeoutMs) || lockTimeoutMs < 1 || lockTimeoutMs > 120000) {
    throw new Error('Invalid lockTimeoutMs');
  }
  const address = lockAddress(key), deadline = Date.now() + lockTimeoutMs;
  let waited = false;
  while (true) {
    if (waited && Date.now() >= deadline) throw lockTimeout();
    const release = await tryBind(address);
    if (release) {
      try { return await operation(); }
      finally { await release(); }
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw lockTimeout();
    await waitForOwner(address, remaining);
    waited = true;
    // Close/bind races and an incompatible local listener must not busy-spin.
    if (Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  }
}

/** Error text/code alone is not evidence that the receiver saw no request. */
function recipientAvailability(value) {
  if(!value || typeof value!=='object')return undefined;
  const result={};
  for(const [field,allowed] of Object.entries({appState:['running','not-running','unknown'],
    conversationState:['stored','missing','ambiguous','archived','unknown'],
    runtimeState:['running','absent','ambiguous','unknown']})) {
    if(allowed.includes(value[field]))result[field]=value[field];
  }
  if(value.wake?.supported===false && value.wake.reason==='desktop-no-supported-unattended-runtime-wake') {
    result.wake={supported:false,reason:value.wake.reason};
  }
  return Object.keys(result).length?result:undefined;
}
export function transportFailure(error) {
  const value = error?.delivery;
  const phase = ['lock', 'preflight', 'prepare', 'connect', 'write', 'response'].includes(value?.phase)
    ? value.phase : 'unknown';
  const code = failureDiagnostics.has(error?.code) || nativeFailureCodes.has(error?.code)
    ? error.code : 'TRANSPORT_ERROR';
  const retrySafe = value?.submitted === false;
  const diagnostic = failureDiagnostics.get(code);
  const availability=code.startsWith('CLAUDE_')?recipientAvailability(error.recipientAvailability):undefined;
  return { code, phase, retrySafe,
    retryable: retrySafe && value?.retryable === true && ['connect', 'preflight'].includes(phase),
    ...(diagnostic ? { reason: diagnostic[0], action: diagnostic[2] } : {}),
    ...(availability?{recipientAvailability:availability}:{}),
    summary: `Transport failure (${code}, ${phase}); ${retrySafe ? 'nothing submitted' : 'delivery uncertain'}`
      + (diagnostic ? `. ${diagnostic[1]}. Action: ${diagnostic[2]}` : '') };
}

/** Rebuild receipt diagnostics from the same allowlist; never echo stored text. */
export function diagnosticTransportFailure(failure) {
  if (!failure || typeof failure !== 'object') return undefined;
  return transportFailure({ code: failure.code, recipientAvailability:failure.recipientAvailability, delivery: {
    phase: failure.phase, submitted: failure.retrySafe === true ? false : undefined,
    retryable: failure.retryable === true
  } });
}

/** Complete observation is evidence of absence in the recipient log, not proof
 * that its native queue is empty. Only claim-v1 consumers permit one bounded
 * same-ID redelivery; they must atomically claim work before executing it. */
function guardedRedelivery(events, attempts, uncertain, options) {
  if (options.guardedDelivery !== 'claim-v1' || options.recipientAgent !== 'codex') return null;
  const outcomes = attempt => events.filter(row => row.attemptId === attempt.attemptId && !row.observation
    && ['delivery-error', 'send-blocked', 'native-accepted', 'transport-written'].includes(row.state));
  const lastOutcome = attempt => outcomes(attempt).at(-1);
  const spent = attempts.some(attempt => attempt.redeliveryReason === 'unobserved-guarded-redelivery'
    && lastOutcome(attempt)?.failure?.retrySafe !== true && lastOutcome(attempt)?.state !== 'send-blocked');
  if (spent) return { allowed: false, reason: 'guarded-redelivery-pending', inspect: false };
  // A crash before a result or an unknown write phase cannot be converted into
  // this specific response-timeout recovery solely from a negative log scan.
  if (!uncertain.length || uncertain.some(attempt => {
    const outcome = lastOutcome(attempt);
    return outcome?.state !== 'delivery-error' || outcome.failure?.phase !== 'response';
  })) return null;
  const latest = [...attempts].sort((a, b) => (a.attemptNumber ?? 0) - (b.attemptNumber ?? 0)).at(-1);
  const outcome = lastOutcome(latest);
  const observed = events.filter(row => row.attemptId === latest.attemptId && row.observation).at(-1);
  const observation = observed?.observation, evidence = observation?.evidence;
  const observedAt = Date.parse(observation?.observedAt ?? observed?.createdAt);
  const outcomeAt = Date.parse(outcome?.createdAt);
  if (typeof latest.messageId !== 'string' || !latest.messageId
      || observation?.state !== 'delivery-not-observed' || observation.transport !== 'codex-app-tools'
      || evidence?.complete !== true || evidence.messageId !== latest.messageId
      || (observation.messageId !== undefined && observation.messageId !== latest.messageId)
      || typeof evidence.threadId !== 'string' || !evidence.threadId
      || (options.recipientThreadId !== undefined && options.recipientThreadId !== evidence.threadId)
      || !Number.isFinite(observedAt) || !Number.isFinite(outcomeAt) || observedAt < outcomeAt) return null;
  return { allowed: true, reason: 'unobserved-guarded-redelivery', inspect: false };
}

/** Legacy requests still require durable no-submission evidence. Guarded new
 * requests may use one bounded redelivery after an exact complete observation. */
export function resumeDecision(events, fingerprint, options = {}) {
  const attempts = events.filter(row => row.state === 'delivery-attempt');
  if (events.some(row => ['superseded', 'message-superseded'].includes(row.state))) {
    return { allowed: false, reason: 'message-superseded', inspect: false };
  }
  if (attempts.some(row => row.recipientFingerprint !== fingerprint)) {
    return { allowed: false, reason: 'recipient-changed', inspect: false };
  }
  if (events.some(row => ['native-accepted', 'transport-written', 'received', 'recipient-observed',
    'work-claimed', 'handled', 'execution-running', 'execution-failed', 'approval-pending', 'delivery-rejected'].includes(row.state)
    || row.observation?.recipientObserved === true)) {
    return { allowed: false, reason: 'delivery-already-submitted', inspect: false };
  }
  // Each attempt needs its own explicit no-submission outcome. A crash between
  // attempt and outcome remains uncertain, even if the final file is older.
  const uncertain = [];
  for (const attempt of attempts) {
    const outcome = events.find(row => row.attemptId === attempt.attemptId && !row.observation
      && ['delivery-error', 'send-blocked', 'native-accepted', 'transport-written'].includes(row.state));
    if (!outcome || !(outcome.failure?.retrySafe === true || outcome.state === 'send-blocked')) {
      uncertain.push(attempt);
    }
  }
  if (uncertain.length) return guardedRedelivery(events, attempts, uncertain, options)
    ?? { allowed: false, reason: 'delivery-uncertain', inspect: true };
  if (!attempts.length && events.some(row => row.state === 'delivery-error' && row.failure?.retrySafe !== true)) {
    return { allowed: false, reason: 'delivery-uncertain', inspect: true };
  }
  return { allowed: true, reason: 'not-submitted', inspect: false };
}
