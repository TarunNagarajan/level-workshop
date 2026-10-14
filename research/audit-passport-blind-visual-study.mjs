import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const digest = value => createHash('sha256').update(value).digest('hex');
const report = JSON.parse(readFileSync('research/passport-blind-visual-study.json', 'utf8'));
assert.equal(report.status, 'passed');
assert.equal(report.initial.path, '/reference/research/preview');
assert.deepEqual(report.worlds.map(row => row.id), [
  'match-intact', 'match-broken', 'mismatch-intact', 'mismatch-broken',
]);
for (const [path, hash] of Object.entries(report.sourceHashes)) assert.equal(digest(readFileSync(path)), hash, `Source changed: ${path}`);
for (const [path, hash] of Object.entries(report.bundleHashes)) assert.equal(digest(readFileSync(`dist/client/${path}`)), hash, `Bundle changed: ${path}`);
for (const [name, hash] of Object.entries(report.screenshotHashes)) {
  assert.equal(digest(readFileSync(`research/browser-blind-worlds/${name}.png`)), hash, `Screenshot changed: ${name}`);
}
for (const item of report.initial.network) {
  const bundleHash = report.bundleHashes[item.path.replace(/^\//, '')];
  if (bundleHash) assert.equal(item.hash, bundleHash, `Browser received different bytes: ${item.path}`);
}
assert.equal(new Set(report.worlds.map(row => row.closedPixelHash)).size, 1);
assert.equal(new Set(report.worlds.map(row => row.closedRoundHash)).size, 1);
for (const relation of ['match', 'mismatch']) {
  const rows = report.worlds.filter(row => row.id.startsWith(`${relation}-`));
  for (const field of ['cardPixelHash', 'cardAccessibilityHash', 'cardResponseHash']) {
    assert.equal(new Set(rows.map(row => row[field])).size, 1, `${field} changed with UV status`);
  }
}
for (const status of ['intact', 'broken']) {
  const rows = report.worlds.filter(row => row.id.endsWith(`-${status}`));
  for (const field of ['uvFirstPixelHash', 'uvFirstAccessibilityHash', 'uvFirstResponseHash']) {
    assert.equal(new Set(rows.map(row => row[field])).size, 1, `${field} changed with card relation`);
  }
}
assert.notEqual(report.worlds[0].cardPixelHash, report.worlds[2].cardPixelHash);
assert.notEqual(report.worlds[0].uvFirstPixelHash, report.worlds[1].uvFirstPixelHash);
assert.equal(report.rasterControl.sameConfig, true);
assert.equal(report.rasterControl.sameRenderedText, true);
assert.equal(report.rasterControl.imageNetworkChanged, true);
assert.equal(report.rasterControl.introPixelsChanged, true);
assert.notEqual(report.rasterControl.baselinePixelHash, report.rasterControl.substitutedPixelHash);
console.log(JSON.stringify({ status: 'fresh', worlds: report.worlds.length, screenshots: Object.keys(report.screenshotHashes).length }));
