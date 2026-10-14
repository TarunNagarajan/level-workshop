import 'dotenv/config';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { buildCompletionBody, modelConfig } from '../server/model.mjs';
import { equipmentModelJobs, equipmentModelSeed } from './equipment-model-live-plan.mjs';
import { equipmentPublication } from './equipment-model-contract.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const sources = ['research/equipment-model-live-protocol.md', 'research/equipment-model-live-plan.mjs',
  'research/equipment-model-live-plan.test.mjs', 'research/equipment-model-live-study.mjs',
  'research/analyze-equipment-model-live.mjs',
  'research/equipment-model-contract.mjs', 'research/equipment-first-use-study.json',
  'research/dynamic-evidence-fixture.mjs', 'server/model.mjs'];
const sourceHashes = Object.fromEntries(sources.map(path => [path, hash(readFileSync(path))]));
const config = modelConfig();
assert.equal(config.model, 'openai/gpt-oss-20b');
const jobs = equipmentModelJobs().map(job => ({ ...job, body: buildCompletionBody({ config, ...job.request }) }));
const manifestHash = hash(JSON.stringify({ sourceHashes, seed: equipmentModelSeed, model: config.model, baseUrl: config.baseUrl,
  jobs: jobs.map(({ key, body, expected, source }) => ({ key, body, expected, source })) }));
if (process.argv.includes('--dry-run')) {
  console.log(JSON.stringify({ status: 'preflight', jobs: jobs.length, manifestHash,
    worlds: [...new Set(jobs.map(job => job.worldId))], configured: Boolean(config.apiKey) }));
  process.exit(0);
}
if (!config.apiKey) throw new Error('Configured GPT-OSS 20B provider key required.');
const resultPath = 'research/equipment-model-live-results.json';
const result = existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, 'utf8')) : {
  startedAt: new Date().toISOString(), status: 'running', manifestHash, sourceHashes,
  model: config.model, baseUrl: config.baseUrl, seed: equipmentModelSeed,
  jobKeys: jobs.map(job => job.key), observations: [], providerErrors: [],
};
assert.equal(result.manifestHash, manifestHash, 'Existing result belongs to another manifest.');
const save = () => writeFileSync(resultPath, JSON.stringify(result, null, 2));
const completed = new Set(result.observations.map(row => row.key));
assert.equal(completed.size, result.observations.length);
let lastCallAt = 0;

async function callProvider(body, key, attempt) {
  const wait = 2600 - (Date.now() - lastCallAt);
  if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
  lastCallAt = Date.now();
  const started = performance.now();
  let response;
  try {
    response = await fetch(`${config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST', headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
    });
  } catch (error) {
    const row = { key, attempt, kind: 'network', detail: error.message, requestHash: hash(JSON.stringify(body)) };
    result.providerErrors.push(row); save();
    return { status: 'network-error', latencyMs: Math.round(performance.now() - started), error: row };
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const row = { key, attempt, status: response.status, detail: data.error ?? null, requestHash: hash(JSON.stringify(body)) };
    result.providerErrors.push(row); save();
    return { status: response.status, latencyMs: Math.round(performance.now() - started), error: row };
  }
  return { status: 200, latencyMs: Math.round(performance.now() - started),
    rawReply: typeof data.choices?.[0]?.message?.content === 'string' ? data.choices[0].message.content.trim() : null,
    model: data.model ?? config.model, usage: data.usage?.total_tokens ?? null };
}

try {
  result.status = 'running'; save();
  for (const job of jobs) {
    if (completed.has(job.key)) continue;
    let reply;
    for (let attempt = 1; attempt <= 2; attempt++) {
      reply = await callProvider(job.body, job.key, attempt);
      if (reply.status !== 400) break;
    }
    if (reply.status === 429) {
      result.status = 'rate-limited'; save();
      throw Object.assign(new Error('Provider rate limit; resume identical manifest later.'), { status: 429 });
    }
    const publication = reply.rawReply ? equipmentPublication(reply.rawReply, job.payload) : null;
    result.observations.push({ key: job.key, worldId: job.worldId, condition: job.condition,
      repetition: job.repetition, expected: job.expected, source: job.source,
      body: job.body, requestHash: hash(JSON.stringify(job.body)), ...reply, publication });
    completed.add(job.key); save();
    if (completed.size % 6 === 0) console.log(JSON.stringify({ done: completed.size, total: jobs.length, providerErrors: result.providerErrors.length }));
  }
  result.status = 'complete'; result.completedAt = new Date().toISOString(); save();
  console.log(JSON.stringify({ status: result.status, observations: result.observations.length,
    providerErrors: result.providerErrors.length }));
} catch (error) {
  if (error.status !== 429) { result.status = 'incomplete'; result.lastError = error.message; save(); }
  throw error;
}
