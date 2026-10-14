import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { auditPrerequisiteClosure } from './prerequisite-closure.mjs';

const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const manifestPath = 'research/reference-visibility-manifest.json';
const browserPath = 'research/reference-dom-visibility.json';
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const browser = JSON.parse(readFileSync(browserPath, 'utf8'));
const atomic = ['passportSignature', 'cardSignature', 'stampDate', 'uvIntact'];
const actions = [
  { id: 'open', reveals: ['passportSignature'] },
  { id: 'card', reveals: ['cardSignature'] },
  { id: 'turn', requiresAll: ['open'], reveals: ['stampDate'] },
  { id: 'uv', reveals: ['uvIntact'] },
  { id: 'compare', requiresAll: ['open', 'card'], reveals: ['signatureMismatch'] },
];
const derived = [{ fact: 'signatureMismatch', from: ['passportSignature', 'cardSignature'] }];
const boundaries = {
  playerAccessible: fact => manifest.firstByBoundary[fact].playerAccessible?.stage,
  modelVerifiedDesk: fact => manifest.firstByBoundary[fact].modelVerifiedDesk?.stage,
  modelFullRequest: fact => manifest.firstByBoundary[fact].modelFullRequest?.stage,
  visibleHistory: fact => browser.firstByBoundary[fact].visibleHistory?.stage,
};
const targets = [
  { action: 'open', fact: 'passportSignature' },
  { action: 'card', fact: 'cardSignature' },
  { action: 'turn', fact: 'stampDate' },
  { action: 'uv', fact: 'uvIntact' },
  { action: 'compare', fact: 'signatureMismatch' },
];
const reports = Object.fromEntries(Object.entries(boundaries).map(([boundary, first]) => {
  const initialFacts = atomic.filter(fact => first(fact) === 'closed' || first(fact) === 'intro');
  const checks = Object.fromEntries(targets.map(target => [target.action, auditPrerequisiteClosure({
    actions, derived, initialFacts, targetAction: target.action, targetFact: target.fact, boundary,
  })]));
  return [boundary, { initialFacts, checks }];
}));
for (const boundary of Object.values(reports)) assert.equal(boundary.checks.compare.status, 'always-known-before');
assert.equal(reports.playerAccessible.checks.turn.status, 'not-proven-known-before');
assert.equal(reports.modelFullRequest.checks.uv.status, 'always-known-before');
assert.equal(reports.visibleHistory.checks.uv.status, 'not-proven-known-before');
assert.equal(reports.modelVerifiedDesk.checks.uv.status, 'not-proven-known-before');
const result = {
  scope: 'Fast declarative lower-bound check using initial exposures from saved local manifests and an authored action/fact contract validated on key states against the runtime reducer. Not an exhaustive source-derived action guard or path certificate.',
  sourceHashes: Object.fromEntries(['server/passport-reference.mjs', 'research/prerequisite-closure.mjs', 'research/reference-prerequisite-audit.mjs', manifestPath, browserPath].map(path => [path, digest(path)])),
  actions, derived, targets, boundaries: reports,
};
writeFileSync('research/reference-prerequisite-audit.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify(Object.fromEntries(Object.entries(reports).map(([boundary, report]) => [boundary, {
  initialFacts: report.initialFacts,
  statuses: Object.fromEntries(Object.entries(report.checks).map(([action, check]) => [action, check.status])),
}]))));
