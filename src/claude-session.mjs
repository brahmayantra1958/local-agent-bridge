import { transportDiagnosticError } from './transport-runtime.mjs';

/** Resolve a runtime only within the configured Desktop chat identity.
 * Discovery must supply live process descriptors. A title/cwd match is never
 * identity evidence. Keep registration unchanged so old attempt fingerprints
 * still protect the original persisted message during resume.
 */
export function resolveClaudeSession(target, sessions) {
  const exact = sessions.filter(row => row.sessionId === target.sessionId);
  if (exact.length > 1) throw transportDiagnosticError('CLAUDE_SESSION_AMBIGUOUS');
  if (exact.length === 1) {
    if (target.hostSessionId && exact[0].hostSessionId !== target.hostSessionId) {
      throw transportDiagnosticError('CLAUDE_HOST_ID_CHANGED');
    }
    return { session: exact[0], requestedSessionId: target.sessionId, matchedBy: 'session-id' };
  }
  if (!target.hostSessionId) throw transportDiagnosticError('CLAUDE_SESSION_NOT_RUNNING');
  const replacements = sessions.filter(row => row.hostSessionId === target.hostSessionId
    && typeof row.sessionId === 'string' && row.sessionId.length > 0);
  if (replacements.length > 1) throw transportDiagnosticError('CLAUDE_SESSION_AMBIGUOUS');
  if (!replacements.length) throw transportDiagnosticError('CLAUDE_SESSION_NOT_RUNNING');
  return { session: replacements[0], requestedSessionId: target.sessionId, matchedBy: 'host-session-id' };
}

export function claudeResolutionEvidence(resolution) {
  return { requestedSessionId: resolution.requestedSessionId,
    resolvedSessionId: resolution.session.sessionId,
    hostSessionId: resolution.session.hostSessionId ?? null,
    matchedBy: resolution.matchedBy };
}
