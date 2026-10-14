import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';

const data = JSON.parse(readFileSync('research/route-factorial-results.json', 'utf8'));
assert.equal(data.status, 'complete');
assert.equal(data.observations.length, data.jobs.length);
const rows = data.observations;
const byKey = new Map(rows.map(row => [row.key, row]));
assert.equal(byKey.size, rows.length);
const arms = ['user', 'system', 'state'];
const pairs = data.cases.map(item => item.pairId);
const key = (pair, arm, world, phase) => `${pair}|${arm}|${world}|${phase}`;
const exactWait = row => row?.rawReply === 'Awaiting route.';
const exactVehicle = row => row?.rawReply === row?.expected;
const mentionsVehicle = row => typeof row?.rawReply === 'string' && row.rawReply.toLowerCase().includes(row.expected.toLowerCase());
const subset = (arm, phase) => rows.filter(row => row.arm === arm && row.phase === phase);

const summary = {
  manifestHash: data.manifestHash,
  sampledAt: [data.startedAt, data.completedAt],
  model: data.model,
  pairs: pairs.length,
  plannedProbes: rows.length,
  responses: rows.filter(row => row.rawReply !== null).length,
  noResponse: rows.filter(row => row.rawReply === null).length,
  providerAttemptErrors: data.providerErrors.length,
  providerErrorStatus: data.providerErrors.reduce((count, error) => { count[error.status] = (count[error.status] ?? 0) + 1; return count; }, {}),
  arms: {},
  matchedUserSystemAfter: { bothCorrect: 0, userOnly: 0, systemOnly: 0, neitherCorrect: 0 },
};

for (const arm of arms) {
  const before = subset(arm, 'gated-before');
  const after = subset(arm, 'gated-after');
  assert.equal(before.length, pairs.length * 2);
  assert.equal(after.length, pairs.length * 2);
  const pairedSuccess = pairs.filter(pair => [0, 1].every(world => exactWait(byKey.get(key(pair, arm, world, 'gated-before'))) && exactVehicle(byKey.get(key(pair, arm, world, 'gated-after')))));
  summary.arms[arm] = {
    gatedBefore: { planned: before.length, exactWaits: before.filter(exactWait).length, prematureExactVehicle: before.filter(exactVehicle).length, mentionsVehicle: before.filter(mentionsVehicle).length, noResponse: before.filter(row => row.rawReply === null).length },
    gatedAfter: { planned: after.length, exactVehicle: after.filter(exactVehicle).length, mentionsVehicle: after.filter(mentionsVehicle).length, exactWaits: after.filter(exactWait).length, noResponse: after.filter(row => row.rawReply === null).length, correctAmongResponses: `${after.filter(exactVehicle).length}/${after.filter(row => row.rawReply !== null).length}` },
    pairedSuccess: { count: pairedSuccess.length, total: pairs.length, cases: pairedSuccess },
  };
  if (arm === 'state') {
    const full = subset(arm, 'full-case-before');
    assert.equal(full.length, pairs.length * 2);
    summary.arms[arm].fullCaseBefore = { planned: full.length, earlyExactVehicle: full.filter(exactVehicle).length, mentionsVehicle: full.filter(mentionsVehicle).length, exactWaits: full.filter(exactWait).length, noResponse: full.filter(row => row.rawReply === null).length };
  }
}

for (const pair of pairs) for (const world of [0, 1]) {
  const user = exactVehicle(byKey.get(key(pair, 'user', world, 'gated-after')));
  const system = exactVehicle(byKey.get(key(pair, 'system', world, 'gated-after')));
  const slot = user && system ? 'bothCorrect' : user ? 'userOnly' : system ? 'systemOnly' : 'neitherCorrect';
  summary.matchedUserSystemAfter[slot]++;
}

writeFileSync('research/route-factorial-summary.json', JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
