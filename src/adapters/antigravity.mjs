import { powershell, execFileAsync } from '../runtime.mjs';
function discoveryError(code, message) {
  return Object.assign(new Error(message), { code,
    delivery: { submitted: false, phase: 'preflight', retryable: false } });
}
export async function discoverAntigravity({ timeoutMs = 15000 } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new Error('Invalid Antigravity discovery timeout');
  const deadline=Date.now()+timeoutMs;
  const raw=await powershell("$p=Get-CimInstance Win32_Process | Where-Object {$_.Name -eq 'language_server.exe' -and $_.ExecutablePath -like '*antigravity*'}; @($p | ForEach-Object { $q=$_; [pscustomobject]@{pid=$q.ProcessId;exe=$q.ExecutablePath;command=$q.CommandLine;ports=@(Get-NetTCPConnection -State Listen -OwningProcess $q.ProcessId -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort)}}) | ConvertTo-Json -Depth 4 -Compress",{timeoutMs:Math.min(timeoutMs,15000)});
  const rows=JSON.parse(raw||'[]');const processes=Array.isArray(rows)?rows:[rows];
  if(processes.length===0)throw discoveryError('ANTIGRAVITY_APP_NOT_RUNNING','Antigravity language server is not running');
  if(processes.length!==1)throw discoveryError('ANTIGRAVITY_ENDPOINT_AMBIGUOUS','Expected one Antigravity language server');
  const p=processes[0],token=p.command?.match(/--csrf_token(?:=|\s+)([^\s]+)/)?.[1];if(!token)throw discoveryError('ANTIGRAVITY_CREDENTIAL_UNAVAILABLE','Antigravity CSRF token unavailable');
  for(const port of p.ports){if(Date.now()>=deadline)break;try{const response=await fetch('http://127.0.0.1:'+port+'/',{signal:AbortSignal.timeout(Math.max(1,Math.min(2000,deadline-Date.now())))});if(response.ok&&(await response.text()).includes('window.__APP_CONFIG__'))return {address:'http://127.0.0.1:'+port,csrfToken:token,exe:p.exe,pid:p.pid};}catch{}}
  throw discoveryError('ANTIGRAVITY_ENDPOINT_UNAVAILABLE','Antigravity HTTP endpoint unavailable');
}
export async function antigravityRpc(method,body,{connection,timeoutMs=15000}={}) {
  if(!/^[A-Za-z]+$/.test(method))throw new Error('Invalid RPC method');
  const c=connection??await discoverAntigravity(),u=new URL(c.address);if(u.hostname!=='127.0.0.1'&&u.hostname!=='localhost')throw new Error('Local Antigravity endpoint required');
  const response=await fetch(u.origin+'/exa.language_server_pb.LanguageServerService/'+method,{method:'POST',headers:{'content-type':'application/json','x-codeium-csrf-token':c.csrfToken},body:JSON.stringify(body),signal:AbortSignal.timeout(timeoutMs)});
  const text=await response.text();if(!response.ok)throw Object.assign(new Error('Antigravity RPC '+method+' HTTP '+response.status), {httpStatus:response.status});
  try{return JSON.parse(text);}catch{throw new Error('Antigravity RPC '+method+' returned invalid JSON');}
}

const USER_INPUT = 'CORTEX_STEP_TYPE_USER_INPUT';
const AGENT_INPUT = 'CORTEX_STEP_TYPE_SYSTEM_MESSAGE';
const ERROR_STEP = 'CORTEX_STEP_TYPE_ERROR_MESSAGE';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function inputText(step) {
  if (step.type === USER_INPUT) return step.userInput?.userResponse
    || step.userInput?.items?.map(item => item.text).filter(Boolean).join('\n') || '';
  if (step.type === AGENT_INPUT && step.systemMessage?.agentMessage) {
    return step.systemMessage.agentMessage.content || '';
  }
  return null;
}

function stepIndex(step, fallback) {
  return step.metadata?.sourceTrajectoryStepInfo?.stepIndex ?? fallback;
}

function executorErrorCode(step) {
  const error = step.errorMessage?.error;
  const text = typeof error === 'string' ? error
    : [error?.userErrorMessage, error?.shortError, error?.fullError].filter(value => typeof value === 'string').join('\n');
  if (/plan model not specified|must specify a valid model/i.test(text)) return 'plan-model-not-specified';
  if (/The stream was interrupted\. Please continue the task you were working on\./i.test(text)) return 'stream-interrupted';
  return 'executor-error';
}

function activityStep(step, index) {
  const sourceIndex = stepIndex(step, index), createdAt = step.metadata?.createdAt ?? step.createdAt;
  return { stepIndex: Number.isSafeInteger(sourceIndex) && sourceIndex >= 0 ? sourceIndex : index,
    ...(/^CORTEX_STEP_TYPE_[A-Z_]{1,80}$/.test(step.type ?? '') ? { type: step.type } : {}),
    ...(/^CORTEX_STEP_STATUS_[A-Z_]{1,80}$/.test(step.status ?? '') ? { status: step.status } : {}),
    ...(UUID.test(step.metadata?.executionId ?? '') ? { executionId: step.metadata.executionId } : {}),
    ...(typeof createdAt === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(createdAt)
      && Number.isFinite(Date.parse(createdAt)) ? { createdAt } : {}) };
}

/** Later inputs are chronology, not proof of recovery/correlation with this request. */
function laterActivity(steps, start, complete) {
  if (start >= steps.length) return undefined;
  let latestInput = start, latestError;
  for (let index = start; index < steps.length; index++) {
    const step = steps[index];
    if (inputText(step) !== null) latestInput = index;
    if (step.type === ERROR_STEP) {
      const errorId = step.errorMessage?.error?.errorId;
      latestError = { ...activityStep(step, index), kind: 'executor-error', reasonCode: executorErrorCode(step),
        ...(/^[0-9a-f-]{36}-\d+$/i.test(errorId ?? '') ? { errorId } : {}),
        arrayIndex: index };
    }
  }
  const input = activityStep(steps[latestInput], latestInput);
  if (latestError) {
    latestError.afterLatestInput = latestError.arrayIndex > latestInput;
    delete latestError.arrayIndex;
    latestError.executionMatchesLatestInput = latestError.executionId && input.executionId
      ? latestError.executionId === input.executionId : null;
  }
  return { relationship: 'later-input-unattributed', historyComplete: complete,
    latestInput: input, ...(latestError ? { latestError } : {}),
    latestStep: activityStep(steps.at(-1), steps.length - 1), completion: 'unverified' };
}

function observation(target, fields) {
  return { transport: 'antigravity-trajectory', conversationId: target.conversationId,
    observedAt: new Date().toISOString(), ...fields };
}

function blocked(target, reasonCode, nextAction) {
  const result = observation(target, { state: 'send-blocked', executionState: 'not-started',
    transport: 'antigravity-agentapi', transportState: 'not-submitted', reasonCode, nextAction });
  return { state: 'send-blocked', transport: result.transport, observation: result };
}

/** Only explicit bridge headers identify a request. Mentions, tool output and thinking do not. */
export function observeAntigravityTrajectory(target, message, result) {
  const steps = result.trajectory?.steps ?? [];
  const complete = (result.numTotalSteps ?? steps.length) <= steps.length;
  const prefix = `[agent-bridge v1 | ${message.from} → gemini | ${message.kind}]\nMessage ID: ${message.id}\n`;
  let input = -1;
  for (let i = 0; i < steps.length; i++) {
    const text = inputText(steps[i]);
    if (typeof text === 'string' && text.replaceAll('\r\n', '\n').startsWith(prefix)) input = i;
  }
  const common = { conversationStatus: result.status, recipientObserved: input >= 0, evidence: { source: 'GetCascadeTrajectory',
    historyComplete: complete, totalSteps: result.numTotalSteps ?? steps.length } };
  if (input < 0) return observation(target, { ...common, state: 'delivery-unconfirmed',
    executionState: 'unknown', reasonCode: 'matching-input-not-observed',
    nextAction: 'Check the recipient or its completion event; do not resend automatically.' });
  common.transport = steps[input].type === USER_INPUT ? 'antigravity-rpc' : 'antigravity-agentapi';

  let end = steps.length;
  for (let i = input + 1; i < steps.length; i++) {
    if (inputText(steps[i]) !== null) { end = i; break; }
  }
  const activity = laterActivity(steps, end, complete);
  if (activity) common.laterActivity = activity;
  const executionId = steps[input].metadata?.executionId;
  const evidence = { ...common.evidence, inputStepIndex: stepIndex(steps[input], input),
    ...(UUID.test(executionId ?? '') ? { executionId } : {}) };
  for (let i = input + 1; i < end; i++) {
    const step = steps[i];
    if (step.type !== ERROR_STEP) continue;
    if (executionId && step.metadata?.executionId && step.metadata.executionId !== executionId) continue;
    const error = step.errorMessage?.error;
    const errorId = error?.errorId;
    return observation(target, { ...common, state: 'execution-failed', executionState: 'failed',
      reasonCode: executorErrorCode(step),
      evidence: { ...evidence, errorStepIndex: stepIndex(step, i),
        ...(/^[0-9a-f-]{36}-\d+$/i.test(errorId ?? '') ? { errorId } : {}) },
      nextAction: 'Inspect the existing conversation and recovery evidence before any resubmission.' });
  }
  const progressed = steps.slice(input + 1, end).some(step =>
    step.type !== ERROR_STEP && (step.type === 'CORTEX_STEP_TYPE_PLANNER_RESPONSE' || step.type === 'CORTEX_STEP_TYPE_GENERIC')
    && (!executionId || !step.metadata?.executionId || step.metadata.executionId === executionId));
  const running = complete && end === steps.length && progressed && result.status === 'CASCADE_RUN_STATUS_RUNNING';
  return observation(target, { ...common, state: running ? 'execution-running' : 'recipient-observed',
    executionState: running ? 'running' : 'unverified', evidence,
    reasonCode: running ? 'matching-execution-running' : 'input-observed-task-completion-unverified',
    nextAction: 'Wait for the existing task completion event; do not resend.' });
}

/** One read-only snapshot. A global RUNNING status never hides an earlier request's executor error. */
export async function inspectAntigravity(target, config, message, options = {}) {
  try {
    const rpc = options.rpc ?? antigravityRpc;
    const result = await rpc('GetCascadeTrajectory', {
      cascadeId: target.conversationId, disableRehydration: true
    }, options);
    return observeAntigravityTrajectory(target, message, result);
  } catch {
    return observation(target, { state: 'delivery-unconfirmed', executionState: 'unknown',
      reasonCode: 'trajectory-query-failed', nextAction: 'Inspect the existing conversation; do not resend automatically.' });
  }
}

function existingModel(trajectory) {
  const steps = trajectory.trajectory?.steps ?? [];
  for (let i = steps.length - 1; i >= 0; i--) {
    if (steps[i].type !== USER_INPUT) continue;
    const user = steps[i].userInput;
    const config = user?.userConfig ?? user?.lastUserConfig;
    if (!config) continue;
    const model = config.plannerConfig?.planModel;
    if ((typeof model === 'number' && model > 0)
      || (typeof model === 'string' && model !== '0' && model.length > 0 && !/UNSPECIFIED|UNKNOWN/i.test(model))) return model;
    return null;
  }
  return null;
}

/** Official agentapi reuses the conversation's executor configuration; never invent a model or plan. */
export async function sendAntigravity(target, prompt, config, message, options = {}) {
  if (!UUID.test(target.conversationId ?? '') || !UUID.test(message?.id ?? '')) {
    return blocked(target, 'invalid-conversation-or-message-id', 'Use the registered conversation and a bridge message UUID.');
  }
  let connection;
  try { connection = options.connection ?? await discoverAntigravity(); }
  catch (error) { error.delivery = { submitted: false, phase: 'preflight', retryable: false }; throw error; }
  if (!connection.exe) return blocked(target, 'agentapi-executable-unavailable', 'Open Antigravity and rediscover its language server.');
  // Windows CreateProcess has a 32,767 UTF-16-unit command-line limit. Reserve quoting overhead.
  // agentapi has no supported stdin/body-file option; never truncate or split a task into duplicate sends.
  const args = ['agentapi', 'send-message', target.conversationId, prompt];
  const commandUnits = [connection.exe, ...args].reduce((sum, value) => sum + value.length + (value.match(/["\\]/g)?.length ?? 0) + 3, 0);
  if (commandUnits > 30000 || prompt.includes('\0')) {
    return blocked(target, 'agentapi-content-too-large', 'Use a short bridge request referencing a shared task file. Nothing was sent.');
  }
  const rpc = options.rpc ?? antigravityRpc;
  let previous;
  try {
    previous = await rpc('GetCascadeTrajectory', { cascadeId: target.conversationId, disableRehydration: true }, { ...options, connection });
  } catch (error) {
    if ([401,403].includes(error?.httpStatus)) {
      throw discoveryError('ANTIGRAVITY_CREDENTIAL_UNAVAILABLE', 'Antigravity native authentication is unavailable');
    }
    throw discoveryError('ANTIGRAVITY_TARGET_UNAVAILABLE', 'Existing Antigravity conversation is not loaded');
  }
  // The exact cascade is the destination; a replacement or ambiguous response
  // must never provide the model/preflight for a different chat.
  if (previous.trajectory?.cascadeId !== target.conversationId) {
    return blocked(target, 'conversation-identity-mismatch', 'The native trajectory does not match the saved recipient. Nothing was sent.');
  }
  if (target.projectId && previous.trajectory?.metadata?.projectId !== target.projectId) {
    return blocked(target, 'conversation-project-mismatch', 'The native conversation project does not match the saved recipient. Nothing was sent.');
  }
  if (!existingModel(previous)) {
    return blocked(target, 'existing-model-unavailable', 'Select a valid model in the existing Antigravity conversation. Nothing was sent.');
  }
  const run = options.runAgentApi ?? execFileAsync;
  try {
    await run(connection.exe, args, { windowsHide: true, encoding: 'utf8', timeout: options.cliTimeoutMs ?? 15000,
      maxBuffer: 1024 * 1024, env: { ...process.env, ANTIGRAVITY_LS_ADDRESS: connection.address,
        ANTIGRAVITY_CSRF_TOKEN: connection.csrfToken } });
  } catch (error) {
    if (['ENOENT', 'E2BIG', 'EINVAL'].includes(error.code)) {
      return blocked(target, 'agentapi-not-started', 'Check the installed executable and request size. Nothing was sent.');
    }
    // CLI errors may include the original argv/body. Never return stdout, stderr or error.message.
    const observed = await inspectAntigravity(target, config, message, { ...options, connection });
    return { state: 'delivery-error', transport: 'antigravity-agentapi', observation: {
      ...observed, transportState: 'uncertain',
      ...(observed.state === 'delivery-unconfirmed' ? { reasonCode: 'agentapi-failed-or-timed-out' } : {})
    } };
  }
  const observed = await inspectAntigravity(target, config, message, { ...options, connection });
  return { state: 'native-accepted', transport: 'antigravity-agentapi', conversationId: target.conversationId,
    observation: { ...observed, transportState: 'native-accepted' } };
}
export function formatAntigravitySteps(steps) {
  const messages = [];
  for (const step of steps ?? []) {
    if (step.type === 'CORTEX_STEP_TYPE_USER_INPUT') {
      const text = step.userInput?.userResponse
        || step.userInput?.items?.map(item => item.text).filter(Boolean).join('\n') || '';
      if (text) messages.push({ type: 'user', text });
    } else if (step.type === 'CORTEX_STEP_TYPE_PLANNER_RESPONSE') {
      const text = step.plannerResponse?.modifiedResponse || step.plannerResponse?.response || '';
      if (text) messages.push({ type: 'assistant', text });
    }
  }
  return messages.slice(-8);
}
export async function readAntigravity(target, config, options) {
  const result = await antigravityRpc('GetCascadeTrajectory', {
    cascadeId: target.conversationId, disableRehydration: true
  }, options);
  return {
    conversationId: target.conversationId, status: result.status,
    numTotalSteps: result.numTotalSteps,
    messages: formatAntigravitySteps(result.trajectory?.steps)
  };
}
