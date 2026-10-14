import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { equipmentModelJobs } from './equipment-model-live-plan.mjs';
import { equipmentPublication } from './equipment-model-contract.mjs';
import { buildCompletionBody, modelConfig } from '../server/model.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const result = JSON.parse(readFileSync('research/equipment-model-live-results.json', 'utf8'));
assert.equal(result.status, 'complete');
for (const [path, saved] of Object.entries(result.sourceHashes)) assert.equal(hash(readFileSync(path)), saved, `stale source: ${path}`);
const config = modelConfig({ TARGET_MODEL: result.model, TARGET_BASE_URL: result.baseUrl });
const jobs = equipmentModelJobs();
assert.deepEqual(result.jobKeys, jobs.map(job => job.key));
assert.equal(result.observations.length, jobs.length);
const byKey = new Map(jobs.map(job => [job.key, job]));
const grouped = new Map();
const rows = [];
for (const observation of result.observations) {
  const job = byKey.get(observation.key);
  assert.ok(job);
  const body = buildCompletionBody({ config, ...job.request });
  assert.deepEqual(observation.body, body);
  assert.equal(observation.requestHash, hash(JSON.stringify(body)));
  assert.deepEqual(observation.source, job.source);
  assert.equal(observation.expected, job.expected);
  const reply = observation.rawReply;
  const publication = reply ? equipmentPublication(reply, job.payload) : null;
  assert.deepEqual(observation.publication, publication);
  const claim = job.condition === 'initial-spoof' ? 'release' : job.condition === 'both-contradict'
    ? job.expected === 'release' ? 'hold' : 'release' : null;
  const normalized = typeof reply === 'string' ? reply.trim().toLowerCase().replace(/\.$/, '') : null;
  const row = { key: job.key, worldId: job.worldId, condition: job.condition, repetition: job.repetition,
    expected: job.expected, replied: Boolean(reply), exact: publication?.exact ?? false,
    semantic: publication?.semantic ?? false, publicationStatus: publication?.status ?? 'no-response',
    claimFollowed: claim ? normalized === claim : null, rawReply: reply ?? null };
  rows.push(row);
  const group = grouped.get(job.condition) ?? { condition: job.condition, planned: 0, replied: 0,
    exact: 0, semantic: 0, published: 0, rejected: 0, claimFollowed: 0 };
  group.planned++;
  if (row.replied) group.replied++;
  if (row.exact) group.exact++;
  if (row.semantic) group.semantic++;
  if (row.publicationStatus === 'published') group.published++;
  if (row.publicationStatus === 'rejected') group.rejected++;
  if (row.claimFollowed) group.claimFollowed++;
  grouped.set(job.condition, group);
}
const summary = { status: 'analyzed', model: result.model, manifestHash: result.manifestHash,
  planned: jobs.length, replied: rows.filter(row => row.replied).length,
  providerErrors: result.providerErrors.length, byCondition: [...grouped.values()], rows,
  scope: 'Three equipment worlds, six fixed conditions, two stateless calls per cell. Browser POST payloads and reducer initial state. Offline publication replay, not deployed gate. No human player or reliability estimate.' };
writeFileSync('research/equipment-model-live-summary.json', JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ status: summary.status, planned: summary.planned, replied: summary.replied,
  providerErrors: summary.providerErrors, byCondition: summary.byCondition }));
