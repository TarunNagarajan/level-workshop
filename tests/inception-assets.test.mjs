import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const assets = resolve('static/inception-assets');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

test('Inception film and portrait manifest hashes match versioned assets while archived ending bytes stay frozen', async () => {
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
  assert.equal(manifest.successVideo, '/inception-assets/strongroom-success-v2.mp4');
  assert.equal(manifest.successVideoV1, '/inception-assets/strongroom-success-v1.mp4');
  assert.equal(manifest.provenance.successVideo.visualFade, false);
  assert.equal(manifest.provenance.successVideo.audioFade, false);
  assert.equal(manifest.provenance.successVideo.sourceIntervalSeconds.join(','), '39.5,68.65');
  assert.deepEqual(manifest.provenance.successVideo.audioSourceIntervalSeconds, [39.5, 68.65]);
  assert.equal(manifest.provenance.successVideoV1.sha256, '8f387fdbcad3bffd9c1bee6666ed02f37d583966fb8ea70dd1d4cb1e0bea0bf8');
  assert.equal(digest(await readFile(resolve(assets, 'strongroom-success-v1.mp4'))), manifest.provenance.successVideoV1.sha256);
  assert.equal(manifest.provenance.successVideo.audioPacketStreamSha256.length, 64, 'v2 records its newly encoded unfaded AAC stream');
  assert.equal(manifest.provenance.successCaptions.sha256, 'd2d637e7a36ec244fb3ea4d1606ffa2b149bc5cba8051a33d2b89eb89d3dfb24');
  assert.equal(manifest.endingWordmark, '/inception-assets/inception-wordmark-v1.svg');
  const wordmark = await readFile(resolve(assets, 'inception-wordmark-v1.svg'));
  assert.equal(digest(wordmark), manifest.provenance.endingWordmark.sha256);
  assert.match(wordmark.toString('utf8'), /fill:#f4f3ef/);
  assert.match(manifest.provenance.endingWordmark.source, /commons\.wikimedia\.org/);
  assert.equal(manifest.endingLogo, '/inception-assets/cses-society-logo-v1.png');
  const endingLogo = await readFile(resolve(assets, 'cses-society-logo-v1.png'));
  assert.equal(digest(endingLogo), '3a900361cae625a9fbbfdb481fc1e8a6b34fe40227d2f38a41d1166cf7ca0789');
  assert.equal(digest(endingLogo), manifest.provenance.endingLogo.sha256);
  assert.deepEqual([endingLogo.readUInt32BE(16), endingLogo.readUInt32BE(20)], [1080, 1080]);
  assert.equal(manifest.provenance.endingLogo.bytes, 11768);
  assert.doesNotMatch(JSON.stringify(manifest), /528491/);
  assert.equal(manifest.gameplayLoop, '/inception-assets/strongroom-score-gameplay-v1.mp3');
  assert.equal(Object.hasOwn(manifest, 'musicCues'), false, 'archived short stages are not selected by the current runtime manifest');
  const gameplay = manifest.provenance.gameplayLoop;
  const gameplayBytes = await readFile(resolve(assets, gameplay.path.split('/').at(-1)));
  assert.equal(gameplay.looped, true);
  assert.equal(gameplay.distinctMusicalSeconds, 128);
  assert.equal(gameplay.decodedSeconds, 128);
  assert.equal(gameplay.sourceSha256, '64c6a8cde658e3ebac33b560ce82a832bd1ed3a6e44068894fade70a0c2c0975');
  assert.deepEqual(gameplay.sourceSegmentsSeconds, [[12, 132], [132, 140], [4, 12]]);
  assert.equal(gameplay.bytes, gameplayBytes.length);
  assert.equal(gameplay.sha256, digest(gameplayBytes));
  assert.ok(gameplay.durationSeconds >= 120, 'gameplay arrangement contains at least two continuous minutes');
  assert.ok(gameplay.loopBoundaryJumpRatio < 2.5, 'the decoded loop wrap is continuous');
  assert.ok(gameplay.loopEdgeRmsDifferenceDb < 4, 'the decoded loop edges have comparable energy');
  assert.ok(gameplay.editBoundaryJumpRatio < 2.5, 'the tail-to-head edit does not click');
  assert.ok(gameplay.editAdjacentRmsDifferenceDb < 8, 'the tail-to-head splice has no abrupt energy change');
  assert.ok(gameplay.peakDbfs < 0, 'gameplay master asset has no clipped samples');
  assert.doesNotMatch(gameplay.path, /528491|Hans|Zimmer/i, 'gameplay asset name reveals no protected title');
  assert.equal(manifest.creditsCue, '/inception-assets/strongroom-score-credits-tail-v2.mp3');
  assert.equal(manifest.provenance.musicCues.credits.looped, false);
  assert.deepEqual(manifest.provenance.musicCues.credits.sourceSeconds, [120, 144.256]);
  const creditsTail = manifest.provenance.musicCues.creditsTailV2;
  assert.equal(creditsTail.path, manifest.creditsCue);
  assert.equal(creditsTail.initialFadeSeconds, 0, 'the new handoff tail has no baked fade-in');
  assert.equal(creditsTail.fadeOutSeconds, 6, 'the new tail resolves with its natural end fade');
  assert.equal(creditsTail.durationSeconds, 24.256);
  assert.equal(manifest.creditsDurationSeconds, 24.256);
  assert.deepEqual(creditsTail.sourceSeconds, [120, 144.256]);
  assert.ok(Math.abs(creditsTail.decodedOpeningRmsDbfs - creditsTail.referenceFilmRmsDbfs) <= 1.1, 'decoded credits opening matches stable film loudness');
  assert.equal(creditsTail.handoff.prerollSeconds, 1.15);
  assert.equal(creditsTail.handoff.durationSeconds, 0.25);
  assert.equal(creditsTail.handoff.windowSeconds, 0.5);
  assert.ok(creditsTail.handoff.minimumCompositeWindowRmsDbfs >= creditsTail.handoff.maximumCompositeWindowRmsDbfs - 3);
  assert.ok(creditsTail.handoff.maximumCompositeWindowPeakDbfs < 0);
  assert.match(creditsTail.handoff.curve, /silent 1\.15-second cue pre-roll.*final 250 milliseconds/);
  assert.equal(manifest.provenance.musicCues.cues.calm.durationSeconds, 32);
  assert.equal(manifest.provenance.musicCues.cues.developing.durationSeconds, 36);
  assert.equal(manifest.provenance.musicCues.cues.urgent.durationSeconds, 34);
  for (const cue of Object.values(manifest.provenance.musicCues.cues)) {
    assert.equal(cue.decodedSeconds, cue.durationSeconds, `${cue.path} decoded duration`);
    assert.ok(cue.loopBoundaryJumpRatio < 2.5, `${cue.path} has a smooth decoded loop boundary`);
    assert.ok(cue.loopEdgeRmsDifferenceDb < 4, `${cue.path} loop edges have comparable energy`);
  }
  for (const cue of [...Object.values(manifest.provenance.musicCues.cues), manifest.provenance.musicCues.credits, creditsTail, gameplay]) {
    assert.ok(cue.path.endsWith('.mp3'));
    const audioBytes = await readFile(resolve(assets, cue.path.split('/').at(-1)));
    assert.equal(audioBytes.length, cue.bytes, `${cue.path} byte count`);
    assert.equal(digest(audioBytes), cue.sha256, `${cue.path} hash`);
    assert.doesNotMatch(cue.path, /528491|Hans|Zimmer/i, 'public cue names reveal no protected title');
  }
  assert.equal(digest(await readFile(resolve(assets, 'strongroom-score-credits-v1.mp3'))), '0c37dd27dde159bd934bd8df6a11b9c137735ba8ef6005520335c9477300e453', 'published credits v1 remains byte-for-byte unchanged');
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
