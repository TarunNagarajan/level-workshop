import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const hash = value => createHash('sha256').update(value).digest('hex');
const report = JSON.parse(readFileSync(new URL('./world-bound-template-study.json', import.meta.url)));
assert.equal(report.status, 'passed');
for (const [path, expected] of Object.entries(report.sourceHashes)) assert.equal(hash(readFileSync(path)), expected, `Stale source: ${path}`);
for (const family of [report.passport, report.equipment]) {
  assert.equal(family.worldCount, 4);
  assert.equal(family.distinctTargetPrompts, 4);
  assert.equal(family.initialPlayerViewsEqual, true);
  assert.equal(family.oneFactorPairs.length, 4);
  assert.ok(family.oneFactorPairs.every(pair => pair.differentTarget && pair.sameNormalizedTarget));
}
assert.equal(report.negativeControls.length, 6);
assert.ok(report.negativeControls.every(control => control.status === 'rejected'));
assert.equal(report.knownLimits.undeclaredParaphrase.status, 'accepted-invalid');
assert.equal(report.knownLimits.benignQuotation.status, 'rejected-benign');
console.log(JSON.stringify({ verified: true, families: 2, worlds: 8, oneFactorPairs: 8, rejectedControls: 6, knownFalseNegative: 1, knownConservativeRejection: 1 }));
