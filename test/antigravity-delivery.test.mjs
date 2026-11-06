import test from 'node:test';
import assert from 'node:assert/strict';
import { observeAntigravityTrajectory, inspectAntigravity, sendAntigravity } from '../src/adapters/antigravity.mjs';

const target = { conversationId: 'cb1321e8-0ffd-4a34-a38e-6293568f96f6' };
const message = { id: '6d16e05c-3604-43ee-abec-d8f57d4dc055', from: 'codex', kind: 'task' };
const prompt = `[agent-bridge v1 | codex → gemini | task]\nMessage ID: ${message.id}\nCorrelation ID: ${message.id}\nPRIVATE CASE BODY`;
const execId = '17a1ef21-60e5-4f1a-811a-df0a4424db24';
const selectedConfig = { plannerConfig: { planModel: 'MODEL_PLACEHOLDER_M417', useAiCredits: false,
  customModelInfoOverride: { configured: 'unchanged' } }, executorConfig: { keep: true } };
const input = (text = prompt, extra = {}) => ({ type: 'CORTEX_STEP_TYPE_USER_INPUT',
  metadata: { executionId: execId }, userInput: { userResponse: text, userConfig: selectedConfig, ...extra } });
const agentInput = (text = prompt) => ({ type: 'CORTEX_STEP_TYPE_SYSTEM_MESSAGE',
  metadata: { executionId: execId }, systemMessage: { agentMessage: { content: text } } });
const failed = { type: 'CORTEX_STEP_TYPE_ERROR_MESSAGE', errorMessage: { error: {
  userErrorMessage: 'failed to construct executor: plan model not specified; you must specify a valid model',
  errorId: '39d6746e-790d-406f-a1f7-004295807c92-5',
  fullError: 'PRIVATE CASE BODY', modelErrorMessage: 'PRIVATE MODEL DETAIL'
} } };
const progress = { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', metadata: { executionId: execId },
  plannerResponse: { response: 'PRIVATE PUBLIC RESPONSE', thinking: 'PRIVATE THINKING' } };
const trajectory = (steps, status = 'CASCADE_RUN_STATUS_RUNNING') => ({ status, numTotalSteps: steps.length, trajectory: { cascadeId: target.conversationId, steps } });
const connection = { exe: 'C:\\Antigravity\\language_server.exe', address: 'http://127.0.0.1:45678', csrfToken: 'SECRET' };

test('executor failure remains tied to its original input even after another task resumes', () => {
  const result = observeAntigravityTrajectory(target, message, trajectory([
    input('earlier input'), input(), failed, agentInput(`Recovery of ${message.id}`), progress
  ]));
  assert.equal(result.state, 'execution-failed');
  assert.equal(result.recipientObserved, true);
  assert.equal(result.transport, 'antigravity-rpc');
  assert.equal(result.reasonCode, 'plan-model-not-specified');
  assert.equal(result.conversationStatus, 'CASCADE_RUN_STATUS_RUNNING');
  assert.equal(result.evidence.inputStepIndex, 1);
  assert.equal(result.evidence.errorStepIndex, 2);
  assert.equal(result.evidence.errorId, '39d6746e-790d-406f-a1f7-004295807c92-5');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|SECRET/);
});

test('official agent messages with the exact bridge header can prove execution', () => {
  const result = observeAntigravityTrajectory(target, message, trajectory([agentInput(), progress]));
  assert.equal(result.state, 'execution-running');
  assert.equal(result.transport, 'antigravity-agentapi');
  assert.equal(result.evidence.executionId, execId);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
});

test('mentions, assistant text, unrelated errors and global RUNNING cannot prove this request ran', () => {
  const result = observeAntigravityTrajectory(target, message, trajectory([
    input(`Discuss ${message.id}`), failed, { ...progress, plannerResponse: { response: prompt } }
  ]));
  assert.equal(result.state, 'delivery-unconfirmed');
  assert.equal(result.recipientObserved, false);
  const old = observeAntigravityTrajectory(target, message, trajectory([input(), input('other task'), failed]));
  assert.equal(old.state, 'recipient-observed');
  assert.equal(old.reasonCode, 'input-observed-task-completion-unverified');
});

test('incomplete trajectory and input alone do not imply started or completed', () => {
  const incomplete = { ...trajectory([input(), progress]), numTotalSteps: 50 };
  assert.equal(observeAntigravityTrajectory(target, message, incomplete).state, 'recipient-observed');
  assert.equal(observeAntigravityTrajectory(target, message, trajectory([input()])).state, 'recipient-observed');
  assert.equal(observeAntigravityTrajectory(target, message, trajectory([input(), progress], 'CASCADE_RUN_STATUS_IDLE')).state, 'recipient-observed');
});

test('inspection performs one read-only query and hides raw RPC errors', async () => {
  const calls = [];
  const result = await inspectAntigravity(target, {}, message, { rpc: async (method, body) => {
    calls.push({ method, body }); throw new Error('SECRET PRIVATE CASE BODY');
  } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'GetCascadeTrajectory');
  assert.equal(result.reasonCode, 'trajectory-query-failed');
  assert.doesNotMatch(JSON.stringify(result), /SECRET|PRIVATE/);
});

test('send uses supported agentapi without model/plan overrides, then separately observes failure', async () => {
  const calls = [];
  let query = 0;
  const before = trajectory([input('existing conversation', { userConfig: undefined, lastUserConfig: selectedConfig })]);
  const originalConfig = JSON.stringify(selectedConfig);
  const result = await sendAntigravity(target, prompt, {}, message, { connection,
    rpc: async (method, body, options) => {
      assert.equal(method, 'GetCascadeTrajectory');
      assert.equal(body.cascadeId, target.conversationId);
      assert.equal(options.connection, connection);
      query++;
      return query === 1 ? before : trajectory([input(), failed], 'CASCADE_RUN_STATUS_IDLE');
    },
    runAgentApi: async (exe, args, options) => {
      calls.push({ exe, args, options }); return { stdout: 'PRIVATE CASE BODY', stderr: '' };
    }
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ['agentapi', 'send-message', target.conversationId, prompt]);
  assert.equal(calls[0].options.env.ANTIGRAVITY_LS_ADDRESS, connection.address);
  assert.equal(calls[0].options.env.ANTIGRAVITY_CSRF_TOKEN, connection.csrfToken);
  assert.equal(calls[0].options.windowsHide, true);
  assert.equal(calls[0].options.timeout, 15000);
  assert.equal(query, 2);
  assert.equal(JSON.stringify(selectedConfig), originalConfig);
  assert.equal(result.state, 'native-accepted');
  assert.equal(result.observation.state, 'execution-failed');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|SECRET/);
});

test('missing or invalid existing model blocks before sending', async () => {
  for (const model of [undefined, 0, 'MODEL_UNSPECIFIED']) {
    let sent = 0;
    const result = await sendAntigravity(target, prompt, {}, message, { connection,
      rpc: async () => trajectory([input('existing', { userConfig: { plannerConfig: { planModel: model } } })]),
      runAgentApi: async () => { sent++; }
    });
    assert.equal(sent, 0);
    assert.equal(result.state, 'send-blocked');
    assert.equal(result.observation.reasonCode, 'existing-model-unavailable');
  }
});

test('configless historical inputs preserve the last valid selection without bypassing an explicit invalid selection', async () => {
  let sent = 0;
  const configless = input('raw RPC input', { userConfig: undefined });
  const options = { connection,
    rpc: async () => trajectory([input('selected model'), configless]),
    runAgentApi: async () => { sent++; return { stdout: '' }; }
  };
  const accepted = await sendAntigravity(target, prompt, {}, message, options);
  assert.equal(accepted.state, 'native-accepted');
  assert.equal(sent, 1);
  const blocked = await sendAntigravity(target, prompt, {}, message, {
    ...options, rpc: async () => trajectory([input('selected model'),
      input('explicit invalid model', { userConfig: { plannerConfig: { planModel: 'MODEL_UNSPECIFIED' } } })])
  });
  assert.equal(blocked.state, 'send-blocked');
  assert.equal(sent, 1);
});

test('oversize body is blocked before launch or RPC without truncation', async () => {
  let calls = 0;
  const result = await sendAntigravity(target, 'a'.repeat(31000), {}, message, { connection,
    rpc: async () => { calls++; }, runAgentApi: async () => { calls++; }
  });
  assert.equal(calls, 0);
  assert.equal(result.observation.reasonCode, 'agentapi-content-too-large');
});

test('CLI timeout never retries and never leaks command arguments or stderr', async () => {
  let sends = 0;
  let queries = 0;
  const result = await sendAntigravity(target, prompt, {}, message, { connection,
    rpc: async () => { queries++; return trajectory([input('another message')]); },
    runAgentApi: async () => { sends++; throw Object.assign(new Error('PRIVATE argv SECRET'), { killed: true, stderr: prompt }); }
  });
  assert.equal(sends, 1);
  assert.equal(queries, 2);
  assert.equal(result.state, 'delivery-error');
  assert.equal(result.observation.transportState, 'uncertain');
  assert.equal(result.observation.reasonCode, 'agentapi-failed-or-timed-out');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|SECRET/);
});

test('launch failure reports not submitted and performs no retry or post-send query', async () => {
  let queries = 0;
  const result = await sendAntigravity(target, prompt, {}, message, { connection,
    rpc: async () => { queries++; return trajectory([input('another message')]); },
    runAgentApi: async () => { throw Object.assign(new Error('SECRET argv'), { code: 'ENOENT' }); }
  });
  assert.equal(queries, 1);
  assert.equal(result.observation.transportState, 'not-submitted');
  assert.equal(result.observation.reasonCode, 'agentapi-not-started');
});

test('unloaded target is classified before sending so one-shot recovery can keep the original message', async () => {
  let sends=0;
  await assert.rejects(()=>sendAntigravity(target,prompt,{},message,{connection,
    rpc:async()=>{throw new Error('PRIVATE RPC');},runAgentApi:async()=>{sends++;}}),error=>{
    assert.equal(error.code,'ANTIGRAVITY_TARGET_UNAVAILABLE');
    assert.deepEqual(error.delivery,{submitted:false,phase:'preflight',retryable:false});
    assert.doesNotMatch(error.message,/PRIVATE/);return true;
  });
  assert.equal(sends,0);
});

test('different cascade cannot supply the model selection for the pinned destination', async () => {
  const result=await sendAntigravity(target,prompt,{},message,{connection,
    rpc:async()=>({trajectory:{cascadeId:'00000000-0000-4000-8000-000000000001',steps:[input()]}}),
    runAgentApi:async()=>assert.fail('must not submit to mismatched destination')});
  assert.equal(result.observation.reasonCode,'conversation-identity-mismatch');
  assert.equal(result.observation.transportState,'not-submitted');
});

test('missing cascade identity or changed project blocks before native submission', async () => {
  for (const previous of [{trajectory:{steps:[input()]}},
    {trajectory:{cascadeId:target.conversationId,metadata:{projectId:'different'},steps:[input()]}}]) {
    const result=await sendAntigravity({...target,projectId:'pinned'},prompt,{},message,{connection,
      rpc:async()=>previous,runAgentApi:async()=>assert.fail('must not submit')});
    assert.equal(result.state,'send-blocked');
    assert.equal(result.observation.transportState,'not-submitted');
  }
});

test('native authentication rejection remains separate from a recoverable unloaded target', async () => {
  await assert.rejects(()=>sendAntigravity(target,prompt,{},message,{connection,
    rpc:async()=>{throw Object.assign(new Error('private auth payload'),{httpStatus:403});},
    runAgentApi:async()=>assert.fail('no submission')}),error=>error.code==='ANTIGRAVITY_CREDENTIAL_UNAVAILABLE');
});
