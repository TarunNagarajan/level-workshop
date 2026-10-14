import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { auditTwoClueContract, compileTwoClueRequest, parseTwoClueLabel, twoClueWorlds } from './two-clue-contract.mjs';

const data = JSON.parse(readFileSync('research/two-clue-results.json', 'utf8'));
assert.equal(data.status, 'complete');
assert.equal(data.model, 'openai/gpt-oss-20b');
assert.equal(data.jobs.length, 32);
assert.equal(data.observations.length, 32);
assert.deepEqual(data.observations.map(row => row.key), data.jobs.map(job => `${job.worldId}|${job.arm}|${job.stage}`));
assert.equal(new Set(data.observations.map(row => row.key)).size, 32);
assert.equal(createHash('sha256').update(readFileSync('research/two-clue-contract.mjs')).digest('hex'), data.compilerHash);
const worlds = twoClueWorlds();
auditTwoClueContract(worlds);
assert.deepEqual(data.worlds, worlds);
const byId = Object.fromEntries(worlds.map(world => [world.id, world]));
const groups = {};
for (const row of data.observations) {
  const world = byId[row.worldId];
  assert(world);
  const compiled = compileTwoClueRequest({ world, inspected: row.inspected, arm: row.arm });
  assert.deepEqual(row.observed, compiled.observed);
  assert.equal(row.expected, compiled.expected);
  assert.equal(row.worldAnswer, world.answer);
  assert.equal(row.body.model, data.model);
  assert.deepEqual(row.body.messages, [{ role: 'system', content: compiled.system }, ...compiled.messages]);
  assert.equal(row.body.temperature, compiled.temperature);
  assert.equal(row.body.reasoning_effort, 'low');
  assert.equal(row.body.include_reasoning, false);
  assert.equal(createHash('sha256').update(JSON.stringify(row.body)).digest('hex'), row.requestHash);
  const parsed = parseTwoClueLabel(row.rawReply);
  assert.equal(row.parsedValue, parsed.value);
  assert.equal(row.exactFormat, parsed.exactFormat);
  assert.equal(row.semanticCorrect, parsed.value === compiled.expected);
  assert.equal(row.exactCorrect, row.rawReply === compiled.expected);
  const kind = row.stage === 0 ? 'no-inspection' : row.stage === 3 ? 'both-inspected' : compiled.expected === 'hold' ? 'partial-decisive-failure' : 'partial-ambiguous';
  const key = `${row.arm}|${kind}`;
  (groups[key] ??= []).push(row);
}
const cohorts = Object.fromEntries(Object.entries(groups).map(([key, rows]) => [key, {
  planned: rows.length,
  replies: rows.filter(row => row.rawReply !== null).length,
  exactCorrect: rows.filter(row => row.exactCorrect).length,
  wholeLabelCorrect: rows.filter(row => row.semanticCorrect).length,
  unparseable: rows.filter(row => row.rawReply !== null && row.parsedValue === null).length,
  wrongWholeLabel: rows.filter(row => row.parsedValue !== null && !row.semanticCorrect).length,
  repliesByExpectedAndActual: rows.map(row => ({ worldId: row.worldId, expected: row.expected, rawReply: row.rawReply })),
}]));
const arms = Object.fromEntries(['vague', 'explicit'].map(arm => {
  const rows = data.observations.filter(row => row.arm === arm);
  return [arm, { planned: rows.length, replies: rows.filter(row => row.rawReply !== null).length, exactCorrect: rows.filter(row => row.exactCorrect).length, wholeLabelCorrect: rows.filter(row => row.semanticCorrect).length, unparseable: rows.filter(row => row.rawReply !== null && row.parsedValue === null).length }];
}));
const summary = {
  model: data.model, manifestHash: data.manifestHash, sampledAt: [data.startedAt, data.completedAt],
  worlds: worlds.length, plannedCalls: 32, replies: data.observations.filter(row => row.rawReply !== null).length,
  noResponses: data.observations.filter(row => row.rawReply === null).length,
  providerAttemptErrors: data.providerErrors.length,
  providerErrorStatus: data.providerErrors.reduce((acc, row) => (acc[row.status ?? row.kind] = (acc[row.status ?? row.kind] ?? 0) + 1, acc), {}),
  arms, cohorts,
  limitation: 'Four deterministic authored worlds; one stateless call per condition. Same model as the chain studies. This is descriptive second-family transfer, not a reliability estimate or a deployed integration.',
};
writeFileSync('research/two-clue-summary.json', JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
