import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { observeAntigravityTrajectory } from '../src/adapters/antigravity.mjs';
import { diagnosticObservation, summarizeDelivery } from '../src/delivery.mjs';

const fixture = JSON.parse(await readFile(new URL('./fixtures/gemini-stream-fixture.json', import.meta.url), 'utf8'));
const target = { conversationId: '33333333-3333-4333-8333-333333333333' };
const message = { id: '44444444-4444-4444-8444-444444444444', from: 'codex', kind: 'task' };
const errorBase = '55555555-5555-4555-8555-555555555555';
const laterExec = fixture.laterInput.executionId;
const time = '2026-10-28T02:06:28.536286100Z';

function sample() {
  const steps = Array.from({ length: fixture.totalSteps }, (_, index) => ({
    type: 'CORTEX_STEP_TYPE_GENERIC', status: 'CORTEX_STEP_STATUS_DONE',
    metadata: { sourceTrajectoryStepInfo: { stepIndex: index }, executionId: laterExec },
    generic: { payload: 'PRIVATE TOOL ARGUMENTS' },
  }));
  steps[fixture.originalInput.stepIndex] = { type: 'CORTEX_STEP_TYPE_USER_INPUT', metadata: {
    executionId: fixture.originalInput.executionId }, userInput: { userResponse:
      `[agent-bridge v1 | codex → gemini | task]\nMessage ID: ${message.id}\nPRIVATE REQUEST` } };
  steps[fixture.originalError.stepIndex] = { type: 'CORTEX_STEP_TYPE_ERROR_MESSAGE', errorMessage: { error: {
    userErrorMessage: 'plan model not specified', errorId: errorBase + '-5' } } };
  steps[fixture.laterInput.stepIndex] = { type: 'CORTEX_STEP_TYPE_SYSTEM_MESSAGE', status: 'CORTEX_STEP_STATUS_DONE',
    metadata: { executionId: laterExec }, systemMessage: { agentMessage: { content: 'PRIVATE LATER INPUT' } } };
  for (const error of fixture.laterErrors) steps[error.stepIndex] = { type: 'CORTEX_STEP_TYPE_ERROR_MESSAGE',
    status: 'CORTEX_STEP_STATUS_DONE', metadata: { executionId: laterExec, createdAt: time },
    errorMessage: { error: { userErrorMessage: 'The stream was interrupted. Please continue the task you were working on.',
      fullError: 'PRIVATE ERROR PAYLOAD', modelErrorMessage: 'PRIVATE MODEL ERROR', errorId: errorBase + '-' + error.stepIndex } } };
  steps[fixture.lastStep.stepIndex] = { ...fixture.lastStep, metadata: { executionId: laterExec,
    createdAt: '2026-10-28T02:06:33.956933900Z' }, plannerResponse: { thinking: 'PRIVATE THINKING', response: 'PRIVATE RESPONSE' } };
  return { status: fixture.conversationStatus, numTotalSteps: fixture.totalSteps, trajectory: { steps } };
}

test('later stream interruption is visible without replacing the original model failure', () => {
  const result = observeAntigravityTrajectory(target, message, sample());
  assert.equal(result.state, fixture.expectedOriginalState);
  assert.equal(result.executionState, 'failed');
  assert.equal(result.reasonCode, 'plan-model-not-specified');
  assert.deepEqual(result.evidence, { source: 'GetCascadeTrajectory', historyComplete: true, totalSteps: 167,
    inputStepIndex: 4, executionId: fixture.originalInput.executionId, errorStepIndex: 5, errorId: errorBase + '-5' });
  const activity = result.laterActivity;
  assert.equal(activity.relationship, 'later-input-unattributed');
  assert.equal(activity.latestInput.executionId, laterExec);
  assert.equal(activity.latestInput.stepIndex, 6);
  assert.equal(activity.latestError.reasonCode, 'stream-interrupted');
  assert.equal(activity.latestError.kind, 'executor-error');
  assert.equal(activity.latestError.stepIndex, 165);
  assert.equal(activity.latestError.createdAt, time);
  assert.equal(activity.latestError.afterLatestInput, true);
  assert.equal(activity.latestError.executionMatchesLatestInput, true);
  assert.equal(activity.latestStep.status, 'CORTEX_STEP_STATUS_GENERATING');
  assert.equal(activity.completion, 'unverified');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|Please continue|stream was interrupted/);
  const safe = diagnosticObservation({ ...result, rawPayload: 'PRIVATE' });
  assert.deepEqual(safe.laterActivity, activity);
  assert.equal(summarizeDelivery([{ state: safe.state, observation: safe }]).requiresAttention, true);
});

test('DONE metadata, completion timestamp and global IDLE never prove later task completion', () => {
  const value = sample();
  value.status = 'CASCADE_RUN_STATUS_IDLE';
  const step = value.trajectory.steps.at(-1);
  step.status = 'CORTEX_STEP_STATUS_DONE';
  step.metadata.completedAt = '2026-10-28T02:10:00Z';
  const result = observeAntigravityTrajectory(target, message, value);
  assert.equal(result.state, 'execution-failed');
  assert.equal(result.laterActivity.latestStep.status, 'CORTEX_STEP_STATUS_DONE');
  assert.equal(result.laterActivity.completion, 'unverified');
  assert.equal(result.laterActivity.latestError.reasonCode, 'stream-interrupted');
  assert.equal(result.laterActivity.latestStep.completedAt, undefined);
});

test('an additional input distinguishes an older later error from the newest execution', () => {
  const value = sample(), nextExec = '66666666-6666-4666-8666-666666666666';
  value.trajectory.steps.push({ type: 'CORTEX_STEP_TYPE_USER_INPUT', metadata: { executionId: nextExec },
    userInput: { userResponse: 'PRIVATE UNRELATED REQUEST' } });
  value.trajectory.steps.push({ type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', status: 'CORTEX_STEP_STATUS_GENERATING',
    metadata: { executionId: nextExec }, plannerResponse: { response: 'PRIVATE' } });
  value.numTotalSteps = value.trajectory.steps.length;
  const result = observeAntigravityTrajectory(target, message, value);
  assert.equal(result.reasonCode, 'plan-model-not-specified');
  assert.equal(result.laterActivity.latestInput.stepIndex, 167);
  assert.equal(result.laterActivity.latestInput.executionId, nextExec);
  assert.equal(result.laterActivity.latestError.afterLatestInput, false);
  assert.equal(result.laterActivity.latestError.executionMatchesLatestInput, false);
  assert.equal(result.laterActivity.completion, 'unverified');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
});

test('partial history marks later observations incomplete and absent matching input has no later attribution', () => {
  const value = sample();
  value.numTotalSteps = 200;
  const result = observeAntigravityTrajectory(target, message, value);
  assert.equal(result.laterActivity.historyComplete, false);
  assert.equal(result.laterActivity.completion, 'unverified');
  value.trajectory.steps[4].userInput.userResponse = 'PRIVATE UNRELATED';
  const unrelated = observeAntigravityTrajectory(target, message, value);
  assert.equal(unrelated.state, 'delivery-unconfirmed');
  assert.equal(unrelated.laterActivity, undefined);
});

test('current request stream failures have their own code and no invented later activity', () => {
  const value = sample();
  value.trajectory.steps = value.trajectory.steps.slice(0, 6);
  value.numTotalSteps = 6;
  value.trajectory.steps[5].errorMessage.error.userErrorMessage =
    'The stream was interrupted. Please continue the task you were working on.';
  const result = observeAntigravityTrajectory(target, message, value);
  assert.equal(result.state, 'execution-failed');
  assert.equal(result.reasonCode, 'stream-interrupted');
  assert.equal(result.laterActivity, undefined);
});

test('later metadata uses bounded code/ID/time fields and never copies arbitrary values', () => {
  const value = sample();
  const error = value.trajectory.steps[165], last = value.trajectory.steps[166];
  error.metadata.executionId = 'PRIVATE EXECUTION';
  error.metadata.createdAt = 'PRIVATE TIME';
  error.errorMessage.error.errorId = 'PRIVATE ERROR ID';
  error.errorMessage.error.userErrorMessage = 'PRIVATE UNRECOGNIZED ERROR';
  last.type = 'PRIVATE TYPE'; last.status = 'PRIVATE STATUS';
  last.metadata.sourceTrajectoryStepInfo = { stepIndex: 'PRIVATE INDEX' };
  const activity = observeAntigravityTrajectory(target, message, value).laterActivity;
  assert.equal(activity.latestError.reasonCode, 'executor-error');
  assert.equal(activity.latestError.executionId, undefined);
  assert.equal(activity.latestError.createdAt, undefined);
  assert.equal(activity.latestError.errorId, undefined);
  assert.equal(activity.latestError.executionMatchesLatestInput, null);
  assert.equal(activity.latestStep.stepIndex, 166);
  assert.equal(activity.latestStep.type, undefined);
  assert.equal(activity.latestStep.status, undefined);
  assert.doesNotMatch(JSON.stringify(activity), /PRIVATE/);
});
