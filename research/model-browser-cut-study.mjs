import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { auditEventCut } from './event-cut-contract.mjs';
import { passportEvidenceWorlds } from './passport-dynamic-adapter.mjs';
import { auditTemporalObserverCut } from './temporal-observer-cut.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const sourceFiles = ['server/passport-reference.mjs', 'research/passport-dynamic-adapter.mjs',
  'research/event-cut-contract.mjs', 'research/observer-relative-cut.mjs', 'research/temporal-observer-cut.mjs',
  'research/model-browser-cut-study.mjs'];
const sourceHashes = Object.fromEntries(sourceFiles.map(path => [path, digest(readFileSync(path))]));
const browserReport = JSON.parse(readFileSync('research/temporal-asset-cut-study.json', 'utf8'));
assert.equal(browserReport.status, 'passed');
const browserReportHash = digest(readFileSync('research/temporal-asset-cut-study.json'));
const cleanHash = browserReport.bundleHashes['reference-assets/open-book.webp'];
const rows = browserReport.rows;
const pairFor = (condition, order) => rows.filter(row => row.condition === condition && row.order.join(',') === order.join(','));
const injectedPair = pairFor('injected', ['open', 'card']);
assert.deepEqual(injectedPair.map(row => row.world), ['match-intact', 'mismatch-intact']);
const injectedHashes = Object.fromEntries(injectedPair.map(row => [row.world, row.replacementHash]));
for (const row of rows.filter(row => row.condition === 'injected')) assert.equal(row.replacementHash, injectedHashes[row.world]);
assert.notEqual(injectedHashes['match-intact'], injectedHashes['mismatch-intact']);

function worlds(condition, includeAsset) {
  return passportEvidenceWorlds({ boundary: 'player' })
    .filter(world => ['match-intact', 'mismatch-intact'].includes(world.id))
    .map(world => ({ ...world, observe: state => ({ ...world.observe(state),
      ...(includeAsset ? { loadedAssets: state.page ? { '/reference-assets/open-book.webp': condition === 'injected' ? injectedHashes[world.id] : cleanHash } : {} } : {}) }) }));
}
const clean = auditEventCut({ worlds: worlds('clean', true), requiredAction: 'card', maxPairs: 50000 });
const injected = auditEventCut({ worlds: worlds('injected', true), requiredAction: 'card', maxPairs: 50000 });
const missingAsset = auditEventCut({ worlds: worlds('injected', false), requiredAction: 'card', maxPairs: 50000 });
assert.equal(clean.status, 'certified');
assert.equal(injected.status, 'bypass');
assert.equal(missingAsset.status, 'certified');
assert.deepEqual(clean.revealTrace.actions, ['card']);
assert.deepEqual(injected.shortestBypass.actions, ['open']);
assert.equal(injected.shortestBypass.firstDifferingField.path, '$.observation.loadedAssets./reference-assets/open-book.webp');

const [cleanLeft, cleanRight] = pairFor('clean', ['card', 'open']);
const [leakLeft, leakRight] = injectedPair;
const cleanScreen = auditTemporalObserverCut(cleanLeft.trace, cleanRight.trace, { requiredAction: 'card', channel: 'renderedPixels' });
const leakScreen = auditTemporalObserverCut(leakLeft.trace, leakRight.trace, { requiredAction: 'card', channel: 'renderedPixels' });
const leakDownloads = auditTemporalObserverCut(leakLeft.trace, leakRight.trace, { requiredAction: 'card', channel: 'downloadedBytes' });
const cleanActionPayload = auditTemporalObserverCut(cleanLeft.trace, cleanRight.trace, { requiredAction: 'card', channel: 'actionPayload' });
const leakActionPayload = auditTemporalObserverCut(leakLeft.trace, leakRight.trace, { requiredAction: 'card', channel: 'actionPayload' });
assert.equal(cleanScreen.status, 'revealed-at-event');
assert.equal(cleanActionPayload.status, 'revealed-at-event');
assert.deepEqual(cleanScreen.precedingActions.slice(2), clean.revealTrace.actions);
assert.equal(leakScreen.status, 'exposed-before-event');
assert.equal(leakDownloads.status, 'exposed-before-event');
assert.equal(leakActionPayload.status, 'revealed-at-event');
assert.deepEqual(leakScreen.precedingActions.slice(2), injected.shortestBypass.actions);
assert.deepEqual(leakDownloads.differingResources, ['/reference-assets/open-book.webp']);
for (const row of injectedPair) {
  const fetched = row.trace.find(stage => stage.action === 'open').capture.network.find(item => item.path === '/reference-assets/open-book.webp');
  assert.equal(fetched?.hash, injectedHashes[row.world]);
}

const summarize = audit => ({ status: audit.status, exploredPairs: audit.exploredPairs,
  shortestBypass: audit.shortestBypass && { actions: audit.shortestBypass.actions,
    difference: audit.shortestBypass.difference, firstDifferingField: audit.shortestBypass.firstDifferingField },
  revealTrace: audit.revealTrace && { actions: audit.revealTrace.actions,
    difference: audit.revealTrace.difference, firstDifferingField: audit.revealTrace.firstDifferingField } });
const report = { status: 'passed', sourceHashes, browserReportHash,
  scope: 'Actual passport reducer and player serializer, first-use actions only. One ordinary and one injected asset manifest plus a missing-asset negative control. Browser parity checks model-selected card and open prefixes from the saved two-order Chromium study.',
  assetHashes: { clean: cleanHash, injected: injectedHashes },
  graph: { clean: summarize(clean), injected: summarize(injected), missingAsset: summarize(missingAsset) },
  browser: { cleanScreen, cleanActionPayload, leakScreen, leakDownloads, leakActionPayload },
  negativeControl: 'Omitting the loaded asset from model observations yields a false card certificate while the paired browser screens diverge at open.' };
writeFileSync('research/model-browser-cut-study.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify({ status: report.status, clean: clean.status,
  injected: injected.status, shortestBypass: injected.shortestBypass.actions,
  missingAssetFalseCertificate: missingAsset.status === 'certified', browserConfirmed: true }));
