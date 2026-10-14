import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const report = JSON.parse(readFileSync(new URL('./counterfactual-influence-study.json', import.meta.url)));
assert.equal(report.status, 'passed');
for (const [path, expected] of Object.entries(report.sourceHashes))
  assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'), expected, `Stale source: ${path}`);
assert.equal(report.passport.pairCount, 4);
assert.equal(report.equipment.pairCount, 4);
assert.equal(report.passport.cells.length, 16);
assert.equal(report.equipment.cells.length, 10);
assert.ok([...report.passport.cells, ...report.equipment.cells].every(cell => cell.status === 'satisfied'));
assert.equal(Object.keys(report.controls).length, 4);
for (const control of Object.values(report.controls)) assert.ok(control.firstWitness);
console.log(JSON.stringify({ verified: true, families: 2, worlds: 8, pairs: 8, cells: 26, detectedControls: 4 }));
