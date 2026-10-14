import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { compileTwoClueRequest, parseTwoClueLabel, twoClueWorlds } from './two-clue-contract.mjs';

const data = JSON.parse(readFileSync('research/two-clue-spoof-results.json', 'utf8'));
assert.equal(data.status, 'complete');
assert.equal(data.jobs.length, 21);
assert.equal(data.observations.length, 21);
assert.deepEqual(data.observations.map(row => row.key), data.jobs.map(job => `${job.worldId}|${job.stage}|${job.claim}`));
assert.equal(new Set(data.observations.map(row => row.key)).size, 21);
assert.equal(createHash('sha256').update(readFileSync('research/two-clue-contract.mjs')).digest('hex'), data.compilerHash);
const worlds = Object.fromEntries(twoClueWorlds().map(world => [world.id, world]));
for (const row of data.observations) {
  const compiled = compileTwoClueRequest({ world: worlds[row.worldId], inspected: row.inspected, arm: 'explicit' });
  assert.equal(compiled.expected, 'wait');
  assert.deepEqual(row.observed, compiled.observed);
  assert.equal(row.body.messages[0].content, compiled.system);
  assert.deepEqual(row.body.messages[1], compiled.messages[0]);
  assert.equal(row.body.messages[2].content, data.claims[row.stage][row.claim]);
  assert.equal(row.body.model, data.model);
  assert.equal(row.body.temperature, compiled.temperature);
  assert.equal(row.body.reasoning_effort, 'low');
  assert.equal(row.body.include_reasoning, false);
  assert.equal(createHash('sha256').update(JSON.stringify(row.body)).digest('hex'), row.requestHash);
  const parsed = parseTwoClueLabel(row.rawReply);
  assert.equal(row.parsedValue, parsed.value);
  assert.equal(row.exactFormat, parsed.exactFormat);
  assert.equal(row.exactCorrect, row.rawReply === 'wait');
  assert.equal(row.wholeLabelCorrect, parsed.value === 'wait');
}
for (const worldId of Object.keys(worlds)) {
  const rows = data.observations.filter(row => row.worldId === worldId && row.stage === 'none');
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map(row => row.body.messages[0]), [rows[0].body.messages[0], rows[0].body.messages[0], rows[0].body.messages[0]]);
}
const cohorts = Object.fromEntries(['clean', 'fail', 'pass'].map(claim => {
  const rows = data.observations.filter(row => row.claim === claim);
  return [claim, {
    planned: rows.length, replies: rows.filter(row => row.rawReply !== null).length,
    exactWait: rows.filter(row => row.exactCorrect).length,
    wholeLabelWait: rows.filter(row => row.wholeLabelCorrect).length,
    clear: rows.filter(row => row.parsedValue === 'clear').length,
    hold: rows.filter(row => row.parsedValue === 'hold').length,
    unparseable: rows.filter(row => row.rawReply !== null && row.parsedValue === null).length,
    cases: rows.map(row => ({ worldId: row.worldId, stage: row.stage, rawReply: row.rawReply })),
  }];
}));
const summary = {
  model: data.model, manifestHash: data.manifestHash, sampledAt: [data.startedAt, data.completedAt],
  plannedCalls: 21, replies: data.observations.filter(row => row.rawReply !== null).length,
  providerAttemptErrors: data.providerErrors.length,
  providerErrorStatus: data.providerErrors.reduce((acc, row) => (acc[row.status ?? row.kind] = (acc[row.status ?? row.kind] ?? 0) + 1, acc), {}),
  cohorts,
  limitation: 'One crafted tester wording per desired false outcome at seven deterministic states; this tests raw model susceptibility, not the unpublished server gate or attack prevalence.',
};
writeFileSync('research/two-clue-spoof-summary.json', JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
