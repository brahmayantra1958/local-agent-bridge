import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCodexExecutionEvidence, collectCodexExecutionEvidence, unavailableExecutionEvidence } from '../src/execution-evidence.mjs';

const parent = '11111111-1111-4111-a111-111111111111';
const child = '22222222-2222-4222-a222-222222222222';
const unrelated = '33333333-3333-4333-a333-333333333333';
const line = value => JSON.stringify(value) + '\n';
const meta = (id, owner, timestamp = '2026-10-28T00:00:00Z') => ({ type: 'session_meta', timestamp, payload: { id, parent_thread_id: owner, agent_nickname: 'Fixture' } });
const context = (timestamp, model = 'gpt-6-astra', effort = 'xhigh') => ({ type: 'turn_context', timestamp, payload: { model, effort } });
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'bridge-evidence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('collector counts actual scoped children, ignores private messages, and deduplicates rollout copies', async t => {
  const root = await fixture(t);
  const childData = line(meta(child, parent)) + line(context('2026-10-28T01:00:00Z'))
    + line({ type: 'response_item', payload: { type: 'reasoning', text: 'PRIVATE_THINKING' } });
  await writeFile(join(root, 'rollout-parent.jsonl'), line(meta(parent)) + line(context('2026-10-28T00:00:00Z')));
  await writeFile(join(root, 'rollout-child.jsonl'), childData);
  await writeFile(join(root, 'rollout-child-copy.jsonl'), childData);
  await writeFile(join(root, 'rollout-unrelated.jsonl'), line(meta(unrelated, unrelated)) + line(context('2026-10-28T02:00:00Z', 'other-model')));
  const report = await collectCodexExecutionEvidence({ rootDirectory: root, parentThreadId: parent });
  assert.equal(report.startedSubagentCount, 1);
  assert.equal(report.parent.sessionId, parent);
  assert.equal(report.subagents[0].observedModel, 'gpt-6-astra');
  assert.equal(report.subagents[0].observedEffort, 'xhigh');
  assert.equal(report.subagents[0].source.sessionMetaLine, 1);
  assert.equal(report.subagents[0].source.turnContextLine, 2);
  assert.equal(JSON.stringify(report).includes('PRIVATE_THINKING'), false);
  assert.equal(JSON.stringify(report).includes('other-model'), false);
});

test('cutoff selects relevant model; incomplete final records cannot erase previous evidence', async t => {
  const root = await fixture(t), path = join(root, 'rollout-change.jsonl');
  await writeFile(path, line(meta(child, parent)) + line(context('2026-10-28T01:00:00Z'))
    + line(context('2026-10-28T02:00:00Z', 'gpt-other', 'low')) + '{"type":"turn_context","payload":');
  const before = await readCodexExecutionEvidence(path, { sessionId: child, at: '2026-10-28T01:30:00Z' });
  assert.equal(before.observedModel, 'gpt-6-astra');
  const latest = await readCodexExecutionEvidence(path, { sessionId: child });
  assert.equal(latest.observedModel, 'gpt-other');
  assert.equal(latest.observedEffort, 'low');
  assert.equal(await readCodexExecutionEvidence(path, { sessionId: unrelated }), null);
});

test('metadata without model evidence remains unavailable and never inherits the parent model', async t => {
  const root = await fixture(t);
  await writeFile(join(root, 'rollout-child.jsonl'), line(meta(child, parent)) + line(context('2026-10-28T01:00:00Z', undefined, null)));
  const report = await collectCodexExecutionEvidence({ parentThreadId: parent, rootDirectory: root });
  assert.equal(report.startedSubagentCount, 1);
  assert.equal(report.evidenceStatus, 'partial');
  assert.equal(report.subagents[0].evidenceStatus, 'unavailable');
  assert.equal(report.subagents[0].observedEffort, null);
  assert.equal(unavailableExecutionEvidence('claude', child).observedModel, null);
  assert.equal(unavailableExecutionEvidence('gemini', child).evidenceStatus, 'unavailable');
});

test('as-of counts exclude children created after the cutoff even with copied old contexts', async t => {
  const root = await fixture(t);
  await writeFile(join(root, 'rollout-before.jsonl'), line(meta(child, parent)) + line(context('2026-10-28T01:00:00Z')));
  await writeFile(join(root, 'rollout-after.jsonl'), line(meta(unrelated, parent, '2026-10-28T03:00:00Z'))
    + line(context('2026-10-28T01:00:00Z')));
  const report = await collectCodexExecutionEvidence({ rootDirectory: root, parentThreadId: parent, at: '2026-10-28T02:00:00Z' });
  assert.equal(report.startedSubagentCount, 1);
  assert.equal(report.subagents[0].sessionId, child);
  assert.equal(report.asOf, '2026-10-28T02:00:00Z');
  const current = await collectCodexExecutionEvidence({ rootDirectory: root, parentThreadId: parent });
  assert.equal(current.startedSubagentCount, 2);
});

test('a missing rollout is reported as unavailable without terminating collection', async t => {
  const root = await fixture(t), missing = join(root, 'rollout-missing.jsonl');
  const valid = join(root, 'rollout-valid.jsonl');
  await writeFile(valid, line(meta(child, parent)) + line(context('2026-10-28T01:00:00Z')));
  const report = await collectCodexExecutionEvidence({ parentThreadId: parent, files: [missing, valid] });
  assert.deepEqual(report.unavailableFiles, [{ path: missing, code: 'ENOENT' }]);
  assert.equal(report.startedSubagentCount, 1);
  assert.equal(report.subagents[0].sessionId, child);
});
