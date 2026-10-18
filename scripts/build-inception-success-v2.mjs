import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const assets = resolve(root, 'static/inception-assets');
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const source = process.argv[2];
const sourceStart = 39.5;
const duration = 68.65 - sourceStart;
const decodedDuration = Number((Math.round(duration * 30) / 30).toFixed(2));
const outputFile = 'strongroom-success-v2.mp4';
const output = resolve(assets, outputFile);
const previous = resolve(assets, 'strongroom-success-v1.mp4');

if (!source) throw new Error('Usage: node scripts/build-inception-success-v2.mjs <cached-film-source>; set FFMPEG_PATH if ffmpeg is not on PATH.');

execFileSync(ffmpeg, [
  '-hide_banner', '-loglevel', 'error', '-y', '-ss', String(sourceStart), '-t', String(duration), '-i', source,
  '-filter_complex', `[0:v]crop=1920:800:0:140,pad=1920:1080:0:140:black,trim=duration=${duration},setpts=PTS-STARTPTS,fps=30,format=yuv420p[v];[0:a]atrim=duration=${duration},asetpts=PTS-STARTPTS,aresample=48000[a]`,
  '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-preset', 'fast', '-crf', '21', '-maxrate', '4000k', '-bufsize', '8000k', '-threads', '2',
  '-c:a', 'aac', '-b:a', '160k', '-t', String(duration), '-movflags', '+faststart', '-map_metadata', '-1', '-metadata', 'title=Strongroom ending', output,
], { stdio: 'ignore', maxBuffer: 32 * 1024 * 1024 });

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const aacFrom = path => execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', path, '-map', '0:a:0', '-c:a', 'copy', '-f', 'adts', 'pipe:1'], { maxBuffer: 32 * 1024 * 1024 });
const outputAudio = aacFrom(output);
const v1Bytes = await readFile(previous);
if (hash(await readFile(previous)) !== '8f387fdbcad3bffd9c1bee6666ed02f37d583966fb8ea70dd1d4cb1e0bea0bf8') throw new Error('The archived v1 ending changed while building v2.');

const videoProbe = execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', output, '-map', '0:v:0', '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
void videoProbe;
const fileBytes = await readFile(output);
const manifestPath = resolve(assets, 'manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
manifest.successVideoV1 = manifest.successVideoV1 || manifest.successVideo;
manifest.successVideo = `/inception-assets/${outputFile}`;
manifest.successDurationSeconds = decodedDuration;
manifest.provenance = manifest.provenance || {};
manifest.provenance.successVideoV1 = manifest.provenance.successVideoV1 || manifest.provenance.successVideo;
manifest.provenance.successVideo = {
  kind: 'Versioned ending using the same reviewed cached source interval and framing as v1; neither video nor audio terminal fade is applied.',
  sourceDescription: 'Previously reviewed local film cache; no remote download',
  sourceIntervalSeconds: [sourceStart, 68.65],
  crop: '1920x800 at x=0,y=140; padded to 1920x1080 with black bars',
  durationSeconds: decodedDuration,
  video: 'H.264, 30 fps, yuv420p; no visual fade filter',
  visualFade: false,
  audio: '48 kHz stereo AAC at 160 kbit/s encoded from the same cached source interval without an audio fade',
  audioFade: false,
  audioSourceIntervalSeconds: [sourceStart, 68.65],
  sourceSha256: hash(await readFile(source)),
  sha256: hash(fileBytes),
  bytes: fileBytes.length,
  audioPacketStreamSha256: hash(outputAudio),
  archivedV1Sha256: hash(v1Bytes),
};
const verificationPath = resolve(root, 'docs/inception-assets-verification.json');
const verification = JSON.parse(await readFile(verificationPath, 'utf8'));
const entry = { file: outputFile, bytes: fileBytes.length, durationSeconds: decodedDuration, sha256: hash(fileBytes), sourceIntervalSeconds: [sourceStart, 68.65], audioSourceIntervalSeconds: [sourceStart, 68.65], audioPacketStreamSha256: hash(outputAudio), archivedV1Sha256: hash(v1Bytes), visualFade: false, audioFade: false };
const index = verification.findIndex(item => item.file === outputFile);
if (index >= 0) verification[index] = entry;
else verification.push(entry);
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
await writeFile(verificationPath, `${JSON.stringify(verification, null, 2)}\n`);
console.log(JSON.stringify(entry, null, 2));
