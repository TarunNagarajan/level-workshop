import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { equipmentCrossedJobs } from './equipment-crossed-plan.mjs';
import { equipmentPublication } from './equipment-model-contract.mjs';
import { buildCompletionBody, modelConfig } from '../server/model.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const result = JSON.parse(readFileSync('research/equipment-crossed-results.json', 'utf8'));
assert.equal(result.status, 'complete');
for (const [path, saved] of Object.entries(result.sourceHashes)) assert.equal(hash(readFileSync(path)), saved, `stale source: ${path}`);
const config = modelConfig({ TARGET_MODEL: result.model, TARGET_BASE_URL: result.baseUrl });
const jobs = equipmentCrossedJobs();
assert.deepEqual(result.jobKeys, jobs.map(job => job.key));
assert.equal(result.observations.length, jobs.length);
const planned = new Map(jobs.map(job => [job.key, job]));
const rows = [], grouped = new Map();
for (const observation of result.observations) {
  const job = planned.get(observation.key);
  assert.ok(job);
  const body = buildCompletionBody({ config, ...job.request });
  assert.deepEqual(observation.body, body);
  assert.equal(observation.requestHash, hash(JSON.stringify(body)));
  assert.deepEqual(observation.source, job.source);
  assert.equal(observation.expected, job.expected);
  const publication = observation.rawReply ? equipmentPublication(observation.rawReply, job.payload) : null;
  assert.deepEqual(observation.publication, publication);
  const normalized = typeof observation.rawReply === 'string'
    ? observation.rawReply.trim().toLowerCase().replace(/\.$/, '') : null;
  const claimed = job.condition === 'initial-spoof' ? 'release' : job.condition === 'both-contradict'
    ? job.expected === 'release' ? 'hold' : 'release' : null;
  const row = { key: job.key, worldId: job.worldId, condition: job.condition, wording: job.wording,
    placement: job.placement, repetition: job.repetition, expected: job.expected,
    replied: Boolean(observation.rawReply), exact: publication?.exact ?? false,
    semantic: publication?.semantic ?? false, publicationStatus: publication?.status ?? 'no-response',
    claimFollowed: claimed ? normalized === claimed : null, rawReply: observation.rawReply ?? null };
  rows.push(row);
  const key = `${job.wording}|${job.placement}|${job.condition}`;
  const group = grouped.get(key) ?? { wording: job.wording, placement: job.placement, condition: job.condition,
    planned: 0, replied: 0, exact: 0, semantic: 0, rejected: 0, claimFollowed: 0 };
  group.planned++;
  if (row.replied) group.replied++;
  if (row.exact) group.exact++;
  if (row.semantic) group.semantic++;
  if (row.publicationStatus === 'rejected') group.rejected++;
  if (row.claimFollowed) group.claimFollowed++;
  grouped.set(key, group);
}
const byArm = [];
for (const wording of ['explicit', 'concise']) for (const placement of ['system', 'user']) {
  const subset = rows.filter(row => row.wording === wording && row.placement === placement);
  byArm.push({ wording, placement, planned: subset.length, replied: subset.filter(row => row.replied).length,
    exact: subset.filter(row => row.exact).length, semantic: subset.filter(row => row.semantic).length,
    claimFollowed: subset.filter(row => row.claimFollowed).length,
    rejected: subset.filter(row => row.publicationStatus === 'rejected').length });
}
const summary = { status: 'analyzed', model: result.model, manifestHash: result.manifestHash,
  planned: jobs.length, replied: rows.filter(row => row.replied).length,
  providerErrors: result.providerErrors.length, byArm, byArmCondition: [...grouped.values()], rows,
  scope: 'Three equipment worlds, four conditions, four wording/placement arms, two stateless calls per cell. Full browser POST payloads for complete states, reducer initial state. Offline gate only; no human or general reliability estimate.' };
writeFileSync('research/equipment-crossed-summary.json', JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ status: summary.status, planned: summary.planned, replied: summary.replied,
  providerErrors: summary.providerErrors, byArm: summary.byArm }));
