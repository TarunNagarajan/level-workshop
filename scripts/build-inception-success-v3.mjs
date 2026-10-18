import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

const repo = process.cwd();
const ffmpeg = 'C:/Users/ultim/Documents/Codex/2026-09-20/i-ne/work/media-tools/imageio_ffmpeg/binaries/ffmpeg-win-x86_64-v7.1.exe';
const sourceRoot = resolve(repo, '..', 'inception-production');
const film = resolve(sourceRoot, 'film-first75.mp4');
const score = 'C:/Users/ultim/Downloads/Properly Licensed Version of Audio - 528491.mp3';
const output = resolve(repo, 'static/inception-assets/strongroom-success-v3.mp4');

const expectedScoreSha256 = '64c6a8cde658e3ebac33b560ce82a832bd1ed3a6e44068894fade70a0c2c0975';
const filmSourceStart = 39.5;
const sourceFilmDuration = 29.15;
const filmFrameCount = 875;
const filmDuration = filmFrameCount / 30;
const filmEnd = filmDuration;
const overlapStart = 28;
const overlapDuration = filmEnd - overlapStart;
const scoreAtOverlapStart = 120.69225;
const scoreAtFilmEnd = scoreAtOverlapStart + overlapDuration;
const scoreEnd = 144.256;
const scoreCalibrationDb = 4.748;
const scoreTailDuration = scoreEnd - scoreAtOverlapStart;
const fullDuration = filmDuration + scoreTailDuration - overlapDuration;
const blackDuration = fullDuration - filmDuration;
const fadeTargetScoreSeconds = 126.10;
const titleFadeDuration = 0.75;
const titleBlackDuration = 0.5;
const titleFadeTime = filmEnd + (fadeTargetScoreSeconds - scoreAtFilmEnd);
const titleFadeEndTime = titleFadeTime + titleFadeDuration;
const logoTime = titleFadeEndTime + titleBlackDuration;
const logoFadeTime = fullDuration - 0.75;

const scoreBytes = await readFile(score);
const actualScoreSha256 = createHash('sha256').update(scoreBytes).digest('hex');
if (actualScoreSha256 !== expectedScoreSha256) throw new Error('The local licensed score does not match the reviewed source digest.');
for (const path of [film, score]) await stat(path);

const filters = [
  `[0:v]fps=30,trim=end_frame=${filmFrameCount},setpts=PTS-STARTPTS,crop=1920:800:0:140,pad=1920:1080:0:140:black,format=yuv420p[vfilm]`,
  `color=c=black:s=1920x1080:r=30:d=${blackDuration},trim=duration=${blackDuration},setpts=PTS-STARTPTS,format=yuv420p[vblack]`,
  '[vfilm][vblack]concat=n=2:v=1:a=0[v]',
  `[0:a]atrim=duration=${sourceFilmDuration},apad=whole_dur=${filmDuration},atrim=duration=${filmDuration},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[filmAudio]`,
  `[1:a]atrim=start=${scoreAtOverlapStart}:end=${scoreEnd},asetpts=PTS-STARTPTS,aresample=48000,volume=${scoreCalibrationDb}dB,aformat=sample_fmts=fltp:channel_layouts=stereo[scoreAudio]`,
  `[filmAudio][scoreAudio]acrossfade=d=${overlapDuration}:c1=qsin:c2=qsin,aresample=48000[a]`,
].join(';');

const args = [
  '-hide_banner', '-loglevel', 'warning', '-filter_complex_threads', '2',
  '-ss', String(filmSourceStart), '-t', String(filmDuration + 0.05), '-i', film,
  '-i', score, '-filter_complex', filters,
  '-map', '[v]', '-map', '[a]',
  '-c:v', 'libx264', '-preset', 'fast', '-crf', '19', '-maxrate', '5000k', '-bufsize', '10000k', '-threads', '2',
  '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2',
  '-movflags', '+faststart', '-map_metadata', '-1',
  '-metadata', 'title=The strongroom ending',
  '-t', String(fullDuration), '-y', output,
];

execFileSync(ffmpeg, args, { stdio: 'inherit' });
const bytes = await readFile(output);
const sha256 = createHash('sha256').update(bytes).digest('hex');
console.log(JSON.stringify({
  file: 'strongroom-success-v3.mp4',
  bytes: bytes.length,
  sha256,
  filmSourceStart,
  filmDuration,
  filmEnd,
  overlapStart,
  overlapDuration,
  scoreAtOverlapStart,
  scoreAtFilmEnd,
  scoreCalibrationDb,
  scoreEnd,
  scoreTailDuration,
  fullDuration,
  blackDuration,
  fadeTargetScoreSeconds,
  titleFadeTime,
  titleFadeEndTime,
  logoTime,
  logoFadeTime,
}, null, 2));
