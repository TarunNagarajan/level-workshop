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
const crossfadeSeconds = 8;
const bodyStartSeconds = 12;
const bodyEndSeconds = 132;
const tailStartSeconds = 132;
const tailEndSeconds = 140;
const headStartSeconds = 4;
const headEndSeconds = 12;
const outputFile = 'strongroom-score-gameplay-v1.mp3';
const outputPath = resolve(assets, outputFile);
const creditsOutputFile = 'strongroom-score-credits-tail-v2.mp3';
const creditsOutputPath = resolve(assets, creditsOutputFile);
const creditsStartSeconds = 120;
const creditsEndSeconds = 144.256;
const creditsFadeOutSeconds = 6;
const creditsCalibrationWindowSeconds = [2.5, 0.5];

if (!sourcePath) throw new Error('Usage: node scripts/build-inception-gameplay-loop-v1.mjs <licensed-mp3-path>; set FFMPEG_PATH if ffmpeg is not on PATH.');
const source = await readFile(sourcePath);
const sourceSha256 = createHash('sha256').update(source).digest('hex');
if (sourceSha256 !== expectedSourceHash) throw new Error(`Source audio hash did not match the reviewed download (${sourceSha256}).`);

const sourcePcm = execFileSync(ffmpeg, [
  '-hide_banner', '-loglevel', 'error', '-i', sourcePath,
  '-f', 's16le', '-acodec', 'pcm_s16le', '-ar', String(sampleRate), '-ac', String(channels), 'pipe:1',
], { maxBuffer: 192 * 1024 * 1024 });
if (sourcePcm.length % (channels * 2) !== 0) throw new Error('Decoded source did not align to complete stereo sample frames.');
const sourceSamples = new Int16Array(sourcePcm.buffer, sourcePcm.byteOffset, sourcePcm.byteLength / 2);
const frameAt = seconds => Math.round(seconds * sampleRate);
const bodyFrames = frameAt(bodyEndSeconds - bodyStartSeconds);
const fadeFrames = frameAt(crossfadeSeconds);
const outputFrames = bodyFrames + fadeFrames;
if (sourceSamples.length / channels < frameAt(tailEndSeconds)) throw new Error('Decoded source is too short for the approved gameplay edit.');
if (bodyEndSeconds !== tailStartSeconds || tailEndSeconds - tailStartSeconds !== crossfadeSeconds || headEndSeconds - headStartSeconds !== crossfadeSeconds || headEndSeconds !== bodyStartSeconds) throw new Error('Gameplay loop segments do not preserve the specified continuous loop boundary.');

const outputPcm = Buffer.allocUnsafe(outputFrames * channels * 2);
const writeSample = (outputFrame, channel, sample) => outputPcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sample))), (outputFrame * channels + channel) * 2);
for (let frame = 0; frame < bodyFrames; frame++) {
  const sourceFrame = frameAt(bodyStartSeconds) + frame;
  for (let channel = 0; channel < channels; channel++) writeSample(frame, channel, sourceSamples[sourceFrame * channels + channel]);
}
for (let frame = 0; frame < fadeFrames; frame++) {
  const fraction = frame / (fadeFrames - 1);
  const tailGain = Math.cos(fraction * Math.PI / 2);
  const headGain = Math.sin(fraction * Math.PI / 2);
  const tailFrame = frameAt(tailStartSeconds) + frame;
  const headFrame = frameAt(headStartSeconds) + frame;
  for (let channel = 0; channel < channels; channel++) {
    const sample = sourceSamples[tailFrame * channels + channel] * tailGain + sourceSamples[headFrame * channels + channel] * headGain;
    writeSample(bodyFrames + frame, channel, sample);
  }
}

execFileSync(ffmpeg, [
  '-hide_banner', '-loglevel', 'error', '-y', '-f', 's16le', '-ar', String(sampleRate), '-ac', String(channels), '-i', 'pipe:0',
  '-map_metadata', '-1', '-vn', '-c:a', 'libmp3lame', '-b:a', '160k', '-write_xing', '1', outputPath,
], { input: outputPcm, maxBuffer: 192 * 1024 * 1024 });

const encoded = await readFile(outputPath);
const sha256 = createHash('sha256').update(encoded).digest('hex');
const decoded = execFileSync(ffmpeg, [
  '-hide_banner', '-loglevel', 'error', '-i', outputPath,
  '-f', 'f32le', '-acodec', 'pcm_f32le', '-ar', String(sampleRate), '-ac', '1', 'pipe:1',
], { maxBuffer: 192 * 1024 * 1024 });
if (decoded.length % 4 !== 0) throw new Error('Decoded MP3 does not contain complete float samples.');
const samples = new Float32Array(decoded.buffer, decoded.byteOffset, decoded.byteLength / 4);
const durationSeconds = samples.length / sampleRate;
if (Math.abs(durationSeconds - 128) > 0.03) throw new Error(`Decoded gameplay loop duration ${durationSeconds.toFixed(3)}s differs from the expected 128s.`);

const rms = (start, end) => {
  let sum = 0;
  for (let index = start; index < end; index++) sum += samples[index] * samples[index];
  return Math.sqrt(sum / Math.max(1, end - start));
};
const db = value => Number((20 * Math.log10(Math.max(value, 1e-12))).toFixed(2));
const compareJump = (jump, differences) => {
  differences.sort((left, right) => left - right);
  const p99 = differences[Math.floor(differences.length * 0.99)];
  return { jump: Number(jump.toFixed(8)), localDerivativeP99: Number(p99.toFixed(8)), ratio: Number((jump / Math.max(p99, 1e-12)).toFixed(3)) };
};
const jumpRatioAt = frame => {
  const jump = Math.abs(samples[frame] - samples[frame - 1]);
  const differences = [];
  const start = Math.max(1, frame - sampleRate / 2);
  const end = Math.min(samples.length - 1, frame + sampleRate / 2);
  for (let index = start; index <= end; index++) differences.push(Math.abs(samples[index] - samples[index - 1]));
  return compareJump(jump, differences);
};
let peak = 0, sumSquares = 0;
for (const value of samples) { peak = Math.max(peak, Math.abs(value)); sumSquares += value * value; }
if (peak >= 1) throw new Error('Decoded gameplay loop clips.');
const edgeFrames = frameAt(0.5);
const edgeRmsDbfs = [db(rms(0, edgeFrames)), db(rms(samples.length - edgeFrames, samples.length))];
const joinFrame = frameAt(bodyEndSeconds - bodyStartSeconds);
const joinRmsDbfs = [db(rms(joinFrame - edgeFrames, joinFrame)), db(rms(joinFrame, joinFrame + edgeFrames))];
const wrapDifferences = [];
for (let offset = -sampleRate / 2; offset < sampleRate / 2; offset++) {
  const left = (samples.length + offset) % samples.length;
  const right = (left + 1) % samples.length;
  wrapDifferences.push(Math.abs(samples[right] - samples[left]));
}
const loopJump = compareJump(Math.abs(samples[0] - samples[samples.length - 1]), wrapDifferences);
const joinJump = jumpRatioAt(joinFrame);
const rmsDbfs = db(Math.sqrt(sumSquares / samples.length));
if (loopJump.ratio > 2.5 || joinJump.ratio > 2.5) throw new Error(`Decoded loop seam or tail-to-head edit has a sharp boundary (loop ${loopJump.ratio}, edit ${joinJump.ratio}).`);
if (Math.min(...edgeRmsDbfs) < rmsDbfs - 25) throw new Error('Gameplay loop boundary is near silence compared with the musical body.');
if (Math.abs(joinRmsDbfs[0] - joinRmsDbfs[1]) > 8) throw new Error('Gameplay edit splice has an obvious adjacent-window energy jump.');

const gameplay = {
  path: `/inception-assets/${outputFile}`,
  bytes: encoded.length,
  durationSeconds,
  sourceSegmentsSeconds: [[bodyStartSeconds, bodyEndSeconds], [tailStartSeconds, tailEndSeconds], [headStartSeconds, headEndSeconds]],
  sourceSha256,
  sha256,
  sampleRate,
  channels,
  bitrate: '160 kbit/s MP3',
  encoding: 'Metadata-free stereo MP3; original tempo and pitch preserved',
  crossfadeSeconds,
  crossfadeCurve: 'Eight-second sample-accurate equal-power tail-to-head overlap at the end of the 120-second continuous body',
  distinctMusicalSeconds: 128,
  looped: true,
  decodedSeconds: Number(durationSeconds.toFixed(3)),
  rmsDbfs,
  peakDbfs: db(peak),
  loopBoundaryJump: loopJump.jump,
  loopLocalDerivativeP99: loopJump.localDerivativeP99,
  loopBoundaryJumpRatio: loopJump.ratio,
  loopEdgeRmsDbfs: edgeRmsDbfs,
  loopEdgeRmsDifferenceDb: Number(Math.abs(edgeRmsDbfs[0] - edgeRmsDbfs[1]).toFixed(2)),
  editBoundaryJump: joinJump.jump,
  editLocalDerivativeP99: joinJump.localDerivativeP99,
  editBoundaryJumpRatio: joinJump.ratio,
  editAdjacentRmsDbfs: joinRmsDbfs,
  editAdjacentRmsDifferenceDb: Number(Math.abs(joinRmsDbfs[0] - joinRmsDbfs[1]).toFixed(2)),
};

const filmPath = resolve(assets, 'strongroom-success-v2.mp4');
const filmPcm = execFileSync(ffmpeg, [
  '-hide_banner', '-loglevel', 'error', '-i', filmPath, '-map', '0:a:0',
  '-f', 's16le', '-acodec', 'pcm_s16le', '-ar', String(sampleRate), '-ac', String(channels), 'pipe:1',
], { maxBuffer: 32 * 1024 * 1024 });
const filmSamples = new Int16Array(filmPcm.buffer, filmPcm.byteOffset, filmPcm.byteLength / 2);
const creditsStartFrame = frameAt(creditsStartSeconds);
const creditsEndFrame = frameAt(creditsEndSeconds);
const rmsFrames = (samples, startFrame, endFrame, sampleChannels) => {
  let sumSquares = 0;
  let count = 0;
  for (let frame = startFrame; frame < endFrame; frame++) {
    let mono = 0;
    for (let channel = 0; channel < sampleChannels; channel++) mono += samples[frame * sampleChannels + channel] / (32768 * Math.sqrt(sampleChannels));
    sumSquares += mono * mono;
    count++;
  }
  return Math.sqrt(sumSquares / Math.max(1, count));
};
const filmFrameCount = filmSamples.length / channels;
if (filmFrameCount < frameAt(3) || sourceSamples.length / channels < creditsEndFrame) throw new Error('The frozen ending film or licensed score does not contain the reviewed calibration intervals.');
const calibrationStart = filmFrameCount - frameAt(creditsCalibrationWindowSeconds[0]);
const calibrationEnd = filmFrameCount - frameAt(creditsCalibrationWindowSeconds[1]);
const filmCalibrationRms = rmsFrames(filmSamples, calibrationStart, calibrationEnd, channels);
const sourceCalibrationRms = rmsFrames(sourceSamples, creditsStartFrame, creditsStartFrame + (calibrationEnd - calibrationStart), channels);
const creditsCalibrationDb = 20 * Math.log10(filmCalibrationRms / sourceCalibrationRms);
const creditsCalibration = 10 ** (creditsCalibrationDb / 20);
const creditsFrames = creditsEndFrame - creditsStartFrame;
const creditsFadeFrames = frameAt(creditsFadeOutSeconds);
const creditsPcm = Buffer.allocUnsafe(creditsFrames * channels * 2);
for (let frame = 0; frame < creditsFrames; frame++) {
  const fadeOffset = frame - (creditsFrames - creditsFadeFrames);
  const fadeGain = fadeOffset <= 0 ? 1 : Math.cos((fadeOffset / creditsFadeFrames) * Math.PI / 2);
  for (let channel = 0; channel < channels; channel++) {
    const sourceSample = sourceSamples[(creditsStartFrame + frame) * channels + channel];
    const calibrated = sourceSample * creditsCalibration * fadeGain;
    creditsPcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(calibrated))), (frame * channels + channel) * 2);
  }
}
execFileSync(ffmpeg, [
  '-hide_banner', '-loglevel', 'error', '-y', '-f', 's16le', '-ar', String(sampleRate), '-ac', String(channels), '-i', 'pipe:0',
  '-map_metadata', '-1', '-vn', '-c:a', 'libmp3lame', '-b:a', '160k', '-write_xing', '1', creditsOutputPath,
], { input: creditsPcm, maxBuffer: 96 * 1024 * 1024 });
const creditsEncoded = await readFile(creditsOutputPath);
const creditsSha256 = createHash('sha256').update(creditsEncoded).digest('hex');
const creditsDecoded = execFileSync(ffmpeg, [
  '-hide_banner', '-loglevel', 'error', '-i', creditsOutputPath, '-f', 'f32le', '-acodec', 'pcm_f32le', '-ar', String(sampleRate), '-ac', '1', 'pipe:1',
], { maxBuffer: 32 * 1024 * 1024 });
if (creditsDecoded.length % 4 !== 0) throw new Error('Decoded credits tail does not contain complete float samples.');
const creditsSamples = new Float32Array(creditsDecoded.buffer, creditsDecoded.byteOffset, creditsDecoded.byteLength / 4);
const creditsDecodedSeconds = creditsSamples.length / sampleRate;
let creditsPeak = 0, creditsSumSquares = 0;
for (const sample of creditsSamples) { creditsPeak = Math.max(creditsPeak, Math.abs(sample)); creditsSumSquares += sample * sample; }
const openingFrames = frameAt(creditsCalibrationWindowSeconds[0] - creditsCalibrationWindowSeconds[1]);
const creditsOpeningRms = Math.sqrt(creditsSamples.slice(0, openingFrames).reduce((sum, sample) => sum + sample * sample, 0) / openingFrames);
const creditsOpeningRmsDbfs = Number((20 * Math.log10(creditsOpeningRms)).toFixed(3));
const creditsHandoffPcm = execFileSync(ffmpeg, [
  '-hide_banner', '-loglevel', 'error', '-i', creditsOutputPath, '-f', 's16le', '-acodec', 'pcm_s16le', '-ar', String(sampleRate), '-ac', String(channels), 'pipe:1',
], { maxBuffer: 32 * 1024 * 1024 });
const creditsHandoffSamples = new Int16Array(creditsHandoffPcm.buffer, creditsHandoffPcm.byteOffset, creditsHandoffPcm.byteLength / 2);
if (Math.abs(creditsDecodedSeconds - (creditsEndSeconds - creditsStartSeconds)) > 0.03) throw new Error(`Decoded credits tail duration ${creditsDecodedSeconds.toFixed(3)}s differs from the planned source interval.`);
if (creditsPeak >= 1) throw new Error('Calibrated credits tail clips.');
if (Math.abs(creditsOpeningRmsDbfs - 20 * Math.log10(filmCalibrationRms)) > 1.1) throw new Error(`Credits tail opening level does not match the stable film calibration window (${creditsOpeningRmsDbfs} vs ${20 * Math.log10(filmCalibrationRms)} dBFS; source ${20 * Math.log10(sourceCalibrationRms)}; gain ${creditsCalibrationDb}).`);
const creditsTail = {
  path: `/inception-assets/${creditsOutputFile}`,
  bytes: creditsEncoded.length,
  sourceSeconds: [creditsStartSeconds, creditsEndSeconds],
  sourceSha256,
  sha256: creditsSha256,
  durationSeconds: creditsEndSeconds - creditsStartSeconds,
  decodedSeconds: Number(creditsDecodedSeconds.toFixed(3)),
  sampleRate,
  channels,
  bitrate: '160 kbit/s MP3',
  looped: false,
  initialFadeSeconds: 0,
  fadeOutSeconds: creditsFadeOutSeconds,
  fadeOutCurve: 'six-second cosine fade to silence after a fixed calibration gain',
  calibrationDb: Number(creditsCalibrationDb.toFixed(3)),
  calibrationWindowSeconds: creditsCalibrationWindowSeconds,
  calibrationReference: 'mean RMS over the frozen film from 2.5 to 0.5 seconds before its decoded end, excluding its encoded terminal fade',
  referenceFilmRmsDbfs: Number((20 * Math.log10(filmCalibrationRms)).toFixed(3)),
  sourceOpeningRmsDbfs: Number((20 * Math.log10(sourceCalibrationRms)).toFixed(3)),
  decodedOpeningRmsDbfs: creditsOpeningRmsDbfs,
  rmsDbfs: Number((20 * Math.log10(Math.sqrt(creditsSumSquares / creditsSamples.length))).toFixed(2)),
  peakDbfs: Number((20 * Math.log10(creditsPeak)).toFixed(2)),
};

const handoffFrames = frameAt(0.25);
const filmTailStart = filmFrameCount - handoffFrames;
const creditsFadeStart = frameAt(0.9);
const compositeWindows = [];
for (let windowStart = 0; windowStart < handoffFrames; windowStart += frameAt(0.5)) {
  const windowEnd = Math.min(handoffFrames, windowStart + frameAt(0.5));
  let sumSquares = 0, peak = 0, count = 0;
  for (let frame = windowStart; frame < windowEnd; frame++) {
    const progress = frame / Math.max(1, handoffFrames - 1);
    const filmGain = Math.cos(progress * Math.PI / 2);
    const tailGain = Math.sin(progress * Math.PI / 2);
    const filmSample = (filmSamples[(filmTailStart + frame) * channels] + filmSamples[(filmTailStart + frame) * channels + 1]) / (32768 * Math.sqrt(channels));
    const scoreSample = (creditsHandoffSamples[(creditsFadeStart + frame) * channels] + creditsHandoffSamples[(creditsFadeStart + frame) * channels + 1]) / (32768 * Math.sqrt(channels));
    const sample = filmSample * filmGain + scoreSample * tailGain;
    peak = Math.max(peak, Math.abs(sample));
    sumSquares += sample * sample;
    count++;
  }
  compositeWindows.push({ seconds: Number(((windowEnd - windowStart) / sampleRate).toFixed(3)), rmsDbfs: Number((20 * Math.log10(Math.sqrt(sumSquares / Math.max(1, count)))).toFixed(2)), peakDbfs: Number((20 * Math.log10(peak)).toFixed(2)) });
}
const minimumCompositeDbfs = Math.min(...compositeWindows.map(window => window.rmsDbfs));
const maximumCompositeDbfs = Math.max(...compositeWindows.map(window => window.rmsDbfs));
const maximumCompositePeakDbfs = Math.max(...compositeWindows.map(window => window.peakDbfs));
if (maximumCompositePeakDbfs >= 0) throw new Error('The offline film-to-score composite clips.');
if (minimumCompositeDbfs < creditsTail.referenceFilmRmsDbfs - 3) throw new Error(`Film-to-score crossfade has a half-second level trough exceeding 3 dB (${minimumCompositeDbfs} dBFS; stable reference ${creditsTail.referenceFilmRmsDbfs} dBFS; calibration ${creditsCalibrationDb.toFixed(2)} dB; windows ${JSON.stringify(compositeWindows)}).`);

const manifestPath = resolve(assets, 'manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
delete manifest.musicCues;
delete manifest.approvedTrack;
manifest.gameplayLoop = gameplay.path;
manifest.creditsCue = creditsTail.path;
manifest.creditsDurationSeconds = creditsTail.durationSeconds;
manifest.provenance.gameplayLoop = {
  kind: 'continuous loop edit of user-supplied licensed score; licensing assertion supplied by the user and not independently verified',
  sourceDescription: 'User-supplied latest download; no local path or source title is published',
  ...gameplay,
};
manifest.provenance.musicCues.creditsTailV2 = {
  kind: 'non-looping final-score tail from the user-supplied licensed composition; licensing assertion supplied by the user and not independently verified',
  sourceDescription: 'Neutral asset name; source title and local path are intentionally omitted from public metadata',
  ...creditsTail,
  handoff: {
    prerollSeconds: 1.15,
    durationSeconds: 0.25,
    curve: 'silent 1.15-second cue pre-roll followed by one coordinated equal-power cosine native-video fade and sine WebAudio deck fade over the final 250 milliseconds',
    maximumCompositeWindowRmsDbfs: maximumCompositeDbfs,
    minimumCompositeWindowRmsDbfs: minimumCompositeDbfs,
    maximumCompositeWindowPeakDbfs: maximumCompositePeakDbfs,
    windowSeconds: 0.5,
    windows: compositeWindows,
  },
};
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

const verificationPath = resolve(root, 'docs/inception-assets-verification.json');
const verification = JSON.parse(await readFile(verificationPath, 'utf8'));
const registryEntry = {
  file: outputFile,
  bytes: gameplay.bytes,
  durationSeconds: gameplay.durationSeconds,
  sampleRate,
  channels,
  sourceSegmentsSeconds: gameplay.sourceSegmentsSeconds,
  sha256,
  ...Object.fromEntries(Object.entries(gameplay).filter(([key]) => /^(decodedSeconds|rmsDbfs|peakDbfs|loopBoundaryJump|loopLocalDerivativeP99|loopBoundaryJumpRatio|loopEdgeRmsDbfs|loopEdgeRmsDifferenceDb|editBoundaryJump|editLocalDerivativeP99|editBoundaryJumpRatio|editAdjacentRmsDbfs|editAdjacentRmsDifferenceDb)$/.test(key))),
};
const previousIndex = verification.findIndex(item => item.file === outputFile);
if (previousIndex >= 0) verification[previousIndex] = registryEntry;
else verification.push(registryEntry);
const creditsRegistryEntry = {
  file: creditsOutputFile,
  bytes: creditsTail.bytes,
  durationSeconds: creditsTail.durationSeconds,
  decodedSeconds: creditsTail.decodedSeconds,
  sampleRate,
  channels,
  sourceSeconds: creditsTail.sourceSeconds,
  sha256: creditsTail.sha256,
  initialFadeSeconds: creditsTail.initialFadeSeconds,
  fadeOutSeconds: creditsTail.fadeOutSeconds,
  calibrationDb: creditsTail.calibrationDb,
  calibrationWindowSeconds: creditsTail.calibrationWindowSeconds,
  referenceFilmRmsDbfs: creditsTail.referenceFilmRmsDbfs,
  sourceOpeningRmsDbfs: creditsTail.sourceOpeningRmsDbfs,
  decodedOpeningRmsDbfs: creditsTail.decodedOpeningRmsDbfs,
  rmsDbfs: creditsTail.rmsDbfs,
  peakDbfs: creditsTail.peakDbfs,
  handoffPrerollSeconds: 1.15,
  handoffDurationSeconds: 0.25,
  minimumCompositeWindowRmsDbfs: minimumCompositeDbfs,
  maximumCompositeWindowRmsDbfs: maximumCompositeDbfs,
  maximumCompositeWindowPeakDbfs: maximumCompositePeakDbfs,
};
const creditsPreviousIndex = verification.findIndex(item => item.file === creditsOutputFile);
if (creditsPreviousIndex >= 0) verification[creditsPreviousIndex] = creditsRegistryEntry;
else verification.push(creditsRegistryEntry);
await writeFile(verificationPath, `${JSON.stringify(verification, null, 2)}\n`);

console.log(JSON.stringify({ gameplay, creditsTail, handoff: { windows: compositeWindows, minimumCompositeDbfs, maximumCompositeDbfs, maximumCompositePeakDbfs } }, null, 2));
