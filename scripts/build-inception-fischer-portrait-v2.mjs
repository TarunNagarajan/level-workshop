import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const repo = process.cwd();
const source = resolve(repo, '../inception-production/door-source-60-150.mp4');
const fallback = resolve(repo, '../media-tools/imageio_ffmpeg/binaries/ffmpeg-win-x86_64-v7.1.exe');
const ffmpeg = process.env.FFMPEG_PATH || (existsSync(fallback) ? fallback : 'ffmpeg');
const output = resolve(repo, 'static/inception-assets/fischer-portrait-v2.webp');

if (!existsSync(source)) throw new Error(`Portrait source is missing: ${source}`);
execFileSync(ffmpeg, [
  '-hide_banner', '-loglevel', 'error', '-ss', '40', '-i', source, '-frames:v', '1',
  '-vf', 'crop=800:800:560:140,scale=256:256:flags=lanczos', '-c:v', 'libwebp', '-quality', '92', output, '-y',
], { stdio: 'ignore' });

const bytes = await readFile(output);
console.log(JSON.stringify({
  file: output,
  source: 'door-source-60-150.mp4',
  sourceTimeSeconds: 100,
  cacheWindowStartSeconds: 60,
  cacheOffsetSeconds: 40,
  crop: [560, 140, 800, 800],
  dimensions: [256, 256],
  quality: 92,
  sha256: createHash('sha256').update(bytes).digest('hex'),
}));
