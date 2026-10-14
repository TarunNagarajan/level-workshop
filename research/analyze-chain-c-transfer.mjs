import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { chainWorlds, parseChainLabel } from './chain-contract.mjs';

const data = JSON.parse(readFileSync('research/chain-c-transfer-results.json', 'utf8'));
const benign = JSON.parse(readFileSync('research/chain-state-followup-results.json', 'utf8'));
assert.equal(data.status, 'complete');
assert.equal(data.benignManifest, benign.manifestHash);
assert.equal(data.jobs.length, 32);
assert.equal(data.observations.length, 32);
assert.deepEqual(data.observations.map(row => row.key), data.jobs.map(job => `${job.worldId}|${job.arm}|${job.phase}`));
const rows = new Map(data.observations.map(row => [row.key, row]));
assert.equal(rows.size, 32);
const sources = new Map(benign.observations.map(row => [row.key, row]));
const worlds = chainWorlds();
const cohorts = {}, examples = {};
for (const arm of ['original', 'generated']) for (const phase of ['before', 'after']) {
  const subset = worlds.map(world => {
    const row = rows.get(`${world.id}|${arm}|${phase}`);
    assert(row);
    assert.equal(row.expected, world.vehicle);
    assert.deepEqual(parseChainLabel({ role: 'C', rawReply: row.rawReply }), { value: row.parsedValue, exactFormat: row.exactFormat });
    assert.equal(createHash('sha256').update(JSON.stringify(row.body)).digest('hex'), row.requestHash);
    assert.equal(row.body.messages[0].role, 'system');
    assert.equal(row.body.messages.at(-1).content, 'Perform your role.');
    if (phase === 'after') {
      const source = sources.get(`${world.id}|B-after`);
      assert.equal(source.parsedValue, world.route);
      assert.equal(row.sourceKey, source.key);
      assert.equal(row.artifact.sourceEventId, source.key);
      assert.equal(row.artifact.payload.route, source.parsedValue);
      assert.equal(row.artifact.worldId, world.id);
      assert.equal(row.body.messages.at(-2).content, `Application handoff from B: ROUTE=${world.route}.`);
    } else {
      assert.equal(row.artifact, null);
      assert.equal(row.sourceKey, null);
    }
    return row;
  });
  const key = `${arm}|${phase}`;
  cohorts[key] = {
    planned: 8, replies: subset.filter(row => row.rawReply !== null).length,
    noResponse: subset.filter(row => row.rawReply === null).length,
    exactWait: phase === 'before' ? subset.filter(row => row.rawReply === 'Awaiting route.').length : undefined,
    prematureWholeLabel: phase === 'before' ? subset.filter(row => row.parsedValue !== null).length : undefined,
    correctWholeLabel: phase === 'after' ? subset.filter(row => row.parsedValue === row.expected).length : undefined,
    exactLowercase: phase === 'after' ? subset.filter(row => row.exactFormat && row.factualCorrect).length : undefined,
    mixedWaitAndCorrectVehicle: phase === 'after' ? subset.filter(row => {
      const text = row.rawReply?.toLowerCase() ?? '';
      return text.includes('awaiting route') && text.includes(row.expected);
    }).length : undefined,
    unparseableReply: subset.filter(row => row.rawReply !== null && row.parsedValue === null).length,
  };
  examples[key] = subset.slice(0, 2).map(row => ({ worldId: row.worldId, rawReply: row.rawReply, expected: row.expected }));
}
const summary = {
  model: data.model, manifestHash: data.manifestHash, sampledAt: [data.startedAt, data.completedAt],
  worlds: 8, plannedCalls: 32, replies: data.observations.filter(row => row.rawReply !== null).length,
  noResponses: data.observations.filter(row => row.rawReply === null).length,
  providerAttemptErrors: data.providerErrors.length,
  providerErrorStatus: data.providerErrors.reduce((acc, row) => (acc[row.status ?? row.kind] = (acc[row.status ?? row.kind] ?? 0) + 1, acc), {}),
  cohorts, examples,
  limitation: 'Same eight chain worlds and model as B studies; one call per condition/world. This tests role transfer, not a new task family.',
};
writeFileSync('research/chain-c-transfer-summary.json', JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
