import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { auditTemporalObserverCut } from './temporal-observer-cut.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const report = JSON.parse(readFileSync('research/temporal-asset-cut-study.json', 'utf8'));
assert.equal(report.status, 'passed');
assert.equal(report.rows.length, 8);
assert.equal(report.verdicts.length, 16);
for (const [path, hash] of Object.entries(report.sourceHashes)) assert.equal(digest(readFileSync(path)), hash, `Source changed: ${path}`);
for (const [path, hash] of Object.entries(report.bundleHashes)) assert.equal(digest(readFileSync(`dist/client/${path}`)), hash, `Bundle changed: ${path}`);
for (const row of report.rows) {
  assert.deepEqual(row.trace.map(stage => stage.action), ['intro', 'closed', ...row.order]);
  for (const stage of row.trace) {
    const png = readFileSync(`research/browser-temporal-assets/${row.name}-${stage.action}.png`);
    assert.equal(digest(png), stage.screenshotHash);
    assert.equal(digest(await sharp(png).ensureAlpha().raw().toBuffer()), stage.capture.screenshotPixelHash);
    assert.equal(stage.capture.actionPayload ? digest(JSON.stringify(stage.capture.actionPayload)) : null, stage.capture.actionPayloadHash);
  }
  if (row.condition === 'injected') {
    const bytes = readFileSync(`research/browser-temporal-assets/${row.name}.webp`);
    assert.equal(digest(bytes), row.replacementHash);
    assert.equal(row.trace.find(stage => stage.action === 'open').capture.network.find(item => item.path === '/reference-assets/open-book.webp')?.hash, row.replacementHash);
  }
}
for (const verdict of report.verdicts) {
  const [left, right] = report.rows.filter(row => row.condition === verdict.condition && row.order.join(',') === verdict.order.join(','));
  const calculated = auditTemporalObserverCut(left.trace, right.trace, { requiredAction: 'card', channel: verdict.channel });
  assert.deepEqual({ condition: verdict.condition, order: verdict.order, ...calculated }, verdict);
}
assert.equal(report.verdicts.filter(row => row.status === 'exposed-before-event').length, 2);
assert.equal(report.verdicts.every(row => row.status !== 'exposed-before-event' || row.firstDifferentAction === 'open'), true);
assert.equal(report.verdicts.filter(row => row.channel === 'actionPayload').every(row => row.status === 'revealed-at-event'), true);
console.log(JSON.stringify({ status: 'fresh', fixtures: report.rows.length, verdicts: report.verdicts.length, earlyWitnesses: 2 }));
