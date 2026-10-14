import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const hash = value => createHash('sha256').update(value).digest('hex');
const files = ['research/author-audit-equipment.json', 'research/author-audit-passport.json'];
const before = Object.fromEntries(files.map(file => [file, hash(readFileSync(file))]));
for (const file of files) {
  const bundle = JSON.parse(readFileSync(file, 'utf8'));
  for (const [path, saved] of Object.entries({ ...bundle.reportHashes, ...bundle.compilerHashes }))
    assert.equal(hash(readFileSync(path)), saved, `${file}: stale source ${path}`);
}
execFileSync(process.execPath, ['research/build-author-audit-bundles.mjs'], { stdio: 'pipe' });
for (const file of files) assert.equal(hash(readFileSync(file)), before[file], `${file}: rebuild changed the bundle`);
console.log(JSON.stringify({ status: 'fresh', bundles: files.length,
  scenarios: files.map(file => JSON.parse(readFileSync(file, 'utf8')).scenarios.length) }));
