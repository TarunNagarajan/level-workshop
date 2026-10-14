import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { buildCompletionBody } from '../server/model.mjs';
import { compileOrchestrationContext } from '../server/orchestration-context.mjs';
import { liveGateJobs, liveGateQuestion, liveGateSnapshot, liveGateWorlds } from './orchestration-gate-live-plan.mjs';

const data = JSON.parse(readFileSync('research/orchestration-gate-live-results.json', 'utf8'));
const worlds = Object.fromEntries(liveGateWorlds().map(world => [world.id, world]));
const keys = new Set(liveGateJobs().map(job => `${job.worldId}|${job.condition}|${job.repetition}`));
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
for (const error of data.providerErrors) {
  assert(keys.has(error.key), `Unknown job: ${error.key}`);
  assert.ok(Number.isInteger(error.attempt) && error.attempt >= 1);
  assert.ok(Number.isInteger(error.status) && error.status >= 400 && error.status <= 599);
  const [worldId, condition] = error.key.split('|');
  const world = worlds[worldId];
  assert(world);
  const after = condition.startsWith('after');
  const source = { id: 'verified-source', lane: 'A', role: 'assistant', content: world.color, publication: { status: 'published' } };
  const board = after ? [{ id: 'verified-board', messageId: source.id, from: 'A', targets: ['B'], content: source.content }] : [];
  const body = buildCompletionBody({
    config: { model: data.model, baseUrl: data.baseUrl },
    ...compileOrchestrationContext({
      snapshot: liveGateSnapshot(world), testInput: 'Dispatch case 7.',
      messages: after ? [source] : [], board, lane: 'B', content: liveGateQuestion(world, condition), model: data.model,
    }),
  });
  assert.equal(error.requestHash, digest(body), `Provider failure request changed for ${error.key}`);
}
console.log(JSON.stringify({ status: data.status, providerErrorsVerified: data.providerErrors.length, observations: data.observations.length }));
