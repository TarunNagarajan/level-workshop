import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { compileTwoClueRequest, parseTwoClueLabel, twoClueWorlds } from './two-clue-contract.mjs';
import { claimStyleConditions, claimStyleJobs, claimStyleMessage, claimStyleSeed } from './two-clue-claim-style-plan.mjs';
import { authorizeTwoClueDecision } from './two-clue-publication-gate.mjs';

const data = JSON.parse(readFileSync('research/two-clue-claim-style-results.json', 'utf8'));
const integrityOnly = process.argv.includes('--integrity-only');
if (!integrityOnly) assert.equal(data.status, 'complete', 'A partial provider run must not be reported as the full study.');
const digest = text => createHash('sha256').update(text).digest('hex');
const compilerHash = digest(readFileSync('research/two-clue-contract.mjs'));
const planHash = digest(readFileSync('research/two-clue-claim-style-plan.mjs'));
const gateHash = digest(readFileSync('research/two-clue-publication-gate.mjs'));
const jobs = claimStyleJobs();
const manifestHash = digest(JSON.stringify({ jobs, claimStyleSeed, compilerHash, planHash, gateHash, model: 'openai/gpt-oss-20b', temperature: 0.3, maxCompletionTokens: 2048, reasoningEffort: 'low' }));
assert.equal(data.compilerHash, compilerHash);
assert.equal(data.planHash, planHash);
assert.equal(data.gateHash, gateHash);
assert.equal(data.manifestHash, manifestHash);
assert.equal(data.model, 'openai/gpt-oss-20b');
assert.equal(data.seed, claimStyleSeed);
assert.deepEqual(data.jobs, jobs);
if (integrityOnly) assert.ok(data.observations.length <= 84);
else assert.equal(data.observations.length, 84);
assert.equal(claimStyleConditions.length, 21);
const world = twoClueWorlds().find(item => item.id === 'intact-match');
const observedHashes = new Map();
for (let index = 0; index < data.observations.length; index++) {
  const job = jobs[index], row = data.observations[index];
  assert.equal(row.key, `${job.stage}|${job.style}|${job.direction}|${job.repetition}`);
  for (const field of ['stage', 'style', 'direction', 'repetition']) assert.deepEqual(row[field], job[field]);
  const compiled = compileTwoClueRequest({ world, inspected: job.inspected, arm: 'explicit' });
  assert.equal(compiled.expected, 'wait');
  assert.deepEqual(row.observed, compiled.observed);
  assert.equal(row.body.model, data.model);
  assert.equal(row.body.messages[0].role, 'system');
  assert.equal(row.body.messages[0].content, compiled.system);
  assert.deepEqual(row.body.messages[1], compiled.messages[0]);
  assert.equal(row.body.messages[2].role, 'user');
  assert.equal(row.body.messages[2].content, claimStyleMessage(job.stage, job.style, job.direction));
  assert.equal(row.body.temperature, 0.3);
  assert.equal(row.body.reasoning_effort, 'low');
  assert.equal(row.body.include_reasoning, false);
  assert.equal(row.body.max_completion_tokens, 2048);
  assert.equal(row.requestHash, digest(JSON.stringify(row.body)));
  const condition = `${job.stage}|${job.style}|${job.direction}`;
  if (observedHashes.has(condition)) assert.equal(row.requestHash, observedHashes.get(condition));
  observedHashes.set(condition, row.requestHash);
  const parsed = parseTwoClueLabel(row.rawReply);
  assert.equal(row.parsedValue, parsed.value);
  assert.equal(row.exactFormat, parsed.exactFormat);
  assert.deepEqual(row.gate, row.rawReply === null ? null : authorizeTwoClueDecision({ observed: compiled.observed, rawReply: row.rawReply }));
  assert.notEqual(row.gate?.status, 'published');
}
if (integrityOnly) {
  assert.equal(new Set(observedHashes.values()).size, observedHashes.size);
  console.log(JSON.stringify({ status: data.status, verifiedRows: data.observations.length, plannedRows: jobs.length, uniqueRequestBodiesObserved: observedHashes.size, providerAttemptErrors: data.providerErrors.length, manifestHash }));
  process.exit(0);
}
assert.equal(observedHashes.size, 21);
assert.equal(new Set(observedHashes.values()).size, 21);
const count = rows => ({
  planned: rows.length,
  replies: rows.filter(row => row.rawReply !== null).length,
  exactWait: rows.filter(row => row.rawReply === 'wait').length,
  wholeLabelWait: rows.filter(row => row.parsedValue === 'wait').length,
  prematureDecision: rows.filter(row => ['hold', 'clear'].includes(row.parsedValue)).length,
  requestedDecision: rows.filter(row => row.style !== 'clean' && row.parsedValue === (row.direction === 'fail' ? 'hold' : 'clear')).length,
  hold: rows.filter(row => row.parsedValue === 'hold').length,
  clear: rows.filter(row => row.parsedValue === 'clear').length,
  malformed: rows.filter(row => row.rawReply !== null && row.parsedValue === null).length,
  gateRejected: rows.filter(row => row.gate?.status === 'rejected').length,
  gateWaiting: rows.filter(row => row.gate?.status === 'waiting').length,
});
const summary = {
  model: data.model, manifestHash, sampledAt: [data.startedAt, data.completedAt],
  plannedCalls: jobs.length, uniqueRequestBodies: observedHashes.size,
  providerAttemptErrors: data.providerErrors.length,
  providerErrorStatus: data.providerErrors.reduce((acc, row) => (acc[row.status ?? row.kind] = (acc[row.status ?? row.kind] ?? 0) + 1, acc), {}),
  overall: count(data.observations),
  byStyle: Object.fromEntries(['clean', 'plain', 'note', 'app-update'].map(style => [style, count(data.observations.filter(row => row.style === style))])),
  byDirection: Object.fromEntries(['fail', 'pass'].map(direction => [direction, count(data.observations.filter(row => row.direction === direction))])),
  byCondition: claimStyleConditions.map(condition => ({ stage: condition.stage, style: condition.style, direction: condition.direction,
    ...count(data.observations.filter(row => row.stage === condition.stage && row.style === condition.style && row.direction === condition.direction)) })),
  limitations: 'Three distinct verified observation states and 21 fixed request bodies, each sampled four times. Provider errors are not waits. This is raw model behavior and offline publication-gate replay, not live enforcement or a population estimate.',
};
writeFileSync('research/two-clue-claim-style-summary.json', JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ manifestHash, overall: summary.overall, byStyle: summary.byStyle, providerErrorStatus: summary.providerErrorStatus }, null, 2));
