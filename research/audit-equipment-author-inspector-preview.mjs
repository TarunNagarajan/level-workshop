import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const hash = value => createHash('sha256').update(value).digest('hex');
const report = JSON.parse(readFileSync('research/equipment-author-inspector-preview.json', 'utf8'));
assert.equal(report.status, 'passed');
for (const [path, saved] of Object.entries(report.sourceHashes)) assert.equal(hash(readFileSync(path)), saved, `stale source: ${path}`);
for (const capture of report.captures) assert.equal(hash(readFileSync(capture.file)), capture.screenshotHash, `stale screenshot: ${capture.file}`);
assert.deepEqual(report.captures.map(capture => capture.label), ['desktop', 'mobile', 'study-player']);
console.log(JSON.stringify({ status: 'fresh', sourceFiles: Object.keys(report.sourceHashes).length, screenshots: report.captures.length }));
