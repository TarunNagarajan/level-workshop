import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { chainWorlds, parseChainLabel } from './chain-contract.mjs';

const data = JSON.parse(readFileSync('research/chain-live-results.json', 'utf8'));
assert.equal(data.status, 'complete');
assert.equal(data.jobs.length, 40);
assert.equal(data.observations.length, 40);
const rows = new Map(data.observations.map(row => [row.key, row]));
assert.equal(rows.size, 40);
const worlds = chainWorlds();
const looseWait = (row, expected) => typeof row?.rawReply === 'string' && new RegExp(`^Awaiting ${expected}\\.?$`, 'i').test(row.rawReply.trim());
const stageStats = {};
for (const stage of ['B-before', 'C-before', 'A', 'B-after', 'C-after']) {
  const stageRows = data.observations.filter(row => row.stage === stage);
  assert.equal(stageRows.length, 8);
  const waitWord = stage === 'B-before' ? 'color' : stage === 'C-before' ? 'route' : null;
  stageStats[stage] = {
    planned: 8, called: stageRows.filter(row => !row.skipped).length,
    skipped: stageRows.filter(row => row.skipped).length,
    noResponse: stageRows.filter(row => !row.skipped && row.rawReply === null).length,
    parseable: stageRows.filter(row => row.parsedValue !== null).length,
    factuallyCorrect: stageRows.filter(row => row.factualCorrect).length,
    exactFormat: stageRows.filter(row => row.exactFormat).length,
    ...(waitWord ? {
      exactWait: stageRows.filter(row => row.rawReply === `Awaiting ${waitWord}.`).length,
      looseWait: stageRows.filter(row => looseWait(row, waitWord)).length,
      prematureLabel: stageRows.filter(row => row.parsedValue !== null).length,
    } : {}),
  };
}

const trials = [];
for (const world of worlds) {
  const get = stage => {
    const row = rows.get(`${world.id}|${stage}`);
    assert(row, `Missing ${world.id}/${stage}`);
    const expected = stage === 'A' ? world.color : stage.startsWith('B') ? world.route : world.vehicle;
    assert.equal(row.expected, expected);
    if (!row.skipped) assert.deepEqual(parseChainLabel({ role: row.role, rawReply: row.rawReply }), { value: row.parsedValue, exactFormat: row.exactFormat });
    return row;
  };
  const bBefore = get('B-before'), cBefore = get('C-before'), a = get('A'), bAfter = get('B-after'), cAfter = get('C-after');
  for (const [row, source, kind, valueName] of [[bAfter, a, 'seal-color', 'color'], [cAfter, bAfter, 'decoded-route', 'route']]) {
    if (row.skipped) continue;
    assert.equal(row.artifact.kind, kind);
    assert.equal(row.artifact.sourceEventId, source.key);
    assert.equal(row.artifact.worldId, world.id);
    assert.equal(row.artifact.runId, world.runId);
    assert.equal(row.artifact.payload[valueName], source.parsedValue);
  }
  const sourceColorTrue = a.parsedValue === world.color;
  const routeTrue = bAfter.parsedValue === world.route;
  const vehicleTrue = cAfter.parsedValue === world.vehicle;
  const bConsistentWithA = bAfter.parsedValue !== null && a.parsedValue !== null && bAfter.parsedValue === world.codebook[a.parsedValue];
  const cConsistentWithB = cAfter.parsedValue !== null && bAfter.parsedValue !== null && cAfter.parsedValue === world.fleet[bAfter.parsedValue];
  const bWait = looseWait(bBefore, 'color'), cWait = looseWait(cBefore, 'route');
  const semanticSuccess = bWait && cWait && sourceColorTrue && routeTrue && vehicleTrue;
  const strictSuccess = bBefore.rawReply === 'Awaiting color.' && cBefore.rawReply === 'Awaiting route.' && a.exactFormat && bAfter.exactFormat && cAfter.exactFormat && semanticSuccess;
  const gate = {
    'B-before': 'missing-prerequisite', 'C-before': 'missing-prerequisite',
    A: a.parsedValue === null ? 'source-parse-failure' : sourceColorTrue ? 'open' : 'source-factual-error',
    'B-after': bAfter.skipped ? 'skipped' : !sourceColorTrue ? 'source-factual-error' : bAfter.parsedValue === null ? 'output-parse-failure' : bConsistentWithA ? 'open' : 'output-inconsistent',
    'C-after': cAfter.skipped ? 'skipped' : !sourceColorTrue || !routeTrue ? 'source-factual-error' : cAfter.parsedValue === null ? 'output-parse-failure' : cConsistentWithB ? 'open' : 'output-inconsistent',
  };
  trials.push({ worldId: world.id, bWait, cWait, sourceColorTrue, routeTrue, vehicleTrue, bConsistentWithA, cConsistentWithB, semanticSuccess, strictSuccess, gate, raw: { a: a.rawReply, b: bAfter.rawReply, c: cAfter.rawReply } });
}

const gateCounts = {};
for (const stage of ['A', 'B-after', 'C-after']) {
  gateCounts[stage] = trials.reduce((acc, trial) => (acc[trial.gate[stage]] = (acc[trial.gate[stage]] ?? 0) + 1, acc), {});
}
const summary = {
  model: data.model, manifestHash: data.manifestHash, sampledAt: [data.startedAt, data.completedAt],
  worlds: worlds.length, plannedStages: data.jobs.length,
  providerCalls: data.observations.filter(row => !row.skipped).length,
  providerReplies: data.observations.filter(row => !row.skipped && row.rawReply !== null).length,
  providerNoResponse: data.observations.filter(row => !row.skipped && row.rawReply === null).length,
  providerAttemptErrors: data.providerErrors.length,
  providerErrorStatus: data.providerErrors.reduce((acc, row) => (acc[row.status ?? row.kind] = (acc[row.status ?? row.kind] ?? 0) + 1, acc), {}),
  stages: stageStats,
  semanticCompleteChains: trials.filter(trial => trial.semanticSuccess).length,
  strictCompleteChains: trials.filter(trial => trial.strictSuccess).length,
  gateCounts, trials,
  limitation: 'Offline policy analysis of JSON source records and process-local signatures, not a deployed event-ledger gate.',
};
writeFileSync('research/chain-live-summary.json', JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
