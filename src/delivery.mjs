import { diagnosticTransportFailure } from './transport-runtime.mjs';
import { diagnosticWake, wakeNeedsAttention } from './recipient-wake.mjs';

const transportStates = new Set(['native-accepted', 'transport-written']);
export const attentionStates = new Set(['execution-failed', 'approval-pending', 'send-blocked', 'delivery-refused', 'delivery-rejected']);

function waitingState(failure) {
  if (!failure) return null;
  if (!failure.retrySafe && failure.phase === 'response') return 'pending-receipt';
  if (!failure.retrySafe) return null;
  if (failure.code === 'BRIDGE_ENDPOINT_BUSY' && failure.phase === 'lock') return 'queued';
  if (['CLAUDE_SESSION_NOT_RUNNING', 'CLAUDE_SESSION_STORE_MISSING', 'CODEX_APP_NOT_RUNNING',
    'ANTIGRAVITY_APP_NOT_RUNNING', 'ANTIGRAVITY_ENDPOINT_UNAVAILABLE', 'ANTIGRAVITY_TARGET_UNAVAILABLE'].includes(failure.code)
      && failure.phase === 'preflight') return 'queued';
  if (['ECONNREFUSED', 'ENOENT', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT'].includes(failure.code)
      && failure.phase === 'connect') return 'queued';
  return null;
}

function validTimestamp(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }

// Transport, recipient acknowledgement and executor state are independent facts.
// In particular an API response cannot prove that a model executor started.
export function summarizeDelivery(receipts) {
  const attempt = receipts.filter(row => row.state === 'delivery-attempt')
    .sort((a, b) => (a.attemptNumber ?? 0) - (b.attemptNumber ?? 0)).at(-1);
  const current = attempt ? receipts.filter(row => row.attemptId === attempt.attemptId
    || (!row.attemptId && row.createdAt >= attempt.createdAt)) : receipts;
  const transport = receipts.filter(row => transportStates.has(row.state)).at(-1);
  const lastAttempt = current.filter(row => transportStates.has(row.state)
    || row.state === 'delivery-error' || row.state === 'send-blocked').at(-1);
  let observed = current.filter(row => row.observation).at(-1)?.observation;
  const wake = receipts.filter(row => ['recipient-wake-ready', 'recipient-wake-unavailable'].includes(row.state)).at(-1);
  const handoff = current.some(row => row.state === 'ui-handoff-queued');
  const transportFailure = lastAttempt?.state === 'delivery-error'
    ? diagnosticTransportFailure(lastAttempt.failure) : undefined;
  const acknowledged = receipts.some(row => row.state === 'received');
  const handled = receipts.some(row => row.state === 'handled');
  const claimed = receipts.some(row => row.state === 'work-claimed');
  const superseded = receipts.some(row => ['superseded', 'message-superseded'].includes(row.state));
  const seen = receipts.some(row => row.state === 'recipient-observed'
    || row.state === 'execution-running' || row.observation?.recipientObserved === true);
  // A read with no receipt does not resolve a witnessed trust/login/UI blocker.
  // Retain that actionable state until positive target receipt or local work.
  const uiBlocker = current.filter(row => row.state === 'ui-recovery-blocked'
    && attentionStates.has(row.observation?.state)).at(-1);
  if (uiBlocker && !seen && !acknowledged && !claimed && !handled && !superseded
      && !attentionStates.has(observed?.state)) observed = uiBlocker.observation;
  const observedState = observed?.state;
  const receiptResolves = acknowledged && ['approval-pending', 'delivery-unconfirmed', 'delivery-not-observed'].includes(observedState);
  const wait = !seen && !acknowledged && !claimed && !handled && !superseded ? waitingState(transportFailure) : null;
  const baseState = receiptResolves ? 'received'
    : observedState ?? (acknowledged ? 'received' : transport ? 'delivery-unconfirmed' : 'unconfirmed');
  const state = superseded ? 'superseded' : handled ? 'handled' : claimed && !attentionStates.has(baseState) ? 'work-claimed'
    : wait && !attentionStates.has(baseState) ? wait : baseState;
  const pending = !handled && !superseded && !acknowledged && !seen && !claimed;
  const wakeAttention = pending && wakeNeedsAttention(wake?.wake);
  const waitingSince = pending ? receipts.map(row => row.createdAt).filter(validTimestamp)
    .sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? null : null;
  const nextAction = wakeAttention ? wake.wake.reasonCode
    : handoff && pending && !attentionStates.has(state) ? 'await-ui-recovery'
    : state === 'queued' ? 'resume-when-recipient-available'
    : state === 'pending-receipt' || state === 'delivery-not-observed' ? 'resume-original-id'
      : ['received', 'recipient-observed', 'handled', 'work-claimed', 'superseded'].includes(state) ? 'none'
        : observed?.nextAction ?? transportFailure?.action ?? 'await-result';
  return {
    transportState: lastAttempt?.state === 'send-blocked' ? 'not-submitted'
      : lastAttempt?.state === 'delivery-error' ? (lastAttempt.failure?.retrySafe ? 'not-submitted' : 'uncertain')
        : handoff && pending ? 'handoff-pending' : transport?.state ?? 'unconfirmed',
    receiptState: acknowledged || claimed || handled ? 'received' : seen ? 'recipient-observed' : 'unconfirmed',
    executionState: observed?.executionState ?? 'unconfirmed',
    state: handoff && pending && !attentionStates.has(state) ? 'queued-ui-recovery' : state,
    requiresAttention: !handled && !superseded && (attentionStates.has(state)
      || wakeAttention || (lastAttempt?.state === 'delivery-error' && !seen && !acknowledged && !claimed && !wait)),
    waitingSince, lastAttemptAt: validTimestamp(attempt?.createdAt) ? attempt.createdAt : null, nextAction,
    ...(transportFailure ? { transportFailure } : {}),
    ...(wake ? { wake: { ...diagnosticWake(wake.wake), attemptedAt: wake.createdAt } } : {}),
    ...(observed ? { observation: observed } : {}),
  };
}

// Adapters must return metadata-only evidence. Do not carry raw API results,
// prompts, credentials, transcript text or tool payloads into diagnostic receipts.
export function diagnosticObservation(value) {
  if (!value || typeof value.state !== 'string') throw new Error('Delivery observation requires state');
  const keys = ['state', 'transport', 'transportState', 'executionState', 'reasonCode',
    'sessionId', 'threadId', 'conversationId', 'conversationStatus', 'recipientObserved', 'messageId', 'observedAt', 'nextAction', 'evidence', 'laterActivity'];
  return Object.fromEntries(keys.filter(key => value[key] !== undefined).map(key => [key, value[key]]));
}

