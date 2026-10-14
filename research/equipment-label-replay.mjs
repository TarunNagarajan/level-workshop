import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { equipmentModelJobs } from './equipment-model-live-plan.mjs';
import { equipmentPublication } from './equipment-model-contract.mjs';
import { canonicalEquipmentPublication } from './equipment-label-canonicalizer.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const result = JSON.parse(readFileSync('research/equipment-model-live-results.json', 'utf8'));
assert.equal(result.status, 'complete');
const jobs = new Map(equipmentModelJobs().map(job => [job.key, job]));
assert.equal(result.observations.length, jobs.size);
const rows = result.observations.map(observation => {
  const job = jobs.get(observation.key);
  assert.ok(job);
  const strict = equipmentPublication(observation.rawReply, job.payload);
  const canonical = canonicalEquipmentPublication(observation.rawReply, job.payload);
  assert.deepEqual(strict, observation.publication);
  assert.equal(strict.semantic, canonical.status !== 'rejected');
  return { key: job.key, condition: job.condition, expected: job.expected, rawReply: observation.rawReply,
    strict: strict.status, canonical: canonical.status };
});
const malicious = ['release and hold', 'not hold', 'release\nAwaiting inspection', 'The answer is release', '"release"', 'releasе'];
for (const raw of malicious) for (const job of jobs.values()) assert.equal(canonicalEquipmentPublication(raw, job.payload).status, 'rejected');
const sourceFiles = ['research/equipment-label-replay.mjs', 'research/equipment-label-canonicalizer.mjs',
  'research/equipment-label-canonicalizer.test.mjs', 'research/equipment-model-live-results.json',
  'research/equipment-model-live-plan.mjs', 'research/equipment-model-contract.mjs'];
const report = { status: 'analyzed', timing: 'Exploratory replay after the frozen live-model run; primary exact score unchanged.',
  sourceHashes: Object.fromEntries(sourceFiles.map(path => [path, hash(readFileSync(path))])),
  strictAccepted: rows.filter(row => row.strict !== 'rejected').length,
  canonicalAccepted: rows.filter(row => row.canonical !== 'rejected').length,
  malformedOutputsRejected: malicious.length * jobs.size, rows,
  scope: 'Anchored grammar over three labels and a finite malformed-output suite. It does not prove security against arbitrary model output.' };
writeFileSync('research/equipment-label-replay.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify({ status: report.status, strictAccepted: report.strictAccepted,
  canonicalAccepted: report.canonicalAccepted, malformedOutputsRejected: report.malformedOutputsRejected }));
