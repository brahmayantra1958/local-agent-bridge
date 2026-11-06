/** Only a proven pre-submission outage can invoke host recovery. Auth failures,
 * ambiguous routes and uncertain writes must keep their ordinary guards. */
export function shouldWakeRecipient(agent, failure, target) {
  if (!failure?.retrySafe) return false;
  if (agent === 'claude' && !target?.hostSessionId) return false;
  if (agent === 'gemini' && !target?.conversationId) return false;
  if (!['claude', 'gemini'].includes(agent)) return false;
  if (failure.phase === 'connect') return ['ECONNREFUSED', 'ENOENT'].includes(failure.code);
  if (failure.phase !== 'preflight') return false;
  return (agent === 'claude'
    ? ['CLAUDE_SESSION_NOT_RUNNING', 'CLAUDE_SESSION_STORE_MISSING']
    : ['ANTIGRAVITY_APP_NOT_RUNNING', 'ANTIGRAVITY_ENDPOINT_UNAVAILABLE', 'ANTIGRAVITY_TARGET_UNAVAILABLE']).includes(failure.code);
}

/** Do not persist native exception text, command lines or credentials. */
export function diagnosticWake(value) {
  const result = { ready: value?.ready === true };
  if (typeof value?.reasonCode === 'string' && /^[a-z][a-z0-9-]{0,95}$/.test(value.reasonCode)) {
    result.reasonCode = value.reasonCode;
  }
  if (typeof value?.method === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(value.method)) result.method = value.method;
  return result;
}

const attentionReasons = new Set(['invalid-conversation-id', 'invalid-wake-timeout',
  'stored-conversation-unavailable', 'app-executable-unavailable', 'app-launch-failed',
  'conversation-project-mismatch', 'conversation-identity-unconfirmed',
  'endpoint-not-recoverable', 'claude-wake-host-required', 'claude-wake-metadata-unavailable',
  'claude-wake-metadata-ambiguous', 'claude-wake-conversation-missing',
  'claude-wake-conversation-archived', 'claude-wake-desktop-unavailable',
  'claude-wake-executor-unavailable', 'claude-wake-codex-executor-unavailable', 'claude-ui-existing-draft']);
export function wakeNeedsAttention(value) {
  return value?.ready === false && attentionReasons.has(value.reasonCode);
}
