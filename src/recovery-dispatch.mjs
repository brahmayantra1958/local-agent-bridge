import { assertAgent } from './protocol.mjs';
import { delegationMessageId } from './delegation.mjs';

/** Bind the durable recovery claim to a real host capability. A session peer
 * can create its own native subagent; a local host supplies nativeDelegate. */
export function createRecoveryDispatcher({ bridge, from, to = 'codex', nativeDelegate } = {}) {
  assertAgent(from); assertAgent(to);
  if (!bridge || typeof bridge.send !== 'function') throw new Error('Recovery dispatcher requires a bridge');
  if (from === to && typeof nativeDelegate !== 'function') throw new Error('Local recovery requires the host native-subagent capability');
  return async claim => {
    const parent = await bridge.get(claim.requestId);
    const task = { ...claim, contract: 'recovery-task.v1', originalRequestId: claim.requestId,
      instructions: 'Use a native subagent for this independent error when supported. Keep the original request ID and scope; preserve other workers files. Diagnose the observed environment/endpoint and do not assume ports from another machine. Fix and verify the error, then reply once on completed, failed or blocked. Do not send ACK or progress polls. Do not commit.',
      doNotChange: ['Files outside writeScope', 'Other sessions permission/model settings'],
      report: { summaryMaxLines: 5, artifacts: true, observedExecutionEvidence: true } };
    if (from === to) return { route: 'native-subagent', execution: await nativeDelegate(task) };
    const id = delegationMessageId({ profileId: 'agent-bridge-recovery', taskId: claim.fingerprint, revision: 1 });
    const sent = await bridge.send({ id, from, to, kind: 'task', body: JSON.stringify(task), correlationId: parent.correlationId });
    const status = sent.status ?? null;
    const submitted = ['native-accepted', 'transport-written'].includes(status?.transportState)
      || ['received', 'recipient-observed'].includes(status?.receiptState);
    return { route: 'registered-session', messageId: id, app: to, duplicate: sent.duplicate === true,
      state: status?.state ?? sent.delivery?.state ?? 'delivery-unconfirmed',
      dispatched: submitted && status?.requiresAttention !== true, status };
  };
}
