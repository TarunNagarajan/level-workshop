import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { auditChainState } from './chain-state-contract.mjs';
import { auditPrerequisiteClosure } from './prerequisite-closure.mjs';

const report = JSON.parse(readFileSync('research/chain-prerequisite-audit.json', 'utf8'));
for (const [name, expected] of Object.entries(report.sourceHashes)) assert.equal(createHash('sha256').update(readFileSync(name)).digest('hex'), expected, `Chain preflight source changed: ${name}`);
assert.deepEqual(report.compilerAudit, auditChainState());
const plans = {
  colorToB: ['share-color', 'color', 'B', ['codebook']],
  routeAtB: ['decode-route', 'route', 'B', ['codebook']],
  routeToC: ['share-route', 'route', 'C', ['fleet']],
  vehicleAtC: ['allocate-vehicle', 'vehicle', 'C', ['fleet']],
};
for (const [name, [targetAction, targetFact, boundary, initialFacts]] of Object.entries(plans)) assert.deepEqual(report.checks[name], auditPrerequisiteClosure({ actions: report.actions, derived: report.derived, initialFacts, targetAction, targetFact, boundary }));
assert.deepEqual(Object.fromEntries(Object.entries(report.checks).map(([name, check]) => [name, check.status])), {
  colorToB: 'not-proven-known-before', routeAtB: 'always-known-before', routeToC: 'not-proven-known-before', vehicleAtC: 'always-known-before',
});
console.log(JSON.stringify({ worlds: report.compilerAudit.worlds, scopedChecks: Object.keys(report.checks).length, sourceFiles: Object.keys(report.sourceHashes).length }));
