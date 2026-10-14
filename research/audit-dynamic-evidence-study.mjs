import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { auditDynamicEvidence } from './dynamic-evidence-audit.mjs';
import { equipmentWorlds } from './dynamic-evidence-fixture.mjs';

const report = JSON.parse(readFileSync('research/dynamic-evidence-study.json', 'utf8'));
for (const [name, expected] of Object.entries(report.sourceHashes)) {
  const actual = createHash('sha256').update(readFileSync(name)).digest('hex');
  assert.equal(actual, expected, `Study source changed: ${name}`);
}
for (const [name, options] of Object.entries(report.conditions)) {
  assert.deepEqual(report.results[name], auditDynamicEvidence({ worlds: equipmentWorlds(options) }), `Study result changed: ${name}`);
}
console.log(JSON.stringify({ verified: true, conditions: Object.keys(report.conditions).length,
  baselineBeliefStates: report.results.baseline.exploredBeliefStates,
  adaptiveWorstCaseActions: report.results.baseline.initialPartitions[0].adaptiveWorstCaseActions }));
