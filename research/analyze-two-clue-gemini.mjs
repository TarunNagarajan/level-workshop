import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { compileTwoClueRequest, parseTwoClueLabel, twoClueWorlds } from './two-clue-contract.mjs';

const data = JSON.parse(readFileSync('research/two-clue-gemini-results.json', 'utf8'));
assert.equal(data.status, 'complete');
assert.equal(data.model, 'gemini-3.5-flash-lite');
assert.equal(data.jobs.length, 32);
assert.equal(data.observations.length, 32);
assert.deepEqual(data.observations.map(row => row.key), data.jobs.map(job => `${job.worldId}|${job.arm}|${job.stage}`));
assert.equal(new Set(data.observations.map(row => row.key)).size, 32);
assert.equal(createHash('sha256').update(readFileSync('research/two-clue-contract.mjs')).digest('hex'), data.compilerHash);
const byId = Object.fromEntries(twoClueWorlds().map(world => [world.id, world]));
function kind(row) {
  if (row.stage === 0) return 'no-inspection';
  if (row.stage === 3) return 'both-inspected';
  return row.expected === 'hold' ? 'partial-decisive-failure' : 'partial-ambiguous';
}
function tally(rows) {
  return {
    planned: rows.length, replies: rows.filter(row => row.rawReply !== null).length,
    exactCorrect: rows.filter(row => row.exactCorrect).length,
    wholeLabelCorrect: rows.filter(row => row.semanticCorrect).length,
    unparseable: rows.filter(row => row.rawReply !== null && row.parsedValue === null).length,
    noResponse: rows.filter(row => row.rawReply === null).length,
  };
}
for (const row of data.observations) {
  const request = compileTwoClueRequest({ world: byId[row.worldId], inspected: row.inspected, arm: row.arm });
  const expectedBody = {
    systemInstruction: { parts: [{ text: request.system }] },
    contents: request.messages.map(message => ({ role: 'user', parts: [{ text: message.content }] })),
    generationConfig: { temperature: 1, maxOutputTokens: 1024 },
  };
  assert.deepEqual(row.body, expectedBody);
  assert.deepEqual(row.observed, request.observed);
  assert.equal(row.expected, request.expected);
  assert.equal(row.worldAnswer, byId[row.worldId].answer);
  assert.equal(createHash('sha256').update(JSON.stringify(row.body)).digest('hex'), row.requestHash);
  const parsed = parseTwoClueLabel(row.rawReply);
  assert.equal(row.parsedValue, parsed.value);
  assert.equal(row.exactFormat, parsed.exactFormat);
  assert.equal(row.semanticCorrect, parsed.value === request.expected);
  assert.equal(row.exactCorrect, row.rawReply === request.expected);
}
const arms = Object.fromEntries(['vague', 'explicit'].map(arm => [arm, tally(data.observations.filter(row => row.arm === arm))]));
const evidenceStates = Object.fromEntries(['no-inspection', 'partial-ambiguous', 'partial-decisive-failure', 'both-inspected'].flatMap(state => ['vague', 'explicit'].map(arm => {
  const rows = data.observations.filter(row => row.arm === arm && kind(row) === state);
  return [`${arm}|${state}`, { ...tally(rows), cases: rows.map(row => ({ worldId: row.worldId, expected: row.expected, rawReply: row.rawReply })) }];
})));
const summary = {
  model: data.model, manifestHash: data.manifestHash, sampledAt: [data.startedAt, data.completedAt],
  plannedCalls: 32, replies: data.observations.filter(row => row.rawReply !== null).length,
  providerAttemptErrors: data.providerErrors.length,
  providerErrorStatus: data.providerErrors.reduce((acc, row) => (acc[row.status ?? row.kind] = (acc[row.status ?? row.kind] ?? 0) + 1, acc), {}),
  arms, evidenceStates,
  limitation: 'Single call per condition, four frozen worlds; Gemini API, temperature, and sampling time differ from GPT-OSS. Descriptive prompt transfer, not a model ranking or reliability estimate.',
};
writeFileSync('research/two-clue-gemini-summary.json', JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
