import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { auditDynamicEvidence } from './dynamic-evidence-audit.mjs';
import { equipmentWorlds } from './dynamic-evidence-fixture.mjs';

const sourceFiles = ['research/dynamic-evidence-audit.mjs', 'research/dynamic-evidence-fixture.mjs', 'research/dynamic-evidence-audit.test.mjs', 'research/dynamic-evidence-study.mjs'];
const sourceHashes = Object.fromEntries(sourceFiles.map(name => [name, createHash('sha256').update(readFileSync(name)).digest('hex')]));
const conditions = {
  baseline: {},
  initialVoltageLeak: { leakVoltage: true },
  controlAvailabilityLeak: { leakFuseByAvailability: true },
  clipboardShortcut: { shortcutViaClipboard: true },
};
const results = Object.fromEntries(Object.entries(conditions).map(([name, options]) => [name, auditDynamicEvidence({ worlds: equipmentWorlds(options) })]));
for (const result of Object.values(results)) assert.equal(result.status, 'analyzed');
for (const result of Object.values(results)) assert.equal(result.adaptivePolicyStatus, 'guaranteed');
const find = (arm, id) => results[arm].worlds.find(row => row.worldId === id);
assert.equal(results.baseline.initialPartitions.length, 1);
assert.equal(results.baseline.initialPartitions[0].adaptiveWorstCaseActions, 3);
assert.equal(find('baseline', 'stable-intact').shortestDecision.actions.length, 3);
assert.equal(find('baseline', 'unstable-blown').requiredOnEveryResolvingPath.length, 0);
assert.equal(find('initialVoltageLeak', 'unstable-intact').initialSufficient, true);
assert.equal(find('controlAvailabilityLeak', 'stable-blown').initialSufficient, true);
assert.deepEqual(find('clipboardShortcut', 'unstable-intact').shortestDecision.actions, ['moveClipboard']);
const report = {
  boundary: 'Research-only deterministic equipment inspection. Supplied state machines, observations, and available-action lists; no production client, API, model, timing, or human playtest.',
  sourceHashes, conditions, results,
};
writeFileSync('research/dynamic-evidence-study.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify({ conditions: Object.keys(conditions), worlds: results.baseline.worlds.length,
  baselineBeliefStates: results.baseline.exploredBeliefStates, baselineEdges: results.baseline.transitionEdges,
  baselineAdaptiveWorstCaseActions: results.baseline.initialPartitions[0].adaptiveWorstCaseActions,
  initialVoltageLeakWorlds: results.initialVoltageLeak.worlds.filter(row => row.initialSufficient).map(row => row.worldId),
  availabilityLeakWorlds: results.controlAvailabilityLeak.worlds.filter(row => row.initialSufficient).map(row => row.worldId),
  shortcutWitness: find('clipboardShortcut', 'unstable-intact').shortestDecision.actions }));
