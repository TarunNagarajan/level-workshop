import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const assets = resolve('static/inception-assets');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

test('Inception film and portrait manifest hashes match versioned assets while approved ending bytes stay frozen', async () => {
  const manifest = JSON.parse(await readFile(resolve(assets, 'manifest.json'), 'utf8'));
  assert.equal(manifest.introVideo, '/inception-assets/strongroom-intro-v4.mp4');
  assert.equal(manifest.introDurationSeconds, 25);
  assert.equal(manifest.captions, '/inception-assets/strongroom-intro-v4.vtt');
  for (const item of ['introVideo', 'captions', 'successVideo', 'successCaptions']) {
    const path = resolve(assets, manifest[item].split('/').at(-1));
    assert.equal(digest(await readFile(path)), manifest.provenance[item].sha256, `${item} provenance hash`);
  }
  assert.equal(manifest.provenance.introVideo.actualFilmExcerptSeconds, 18);
  assert.deepEqual(manifest.provenance.introVideo.sourceSegmentsSeconds, [[66.25, 68.65], [77.5, 79.5], [88.5, 91.5], [15.6, 26.2]]);
  assert.equal(manifest.provenance.successVideo.sha256, '8f387fdbcad3bffd9c1bee6666ed02f37d583966fb8ea70dd1d4cb1e0bea0bf8');
  assert.equal(manifest.provenance.successCaptions.sha256, 'd2d637e7a36ec244fb3ea4d1606ffa2b149bc5cba8051a33d2b89eb89d3dfb24');
  assert.doesNotMatch(JSON.stringify(manifest), /528491/);
  for (const [name, path] of Object.entries(manifest.portraits)) {
    const provenance = manifest.provenance.portraits[name];
    assert.equal(digest(await readFile(resolve(assets, path.split('/').at(-1)))), provenance.sha256);
    assert.deepEqual(provenance.dimensions, [256, 256]);
  }
});
