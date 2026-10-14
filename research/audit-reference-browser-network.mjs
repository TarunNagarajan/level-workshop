import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const digest = value => createHash('sha256').update(value).digest('hex');
const sqlite = JSON.parse(readFileSync(new URL('./reference-dom-visibility.json', import.meta.url)));
const postgres = JSON.parse(readFileSync(new URL('./reference-dom-visibility-postgres.json', import.meta.url)));
const stages = ['intro', 'closed', 'opened', 'turned', 'card', 'compared', 'uv'];
const facts = ['passportSignature', 'cardSignature', 'signatureMismatch', 'stampDate', 'uvIntact', 'protectedTravellerName'];
const first = (report, fact, boundary) => report.firstByBoundary[fact][boundary]?.stage ?? null;

for (const report of [sqlite, postgres]) {
  assert.equal(report.status, 'violated');
  assert.deepEqual(report.stages, stages);
  assert.deepEqual(report.pageErrors, []);
  assert.deepEqual(report.networkErrors, []);
  assert.ok(report.networkResponseCount >= 10);
  assert.equal(report.networkResponseCount, report.networkResponseHashes.length);
  assert.ok(report.networkResponseHashes.some(item => item.path === '/api/reference/play/:token' && item.kind === 'api'));
  assert.ok(report.networkResponseHashes.some(item => item.path.endsWith('.js') && item.kind === 'asset'));
  assert.ok(report.networkResponseHashes.every(item => !/\/play\/(?!:token)/.test(item.path)));
  for (const [name, hash] of Object.entries(report.sourceHashes)) assert.equal(digest(readFileSync(name)), hash, `${name} changed since capture`);
  for (const [name, hash] of Object.entries(report.bundleHashes)) assert.equal(digest(readFileSync(`dist/client/${name}`)), hash, `${name} changed since capture`);
  const screenshotDir = report === postgres ? 'research/browser-visibility-postgres' : 'research/browser-visibility';
  for (const [name, hash] of Object.entries(report.screenshotHashes)) assert.equal(digest(readFileSync(`${screenshotDir}/${name}.png`)), hash, `${name} screenshot changed since capture`);
  const expected = {
    passportSignature: ['opened', 'opened'], cardSignature: ['card', 'card'],
    signatureMismatch: ['card', 'card'], stampDate: ['turned', 'turned'],
    uvIntact: ['uv', 'uv'], protectedTravellerName: [null, null],
  };
  for (const [fact, [network, screen]] of Object.entries(expected)) {
    assert.equal(first(report, fact, 'browserNetworkAccessible'), network);
    assert.equal(first(report, fact, 'visibleHistory'), screen);
  }
  assert.ok(report.firstByBoundary.passportSignature.browserNetworkApi.exposures[0].paths.some(path => path.endsWith('/body/documents/passport/signature')));
  assert.ok(report.firstByBoundary.cardSignature.browserNetworkApi.exposures[0].paths.some(path => path.endsWith('/body/documents/card/signature')));
  assert.equal(report.firstByBoundary.stampDate.browserNetworkAssets, null);
}
for (const fact of facts) for (const boundary of ['browserNetworkAccessible', 'browserNetworkApi', 'browserNetworkAssets', 'visibleHistory']) {
  assert.equal(first(sqlite, fact, boundary), first(postgres, fact, boundary), `${fact} differs on ${boundary}`);
}
console.log(JSON.stringify({ verified: true, adapters: 2, stages: stages.length, responseCounts: [sqlite.networkResponseCount, postgres.networkResponseCount],
  actionGatedNetworkFacts: ['passportSignature', 'cardSignature', 'stampDate', 'uvIntact'],
  mismatchAvailableBeforeCompare: true, protectedTravellerNameExposed: false }));
