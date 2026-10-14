import 'dotenv/config';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { modelConfig } from '../server/model.mjs';
import { issueArtifact } from './handoff-contract.mjs';
import { auditChain, chainWorlds, compileChainRequest, parseChainLabel } from './chain-contract.mjs';

const worlds = chainWorlds();
auditChain(worlds);
const worldById = Object.fromEntries(worlds.map(world => [world.id, world]));
const stages = ['B-before', 'C-before', 'A', 'B-after', 'C-after'];
const seed = 411;
let randomState = seed;
const random = () => { randomState = (1664525 * randomState + 1013904223) >>> 0; return randomState / 2 ** 32; };
const worldOrder = worlds.map(world => world.id);
for (let i = worldOrder.length - 1; i > 0; i--) {
  const j = Math.floor(random() * (i + 1));
  [worldOrder[i], worldOrder[j]] = [worldOrder[j], worldOrder[i]];
}
const jobs = worldOrder.flatMap(worldId => stages.map(stage => ({ worldId, stage })));
const compilerHash = createHash('sha256').update(readFileSync('research/chain-contract.mjs')).digest('hex');
const manifestHash = createHash('sha256').update(JSON.stringify({ worlds, jobs, seed, compilerHash, model: 'openai/gpt-oss-20b', temperature: 0.3, maxCompletionTokens: 2048 })).digest('hex');
if (process.argv.includes('--dry-run')) {
  console.log(JSON.stringify({ worlds: worlds.length, jobs: jobs.length, worldOrder, manifestHash }, null, 2));
  process.exit(0);
}

const provider = modelConfig();
if (!provider.apiKey || provider.model !== 'openai/gpt-oss-20b') throw new Error('GPT-OSS 20B provider required.');
const signingKey = randomBytes(32);
const path = 'research/chain-live-results.json';
const result = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {
  startedAt: new Date().toISOString(), status: 'running', model: provider.model, seed,
  compilerHash, manifestHash, worlds, jobs, observations: [], providerErrors: [],
};
if (result.manifestHash !== manifestHash) throw new Error('Existing chain pilot file has a different manifest.');
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

function sourceArtifact(world, stage, rows) {
  if (stage === 'B-after') {
    const source = rows.get(`${world.id}|A`);
    if (!source || source.skipped || !source.parsedValue) return { skippedReason: 'A-unparseable-or-missing' };
    return { artifact: issueArtifact({ world, kind: 'seal-color', sourceRole: 'A', sourceEventId: source.key, payload: { color: source.parsedValue }, signingKey }) };
  }
  if (stage === 'C-after') {
    const source = rows.get(`${world.id}|B-after`);
    if (!source || source.skipped || !source.parsedValue) return { skippedReason: 'B-unparseable-or-missing' };
    return { artifact: issueArtifact({ world, kind: 'decoded-route', sourceRole: 'B', sourceEventId: source.key, payload: { route: source.parsedValue }, signingKey }) };
  }
  return {};
}

try {
  const rows = new Map(result.observations.map(row => [row.key, row]));
  assert.equal(rows.size, result.observations.length);
  for (const job of jobs) {
    const key = `${job.worldId}|${job.stage}`;
    if (rows.has(key)) continue;
    const world = worldById[job.worldId];
    const role = job.stage[0];
    const expected = role === 'A' ? world.color : role === 'B' ? world.route : world.vehicle;
    const { artifact, skippedReason } = sourceArtifact(world, job.stage, rows);
    if (skippedReason) {
      const row = { key, ...job, role, expected, skipped: true, skippedReason, rawReply: null, parsedValue: null };
      result.observations.push(row); rows.set(key, row); save();
      continue;
    }
    const request = compileChainRequest({ world, role, artifact, signingKey });
    const body = { model: provider.model, messages: [{ role: 'system', content: request.system }, ...request.messages], temperature: request.temperature, max_completion_tokens: 2048, stream: false, reasoning_effort: 'low', include_reasoning: false };
    const requestHash = createHash('sha256').update(JSON.stringify(body)).digest('hex');
    const reply = await callProvider(body, key, requestHash);
    const parsed = parseChainLabel({ role, rawReply: reply.rawReply });
    const row = {
      key, ...job, role, expected, skipped: false,
      requestHash, body, artifact: artifact ?? null,
      ...reply, parsedValue: parsed.value, exactFormat: parsed.exactFormat,
      factualCorrect: parsed.value === expected,
    };
    result.observations.push(row); rows.set(key, row); save();
    if (result.observations.length % 5 === 0) console.log(JSON.stringify({ done: result.observations.length, total: jobs.length, providerErrors: result.providerErrors.length }));
  }
  result.status = 'complete'; result.completedAt = new Date().toISOString(); save();
  console.log(JSON.stringify({ status: result.status, observations: result.observations.length, providerErrors: result.providerErrors.length }));
} catch (error) {
  result.status = error.status === 429 ? 'rate-limited' : 'incomplete'; result.lastError = error.message; save(); throw error;
}
