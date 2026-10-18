import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import sharp from 'sharp';

const repo = process.cwd();
const source = resolve(repo, 'static/inception-assets/strongroom-closed-v1.webp');
const output = resolve(repo, 'static/inception-assets/strongroom-walnut-texture-v1.webp');
const crop = { left: 1150, top: 450, width: 75, height: 270 };
const bytes = await sharp(source)
  .extract(crop)
  .resize(300, 1080, { fit: 'fill', kernel: 'lanczos3' })
  .webp({ quality: 92 })
  .toFile(output)
  .then(() => readFile(output));

console.log(JSON.stringify({
  file: output,
  source: 'strongroom-closed-v1.webp',
  sourceSha256: '9eef7b9f19ea069a9a7d1f10cd3a4466b5e370a2953439b66fcd00c265f936f3',
  crop: [crop.left, crop.top, crop.width, crop.height],
  dimensions: [300, 1080],
  quality: 92,
  bytes: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'),
}));
