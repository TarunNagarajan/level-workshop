import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';

const data = JSON.parse(readFileSync('research/route-crossed-results.json', 'utf8'));
assert.equal(data.status, 'complete');
assert.equal(data.jobs.length, 128);
assert.equal(data.observations.length, data.jobs.length);
const rows = new Map(data.observations.map(row => [row.key, row]));
assert.equal(rows.size, data.jobs.length);
for (const job of data.jobs) assert(rows.has(`${job.pairId}|${job.worldIndex}|${job.channel}|${job.format}|${job.phase}`));
const semanticVehicle = row => typeof row.rawReply === 'string' && row.rawReply.trim().toLowerCase() === row.expected.toLowerCase();

const summary = {
  manifestHash: data.manifestHash,
  sampledAt: [data.startedAt, data.completedAt],
  model: data.model,
  pairs: data.cases.length,
  plannedProbes: data.jobs.length,
  responses: data.observations.filter(row => row.rawReply !== null).length,
  noResponse: data.observations.filter(row => row.rawReply === null).length,
  providerAttemptErrors: data.providerErrors.length,
  providerErrorStatus: data.providerErrors.reduce((acc, row) => (acc[row.status] = (acc[row.status] ?? 0) + 1, acc), {}),
  arms: {},
  matchedAfter: {},
};
for (const channel of ['user', 'system']) for (const format of ['narrative', 'typed']) {
  const arm = `${channel}/${format}`;
  const before = data.observations.filter(row => row.channel === channel && row.format === format && row.phase === 'before');
  const after = data.observations.filter(row => row.channel === channel && row.format === format && row.phase === 'after');
  assert.equal(before.length, 16);
  assert.equal(after.length, 16);
  const paired = data.cases.filter(spec => [0, 1].every(worldIndex => {
    const b = rows.get(`${spec.pairId}|${worldIndex}|${channel}|${format}|before`);
    const a = rows.get(`${spec.pairId}|${worldIndex}|${channel}|${format}|after`);
    return b.rawReply === 'Awaiting route.' && a.rawReply === a.expected;
  })).map(spec => spec.pairId);
  const semanticPaired = data.cases.filter(spec => [0, 1].every(worldIndex => {
    const b = rows.get(`${spec.pairId}|${worldIndex}|${channel}|${format}|before`);
    const a = rows.get(`${spec.pairId}|${worldIndex}|${channel}|${format}|after`);
    return b.rawReply === 'Awaiting route.' && semanticVehicle(a);
  })).map(spec => spec.pairId);
  summary.arms[arm] = {
    before: { planned: before.length, exactWaits: before.filter(row => row.rawReply === 'Awaiting route.').length, prematureExactVehicle: before.filter(row => row.rawReply === row.expected).length, noResponse: before.filter(row => row.rawReply === null).length },
    after: { planned: after.length, exactVehicle: after.filter(row => row.rawReply === row.expected).length, semanticVehicle: after.filter(semanticVehicle).length, caseOnlyDifference: after.filter(row => semanticVehicle(row) && row.rawReply !== row.expected).length, exactWaits: after.filter(row => row.rawReply === 'Awaiting route.').length, noResponse: after.filter(row => row.rawReply === null).length },
    pairedSuccess: { count: paired.length, total: data.cases.length, cases: paired },
    semanticPairedSuccess: { count: semanticPaired.length, total: data.cases.length, cases: semanticPaired },
  };
}
for (const factor of ['channel', 'format']) {
  const values = factor === 'channel' ? ['user', 'system'] : ['narrative', 'typed'];
  const otherFactor = factor === 'channel' ? 'format' : 'channel';
  const results = { bothCorrect: 0, firstOnly: 0, secondOnly: 0, neitherCorrect: 0 };
  const semanticResults = { bothCorrect: 0, firstOnly: 0, secondOnly: 0, neitherCorrect: 0 };
  for (const spec of data.cases) for (const worldIndex of [0, 1]) for (const other of (otherFactor === 'channel' ? ['user', 'system'] : ['narrative', 'typed'])) {
    const pair = values.map(value => {
      const parts = { pairId: spec.pairId, worldIndex, channel: undefined, format: undefined, phase: 'after', [factor]: value, [otherFactor]: other };
      return rows.get(`${parts.pairId}|${parts.worldIndex}|${parts.channel}|${parts.format}|after`);
    });
    const exact = pair.map(row => row.rawReply === row.expected);
    const semantic = pair.map(semanticVehicle);
    results[exact[0] ? exact[1] ? 'bothCorrect' : 'firstOnly' : exact[1] ? 'secondOnly' : 'neitherCorrect']++;
    semanticResults[semantic[0] ? semantic[1] ? 'bothCorrect' : 'firstOnly' : semantic[1] ? 'secondOnly' : 'neitherCorrect']++;
  }
  summary.matchedAfter[factor] = { levels: values, exact: results, semantic: semanticResults };
}
writeFileSync('research/route-crossed-summary.json', JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
