import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const hash = data => createHash('sha256').update(data).digest('hex');
const sqlite = JSON.parse(readFileSync(new URL('./passport-routed-worlds.json', import.meta.url)));
const postgres = JSON.parse(readFileSync(new URL('./passport-routed-worlds-postgres.json', import.meta.url)));
for (const report of [sqlite, postgres]) {
  assert.equal(report.status, 'passed');
  assert.equal(report.rows.length, 4);
  assert.ok(Object.values(report.conclusions).every(Boolean));
  for (const [path, digest] of Object.entries(report.sourceHashes)) assert.equal(hash(readFileSync(path)), digest, `Stale source: ${path}`);
}
for (let i = 0; i < 4; i++) {
  for (const key of ['id', 'versionId', 'initialPlayerHash', 'closedPlayerHash', 'afterCardPlayerHash', 'afterUvPlayerHash', 'initialTargetHash', 'afterInspectionTargetHash', 'providerRequestHash', 'cardSignature', 'uvObservation']) {
    assert.equal(sqlite.rows[i][key], postgres.rows[i][key], `Adapter difference: ${sqlite.rows[i].id}.${key}`);
  }
}
console.log(JSON.stringify({ verified: true, adapters: 2, worlds: 4, providerRequestsPerAdapter: 4, playerParity: true, worldFidelity: true }));
