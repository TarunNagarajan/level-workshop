import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { auditEventCut } from './event-cut-contract.mjs';
import { passportEvidenceWorlds } from './passport-dynamic-adapter.mjs';
import { auditTemporalObserverCut } from './temporal-observer-cut.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const report = JSON.parse(readFileSync('research/model-browser-cut-study.json', 'utf8'));
const browserBytes = readFileSync('research/temporal-asset-cut-study.json');
const browser = JSON.parse(browserBytes);
assert.equal(report.status, 'passed');
assert.equal(browser.status, 'passed');
assert.equal(digest(browserBytes), report.browserReportHash);
for (const [path, hash] of Object.entries(report.sourceHashes)) assert.equal(digest(readFileSync(path)), hash, `Source changed: ${path}`);
for (const [path, hash] of Object.entries(browser.sourceHashes)) assert.equal(digest(readFileSync(path)), hash, `Browser source changed: ${path}`);
for (const [path, hash] of Object.entries(browser.bundleHashes)) assert.equal(digest(readFileSync(`dist/client/${path}`)), hash, `Browser bundle changed: ${path}`);
assert.equal(report.assetHashes.clean, browser.bundleHashes['reference-assets/open-book.webp']);
const rows = browser.rows;
for (const row of rows.filter(item => item.condition === 'injected')) assert.equal(row.replacementHash, report.assetHashes.injected[row.world]);

function build(condition, includeAsset) {
  return passportEvidenceWorlds({ boundary: 'player' }).filter(world => ['match-intact', 'mismatch-intact'].includes(world.id))
    .map(world => ({ ...world, observe: state => ({ ...world.observe(state),
      ...(includeAsset ? { loadedAssets: state.page ? { '/reference-assets/open-book.webp': condition === 'injected' ? report.assetHashes.injected[world.id] : report.assetHashes.clean } : {} } : {}) }) }));
}
const summarize = audit => ({ status: audit.status, exploredPairs: audit.exploredPairs,
  shortestBypass: audit.shortestBypass && { actions: audit.shortestBypass.actions,
    difference: audit.shortestBypass.difference, firstDifferingField: audit.shortestBypass.firstDifferingField },
  revealTrace: audit.revealTrace && { actions: audit.revealTrace.actions,
    difference: audit.revealTrace.difference, firstDifferingField: audit.revealTrace.firstDifferingField } });
for (const [key, condition, includeAsset] of [['clean', 'clean', true], ['injected', 'injected', true], ['missingAsset', 'injected', false]]) {
  assert.deepEqual(summarize(auditEventCut({ worlds: build(condition, includeAsset), requiredAction: 'card', maxPairs: 50000 })), report.graph[key]);
}
const pair = (condition, order) => rows.filter(row => row.condition === condition && row.order.join(',') === order.join(','));
const [a, b] = pair('clean', ['card', 'open']);
const [c, d] = pair('injected', ['open', 'card']);
assert.deepEqual(auditTemporalObserverCut(a.trace, b.trace, { requiredAction: 'card', channel: 'renderedPixels' }), report.browser.cleanScreen);
assert.deepEqual(auditTemporalObserverCut(a.trace, b.trace, { requiredAction: 'card', channel: 'actionPayload' }), report.browser.cleanActionPayload);
assert.deepEqual(auditTemporalObserverCut(c.trace, d.trace, { requiredAction: 'card', channel: 'renderedPixels' }), report.browser.leakScreen);
assert.deepEqual(auditTemporalObserverCut(c.trace, d.trace, { requiredAction: 'card', channel: 'downloadedBytes' }), report.browser.leakDownloads);
assert.deepEqual(auditTemporalObserverCut(c.trace, d.trace, { requiredAction: 'card', channel: 'actionPayload' }), report.browser.leakActionPayload);
assert.equal(report.graph.clean.status, 'certified');
assert.equal(report.graph.injected.status, 'bypass');
assert.equal(report.graph.missingAsset.status, 'certified');
assert.deepEqual(report.graph.injected.shortestBypass.actions, ['open']);
console.log(JSON.stringify({ status: 'fresh', graphConditions: 3, browserWitnesses: 2, falseCertificateDetected: true }));
