import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { chainWorlds, parseChainLabel } from './chain-contract.mjs';
import { afterArms, beforeArms } from './chain-b-ablation-contract.mjs';

const data = JSON.parse(readFileSync('research/chain-b-ablation-results.json', 'utf8'));
const baseline = JSON.parse(readFileSync('research/chain-live-results.json', 'utf8'));
assert.equal(data.status, 'complete');
assert.equal(data.baselineManifest, baseline.manifestHash);
assert.equal(data.jobs.length, 64);
assert.equal(data.observations.length, 64);
const worlds = chainWorlds();
const sourceRows = new Map(baseline.observations.map(row => [row.key, row]));
const rows = new Map(data.observations.map(row => [row.key, row]));
assert.equal(rows.size, 64);
assert.deepEqual(data.observations.map(row => row.key), data.jobs.map(job => `${job.worldId}|${job.phase}|${job.arm}`));
const cohorts = {};
const examples = {};
for (const phase of ['before', 'after']) {
  for (const arm of phase === 'before' ? beforeArms : afterArms) {
    const cohort = worlds.map(world => {
      const row = rows.get(`${world.id}|${phase}|${arm}`);
      assert(row);
      assert.equal(row.expected, world.route);
      assert.deepEqual(parseChainLabel({ role: 'B', rawReply: row.rawReply }), { value: row.parsedValue, exactFormat: row.exactFormat });
      assert.equal(createHash('sha256').update(JSON.stringify(row.body)).digest('hex'), row.requestHash);
      assert.equal(row.body.messages[0].role, 'system');
      assert.equal(row.body.messages.at(-1).content, 'Perform your role.');
      if (phase === 'after') {
        const source = sourceRows.get(`${world.id}|A`);
        assert.equal(row.sourceKey, source.key);
        assert.equal(row.artifact.sourceEventId, source.key);
        assert.equal(row.artifact.payload.color, source.parsedValue);
        assert.equal(row.artifact.worldId, world.id);
        assert.equal(source.parsedValue, world.color);
      } else {
        assert.equal(row.sourceKey, null);
        assert.equal(row.artifact, null);
      }
      if (arm.endsWith('-system') && phase === 'after') assert.equal(row.body.messages.at(-2).role, 'system');
      if (arm.endsWith('-user') && phase === 'after') assert.equal(row.body.messages.at(-2).role, 'user');
      return row;
    });
    const key = `${phase}|${arm}`;
    cohorts[key] = {
      planned: 8,
      replies: cohort.filter(row => row.rawReply !== null).length,
      noResponse: cohort.filter(row => row.rawReply === null).length,
      exactWait: phase === 'before' ? cohort.filter(row => row.rawReply === 'Awaiting color.').length : undefined,
      prematureWholeLabel: phase === 'before' ? cohort.filter(row => row.parsedValue !== null).length : undefined,
      correctWholeLabel: phase === 'after' ? cohort.filter(row => row.parsedValue === row.expected).length : undefined,
      exactLowercase: phase === 'after' ? cohort.filter(row => row.exactFormat && row.factualCorrect).length : undefined,
      mixedWaitAndCorrectRoute: phase === 'after' ? cohort.filter(row => {
        const text = row.rawReply?.toLowerCase() ?? '';
        return text.includes('awaiting color') && text.includes(row.expected);
      }).length : undefined,
      unparseableReply: cohort.filter(row => row.rawReply !== null && row.parsedValue === null).length,
    };
    examples[key] = cohort.slice(0, 2).map(row => ({ worldId: row.worldId, rawReply: row.rawReply, expected: row.expected }));
  }
}
const summary = {
  model: data.model, manifestHash: data.manifestHash, sampledAt: [data.startedAt, data.completedAt],
  worlds: 8, plannedCalls: 64, replies: data.observations.filter(row => row.rawReply !== null).length,
  noResponses: data.observations.filter(row => row.rawReply === null).length,
  providerAttemptErrors: data.providerErrors.length,
  providerErrorStatus: data.providerErrors.reduce((acc, row) => (acc[row.status ?? row.kind] = (acc[row.status ?? row.kind] ?? 0) + 1, acc), {}),
  cohorts, examples,
  limitation: 'One call per authored world and arm; compiled-state is a contemporaneous reference, not a cell in the 2x2 instruction/channel factorial.',
};
writeFileSync('research/chain-b-ablation-summary.json', JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
