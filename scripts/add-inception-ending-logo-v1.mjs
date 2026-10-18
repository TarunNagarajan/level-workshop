import { createHash } from 'node:crypto';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = process.cwd();
const sourcePath = process.argv[2];
if (!sourcePath) throw new Error('Pass the approved original PNG path as the first argument.');
const file = 'cses-society-logo-v1.png';
const output = resolve(root, 'static/inception-assets', file);
const manifestPath = resolve(root, 'static/inception-assets/manifest.json');
const registryPath = resolve(root, 'docs/inception-assets-verification.json');
const expectedSha256 = '3a900361cae625a9fbbfdb481fc1e8a6b34fe40227d2f38a41d1166cf7ca0789';
const source = await readFile(sourcePath);
const sha256 = createHash('sha256').update(source).digest('hex');
if (sha256 !== expectedSha256) throw new Error(`Approved source hash mismatch: ${sha256}`);
if (source.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || source.readUInt32BE(16) !== 1080 || source.readUInt32BE(20) !== 1080) {
  throw new Error('Approved source must be the original 1080x1080 PNG.');
}
await copyFile(sourcePath, output);
const copied = await readFile(output);
if (!copied.equals(source)) throw new Error('Copied PNG bytes differ from the approved original.');

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
manifest.endingLogo = `/inception-assets/${file}`;
manifest.provenance.endingLogo = {
  kind: 'original user-supplied CSES logo PNG, copied byte for byte',
  dimensions: [1080, 1080],
  bytes: source.length,
  sha256,
};
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

const registry = JSON.parse(await readFile(registryPath, 'utf8'));
const entry = { file, bytes: source.length, dimensions: [1080, 1080], sha256, copiedByteForByte: true };
const old = registry.findIndex(item => item.file === file);
if (old >= 0) registry[old] = entry;
else registry.push(entry);
await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
console.log(JSON.stringify(entry, null, 2));
