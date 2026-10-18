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
  assert.equal(manifest.endingWordmark, '/inception-assets/inception-wordmark-v1.svg');
  const wordmark = await readFile(resolve(assets, 'inception-wordmark-v1.svg'));
  assert.equal(digest(wordmark), manifest.provenance.endingWordmark.sha256);
  assert.match(wordmark.toString('utf8'), /fill:#f4f3ef/);
  assert.match(manifest.provenance.endingWordmark.source, /commons\.wikimedia\.org/);
  assert.doesNotMatch(JSON.stringify(manifest), /528491/);
  assert.equal(manifest.creditsCue, '/inception-assets/strongroom-score-credits-v1.mp3');
  assert.equal(manifest.provenance.musicCues.credits.looped, false);
  assert.deepEqual(manifest.provenance.musicCues.credits.sourceSeconds, [120, 144.256]);
  assert.equal(manifest.provenance.musicCues.cues.calm.durationSeconds, 32);
  assert.equal(manifest.provenance.musicCues.cues.developing.durationSeconds, 36);
  assert.equal(manifest.provenance.musicCues.cues.urgent.durationSeconds, 34);
  for (const cue of Object.values(manifest.provenance.musicCues.cues)) {
    assert.equal(cue.decodedSeconds, cue.durationSeconds, `${cue.path} decoded duration`);
    assert.ok(cue.loopBoundaryJumpRatio < 2.5, `${cue.path} has a smooth decoded loop boundary`);
    assert.ok(cue.loopEdgeRmsDifferenceDb < 4, `${cue.path} loop edges have comparable energy`);
  }
  for (const cue of [...Object.values(manifest.provenance.musicCues.cues), manifest.provenance.musicCues.credits]) {
    assert.ok(cue.path.endsWith('.mp3'));
    const audioBytes = await readFile(resolve(assets, cue.path.split('/').at(-1)));
    assert.equal(audioBytes.length, cue.bytes, `${cue.path} byte count`);
    assert.equal(digest(audioBytes), cue.sha256, `${cue.path} hash`);
    assert.doesNotMatch(cue.path, /528491|Hans|Zimmer/i, 'public cue names reveal no protected title');
  }
  for (const [name, path] of Object.entries(manifest.portraits)) {
    const provenance = manifest.provenance.portraits[name];
    assert.equal(digest(await readFile(resolve(assets, path.split('/').at(-1)))), provenance.sha256);
    assert.deepEqual(provenance.dimensions, [256, 256]);
  }
  const fischerV1 = JSON.parse(await readFile(resolve(assets, 'manifest.json'), 'utf8')).provenance.portraits.fischerV1;
  assert.equal(digest(await readFile(resolve(assets, 'fischer-portrait-v1.webp'))), fischerV1.sha256);
  assert.equal(fischerV1.sha256, '2ff86b1a03a49d40612210e6a31cfb575790027dc7906f2139345125d3d52ac4');
  const fischerV2 = manifest.provenance.portraits.fischer;
  assert.equal(manifest.portraits.fischer, '/inception-assets/fischer-portrait-v2.webp');
  assert.equal(fischerV2.sourceTimeSeconds, 100);
  assert.equal(fischerV2.cacheWindowStartSeconds, 60);
  assert.equal(fischerV2.cacheOffsetSeconds, 40);
  assert.deepEqual(fischerV2.crop, [560, 140, 800, 800]);
  assert.equal(fischerV2.quality, 92);
  assert.equal(digest(await readFile(resolve(assets, 'strongroom-walnut-texture-v1.webp'))), manifest.provenance.dialogueTexture.sha256);
  assert.deepEqual(manifest.provenance.dialogueTexture.crop, [1150, 450, 75, 270]);
  assert.deepEqual(manifest.provenance.dialogueTexture.dimensions, [300, 1080]);
});
