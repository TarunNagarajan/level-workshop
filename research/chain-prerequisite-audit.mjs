import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { auditChainState } from './chain-state-contract.mjs';
import { auditPrerequisiteClosure } from './prerequisite-closure.mjs';

const actions = [
  { id: 'inspect-seal', revealsTo: { A: ['color'] } },
  { id: 'share-color', requiresAll: ['inspect-seal'], revealsTo: { B: ['color'] } },
  { id: 'decode-route', requiresAll: ['share-color'], revealsTo: { B: ['route'] } },
  { id: 'share-route', requiresAll: ['decode-route'], revealsTo: { C: ['route'] } },
  { id: 'allocate-vehicle', requiresAll: ['share-route'], revealsTo: { C: ['vehicle'] } },
];
const derived = [
  { fact: 'route', from: ['color', 'codebook'] },
  { fact: 'vehicle', from: ['route', 'fleet'] },
];
const checks = {
  colorToB: auditPrerequisiteClosure({ actions, derived, initialFacts: ['codebook'], targetAction: 'share-color', targetFact: 'color', boundary: 'B' }),
  routeAtB: auditPrerequisiteClosure({ actions, derived, initialFacts: ['codebook'], targetAction: 'decode-route', targetFact: 'route', boundary: 'B' }),
  routeToC: auditPrerequisiteClosure({ actions, derived, initialFacts: ['fleet'], targetAction: 'share-route', targetFact: 'route', boundary: 'C' }),
  vehicleAtC: auditPrerequisiteClosure({ actions, derived, initialFacts: ['fleet'], targetAction: 'allocate-vehicle', targetFact: 'vehicle', boundary: 'C' }),
};
assert.equal(checks.colorToB.status, 'not-proven-known-before');
assert.equal(checks.routeAtB.status, 'always-known-before');
assert.equal(checks.routeToC.status, 'not-proven-known-before');
assert.equal(checks.vehicleAtC.status, 'always-known-before');
const compilerAudit = auditChainState();
const paths = ['research/chain-state-contract.mjs', 'research/chain-contract.mjs', 'research/prerequisite-closure.mjs', 'research/chain-prerequisite-audit.mjs'];
const sourceHashes = Object.fromEntries(paths.map(path => [path, createHash('sha256').update(readFileSync(path)).digest('hex')]));
const report = {
  scope: 'Recipient-scoped declarative action/fact preflight for the eight-world three-specialist chain, checked alongside its existing paired-world request compiler. Action availability is an authored contract, not extracted from a deployed role workflow.',
  sourceHashes, actions, derived, compilerAudit, checks,
};
writeFileSync('research/chain-prerequisite-audit.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify({ compilerAudit, statuses: Object.fromEntries(Object.entries(checks).map(([name, check]) => [name, check.status])) }));
