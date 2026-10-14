import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { compileTwoClueRequest, parseTwoClueLabel, twoClueWorlds } from './two-clue-contract.mjs';

const data = JSON.parse(readFileSync('research/two-clue-repeat-results.json', 'utf8'));
const original = JSON.parse(readFileSync('research/two-clue-results.json', 'utf8'));
assert.equal(data.status, 'complete');
assert.equal(original.status, 'complete');
assert.equal(data.jobs.length, 64);
assert.equal(data.observations.length, 64);
assert.deepEqual(data.observations.map(row => row.key), data.jobs.map(job => `${job.repetition}|${job.worldId}|${job.arm}|${job.stage}`));
assert.equal(new Set(data.observations.map(row => row.key)).size, 64);
assert.equal(data.compilerHash, original.compilerHash);
assert.equal(createHash('sha256').update(readFileSync('research/two-clue-contract.mjs')).digest('hex'), data.compilerHash);
const byId = Object.fromEntries(twoClueWorlds().map(world => [world.id, world]));
const originals = new Map(original.observations.map(row => [row.key, row]));
const variants = new Map();
for (const row of data.observations) {
  const request = compileTwoClueRequest({ world: byId[row.worldId], inspected: row.inspected, arm: row.arm });
  const originalRow = originals.get(`${row.worldId}|${row.arm}|${row.stage}`);
  assert(originalRow);
  assert.deepEqual(row.observed, request.observed);
  assert.equal(row.expected, request.expected);
  assert.equal(row.worldAnswer, byId[row.worldId].answer);
  assert.deepEqual(row.body, originalRow.body);
  assert.equal(row.requestHash, originalRow.requestHash);
  assert.equal(createHash('sha256').update(JSON.stringify(row.body)).digest('hex'), row.requestHash);
  const parsed = parseTwoClueLabel(row.rawReply);
  assert.equal(row.parsedValue, parsed.value);
  assert.equal(row.exactFormat, parsed.exactFormat);
  assert.equal(row.semanticCorrect, parsed.value === request.expected);
  assert.equal(row.exactCorrect, row.rawReply === request.expected);
  const key = row.requestHash;
  (variants.get(key) ?? variants.set(key, new Set([originalRow.rawReply])).get(key)).add(row.rawReply);
}
const combined = [
  ...original.observations.map(row => ({ ...row, repetition: 0 })),
  ...data.observations,
];
function kind(row) {
  if (row.stage === 0) return 'no-inspection';
  if (row.stage === 3) return 'both-inspected';
  return row.expected === 'hold' ? 'partial-decisive-failure' : 'partial-ambiguous';
}
function tally(rows) {
  return { planned: rows.length, replies: rows.filter(row => row.rawReply !== null).length, exactCorrect: rows.filter(row => row.exactCorrect).length, wholeLabelCorrect: rows.filter(row => row.semanticCorrect).length, unparseable: rows.filter(row => row.rawReply !== null && row.parsedValue === null).length };
}
const arms = Object.fromEntries(['vague', 'explicit'].map(arm => [arm, {
  original: tally(original.observations.filter(row => row.arm === arm)),
  repetition1: tally(data.observations.filter(row => row.arm === arm && row.repetition === 1)),
  repetition2: tally(data.observations.filter(row => row.arm === arm && row.repetition === 2)),
  combined: tally(combined.filter(row => row.arm === arm)),
}]));
const evidenceStates = Object.fromEntries(['no-inspection', 'partial-ambiguous', 'partial-decisive-failure', 'both-inspected'].flatMap(state => ['vague', 'explicit'].map(arm => {
  const rows = combined.filter(row => row.arm === arm && kind(row) === state);
  return [`${arm}|${state}`, tally(rows)];
})));
const summary = {
  model: data.model, manifestHash: data.manifestHash, originalManifestHash: original.manifestHash,
  sampledAt: [data.startedAt, data.completedAt], newCalls: 64,
  replies: data.observations.filter(row => row.rawReply !== null).length,
  providerAttemptErrors: data.providerErrors.length,
  providerErrorStatus: data.providerErrors.reduce((acc, row) => (acc[row.status ?? row.kind] = (acc[row.status ?? row.kind] ?? 0) + 1, acc), {}),
  arms, evidenceStates,
  uniqueRequestBodies: variants.size,
  bodiesWithVariableReplies: [...variants.values()].filter(values => values.size > 1).length,
  variableReplies: [...variants.entries()].filter(([, values]) => values.size > 1).map(([requestHash, values]) => ({ requestHash, replies: [...values] })),
  limitation: 'Three calls per frozen condition, with 32 distinct conditions and temperature 0.3. Descriptive stability only; prompts and worlds were not resampled.',
};
writeFileSync('research/two-clue-repeat-summary.json', JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
