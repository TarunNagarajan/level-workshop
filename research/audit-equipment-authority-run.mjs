import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { authorityJobs } from './equipment-authority-plan.mjs';
import { buildCompletionBody, modelConfig } from '../server/model.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const result = JSON.parse(readFileSync('research/equipment-authority-results.json', 'utf8'));
assert.ok(['rate-limited', 'complete'].includes(result.status));
for (const [path, saved] of Object.entries(result.sourceHashes)) assert.equal(hash(readFileSync(path)), saved, `stale source: ${path}`);
const jobs = authorityJobs();
assert.deepEqual(result.jobKeys, jobs.map(job => job.key));
const config = modelConfig({ TARGET_MODEL: result.model, TARGET_BASE_URL: result.baseUrl });
const byKey = new Map(jobs.map(job => [job.key, job]));
assert.deepEqual(result.observations.map(row => row.key), jobs.slice(0, result.observations.length).map(job => job.key));
for (const saved of result.observations) {
  const job = byKey.get(saved.key);
  const body = buildCompletionBody({ config, ...job.request });
  assert.deepEqual(saved.body, body);
  assert.equal(saved.requestHash, hash(JSON.stringify(body)));
  assert.deepEqual(saved.source, job.source);
  assert.equal(saved.expected, job.expected);
}
for (const error of result.providerErrors) {
  const job = byKey.get(error.key);
  assert.ok(job);
  assert.equal(error.requestHash, hash(JSON.stringify(buildCompletionBody({ config, ...job.request }))));
}
console.log(JSON.stringify({ status: 'fresh', runStatus: result.status, completed: result.observations.length,
  planned: jobs.length, providerErrors: result.providerErrors.length }));
