import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

const repo = process.cwd();
const source = resolve(repo, '../inception-production/film-first75.mp4');
const fallback = resolve(repo, '../media-tools/imageio_ffmpeg/binaries/ffmpeg-win-x86_64-v7.1.exe');
const ffmpeg = process.env.FFMPEG_PATH || (existsSync(fallback) ? fallback : 'ffmpeg');
const outputRoot = resolve(repo, 'static/inception-assets');
const portraits = [
  { name: 'eames', seconds: '66.8', crop: 'crop=800:800:530:140' },
  { name: 'fischer', seconds: '45.5', crop: 'crop=800:800:330:140' },
];

for (const portrait of portraits) {
  const output = resolve(outputRoot, `${portrait.name}-portrait-v1.webp`);
  execFileSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-ss', portrait.seconds, '-i', source, '-frames:v', '1',
    '-vf', `${portrait.crop},scale=256:256:flags=lanczos`, '-c:v', 'libwebp', '-quality', '92', output, '-y',
  ], { stdio: 'ignore' });
  const bytes = await readFile(output);
  console.log(JSON.stringify({ file: output, source: 'film-first75.mp4', seconds: Number(portrait.seconds), crop: portrait.crop, dimensions: [256, 256], sha256: createHash('sha256').update(bytes).digest('hex') }));
}
