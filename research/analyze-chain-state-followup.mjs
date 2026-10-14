import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { chainWorlds, parseChainLabel } from './chain-contract.mjs';

const data = JSON.parse(readFileSync('research/chain-state-followup-results.json', 'utf8'));
const baseline = JSON.parse(readFileSync('research/chain-live-results.json', 'utf8'));
assert.equal(data.status, 'complete');
assert.equal(baseline.status, 'complete');
assert.equal(data.baselineManifest, baseline.manifestHash);
assert.equal(data.jobs.length, 32);
assert.equal(data.observations.length, 32);
const rows = new Map(data.observations.map(row => [row.key, row]));
const sourceRows = new Map(baseline.observations.map(row => [row.key, row]));
assert.equal(rows.size, 32);
const worlds = chainWorlds();
const looseWait = (row, expected) => typeof row?.rawReply === 'string' && new RegExp(`^Awaiting ${expected}\\.?$`, 'i').test(row.rawReply.trim());
const stages = {};
for (const stage of ['B-before', 'C-before', 'B-after', 'C-after']) {
  const subset = data.observations.filter(row => row.stage === stage);
  assert.equal(subset.length, 8);
  const waitWord = stage === 'B-before' ? 'color' : stage === 'C-before' ? 'route' : null;
  stages[stage] = {
    planned: 8, called: subset.filter(row => !row.skipped).length,
    skipped: subset.filter(row => row.skipped).length,
    noResponse: subset.filter(row => !row.skipped && row.rawReply === null).length,
    parseable: subset.filter(row => row.parsedValue !== null).length,
    factuallyCorrect: subset.filter(row => row.factualCorrect).length,
    exactFormat: subset.filter(row => row.exactFormat).length,
    ...(waitWord ? {
      exactWait: subset.filter(row => row.rawReply === `Awaiting ${waitWord}.`).length,
      looseWait: subset.filter(row => looseWait(row, waitWord)).length,
      prematureLabel: subset.filter(row => row.parsedValue !== null).length,
    } : {}),
  };
}

const trials = [];
for (const world of worlds) {
  const get = stage => {
    const row = rows.get(`${world.id}|${stage}`);
    assert(row, `Missing ${world.id}/${stage}`);
    assert.equal(row.expected, stage.startsWith('B') ? world.route : world.vehicle);
    if (!row.skipped) assert.deepEqual(parseChainLabel({ role: row.role, rawReply: row.rawReply }), { value: row.parsedValue, exactFormat: row.exactFormat });
    return row;
  };
  const a = sourceRows.get(`${world.id}|A`);
  assert(a?.parsedValue);
  const bBefore = get('B-before'), cBefore = get('C-before'), bAfter = get('B-after'), cAfter = get('C-after');
  if (!bAfter.skipped) {
    assert.equal(bAfter.artifact.sourceEventId, a.key);
    assert.equal(bAfter.artifact.payload.color, a.parsedValue);
    assert.equal(bAfter.artifact.worldId, world.id);
  }
  if (!cAfter.skipped) {
    assert.equal(cAfter.artifact.sourceEventId, bAfter.key);
    assert.equal(cAfter.artifact.payload.route, bAfter.parsedValue);
    assert.equal(cAfter.artifact.worldId, world.id);
  }
  const aTrue = a.parsedValue === world.color, bTrue = bAfter.parsedValue === world.route, cTrue = cAfter.parsedValue === world.vehicle;
  const bConsistentWithA = bAfter.parsedValue !== null && bAfter.parsedValue === world.codebook[a.parsedValue];
  const cConsistentWithB = cAfter.parsedValue !== null && bAfter.parsedValue !== null && cAfter.parsedValue === world.fleet[bAfter.parsedValue];
  const semanticSuccess = looseWait(bBefore, 'color') && looseWait(cBefore, 'route') && aTrue && bTrue && cTrue;
  const strictDownstream = semanticSuccess && bBefore.rawReply === 'Awaiting color.' && cBefore.rawReply === 'Awaiting route.' && bAfter.exactFormat && cAfter.exactFormat;
  const strictFullChain = strictDownstream && a.exactFormat;
  const gate = {
    'B-before': 'missing-prerequisite', 'C-before': 'missing-prerequisite',
    'B-after': bAfter.skipped ? 'skipped' : !aTrue ? 'source-factual-error' : bAfter.parsedValue === null ? 'output-parse-failure' : bConsistentWithA ? 'open' : 'output-inconsistent',
    'C-after': cAfter.skipped ? 'skipped' : !aTrue || !bTrue ? 'source-factual-error' : cAfter.parsedValue === null ? 'output-parse-failure' : cConsistentWithB ? 'open' : 'output-inconsistent',
  };
  trials.push({ worldId: world.id, aTrue, bTrue, cTrue, bConsistentWithA, cConsistentWithB, semanticSuccess, strictDownstream, strictFullChain, gate, raw: { a: a.rawReply, b: bAfter.rawReply, c: cAfter.rawReply } });
}
const gateCounts = {};
for (const stage of ['B-after', 'C-after']) gateCounts[stage] = trials.reduce((acc, trial) => (acc[trial.gate[stage]] = (acc[trial.gate[stage]] ?? 0) + 1, acc), {});
const summary = {
  model: data.model, manifestHash: data.manifestHash, baselineManifest: data.baselineManifest,
  sampledAt: [data.startedAt, data.completedAt], worlds: 8, plannedStages: 32,
  providerCalls: data.observations.filter(row => !row.skipped).length,
  providerReplies: data.observations.filter(row => !row.skipped && row.rawReply !== null).length,
  providerNoResponse: data.observations.filter(row => !row.skipped && row.rawReply === null).length,
  providerAttemptErrors: data.providerErrors.length,
  providerErrorStatus: data.providerErrors.reduce((acc, row) => (acc[row.status ?? row.kind] = (acc[row.status ?? row.kind] ?? 0) + 1, acc), {}),
  stages, semanticCompleteChains: trials.filter(trial => trial.semanticSuccess).length,
  strictDownstreamChains: trials.filter(trial => trial.strictDownstream).length,
  strictFullChains: trials.filter(trial => trial.strictFullChain).length,
  gateCounts, trials,
  limitation: 'Offline policy analysis; state wording and representation changed together, and the saved A replies came from the earlier run.',
};
writeFileSync('research/chain-state-followup-summary.json', JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
