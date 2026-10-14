import 'dotenv/config';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { modelConfig } from '../server/model.mjs';
import { auditTwoClueContract, compileTwoClueRequest, parseTwoClueLabel, twoClueWorlds } from './two-clue-contract.mjs';

const worlds = twoClueWorlds();
auditTwoClueContract(worlds);
const byId = Object.fromEntries(worlds.map(world => [world.id, world]));
const stages = [[], ['uv'], ['compare'], ['uv', 'compare']];
const jobs = [1, 2].flatMap(repetition => worlds.flatMap(world => ['vague', 'explicit'].flatMap(arm => stages.map((inspected, stage) => ({ repetition, worldId: world.id, arm, stage, inspected })))));
const seed = 1775;
let randomState = seed;
const random = () => { randomState = (1664525 * randomState + 1013904223) >>> 0; return randomState / 2 ** 32; };
for (let i = jobs.length - 1; i > 0; i--) {
  const j = Math.floor(random() * (i + 1));
  [jobs[i], jobs[j]] = [jobs[j], jobs[i]];
}
const compilerHash = createHash('sha256').update(readFileSync('research/two-clue-contract.mjs')).digest('hex');
const manifestHash = createHash('sha256').update(JSON.stringify({ worlds, jobs, seed, compilerHash, model: 'openai/gpt-oss-20b', temperature: 0.3, maxCompletionTokens: 2048 })).digest('hex');
if (process.argv.includes('--dry-run')) {
  console.log(JSON.stringify({ worlds: worlds.length, jobs: jobs.length, manifestHash }, null, 2));
  process.exit(0);
}
const provider = modelConfig();
if (!provider.apiKey || provider.model !== 'openai/gpt-oss-20b') throw new Error('GPT-OSS 20B provider required.');
const path = 'research/two-clue-repeat-results.json';
const result = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {
  startedAt: new Date().toISOString(), status: 'running', model: provider.model, seed,
  compilerHash, manifestHash, worlds, jobs, observations: [], providerErrors: [],
};
if (result.manifestHash !== manifestHash) throw new Error('Existing repeat file has a different manifest.');
result.status = 'running';
const save = () => writeFileSync(path, JSON.stringify(result, null, 2));
save();
let lastCall = 0;
async function callProvider(body, key, requestHash) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const wait = 2600 - (Date.now() - lastCall);
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
    lastCall = Date.now();
    const start = performance.now();
    let response;
    try {
      response = await fetch(`${provider.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST', headers: { Authorization: `Bearer ${provider.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
      });
    } catch (error) {
      result.providerErrors.push({ key, requestHash, attempt, kind: 'network', detail: error.message }); save();
      if (attempt === 2) return { rawReply: null, latencyMs: null, attempts: attempt };
      continue;
    }
    const data = await response.json();
    if (response.ok) return { rawReply: data.choices?.[0]?.message?.content?.trim() ?? null, latencyMs: Math.round(performance.now() - start), attempts: attempt };
    result.providerErrors.push({ key, requestHash, attempt, status: response.status, detail: data.error ?? null }); save();
    if (response.status === 429) throw Object.assign(new Error('Provider rate limit; resume this manifest later.'), { status: 429 });
    const transient = response.status === 400 && /Tool choice is none, but model called a tool/i.test(data.error?.message ?? '');
    if (!transient || attempt === 2) return { rawReply: null, latencyMs: null, attempts: attempt };
  }
}
try {
  const rows = new Map(result.observations.map(row => [row.key, row]));
  assert.equal(rows.size, result.observations.length);
  for (const job of jobs) {
    const key = `${job.repetition}|${job.worldId}|${job.arm}|${job.stage}`;
    if (rows.has(key)) continue;
    const world = byId[job.worldId];
    const request = compileTwoClueRequest({ world, inspected: job.inspected, arm: job.arm });
    const body = { model: provider.model, messages: [{ role: 'system', content: request.system }, ...request.messages], temperature: request.temperature, max_completion_tokens: 2048, stream: false, reasoning_effort: 'low', include_reasoning: false };
    const requestHash = createHash('sha256').update(JSON.stringify(body)).digest('hex');
    const reply = await callProvider(body, key, requestHash);
    const parsed = parseTwoClueLabel(reply.rawReply);
    const row = {
      key, ...job, worldAnswer: world.answer, observed: request.observed, expected: request.expected,
      requestHash, body, ...reply, parsedValue: parsed.value, exactFormat: parsed.exactFormat,
      semanticCorrect: parsed.value === request.expected, exactCorrect: reply.rawReply === request.expected,
    };
    result.observations.push(row); rows.set(key, row); save();
    if (result.observations.length % 8 === 0) console.log(JSON.stringify({ done: result.observations.length, total: jobs.length, providerErrors: result.providerErrors.length }));
  }
  result.status = 'complete'; result.completedAt = new Date().toISOString(); save();
  console.log(JSON.stringify({ status: result.status, observations: result.observations.length, providerErrors: result.providerErrors.length }));
} catch (error) {
  result.status = error.status === 429 ? 'rate-limited' : 'incomplete'; result.lastError = error.message; save(); throw error;
}
