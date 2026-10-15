import sharp from 'sharp';
import { readdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
const path = (value) => resolve(value).replaceAll('\\', '/');
const source = path('research/diary-art-source');
const destination = path('static/diary-assets');
for (const filename of await readdir(source)) {
  if (!filename.endsWith('.png')) continue;
  const input = `${source}/${filename}`;
  const output = `${destination}/${filename.replace(/\.png$/, '.webp')}`;
  const original = await sharp(input).metadata();
  await sharp(input).webp({ quality: 86, alphaQuality: 100, effort: 6 }).toFile(output);
  const result = await sharp(output).metadata();
  console.log(`${filename}: ${original.width}x${original.height}, alpha=${Boolean(original.hasAlpha)} -> ${await stat(output).then(x => x.size)} bytes, output alpha=${Boolean(result.hasAlpha)}`);
}
