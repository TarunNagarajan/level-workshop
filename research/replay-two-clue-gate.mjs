import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { compileTwoClueRequest, twoClueWorlds } from './two-clue-contract.mjs';
import { authorizeTwoClueDecision } from './two-clue-publication-gate.mjs';

const byId = Object.fromEntries(twoClueWorlds().map(world => [world.id, world]));
const cohorts = {};
for (const [name, file, arm] of [
  ['gpt-original', 'two-clue-results.json', null],
  ['gpt-repeat', 'two-clue-repeat-results.json', null],
  ['gpt-spoof', 'two-clue-spoof-results.json', 'explicit'],
  ['gemini-transfer', 'two-clue-gemini-results.json', null],
]) {
  const data = JSON.parse(readFileSync(`research/${file}`, 'utf8'));
  assert.equal(data.status, 'complete');
  const rows = [];
  for (const row of data.observations) {
    const request = compileTwoClueRequest({ world: byId[row.worldId], inspected: row.inspected, arm: arm ?? row.arm });
    assert.deepEqual(row.observed, request.observed);
    assert.equal(row.expected, request.expected);
    const verdict = authorizeTwoClueDecision({ observed: request.observed, rawReply: row.rawReply });
    assert.equal(verdict.expected, row.expected);
    if (verdict.status === 'published') assert.equal(verdict.label, row.expected);
    rows.push({ key: row.key, arm: arm ?? row.arm, expected: row.expected, rawReply: row.rawReply, ...verdict });
  }
  const byStatus = rows.reduce((acc, row) => (acc[row.status] = (acc[row.status] ?? 0) + 1, acc), {});
  const byReason = rows.reduce((acc, row) => (acc[row.reason] = (acc[row.reason] ?? 0) + 1, acc), {});
  cohorts[name] = { planned: rows.length, byStatus, byReason, byArm: Object.fromEntries([...new Set(rows.map(row => row.arm))].map(role => {
    const subset = rows.filter(row => row.arm === role);
    return [role, { planned: subset.length, published: subset.filter(row => row.status === 'published').length, waiting: subset.filter(row => row.status === 'waiting').length, rejected: subset.filter(row => row.status === 'rejected').length }];
  })) };
}
const summary = {
  cohorts,
  totalReplayed: Object.values(cohorts).reduce((sum, cohort) => sum + cohort.planned, 0),
  limitation: 'Deterministic offline replay from archived server-compiled observations. It demonstrates verdict separation but is not wired to the deployed API, browser, or persistent event ledger.',
};
writeFileSync('research/two-clue-gate-replay.json', JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
