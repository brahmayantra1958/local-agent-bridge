import test from 'node:test';
import assert from 'node:assert/strict';
import { loadRoutingProfile, selectRoute, selectRunner, validateRoutingProfile } from '../src/routing.mjs';

const sessionId = '11111111-1111-4111-a111-111111111111';
const evidence = { app: 'codex', sessionId, evidenceStatus: 'observed', observedModel: 'gpt-6-astra', observedEffort: 'xhigh',
  observedAt: '2026-10-28T01:00:00Z', source: { type: 'codex-rollout', path: '/fixture/rollout.jsonl' } };

test('library defaults apply user roles without inventing Claude or Gemini models', async () => {
  const profile = await loadRoutingProfile();
  assert.equal(profile.scope, 'library-default');
  for (const taskType of ['logic', 'analysis', 'backend']) assert.equal(selectRoute(profile, taskType).app, 'codex');
  for (const taskType of ['coordination', 'supervision']) assert.equal(selectRoute(profile, taskType).app, 'claude');
  for (const taskType of ['writing', 'revision']) {
    const route = selectRoute(profile, taskType);
    assert.equal(route.app, 'gemini');
    assert.equal(route.worker.modelId, null);
    assert.equal(selectRunner(route).evidenceStatus, 'not-verified');
  }
  assert.throws(() => selectRoute(profile, 'unknown'), /No configured route/);
});

test('fixed native route requires evidence for this session with this model and effort', async () => {
  const route = selectRoute(await loadRoutingProfile(), 'logic');
  assert.throws(() => selectRunner(route), /matching evidence/);
  assert.throws(() => selectRunner(route, { sessionId, evidence: { ...evidence, observedEffort: 'low' } }), /matching evidence/);
  assert.throws(() => selectRunner(route, { sessionId: 'different', evidence }), /matching evidence/);
  assert.throws(() => selectRunner(route, { sessionId, evidence: { ...evidence, evidenceStatus: 'unavailable' } }), /matching evidence/);
  assert.equal(selectRunner(route, { runner: 'native-subagent', sessionId, evidence }).evidenceStatus, 'observed');
  assert.equal(selectRunner(route, { runner: 'ccb-worker' }).evidenceStatus, 'not-verified');
});

test('imported policy restrictions are retained and duplicate routes fail', async () => {
  const profile = await loadRoutingProfile();
  profile.scope = 'imported-skill';
  profile.routes = [profile.routes[0]];
  profile.routes[0].allowedRunners = ['ccb-worker'];
  assert.throws(() => selectRunner(selectRoute(profile, 'logic'), { sessionId, evidence }), /not allowed/);
  assert.equal(selectRunner(selectRoute(profile, 'logic'), { runner: 'ccb-worker' }).runner, 'ccb-worker');
  profile.routes.push(structuredClone(profile.routes[0]));
  assert.throws(() => validateRoutingProfile(profile), /Duplicate/);
});
