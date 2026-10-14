import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { auditTemporalObserverCut } from './temporal-observer-cut.mjs';
import { compareObserverBoundary } from './observer-relative-cut.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const report = JSON.parse(readFileSync('research/equipment-browser-study.json', 'utf8'));
const protocol = JSON.parse(readFileSync('research/equipment-browser-protocol.json', 'utf8'));
assert.equal(report.status, 'passed');
for (const [path, recorded] of Object.entries(report.sourceHashes)) assert.equal(hash(readFileSync(path)), recorded, `stale source: ${path}`);
let screenshots = 0;
for (const row of report.rows) for (const stage of row.trace) {
  const bytes = readFileSync(`research/browser-equipment/${row.name}-${stage.action}.png`);
  assert.equal(hash(bytes), stage.screenshotHash, `${row.name} ${stage.action}: stale screenshot`);
  assert.equal(hash(await sharp(bytes).ensureAlpha().raw().toBuffer()), stage.capture.screenshotPixelHash,
    `${row.name} ${stage.action}: stale pixel digest`);
  if (stage.capture.actionPayload) assert.equal(hash(JSON.stringify(stage.capture.actionPayload)), stage.capture.actionPayloadHash);
  screenshots++;
}
for (const pair of protocol.baselinePairs) for (const path of pair.paths) {
  const matches = report.rows.filter(row => row.condition === 'baseline' && path.join(',') === row.path.join(',')
    && [pair.left, pair.right].includes(row.worldId));
  assert.equal(matches.length, 2);
  for (const channel of protocol.channels) {
    const recomputed = auditTemporalObserverCut(matches[0].trace, matches[1].trace, { requiredAction: pair.event, channel });
    const saved = report.verdicts.find(row => row.condition === 'baseline' && row.factor === pair.factor
      && row.path.join(',') === path.join(',') && row.channel === channel);
    assert.deepEqual(saved, { condition: 'baseline', factor: pair.factor, path, ...recomputed });
  }
}
for (const control of protocol.injectedControls) {
  const matches = report.rows.filter(row => row.condition === control.name);
  assert.equal(matches.length, 2);
  const index = control.path ? 1 : 0;
  const comparison = compareObserverBoundary(matches[0].trace[index].capture, matches[1].trace[index].capture);
  const saved = report.verdicts.find(row => row.condition === control.name);
  assert.deepEqual(saved.channels, comparison.channels);
}
console.log(JSON.stringify({ status: 'fresh', browserFixtures: report.rows.length, screenshots,
  baselineVerdicts: report.verdicts.filter(row => row.condition === 'baseline').length, controls: protocol.injectedControls.length }));
