import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { equipmentWorlds } from './dynamic-evidence-fixture.mjs';
import { auditTemporalObserverCut } from './temporal-observer-cut.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const report = JSON.parse(readFileSync('research/equipment-order-mutation-study.json', 'utf8'));
assert.equal(report.status, 'passed');
for (const [path, expected] of Object.entries(report.sourceHashes))
  assert.equal(hash(readFileSync(path)), expected, `Stale source: ${path}`);
assert.equal(report.rows.length, 4);
assert.equal(report.verdicts.length, 10);
for (const row of report.rows) {
  const world = equipmentWorlds().find(item => item.id === row.worldId);
  assert.ok(world);
  assert.deepEqual(row.trace.map(stage => stage.action), ['intro', ...row.path]);
  let state = structuredClone(world.initialState);
  for (const [index, stage] of row.trace.entries()) {
    if (index) state = world.step(state, stage.action);
    const png = readFileSync(stage.screenshot);
    assert.equal(hash(png), stage.screenshotHash, `${row.label}/${row.worldId}/${stage.action}: PNG bytes`);
    assert.equal(hash(await sharp(png).ensureAlpha().raw().toBuffer()), stage.capture.screenshotPixelHash,
      `${row.label}/${row.worldId}/${stage.action}: decoded pixels`);
    const expectedPayload = index ? { observation: world.observe(state), availableActions: world.enabled(state) } : null;
    assert.deepEqual(stage.capture.actionPayload, expectedPayload,
      `${row.label}/${row.worldId}/${stage.action}: ordinary POST vs reducer`);
    assert.equal(stage.capture.actionPayloadHash,
      expectedPayload ? hash(JSON.stringify(expectedPayload)) : null);
  }
}
for (const label of ['selected', 'omitted']) {
  const pair = report.rows.filter(row => row.label === label);
  assert.deepEqual(pair.map(row => row.worldId), ['stable-intact', 'unstable-intact']);
  for (const channel of ['domText', 'accessibility', 'renderedPixels', 'actionPayload', 'downloadedBytes']) {
    const actual = auditTemporalObserverCut(pair[0].trace, pair[1].trace,
      { requiredAction: 'measureVoltage', channel });
    const saved = report.verdicts.find(row => row.label === label && row.channel === channel);
    assert.deepEqual(saved, { label, channel, ...actual });
  }
}
const selected = report.verdicts.filter(row => row.label === 'selected');
const omitted = report.verdicts.filter(row => row.label === 'omitted');
assert.ok(selected.every(row => row.status === (row.channel === 'downloadedBytes' ? 'unrevealed' : 'revealed-at-event')));
assert.ok(omitted.filter(row => row.channel !== 'actionPayload').every(row => row.status === 'exposed-before-event'
  && row.firstDifferentAction === 'moveClipboard'));
assert.equal(omitted.find(row => row.channel === 'downloadedBytes').differingResources.join(','), '/api/debug-voltage');
assert.equal(omitted.find(row => row.channel === 'actionPayload').status, 'revealed-at-event');
console.log(JSON.stringify({ status: 'fresh', fixtures: report.rows.length, screenshots: report.rows.reduce((n, row) => n + row.trace.length, 0),
  selectedAtEvent: selected.filter(row => row.status === 'revealed-at-event').length,
  omittedEarly: omitted.filter(row => row.status === 'exposed-before-event').length }));
