import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compileAuthorAuditBundle } from './author-audit-bundle.mjs';
import { localizeAuthorAuditBundle } from './author-audit-localization.mjs';

const equipment = JSON.parse(readFileSync('research/author-audit-equipment.json', 'utf8'));
const passport = JSON.parse(readFileSync('research/author-audit-passport.json', 'utf8'));

test('portable bundle distinguishes clean event reveals and early leaks in two scene families', () => {
  assert.equal(equipment.schemaVersion, 1);
  assert.equal(equipment.scenarios.length, 28);
  assert.equal(passport.scenarios.length, 4);
  for (const scenario of equipment.scenarios.filter(row => /-order-\d+$/.test(row.id))) {
    for (const channel of ['domText', 'accessibility', 'renderedPixels', 'actionPayload'])
      assert.equal(scenario.firstDifference[channel].status, 'revealed-at-event', `${scenario.id} ${channel}`);
    assert.equal(scenario.firstDifference.downloadedBytes.status, 'unrevealed');
  }
  assert.equal(equipment.scenarios.filter(row => row.id.startsWith('control-')).length, 4);
  for (const scenario of equipment.scenarios.filter(row => row.id.startsWith('control-')))
    assert.equal(scenario.firstDifference.renderedPixels.status, 'exposed-before-event');
  const clean = passport.scenarios.find(row => row.id === 'clean-open-card');
  const injected = passport.scenarios.find(row => row.id === 'injected-open-card');
  assert.equal(clean.firstDifference.renderedPixels.action, 'card');
  assert.equal(injected.firstDifference.renderedPixels.action, 'open');
  assert.equal(injected.firstDifference.downloadedBytes.action, 'open');
  assert.equal(injected.firstDifference.actionPayload.action, 'card');
  const injectedOpen = injected.stages[injected.firstDifference.renderedPixels.stageIndex];
  assert.ok(injectedOpen.localization.pixels.changedPixels > 0);
  assert.deepEqual(injectedOpen.localization.resources, ['/reference-assets/open-book.webp']);
  const shortcut = equipment.scenarios.find(row => row.id === 'control-clipboardshortcut');
  const shortcutStage = shortcut.stages[shortcut.firstDifference.actionPayload.stageIndex];
  assert.deepEqual(shortcutStage.localization.actionFields, ['$.observation.voltage']);
  const order = equipment.scenarios.find(row => row.id === 'control-order-sensitive-voltage');
  assert.equal(order.firstDifference.renderedPixels.action, 'moveClipboard');
  assert.equal(order.firstDifference.actionPayload.action, 'measureVoltage');
  assert.deepEqual(order.stages[order.firstDifference.downloadedBytes.stageIndex].localization.resources,
    ['/api/debug-voltage']);
});

test('bundle compiler rejects inconsistent paired histories and screenshot provenance', () => {
  const report = JSON.parse(readFileSync('research/equipment-first-use-study.json', 'utf8'));
  const rows = report.rows.slice(0, 2).map(row => structuredClone(row));
  const baseline = { id: 'test', label: 'test', factLabel: 'voltage', declaredEvent: 'measureVoltage',
    worldLabels: ['a', 'b'], answers: ['release', 'hold'], rows, screenshotRoot: 'browser-equipment' };
  const input = scenario => ({ sceneId: 'test', title: 'test', scenarios: [scenario],
    sourceReports: ['research/equipment-first-use-study.json'] });
  assert.equal(compileAuthorAuditBundle(input(baseline)).scenarios.length, 1);
  assert.throws(() => compileAuthorAuditBundle(input({ ...baseline, answers: ['hold', 'hold'] })), /outcomes must differ/);
  const mismatched = structuredClone(rows); mismatched[1].trace[1].action = 'wrong';
  assert.throws(() => compileAuthorAuditBundle(input({ ...baseline, rows: mismatched })), /paired actions differ/);
  const stale = structuredClone(rows); stale[0].trace[0].screenshotHash = '00';
  assert.throws(() => compileAuthorAuditBundle(input({ ...baseline, rows: stale })), /screenshot hash does not match/);
});

test('localization identifies the injected browser asset and verifies actual screenshot pixels', async () => {
  const report = JSON.parse(readFileSync('research/temporal-asset-cut-study.json', 'utf8'));
  const rows = report.rows.filter(row => row.condition === 'injected' && row.order.join(',') === 'open,card');
  assert.equal(rows.length, 2);
  const scenario = { id: 'injected-open-card', label: 'test', factLabel: 'signature', declaredEvent: 'card',
    worldLabels: ['match', 'mismatch'], answers: ['clear', 'hold'], rows,
    screenshotRoot: 'browser-temporal-assets' };
  const input = value => ({ sceneId: 'passport', title: 'Passport', scenarios: [value],
    sourceReports: ['research/temporal-asset-cut-study.json'] });
  const bundle = await localizeAuthorAuditBundle(compileAuthorAuditBundle(input(scenario)), [scenario]);
  const first = bundle.scenarios[0].firstDifference.renderedPixels.stageIndex;
  const location = bundle.scenarios[0].stages[first].localization;
  assert.equal(bundle.scenarios[0].stages[first].action, 'open');
  assert.ok(location.pixels.changedPixels > 0);
  assert.ok(location.pixels.bounds.width > 0);
  assert.deepEqual(location.resources, ['/reference-assets/open-book.webp']);
  const stalePixels = structuredClone(scenario);
  stalePixels.rows[0].trace[first].capture.screenshotPixelHash = '00';
  await assert.rejects(() => localizeAuthorAuditBundle(compileAuthorAuditBundle(input(stalePixels)), [stalePixels]),
    /capture pixel hash differs from PNG/);
  const stalePayload = structuredClone(scenario);
  const card = stalePayload.rows[0].trace.find(stage => stage.action === 'card');
  card.capture.actionPayload.documents.card.signature = 'altered';
  await assert.rejects(() => localizeAuthorAuditBundle(compileAuthorAuditBundle(input(stalePayload)), [stalePayload]),
    /response hash differs from captured payload/);
});
