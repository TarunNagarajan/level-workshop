import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import sharp from 'sharp';

const digest = value => createHash('sha256').update(value).digest('hex');
const report = JSON.parse(readFileSync('research/asset-fact-boundary-study.json', 'utf8'));
assert.equal(report.status, 'passed');
assert.equal(report.pairs.length, 4);
for (const [path, hash] of Object.entries(report.sourceHashes)) assert.equal(digest(readFileSync(path)), hash, `Source changed: ${path}`);
for (const [path, hash] of Object.entries(report.bundleHashes)) assert.equal(digest(readFileSync(`dist/client/${path}`)), hash, `Bundle changed: ${path}`);
for (const row of report.pairs) {
  const name = `${row.carrier}-${row.value.startsWith('E') ? 'match' : 'mismatch'}`;
  const cover = readFileSync(`research/browser-asset-facts/${name}.webp`);
  const screenshot = readFileSync(`research/browser-asset-facts/${name}.png`);
  assert.equal(digest(cover), row.coverByteHash);
  assert.equal(digest(screenshot), row.screenshotHash);
  assert.equal(digest(await sharp(cover).ensureAlpha().raw().toBuffer()), row.coverPixelHash);
  assert.equal(digest(await sharp(screenshot).ensureAlpha().raw().toBuffer()), row.screenshotPixelHash);
  const metadata = await sharp(cover).metadata();
  assert.equal(metadata.exif ? digest(metadata.exif) : null, row.exifHash);
  assert.equal(metadata.exif?.includes(Buffer.from(`card-signature=${row.value}`)) ?? false, row.exifContainsValue);
  assert.equal(row.network.find(item => item.path === report.witness.firstDifferingResource)?.hash, row.coverByteHash);
}
assert.equal(new Set(report.pairs.map(row => row.textHash)).size, 1);
assert.equal(new Set(report.pairs.map(row => row.accessibilityHash)).size, 1);
assert.equal(new Set(report.pairs.map(row => JSON.stringify(row.network.filter(item => item.path !== report.witness.firstDifferingResource)))).size, 1);
for (const carrier of ['raster', 'metadata']) {
  const [a, b] = report.pairs.filter(row => row.carrier === carrier);
  assert.deepEqual(a.network.filter((item, i) => item.hash !== b.network[i].hash).map(item => item.path), [report.witness.firstDifferingResource]);
  assert.notEqual(a.coverByteHash, b.coverByteHash);
  assert.equal(a.coverPixelHash === b.coverPixelHash, carrier === 'metadata');
  assert.equal(a.screenshotPixelHash === b.screenshotPixelHash, carrier === 'metadata');
  assert.equal(a.exifContainsValue && b.exifContainsValue, carrier === 'metadata');
  assert.equal(report.cuts[carrier].downloadable.status, 'exposed');
  assert.equal(report.cuts[carrier].screen.status, carrier === 'raster' ? 'exposed' : 'equivalent');
  assert.deepEqual(report.cuts[carrier].screen.differingResources, [report.witness.firstDifferingResource]);
}
console.log(JSON.stringify({ status: 'fresh', fixtures: report.pairs.length, firstDifferingResource: report.witness.firstDifferingResource }));
