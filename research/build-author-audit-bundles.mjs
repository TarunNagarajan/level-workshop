import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { compileAuthorAuditBundle } from './author-audit-bundle.mjs';
import { localizeAuthorAuditBundle } from './author-audit-localization.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const equipment = JSON.parse(readFileSync('research/equipment-first-use-study.json', 'utf8'));
const controls = JSON.parse(readFileSync('research/equipment-browser-study.json', 'utf8'));
const orderMutation = JSON.parse(readFileSync('research/equipment-order-mutation-study.json', 'utf8'));
const temporal = JSON.parse(readFileSync('research/temporal-asset-cut-study.json', 'utf8'));
for (const report of [equipment, controls, orderMutation, temporal]) assert.equal(report.status, 'passed');
const pair = (rows, left, right) => {
  const selected = [left, right].map(id => rows.find(row => row.worldId === id || row.world === id));
  assert.ok(selected.every(Boolean));
  return selected;
};
const equipmentScenarios = [];
for (const factor of [
  { id: 'voltage', label: 'Voltage', factLabel: 'voltage reading', event: 'measureVoltage', pair: ['stable-intact', 'unstable-intact'] },
  { id: 'fuse', label: 'Fuse condition', factLabel: 'fuse condition', event: 'inspectFuse', pair: ['stable-intact', 'stable-blown'] },
]) {
  for (const [index, path] of equipment.pathsByFactor[factor.id].entries()) {
    const rows = equipment.rows.filter(row => row.condition === `orders-${factor.id}` && row.path.join(',') === path.join(','));
    equipmentScenarios.push({ id: `${factor.id}-order-${index + 1}`, label: `${factor.label}: order ${index + 1}`,
      factLabel: factor.factLabel, declaredEvent: factor.event, worldLabels: factor.pair, answers: ['release', 'hold'],
      rows: pair(rows, ...factor.pair), screenshotRoot: 'browser-equipment',
      sourceScenario: { condition: 'baseline', path } });
  }
}
for (const control of [
  { condition: 'initialVoltageLeak', factor: 'voltage', event: 'measureVoltage', worlds: ['stable-intact', 'unstable-intact'] },
  { condition: 'clipboardShortcut', factor: 'voltage', event: 'measureVoltage', worlds: ['stable-intact', 'unstable-intact'] },
  { condition: 'fuseAvailabilityLeak', factor: 'fuse', event: 'inspectFuse', worlds: ['stable-intact', 'stable-blown'] },
]) {
  const rows = controls.rows.filter(row => row.condition === control.condition);
  equipmentScenarios.push({ id: `control-${control.condition.toLowerCase()}`, label: `Injected control: ${control.condition}`,
    factLabel: control.factor === 'voltage' ? 'voltage reading' : 'fuse condition', declaredEvent: control.event,
    worldLabels: control.worlds, answers: ['release', 'hold'], rows: pair(rows, ...control.worlds),
    screenshotRoot: 'browser-equipment', sourceScenario: { condition: control.condition, path: rows[0]?.path ?? [] } });
}
const mutatedRows = orderMutation.rows.filter(row => row.label === 'omitted').map(row => ({
  ...row, name: `${row.label}-${row.worldId}` }));
equipmentScenarios.push({ id: 'control-order-sensitive-voltage', label: 'Injected control: order-sensitive voltage',
  factLabel: 'voltage reading', declaredEvent: 'measureVoltage',
  worldLabels: ['stable-intact', 'unstable-intact'], answers: ['release', 'hold'],
  rows: pair(mutatedRows, 'stable-intact', 'unstable-intact'), screenshotRoot: 'browser-order-mutation',
  sourceScenario: { condition: 'order-sensitive-browser-route', path: orderMutation.omitted } });
const equipmentBundle = await localizeAuthorAuditBundle(compileAuthorAuditBundle({ sceneId: 'equipment-inspection', title: 'Inspection bay',
  scenarios: equipmentScenarios,
  sourceReports: ['research/equipment-first-use-study.json', 'research/equipment-browser-study.json',
    'research/equipment-browser-protocol.json', 'research/equipment-order-mutation-study.json'] }), equipmentScenarios);

const passportScenarios = [];
for (const condition of ['clean', 'injected']) for (const order of [['open', 'card'], ['card', 'open']]) {
  const rows = temporal.rows.filter(row => row.condition === condition && row.order.join(',') === order.join(','));
  passportScenarios.push({ id: `${condition}-${order.join('-')}`, label: `${condition === 'clean' ? 'Designed art' : 'Injected art'}: ${order.join(' then ')}`,
    factLabel: 'card-signature relation', declaredEvent: 'card',
    worldLabels: ['match-intact', 'mismatch-intact'], answers: ['clear', 'hold'],
    rows: pair(rows, 'match-intact', 'mismatch-intact'), screenshotRoot: 'browser-temporal-assets',
    sourceScenario: { condition, order } });
}
const passportBundle = await localizeAuthorAuditBundle(compileAuthorAuditBundle({ sceneId: 'passport-counter', title: 'Passport counter',
  scenarios: passportScenarios, sourceReports: ['research/temporal-asset-cut-study.json'] }), passportScenarios);
const compilerHashes = Object.fromEntries(['research/author-audit-bundle.mjs', 'research/build-author-audit-bundles.mjs',
  'research/author-audit-localization.mjs', 'research/observer-relative-cut.mjs'].map(path => [path, hash(readFileSync(path))]));
for (const [path, bundle] of [['research/author-audit-equipment.json', equipmentBundle], ['research/author-audit-passport.json', passportBundle]]) {
  writeFileSync(path, JSON.stringify({ ...bundle, compilerHashes }, null, 2));
}
console.log(JSON.stringify({ status: 'built', equipmentScenarios: equipmentBundle.scenarios.length,
  passportScenarios: passportBundle.scenarios.length,
  equipmentEarlyControls: equipmentBundle.scenarios.filter(scenario => scenario.id.startsWith('control-')
    && Object.values(scenario.firstDifference).some(result => result.status === 'exposed-before-event')).length,
  passportInjectedOpenBypass: passportBundle.scenarios.find(scenario => scenario.id === 'injected-open-card')?.firstDifference.renderedPixels.status }));
