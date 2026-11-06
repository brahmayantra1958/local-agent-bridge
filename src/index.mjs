import { readFile, readdir, mkdir, writeFile, link, unlink, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { makeEnvelope, validateEnvelope, assertAgent, assertId, renderPrompt, AGENTS } from './protocol.mjs';
import { sendCodex, readCodex, inspectCodex } from './adapters/codex.mjs';
import { buildMessageRoutes, selectMessageTarget, sessionMatches, normalizeSession } from './session-routing.mjs';
import { createMailbox, completedMessageIds } from './mailbox.mjs';
import { delegationScope, activeReservations, scopeConflicts, protectedPathsReservedElsewhere, reservationTtlMs,
  takeScopeBaseline, checkScope, scopeCheckNote } from './scope-guard.mjs';
import { inspectClaudeHost } from './claude-host.mjs';
import { shouldWakeRecipient, diagnosticWake } from './recipient-wake.mjs';
import { sendClaude, readClaude, discoverClaude, inspectClaude } from './adapters/claude.mjs';
import { sendAntigravity, readAntigravity, discoverAntigravity, inspectAntigravity } from './adapters/antigravity.mjs';
import { diagnosticObservation, summarizeDelivery } from './delivery.mjs';
import { transportEndpointKey, recipientFingerprint, transportOptions, withEndpointLock,
  transportFailure, resumeDecision } from './transport-runtime.mjs';
import { defaultAppVersionReaders, normalizeAppVersionReading, loadVerifiedAppVersions, recordVerifiedAppVersions,
  compareAppVersion, appVersionWarning, evaluateAppVersionEvidence, APP_REVERIFY_ACTION } from './app-versions.mjs';

export * from './protocol.mjs';
export { verifyCommunication } from './verification.mjs';
export { loadRoutingProfile, validateRoutingProfile, selectRoute, selectRunner, routingProfileForApps,
  stateRoutingProfilePath } from './routing.mjs';
export { joinChat, selfTest, syncStateRoutingProfile, identifyClaudeChat, identifyCodexChat,
  identifyAntigravityChat } from './join.mjs';
export { createDelegation, validateDelegation, serializeDelegation, delegationMessageId, delegate } from './delegation.mjs';
export { readCodexExecutionEvidence, collectCodexExecutionEvidence, unavailableExecutionEvidence } from './execution-evidence.mjs';
export { createCoordinator, completionMessageId, terminalEvent, recoveryFingerprint } from './coordination.mjs';
export { createRecoveryDispatcher } from './recovery-dispatch.mjs';
export { IMAGE_ROUTES, selectImageRoute, createImageTask, dispatchImageTask, recordImageResult } from './images.mjs';
export { withEndpointLock, transportEndpointKey, transportOptions } from './transport-runtime.mjs';
export { normalizeSession, sessionMatches } from './session-routing.mjs';
export { inspectClaudeHost } from './claude-host.mjs';
export { APP_VERSIONS_FILE, loadVerifiedAppVersions, recordVerifiedAppVersions, compareAppVersion,
  evaluateAppVersionEvidence, readClaudeVersion, readWindowsAppVersion } from './app-versions.mjs';
export { delegationScope, activeReservations, scopeConflicts, checkScope, scopeCheckNote } from './scope-guard.mjs';
export { predictClaudeHold, effectiveInbound, claudePermissionClass } from './claude-inbound.mjs';

/** Publish a complete JSON file without replacing an existing message. */
export async function atomicCreate(path, value) {
  const temp = path + '.tmp-' + randomUUID();
  await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  try {
    await link(temp, path);
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  } finally {
    await unlink(temp).catch(() => {});
  }
}

export function createBridge({ root = process.cwd(), adapters, inspectors, wakers, versionReaders, scopeRunner } = {}) {
  root = resolve(root);
  const state = join(root, '.bridge');
  const transports = adapters ?? { codex: sendCodex, claude: sendClaude, gemini: sendAntigravity };
  const observers = inspectors ?? { codex: inspectCodex, claude: inspectClaude, gemini: inspectAntigravity };
  // Injected transports must never launch a real user application implicitly.
  const recovery = wakers ?? (adapters ? {} : {
    claude: async (...args) => (await import('./claude-wake.mjs')).wakeClaude(...args),
    gemini: async (...args) => (await import('./antigravity-wake.mjs')).wakeAntigravity(...args),
  });
  // Nor inspect the real installed apps: version checks then need explicit readers.
  const versionSources = versionReaders ?? (adapters ? {} : defaultAppVersionReaders);
  const versionCache = new Map();
  const init = async () => {
    await Promise.all(['messages', 'receipts'].map(name => mkdir(join(state, name), { recursive: true })));
  };
  const config = async () => JSON.parse(await readFile(join(state, 'config.json'), 'utf8'));
  const get = async id => validateEnvelope(JSON.parse(
    await readFile(join(state, 'messages', assertId(id) + '.json'), 'utf8')
  ));

  async function receipt(data, stableName) {
    await init();
    const row = { ...data, id: randomUUID(), createdAt: new Date().toISOString() };
    const path = join(state, 'receipts', (stableName ?? row.id) + '.json');
    if (!await atomicCreate(path, row)) return JSON.parse(await readFile(path, 'utf8'));
    return row;
  }

  async function receipts(messageId) {
    await init();
    const rows = [];
    for (const name of await readdir(join(state, 'receipts'))) {
      if (!name.endsWith('.json')) continue;
      const row = JSON.parse(await readFile(join(state, 'receipts', name), 'utf8'));
      if (!messageId || row.messageId === messageId) rows.push(row);
    }
    return rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** Metadata-only app version reading; memoized briefly so one flush pass
   * does not repeat the Windows inventory for every queued message. */
  async function readAppVersion(agent, target, settings, { fresh = false } = {}) {
    const reader = versionSources[agent];
    if (typeof reader !== 'function') return null;
    const key = agent + ':' + (agent === 'claude' ? target?.hostSessionId ?? target?.sessionId ?? '' : '');
    const cached = versionCache.get(key);
    if (!fresh && cached && Date.now() - cached.at < 60000) return cached.reading;
    let reading;
    try { reading = normalizeAppVersionReading(agent, await reader({ ...target }, settings)); }
    catch { reading = normalizeAppVersionReading(agent, { reason: 'version-read-failed' }); }
    versionCache.set(key, { at: Date.now(), reading });
    return reading;
  }

  /** Warn-only comparison with the verified baseline; never blocks delivery. */
  async function recipientVersionCheck(agent, target, settings, policy) {
    if (policy.versionCheck === false) return null;
    try {
      const reading = await readAppVersion(agent, target, settings);
      return reading ? compareAppVersion(reading, (await loadVerifiedAppVersions(root)).apps[agent]) : null;
    } catch { return null; }
  }

  const withVersionWarning = (result, check) => !check || check.state === 'verified' ? result
    : { ...result, warnings: [...(result.warnings ?? []), appVersionWarning(check)] };

  async function send(input, options = {}) {
    const policy = transportOptions(options);
    await init();
    const settings = await config();
    const base = makeEnvelope(input);
    const parent = base.replyTo ? await get(base.replyTo) : null;
    const message = makeEnvelope({ ...base, ...buildMessageRoutes(input, settings, parent), guardedDelivery: 'claim-v1' });
    if (!settings.agents?.[message.from] || !settings.agents?.[message.to]) {
      throw new Error('Both peers must be registered');
    }
    if (message.replyTo) {
      if (parent.to !== message.from || parent.from !== message.to
          || parent.correlationId !== message.correlationId) {
        throw new Error('Reply endpoints or correlation do not match parent');
      }
    }
    const path = join(state, 'messages', message.id + '.json');
    const scope = options.scopeGuard === false ? null : delegationScope(message);
    let created, protectedElsewhere = [];
    if (scope) {
      // Check and persist under one state-root mutex so two overlapping
      // delegations cannot both pass. Nothing is persisted or sent on conflict.
      const guarded = await withEndpointLock(scopeLockKey, async () => {
        if (await exists(path)) return { created: false };
        const active = await currentReservations(settings);
        const candidate = { messageId: message.id, ...scope };
        const conflicts = scopeConflicts(candidate, active);
        if (conflicts.length) return { conflicts };
        return { created: await atomicCreate(path, message), protectedElsewhere: protectedPathsReservedElsewhere(candidate, active) };
      }, { lockTimeoutMs: policy.lockTimeoutMs });
      if (guarded.conflicts) return { message, persisted: false, blocked: true, reason: 'write-scope-reserved',
        conflicts: guarded.conflicts, requiresAttention: true,
        nextAction: 'Wait for or supersede the reserving task, or release its reservation, then send this same delegation again. Nothing was sent.' };
      created = guarded.created;
      protectedElsewhere = guarded.protectedElsewhere ?? [];
    } else created = await atomicCreate(path, message);
    if (!created) {
      const original = await get(message.id);
      if (['from', 'to', 'kind', 'body', 'correlationId', 'replyTo'].some(key => original[key] !== message[key])
          || ['senderSession', 'recipientSession'].some(key => input[key] !== undefined
            && !sessionMatches(key === 'senderSession' ? message.from : message.to, original[key], message[key]))) {
        throw new Error('Message ID already used for a different envelope');
      }
      const events = await receipts(message.id);
      const stored = original.kind === 'result' && original.replyTo
        ? (await receipts(original.replyTo)).find(row => row.state === 'scope-checked')?.check : undefined;
      return { message: original, duplicate: true, receipts: events, status: summarizeDelivery(events),
        ...(stored ? { scopeCheck: stored, ...(stored.requiresAttention ? { requiresAttention: true } : {}) } : {}) };
    }
    await receipt({ messageId: message.id, agent: message.from, state: 'persisted' });
    // The delegate's terminal result is compared once with the task baseline,
    // locally and before delivery, so the requester sees it in this same turn.
    const scopeCheck = message.kind === 'result' && parent && options.scopeGuard !== false
      ? await resultScopeCheck(parent, message, settings, options) : undefined;
    const result = await deliver(message, settings, { ...policy, ...options }, false);
    return { ...result,
      ...(protectedElsewhere.length ? { warnings: [...(result.warnings ?? []), { code: 'protected-path-reserved-elsewhere',
        reservations: protectedElsewhere, action: 'Another unfinished task may write these doNotChange paths; its changes will be reported, not attributed to this task.' }] } : {}),
      ...(scopeCheck ? { scopeCheck, ...(scopeCheck.requiresAttention ? { requiresAttention: true } : {}) } : {}) };
  }

  const scopeLockKey = JSON.stringify(['agent-bridge-scope', process.platform === 'win32' ? state.toLowerCase() : state]);
  const exists = path => access(path).then(() => true, () => false);
  const baselinePath = id => join(state, 'scope', assertId(id) + '.baseline.json');
  const scopeGit = settings => ({ git: settings.scopeGuard?.git ?? 'git', ...(scopeRunner ? { run: scopeRunner } : {}) });

  async function currentReservations(settings) {
    const messages = await listMessages(), events = await receipts();
    return activeReservations(messages, events, completedMessageIds(messages, events), { ttlMs: reservationTtlMs(settings) });
  }

  async function readScopeBaseline(id) {
    try { return JSON.parse(await readFile(baselinePath(id), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }

  /** Taken once, before the delegate could have seen the task. A message with
   * an earlier accepted delivery never gets a late (misleading) baseline. */
  async function ensureScopeBaseline(message, scope, settings) {
    if (await exists(baselinePath(message.id))) return;
    if ((await receipts(message.id)).some(row => ['native-accepted', 'transport-written', 'received',
      'recipient-observed', 'work-claimed'].includes(row.state))) return;
    try {
      const baseline = await takeScopeBaseline(message, scope, scopeGit(settings));
      await mkdir(join(state, 'scope'), { recursive: true });
      await atomicCreate(baselinePath(message.id), baseline);
    } catch { /* No baseline means no result comparison; delivery is unaffected. */ }
  }

  async function resultScopeCheck(parent, message, settings, options) {
    const scope = delegationScope(parent);
    if (!scope) return undefined;
    const previous = (await receipts(parent.id)).find(row => row.state === 'scope-checked');
    if (previous) return previous.check;
    const baseline = await readScopeBaseline(parent.id).catch(() => null);
    if (!baseline) return undefined;
    let check;
    try {
      check = await checkScope({ scope, baseline, messages: await listMessages(), resultBody: message.body,
        exclude: [state, options.scopeExclude], ...scopeGit(settings) });
    } catch { return undefined; }
    const row = await receipt({ messageId: parent.id, agent: message.from, state: 'scope-checked',
      resultId: message.id, check }, parent.id + '.scope-check');
    return row.check;
  }

  /** Bridge facts rendered into the same delivery; no extra message or turn. */
  async function promptNotes(message, scope) {
    if (scope) return ['agent-bridge recorded doNotChange and the git working state before this delivery and compares them once when you reply: write only inside writeScope, leave doNotChange untouched, and do not commit.'];
    if (message.kind !== 'result' || !message.replyTo) return [];
    const check = (await receipts(message.replyTo)).find(row => row.state === 'scope-checked')?.check;
    return check ? [scopeCheckNote(check)] : [];
  }

  async function deliver(message, settings, policy, resumed) {
    const target = selectMessageTarget(message, settings);
    const sender = { ...settings.agents[message.from], ...message.senderSession };
    const effectiveSettings = { ...settings, agents: { ...settings.agents, [message.from]: sender, [message.to]: target } };
    const fingerprint = recipientFingerprint(message.to, target, settings);
    const scope = policy.scopeGuard === false ? null : delegationScope(message);
    if (scope) await ensureScopeBaseline(message, scope, settings);
    const notes = await promptNotes(message, scope);
    // Read before taking the endpoint lock; the reading is attempt metadata only.
    const versionCheck = await recipientVersionCheck(message.to, target, settings, policy);
    const recipientApp = versionCheck ? { ...(versionCheck.current ? { version: versionCheck.current } : {}),
      state: versionCheck.state, source: versionCheck.source, ...(versionCheck.reason ? { reason: versionCheck.reason } : {}) } : null;
    try {
      return withVersionWarning(await withEndpointLock(transportEndpointKey(message.to, target, settings), async () => {
        let events = await receipts(message.id);
        let adoption = events.find(row => row.state === 'claim-protocol-adopted' && row.recipientFingerprint === fingerprint);
        const decisionOptions = { guardedDelivery: adoption ? 'claim-v1' : message.guardedDelivery,
          recipientAgent: message.to, recipientThreadId: target.threadId };
        if (events.some(row => row.state === 'message-superseded')) {
          return { message, resumed: false, reason: 'message-superseded', status: summarizeDelivery(events) };
        }
        let decision = resumeDecision(events, fingerprint, decisionOptions);
        if (!decision.allowed && decision.inspect) {
          await observe(message, settings);
          events = await receipts(message.id);
          decision = resumeDecision(events, fingerprint, decisionOptions);
        }
        if (!decision.allowed && policy.adoptClaim === true && !message.guardedDelivery && !adoption) {
          const migrated = resumeDecision(events, fingerprint, { ...decisionOptions, guardedDelivery: 'claim-v1' });
          if (migrated.allowed && migrated.reason === 'unobserved-guarded-redelivery') {
            adoption = await receipt({ messageId: message.id, agent: message.from, state: 'claim-protocol-adopted',
              recipientFingerprint: fingerprint, legacyConsumerUnfenced: true,
              redeliverySemantics: 'at-least-once-legacy-migration' }, message.id + '.claim-protocol-adopted');
            decision = migrated;
          }
        }
        if (!decision.allowed) {
          const status = summarizeDelivery(await receipts(message.id));
          return { message, resumed: false, reason: decision.reason,
            status: decision.reason === 'recipient-changed' ? { ...status, requiresAttention: true } : status };
        }
        const prompt = renderPrompt(adoption ? { ...message, guardedDelivery: 'claim-v1' } : message, root, notes);
        let attemptLimit = policy.maxAttempts, wakeAttempted = false, recipientWake;
        for (let attempt = 1; attempt <= attemptLimit; attempt++) {
          const attemptId = randomUUID();
          const priorAttempts = (await receipts(message.id)).filter(row => row.state === 'delivery-attempt');
          const attemptNumber = Math.max(0, ...priorAttempts.map(row => row.attemptNumber ?? 0)) + 1;
          const attemptRecord = await receipt({ messageId: message.id, agent: message.from, state: 'delivery-attempt',
            attemptId, attemptNumber, recipientFingerprint: fingerprint, resumed,
            ...(recipientApp ? { recipientApp } : {}),
            ...(recipientWake?.method ? { recoveryMethod: recipientWake.method } : {}),
            ...(recipientWake?.method === 'claude-desktop-ui' ? { promptSha256: createHash('sha256').update(prompt).digest('hex') } : {}),
            ...(decision.reason === 'unobserved-guarded-redelivery' ? { redeliveryReason: decision.reason } : {}) });
          let delivery;
          try {
            delivery = await transports[message.to](target,
              prompt, effectiveSettings, message,
              { ...policy, bridgeRoot: root,
                ...(message.to === 'claude' && policy.autoWake !== false && recovery.claude
                  && policy.diagnoseAvailability === undefined ? { diagnoseAvailability: false } : {}),
                ...(recipientWake ? { recipientWake } : {}),
                ...(attemptRecord.promptSha256 ? { uiReceipt: {
                  attemptedAt: attemptRecord.createdAt, promptSha256: attemptRecord.promptSha256 } } : {}) });
          } catch (error) {
            const failure = transportFailure(error);
            await receipt({ messageId: message.id, agent: message.from, state: 'delivery-error',
              attemptId, failure, error: failure.summary });
            if (!wakeAttempted && policy.autoWake !== false && recovery[message.to]
                && (failure.phase === 'preflight' || !failure.retryable || attempt >= attemptLimit)
                && shouldWakeRecipient(message.to, failure, target)) {
              wakeAttempted = true;
              await receipt({ messageId: message.id, agent: message.from, state: 'recipient-wake-attempt',
                attemptId, recipientFingerprint: fingerprint });
              let wake;
              try { wake = diagnosticWake(await recovery[message.to]({ ...target }, effectiveSettings, policy)); }
              catch { wake = diagnosticWake({ ready: false, reasonCode: 'wake-failed' }); }
              await receipt({ messageId: message.id, agent: message.from,
                state: wake.ready ? 'recipient-wake-ready' : 'recipient-wake-unavailable',
                attemptId, recipientFingerprint: fingerprint, wake });
              if (wake.ready) {
                recipientWake = wake;
                // Waking submits no prompt. The next ordinary transport attempt
                // retains the original envelope, route, claim guard and ID.
                attemptLimit = Math.max(attemptLimit, attempt + 1);
                continue;
              }
            }
            if (failure.retryable && attempt < attemptLimit) {
              await new Promise(resolve => setTimeout(resolve, Math.min(5000, policy.retryDelayMs * 2 ** (attempt - 1))));
              continue;
            }
            if (policy.deferErrors === true) {
              if (!failure.retrySafe && observers[message.to]) {
                try { await observe(message, settings); } catch { /* The persisted attempt is still pending. */ }
              }
              const status = summarizeDelivery(await receipts(message.id));
              return { message, deferred: true, resumed: false, reason: status.state, status };
            }
            throw new Error('Message ' + message.id + ' persisted; ' + failure.summary);
          }
          // An exception while recording an outcome must never be interpreted
          // as evidence that the transport did not send the message.
          await receipt({ messageId: message.id, agent: message.from,
            state: delivery.state, transport: delivery.transport, attemptId,
            ...(message.to==='claude' && delivery.runtimeResolution ? {runtimeResolution:delivery.runtimeResolution} : {}) });
          if (delivery.observation) await recordObservation(message, delivery.observation, attemptId);
          return { message, delivery, ...(resumed ? { resumed: true } : {}),
            ...(adoption ? { legacyConsumerUnfenced: true, redeliverySemantics: 'at-least-once-legacy-migration' } : {}),
            status: summarizeDelivery(await receipts(message.id)) };
        }
      }, policy), versionCheck);
    } catch (error) {
      // A busy endpoint never got as far as an attempt. Record that distinction
      // so an explicit resume can use this same persisted request later.
      if (error.code === 'BRIDGE_ENDPOINT_BUSY') {
        const failure = transportFailure(error);
        await receipt({ messageId: message.id, agent: message.from, state: 'delivery-error',
          failure, error: failure.summary });
        if (policy.deferErrors === true) return withVersionWarning({ message, deferred: true, resumed: false,
          reason: 'endpoint-busy', status: summarizeDelivery(await receipts(message.id)) }, versionCheck);
        throw new Error('Message ' + message.id + ' persisted; ' + failure.summary);
      }
      throw error;
    }
  }

  /** Resume only requests with durable evidence that every attempt submitted nothing. */
  async function resume(id, options = {}) {
    const policy = transportOptions(options), message = await get(id), settings = await config();
    if (!settings.agents?.[message.from] || !settings.agents?.[message.to]) {
      throw new Error('Both peers must be registered');
    }
    return deliver(message, settings, { ...policy, ...options }, true);
  }

  async function recordObservation(message, result, attemptId) {
    const observation = diagnosticObservation({ observedAt: new Date().toISOString(), ...result });
    await receipt({ messageId: message.id, agent: message.from,
      state: observation.state, transport: observation.transport, observation, ...(attemptId ? { attemptId } : {}) });
    return observation;
  }

  /** One read-only native inspection; never submits, retries or acknowledges a task. */
  async function observe(message, settings, options) {
    let target = selectMessageTarget(message, settings), historicalResolution;
    if (!target) throw new Error('Recipient is not registered');
    const existing = await receipts(message.id);
    // Claude has no executor-state observer. A durable exact receipt or local
    // claim remains sufficient after a restart or transcript truncation.
    if (message.to === 'claude' && options?.refresh !== true) {
      const local = existing.find(row => row.agent === message.to
        && ['received','work-claimed','handled'].includes(row.state));
      const native = existing.find(row => row.state === 'recipient-observed'
        && row.observation?.evidence?.messageId === message.id);
      if (local || native) return { messageId: message.id, from: message.from, to: message.to,
        cached: true, observation: native?.observation ?? {state:'received',executionState:'unknown',
          reasonCode:'durable-local-recipient-record',evidence:{source:'bridge-receipt',messageId:message.id,receiptId:local.id}},
        status: summarizeDelivery(existing) };
    }
    // The immutable host route may contain no runtime ID. Retain the exact
    // observed runtime for read-only history even after it has exited.
    if (message.to === 'claude' && target.hostSessionId) {
      const historical = existing.map(row => row.observation?.evidence?.messageId === message.id
        ? row.observation.evidence.runtimeResolution : row.runtimeResolution)
        .filter(row => row?.hostSessionId===target.hostSessionId).at(-1);
      const sessionId = historical?.resolvedSessionId;
      if (sessionId) {
        target = {...target,sessionId};
        historicalResolution={...historical,source:'persisted-runtime-resolution'};
      }
    }
    const observer = observers[message.to];
    const uiAttempt = existing.filter(row => row.state === 'delivery-attempt'
      && row.recoveryMethod === 'claude-desktop-ui').at(-1);
    const { uiReceipt: ignoredUiReceipt, ...observerOptions } = options ?? {};
    const observationOptions = { ...observerOptions, bridgeRoot: root,
      ...(message.to === 'claude' && uiAttempt ? { uiReceipt: {
        attemptedAt: uiAttempt.createdAt, promptSha256: uiAttempt.promptSha256 } } : {}) };
    const result = observer ? await observer(target, settings, message, observationOptions) : {
      state: 'delivery-unconfirmed', reasonCode: 'inspection-unsupported',
      executionState: 'unconfirmed', nextAction: 'Use the recipient acknowledgement or correlated reply.',
    };
    if(historicalResolution && !result.evidence?.runtimeResolution) {
      result.evidence={...result.evidence,runtimeResolution:historicalResolution};
    }
    const attempt = existing.filter(row => row.state === 'delivery-attempt')
      .sort((a, b) => (a.attemptNumber ?? 0) - (b.attemptNumber ?? 0)).at(-1);
    const observation = await recordObservation(message, result, attempt?.attemptId);
    return { messageId: message.id, from: message.from, to: message.to,
      observation, status: summarizeDelivery(await receipts(message.id)) };
  }

  async function check(id, options = {}) {
    const message = await get(id), settings = await config();
    const target = selectMessageTarget(message, settings);
    if (!target) throw new Error('Recipient is not registered');
    return withEndpointLock(transportEndpointKey(message.to, target, settings),
      () => observe(message, settings, options), transportOptions(options));
  }

  async function inbox(agent, options = {}) {
    assertAgent(agent);
    await init();
    const rows = [];
    for (const name of await readdir(join(state, 'messages'))) {
      if (!name.endsWith('.json')) continue;
      const row = await get(name.slice(0, -5));
      if (row.to === agent) rows.push(row);
    }
    rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    if (options.pending) return mailbox.pendingRows(rows, await receipts(), { ...options, agent });
    return rows.filter(message => !options.session || !message.recipientSession
      || sessionMatches(agent, options.session, message.recipientSession)).map(message => {
        if (options.includeBodies !== false) return message;
        const { body, ...metadata } = message; return metadata;
      });
  }

  async function receive(agent, id) {
    assertAgent(agent);
    const message = await get(id);
    if (message.to !== agent) throw new Error('Only intended recipient may acknowledge');
    const previous = (await receipts(id)).find(row => row.state === 'received' && row.agent === agent);
    return previous ?? receipt({ messageId: id, agent, state: 'received' }, id + '.' + agent + '.received');
  }

  async function reply(agent, id, { body, kind = 'result', ...options } = {}) {
    const parent = await get(id);
    await receive(agent, id);
    // Same terminal reply is idempotent even if the CLI response was lost.
    const hash = createHash('sha256').update(JSON.stringify(['bridge-reply.v1', id, agent, kind, body])).digest('hex');
    const replyId = `${hash.slice(0,8)}-${hash.slice(8,12)}-8${hash.slice(13,16)}-a${hash.slice(17,20)}-${hash.slice(20,32)}`;
    return send({ id: replyId, from: agent, to: parent.from, body, kind,
      replyTo: id, correlationId: parent.correlationId,
      senderSession: options.senderSession, recipientSession: options.recipientSession }, options);
  }

  async function status({ includeBodies = true, id } = {}) {
    await init();
    if (id) assertId(id);
    const messages = [];
    for (const name of await readdir(join(state, 'messages'))) {
      if (name.endsWith('.json') && (!id || name === id + '.json')) messages.push(await get(name.slice(0, -5)));
    }
    const events = await receipts();
    return { root, messages: messages.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(message => {
        const rows = events.filter(row => row.messageId === message.id);
        const { body, ...metadata } = message;
        const delivery = summarizeDelivery(rows);
        if (!['received', 'recipient-observed'].includes(delivery.receiptState) && delivery.state !== 'superseded') {
          delivery.waitingSince ??= message.createdAt;
          delivery.waitingMs = Math.max(0, Date.now() - Date.parse(delivery.waitingSince));
        }
        return { ...(includeBodies ? message : metadata), receipts: rows, delivery };
      }) };
  }

  async function read(agent) {
    assertAgent(agent);
    const settings = await config();
    const target = settings.agents?.[agent];
    if (!target) throw new Error('Recipient is not registered');
    return withEndpointLock(transportEndpointKey(agent, target, settings), () =>
      ({ codex: readCodex, claude: readClaude, gemini: readAntigravity }[agent](target, settings)));
  }

  async function discover() {
    const results = await Promise.allSettled([discoverClaude(), discoverAntigravity()]);
    return {
      claude: results[0].status === 'fulfilled'
        ? results[0].value.map(({ sessionId, hostSessionId, name, cwd, status }) => ({ sessionId, hostSessionId, name, cwd, status }))
        : { error: results[0].reason.message },
      gemini: results[1].status === 'fulfilled'
        ? { address: results[1].value.address, pid: results[1].value.pid }
        : { error: results[1].reason.message }
    };
  }

  async function diagnose(agent, {session}={}) {
    if(agent!=='claude')throw new Error('Host availability diagnostics currently support Claude');
    const settings=await config();
    return inspectClaudeHost(session??settings.agents?.claude,settings);
  }

  async function listMessages() {
    return Promise.all((await readdir(join(state, 'messages')))
      .filter(name => name.endsWith('.json')).map(name => get(name.slice(0,-5))));
  }
  const mailbox = createMailbox({ state, atomicCreate, get, receipts, receipt, listMessages });

  async function flush({ to, session, onlyUnsubmitted = false, limit = 20, deadlineAt, ...options } = {}) {
    if (to) assertAgent(to);
    if (session && !to) throw new Error('Session-filtered flush requires a recipient agent');
    const actualSession = session === undefined ? undefined : normalizeSession(to, session);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid flush limit');
    if (deadlineAt !== undefined && (!Number.isFinite(deadlineAt) || deadlineAt < 0)) throw new Error('Invalid flush deadline');
    const settings = await config();
    const snapshot = await status({ includeBodies: false });
    const pending = snapshot.messages.filter(row => (!to || row.to === to)
      && (!actualSession || (()=>{
        const recipient=row.recipientSession ?? buildMessageRoutes(row, settings).recipientSession;
        if(to==='claude' && recipient?.hostSessionId && actualSession.hostSessionId!==recipient.hostSessionId)return false;
        return sessionMatches(to, actualSession, recipient);
      })())
      && !row.receipts.some(event => ['native-accepted','transport-written','received','recipient-observed',
        'work-claimed','handled','message-superseded'].includes(event.state)
        || event.observation?.recipientObserved === true)
      && (!onlyUnsubmitted || resumeDecision(row.receipts,
        recipientFingerprint(row.to, selectMessageTarget(row, settings), settings)).allowed)).slice(0, limit);
    const results = [];
    // One startup pass; serialize targets and never keep a waiting process alive.
    for (const row of pending) {
      if (deadlineAt !== undefined && Date.now() >= deadlineAt) break;
      const result = await resume(row.id, { ...options, maxAttempts: 1, deferErrors: true });
      results.push({ messageId: row.id, resumed: result.resumed === true, reason: result.reason, status: result.status,
        ...(result.warnings ? { warnings: result.warnings } : {}) });
    }
    return { inspected: pending.length, results,
      ...(results.length < pending.length ? {budgetExceeded:true} : {}),
      requiresAttention: results.some(result => result.status?.requiresAttention === true) };
  }

  /** Current registered app versions against the verified baseline. Read-only;
   * starts no app and sends no message. */
  async function appVersions({ fresh = true } = {}) {
    const settings = await config();
    const baseline = await loadVerifiedAppVersions(root);
    const apps = Object.fromEntries(await Promise.all(AGENTS.map(async agent => {
      if (!settings.agents?.[agent]) return [agent, { agent, state: 'unregistered', current: null, verified: null }];
      const reading = await readAppVersion(agent, settings.agents[agent], settings, { fresh })
        ?? normalizeAppVersionReading(agent, { reason: 'version-check-disabled' });
      return [agent, compareAppVersion(reading, baseline.apps[agent])];
    })));
    const pending = AGENTS.filter(agent => !['verified', 'unregistered'].includes(apps[agent].state));
    return { checkedAt: new Date().toISOString(),
      baseline: { source: baseline.source, ...(baseline.updatedAt ? { updatedAt: baseline.updatedAt } : {}) },
      apps, allVerified: pending.length === 0, requiresAttention: pending.length > 0,
      ...(pending.length ? { pending, nextAction: APP_REVERIFY_ACTION } : {}) };
  }

  /** Evidence for the current versions comes only from deliveries whose attempt
   * recorded that exact recipient version. `record` stores verified apps once. */
  async function verifyAppVersions({ record = false } = {}) {
    const report = await appVersions();
    const { messages } = await status({ includeBodies: false });
    const current = Object.fromEntries(AGENTS.map(agent => [agent, report.apps[agent].current ?? null]));
    const registered = AGENTS.filter(agent => report.apps[agent].state !== 'unregistered');
    const evidence = evaluateAppVersionEvidence(messages, current, registered);
    const verifiable = AGENTS.filter(agent => evidence[agent].passed && report.apps[agent].state !== 'verified');
    let recorded = [], baseline;
    if (record && verifiable.length) {
      baseline = await recordVerifiedAppVersions(root, verifiable.map(agent => ({ agent, version: current[agent],
        source: report.apps[agent].source, messageIds: evidence[agent].routes.flatMap(route => route.messageIds.slice(-1)) })));
      recorded = verifiable;
    }
    const apps = Object.fromEntries(AGENTS.map(agent => [agent, { ...(recorded.includes(agent)
      ? compareAppVersion(normalizeAppVersionReading(agent, { version: current[agent], source: report.apps[agent].source }),
        baseline.apps[agent]) : report.apps[agent]), inboundRoutes: evidence[agent].routes }]));
    const pending = AGENTS.filter(agent => !['verified', 'unregistered'].includes(apps[agent].state));
    return { checkedAt: report.checkedAt,
      baseline: baseline ? { source: baseline.source, updatedAt: baseline.updatedAt } : report.baseline,
      apps, verifiable, recorded, allVerified: pending.length === 0,
      ...(pending.length ? { pending, nextAction: APP_REVERIFY_ACTION } : {}) };
  }

  /** Apps registered in this state root, in protocol order. */
  async function registeredAgents() {
    await init();
    let settings;
    try { settings = await config(); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    return AGENTS.filter(agent => settings.agents?.[agent]);
  }

  /** Active write reservations, derived from unfinished delegations. Read-only. */
  async function reservations() {
    await init();
    const settings = await config();
    return { checkedAt: new Date().toISOString(), ttlHours: reservationTtlMs(settings) / 3600000,
      reservations: await currentReservations(settings) };
  }

  /** Explicitly end a reservation (for example an abandoned task). Idempotent. */
  async function releaseScope(id) {
    const message = await get(id);
    if (!delegationScope(message)) throw new Error('Only a delegated task with a write scope has a reservation');
    return receipt({ messageId: id, agent: message.from, state: 'scope-released' }, id + '.scope-released');
  }

  /** On-demand comparison with the task baseline; records nothing. */
  async function scopeCheck(id) {
    const message = await get(id), scope = delegationScope(message);
    if (!scope) throw new Error('Only a delegated task has a scope baseline');
    const baseline = await readScopeBaseline(id);
    if (!baseline) return { messageId: id, available: false, reason: 'baseline-missing' };
    const settings = await config();
    const check = await checkScope({ scope, baseline, messages: await listMessages(), exclude: [state], ...scopeGit(settings) });
    return { ...check, onDemand: true, note: scopeCheckNote(check) };
  }

  return { root, send, resume, inbox, receive, reply, status, check, read, discover, diagnose, get, receipts,
    claim: mailbox.claim, supersede: mailbox.supersede, flush, appVersions, verifyAppVersions,
    reservations, releaseScope, scopeCheck, registeredAgents };
}
