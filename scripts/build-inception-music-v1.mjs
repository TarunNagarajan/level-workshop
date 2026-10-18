import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const assets = resolve(root, 'static/inception-assets');
const sourcePath = process.argv[2];
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const expectedSourceHash = '64c6a8cde658e3ebac33b560ce82a832bd1ed3a6e44068894fade70a0c2c0975';
const sampleRate = 48_000;
const channels = 2;
const cues = [
  { key: 'calm', start: 12, end: 46 },
  { key: 'developing', start: 54, end: 92 },
  { key: 'urgent', start: 103, end: 139 },
];
const creditsCue = { key: 'credits', start: 120, end: 144.29, fadeInSeconds: 1.2, fadeOutSeconds: 6 };

if (!sourcePath) throw new Error('Usage: node scripts/build-inception-music-v1.mjs <licensed-mp3-path>; set FFMPEG_PATH if ffmpeg is not on PATH.');
const source = await readFile(sourcePath);
const sourceSha256 = createHash('sha256').update(source).digest('hex');
if (sourceSha256 !== expectedSourceHash) throw new Error(`Source audio hash did not match the reviewed download (${sourceSha256}).`);

const sourcePcm = execFileSync(ffmpeg, [
  '-hide_banner', '-loglevel', 'error', '-i', sourcePath,
  '-f', 's16le', '-acodec', 'pcm_s16le', '-ar', String(sampleRate), '-ac', String(channels), 'pipe:1',
], { maxBuffer: 128 * 1024 * 1024 });
if (sourcePcm.length % (channels * 2) !== 0) throw new Error('Decoded source did not align to complete stereo sample frames.');
const sourceSamples = new Int16Array(sourcePcm.buffer, sourcePcm.byteOffset, sourcePcm.byteLength / 2);
const encodePcm = (pcm, output) => execFileSync(ffmpeg, [
  '-hide_banner', '-loglevel', 'error', '-y', '-f', 's16le', '-ar', String(sampleRate), '-ac', String(channels), '-i', 'pipe:0',
  '-map_metadata', '-1', '-vn', '-c:a', 'libmp3lame', '-b:a', '160k', '-write_xing', '1', output,
], { input: pcm, maxBuffer: 128 * 1024 * 1024 });

for (const cue of cues) {
  const duration = cue.end - cue.start;
  const seamSeconds = 2;
  const startFrame = Math.round(cue.start * sampleRate);
  const endFrame = Math.round(cue.end * sampleRate);
  const seamFrames = seamSeconds * sampleRate;
  const outputFrames = endFrame - startFrame - seamFrames;
  if (sourceSamples.length < endFrame * channels || outputFrames <= seamFrames) throw new Error(`Decoded source is too short for ${cue.key}.`);
  const outputPcm = Buffer.allocUnsafe(outputFrames * channels * 2);
  const writeFrame = (outputIndex, sourceIndex) => {
    for (let channel = 0; channel < channels; channel++) outputPcm.writeInt16LE(sourceSamples[sourceIndex * channels + channel], (outputIndex * channels + channel) * 2);
  };

  // Crossfade the last two seconds into the first, then continue through the
  // uninterrupted middle. The final and first decoded samples now neighbor
  // each other in the original tail instead of jumping to a distant passage.
  for (let frame = 0; frame < seamFrames; frame++) {
    const fraction = frame / (seamFrames - 1);
    const tailGain = Math.cos(fraction * Math.PI / 2);
    const headGain = Math.sin(fraction * Math.PI / 2);
    for (let channel = 0; channel < channels; channel++) {
      const tail = sourceSamples[(endFrame - seamFrames + frame) * channels + channel];
      const head = sourceSamples[(startFrame + frame) * channels + channel];
      const mixed = Math.round(tail * tailGain + head * headGain);
      outputPcm.writeInt16LE(Math.max(-32768, Math.min(32767, mixed)), (frame * channels + channel) * 2);
    }
  }
  for (let frame = seamFrames; frame < outputFrames; frame++) writeFrame(frame, startFrame + frame);

  const output = resolve(assets, `strongroom-score-${cue.key}-v1.mp3`);
  encodePcm(outputPcm, output);
  const encoded = await readFile(output);
  cue.output = `/inception-assets/strongroom-score-${cue.key}-v1.mp3`;
  cue.durationSeconds = outputFrames / sampleRate;
  cue.sha256 = createHash('sha256').update(encoded).digest('hex');
  cue.bytes = encoded.length;
}

const creditsOutput = resolve(assets, 'strongroom-score-credits-v1.mp3');
const creditsStartFrame = Math.round(creditsCue.start * sampleRate);
const creditsEndFrame = Math.min(Math.round(creditsCue.end * sampleRate), sourceSamples.length / channels);
creditsCue.end = creditsEndFrame / sampleRate;
const creditsFrames = creditsEndFrame - creditsStartFrame;
const creditsPcm = Buffer.allocUnsafe(creditsFrames * channels * 2);
for (let frame = 0; frame < creditsFrames; frame++) {
  const fadeIn = Math.min(1, frame / (creditsCue.fadeInSeconds * sampleRate));
  const fadeOut = Math.min(1, (creditsFrames - frame) / (creditsCue.fadeOutSeconds * sampleRate));
  const gain = Math.min(fadeIn, fadeOut);
  for (let channel = 0; channel < channels; channel++) {
    creditsPcm.writeInt16LE(Math.round(sourceSamples[(creditsStartFrame + frame) * channels + channel] * gain), (frame * channels + channel) * 2);
  }
}
encodePcm(creditsPcm, creditsOutput);
const creditsBytes = await readFile(creditsOutput);
creditsCue.path = '/inception-assets/strongroom-score-credits-v1.mp3';
creditsCue.durationSeconds = creditsFrames / sampleRate;
creditsCue.sha256 = createHash('sha256').update(creditsBytes).digest('hex');
creditsCue.bytes = creditsBytes.length;

const decodeMetrics = (path, expectedDurationSeconds = null, checkLoop = false) => {
  const pcm = execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', path, '-f', 'f32le', '-acodec', 'pcm_f32le', '-ar', String(sampleRate), '-ac', '1', 'pipe:1'], { maxBuffer: 128 * 1024 * 1024 });
  if (pcm.length < sampleRate * 4 || pcm.length % 4 !== 0) throw new Error(`Decoded audio has an invalid PCM length: ${path}`);
  const samples = new Float32Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 4);
  const durationSeconds = samples.length / sampleRate;
  if (expectedDurationSeconds !== null && Math.abs(durationSeconds - expectedDurationSeconds) > 0.025) throw new Error(`Decoded duration ${durationSeconds.toFixed(3)}s differs from planned ${expectedDurationSeconds.toFixed(3)}s: ${path}`);

  const edgeFrames = 4_800;
  let sumSquares = 0;
  let startWindowSquares = 0;
  let endWindowSquares = 0;
  let peak = 0;
  for (let index = 0; index < samples.length; index++) {
    const value = samples[index];
    sumSquares += value * value;
    peak = Math.max(peak, Math.abs(value));
    if (index < edgeFrames) startWindowSquares += value * value;
    if (index >= samples.length - edgeFrames) endWindowSquares += value * value;
  }

  const metrics = {
    decodedSeconds: Number(durationSeconds.toFixed(3)),
    rmsDbfs: Number((20 * Math.log10(Math.sqrt(sumSquares / samples.length))).toFixed(2)),
    peakDbfs: Number((20 * Math.log10(peak)).toFixed(2)),
  };

  if (checkLoop) {
    const boundaryJump = Math.abs(samples[0] - samples[samples.length - 1]);
    const boundaryWindow = [...samples.slice(-edgeFrames), ...samples.slice(0, edgeFrames)];
    const localDifferences = [];
    for (let index = 1; index < boundaryWindow.length; index++) localDifferences.push(Math.abs(boundaryWindow[index] - boundaryWindow[index - 1]));
    localDifferences.sort((left, right) => left - right);
    const localDerivativeP99 = localDifferences[Math.floor(localDifferences.length * 0.99)];
    metrics.loopBoundaryJump = Number(boundaryJump.toFixed(8));
    metrics.localDerivativeP99 = Number(localDerivativeP99.toFixed(8));
    metrics.loopBoundaryJumpRatio = Number((boundaryJump / Math.max(localDerivativeP99, 1e-12)).toFixed(3));
    metrics.loopEdgeRmsDbfs = [
      Number((20 * Math.log10(Math.max(Math.sqrt(startWindowSquares / edgeFrames), 1e-12))).toFixed(2)),
      Number((20 * Math.log10(Math.max(Math.sqrt(endWindowSquares / edgeFrames), 1e-12))).toFixed(2)),
    ];
    metrics.loopEdgeRmsDifferenceDb = Number(Math.abs(metrics.loopEdgeRmsDbfs[0] - metrics.loopEdgeRmsDbfs[1]).toFixed(2));
    if (metrics.loopBoundaryJumpRatio > 2.5) throw new Error(`Loop boundary discontinuity is too large relative to its adjacent waveform (ratio ${metrics.loopBoundaryJumpRatio}): ${path}`);
    if (Math.min(...metrics.loopEdgeRmsDbfs) < metrics.rmsDbfs - 25) throw new Error(`Loop boundary edge is near silence compared with the cue body: ${path}`);
  }
  if (peak >= 1) throw new Error(`Decoded audio clips: ${path}`);
  return metrics;
};

for (const cue of cues) cue.metrics = decodeMetrics(resolve(assets, `strongroom-score-${cue.key}-v1.mp3`), cue.durationSeconds, true);
creditsCue.metrics = decodeMetrics(creditsOutput, creditsCue.durationSeconds);

const manifestPath = resolve(assets, 'manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
manifest.musicCues = Object.fromEntries(cues.map(cue => [cue.key, cue.output]));
manifest.creditsCue = creditsCue.path;
manifest.provenance.musicCues = {
  kind: 'versioned loop-ready edits of a user-supplied licensed score; licensing assertion supplied by the user and not independently verified',
  sourceDescription: 'User-supplied latest download; no local path is published',
  sourceSha256,
  sourceDurationSeconds: 144.29,
  decodedSourceDurationSeconds: sourceSamples.length / channels / sampleRate,
  loopSeamSeconds: 2,
  crossfadeCurve: 'sample-accurate equal-power two-second tail-to-head crossfade, followed by the uninterrupted middle; original tempo and pitch preserved',
  credits: {
    path: creditsCue.path,
    sourceSeconds: [creditsCue.start, creditsCue.end],
    durationSeconds: creditsCue.durationSeconds,
    fadeInSeconds: creditsCue.fadeInSeconds,
    fadeOutSeconds: creditsCue.fadeOutSeconds,
    bytes: creditsCue.bytes,
    sha256: creditsCue.sha256,
    looped: false,
    ...creditsCue.metrics,
  },
  sampleRate,
  channels,
  bitrate: '160 kbit/s MP3',
  cues: Object.fromEntries(cues.map(({ key, start, end, output, durationSeconds, sha256, bytes, metrics }) => [key, {
    path: output,
    sourceSeconds: [start, end],
    durationSeconds,
    bytes,
    sha256,
    ...metrics,
  }])),
};
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

const verificationPath = resolve(root, 'docs/inception-assets-verification.json');
const verification = JSON.parse(await readFile(verificationPath, 'utf8'));
for (const cue of [...cues, creditsCue]) {
  const outputPath = cue.output || cue.path;
  const file = outputPath.split('/').at(-1);
  const entry = {
    file,
    bytes: cue.bytes,
    durationSeconds: cue.durationSeconds,
    sampleRate,
    channels,
    sourceSeconds: [cue.start, cue.end],
    sha256: cue.sha256,
    ...cue.metrics,
  };
  const previousIndex = verification.findIndex(item => item.file === file);
  if (previousIndex >= 0) verification[previousIndex] = entry;
  else verification.push(entry);
}
await writeFile(verificationPath, `${JSON.stringify(verification, null, 2)}\n`);
console.log(JSON.stringify({ sourceSha256, cues: [...cues.map(({ key, start, end, durationSeconds, sha256, bytes, metrics }) => ({ key, sourceSeconds: [start, end], durationSeconds, sha256, bytes, ...metrics })), { key: 'credits', sourceSeconds: [creditsCue.start, creditsCue.end], durationSeconds: creditsCue.durationSeconds, sha256: creditsCue.sha256, bytes: creditsCue.bytes, ...creditsCue.metrics }] }, null, 2));
