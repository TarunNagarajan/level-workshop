import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCompletionBody } from '../server/model.mjs';
import { compileOrchestrationContext } from '../server/orchestration-context.mjs';
import { auditRecipientRequestPair } from './recipient-request-audit.mjs';
import { liveGateConditions, liveGateJobs, liveGateQuestion, liveGateSnapshot, liveGateWorlds } from './orchestration-gate-live-plan.mjs';

const provider = { model: 'openai/gpt-oss-20b', baseUrl: 'https://api.groq.com/openai/v1' };
const body = (world, condition, after) => {
  const snapshot = liveGateSnapshot(world);
  const source = { id: `source-${world.id}`, lane: 'A', role: 'assistant', content: world.color, publication: { status: 'published' } };
  return buildCompletionBody({ config: provider, ...compileOrchestrationContext({ snapshot, testInput: 'Dispatch case 7.', messages: [source], board: after ? [{ id: `share-${world.id}`, messageId: source.id, from: 'A', targets: ['B'], content: source.content }] : [], lane: 'B', content: liveGateQuestion(world, condition), model: provider.model }) });
};

test('locked jobs cover four worlds, four conditions, two repeats without duplication', () => {
  const jobs = liveGateJobs();
  assert.equal(jobs.length, 32);
  assert.equal(new Set(jobs.map(job => `${job.worldId}|${job.condition}|${job.repetition}`)).size, 32);
  assert.deepEqual(new Set(jobs.map(job => job.condition)), new Set(liveGateConditions));
});

test('opposite-color twins have identical full pre-share provider bodies and distinct post-share bodies', () => {
  const worlds = liveGateWorlds();
  for (const flip of [false, true]) {
    const amber = worlds.find(world => world.flip === flip && world.color === 'amber');
    const cobalt = worlds.find(world => world.flip === flip && world.color === 'cobalt');
    for (const condition of ['before-clean', 'before-claim']) assert.deepEqual(body(amber, condition, false), body(cobalt, condition, false));
    assert.notDeepEqual(body(amber, 'after-clean', true), body(cobalt, 'after-clean', true));
    const authored = world => {
      const source = { id: `source-${world.id}`, lane: 'A', role: 'assistant', content: world.color, publication: { status: 'published' } };
      return { snapshot: liveGateSnapshot(world), testInput: 'Dispatch case 7.', expectedOutcome: world.route, messages: [source], boardBefore: [], boardAfter: [{ id: `share-${world.id}`, messageId: source.id, from: 'A', targets: ['B'], content: source.content }] };
    };
    assert.equal(auditRecipientRequestPair({ worlds: [authored(amber), authored(cobalt)], sourceLane: 'A', lane: 'B', content: liveGateQuestion(amber, 'before-clean'), provider }).status, 'passes-request-preflight');
  }
});
