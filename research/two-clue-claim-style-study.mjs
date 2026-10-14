import 'dotenv/config';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { modelConfig } from '../server/model.mjs';
import { compileTwoClueRequest, parseTwoClueLabel, twoClueWorlds } from './two-clue-contract.mjs';
import { claimStyleConditions, claimStyleJobs, claimStyleMessage, claimStyleSeed, claimStyleStages } from './two-clue-claim-style-plan.mjs';
import { authorizeTwoClueDecision } from './two-clue-publication-gate.mjs';

const worlds = Object.fromEntries(twoClueWorlds().map(world => [world.id, world]));
const jobs = claimStyleJobs();
assert.equal(claimStyleConditions.length, 21);
assert.equal(jobs.length, 84);
for (const stage of claimStyleStages) {
  const primary = compileTwoClueRequest({ world: worlds['intact-match'], inspected: stage.inspected, arm: 'explicit' });
  const twin = compileTwoClueRequest({ world: worlds[stage.oppositeWorld], inspected: stage.inspected, arm: 'explicit' });
  assert.equal(primary.expected, 'wait');
  assert.deepEqual(primary, twin, `Opposite-answer worlds differ before ${stage.id} missing inspection`);
}
const digest = text => createHash('sha256').update(text).digest('hex');
const compilerHash = digest(readFileSync('research/two-clue-contract.mjs'));
const planHash = digest(readFileSync('research/two-clue-claim-style-plan.mjs'));
const gateHash = digest(readFileSync('research/two-clue-publication-gate.mjs'));
const model = 'openai/gpt-oss-20b';
const manifestHash = digest(JSON.stringify({ jobs, claimStyleSeed, compilerHash, planHash, gateHash, model, temperature: 0.3, maxCompletionTokens: 2048, reasoningEffort: 'low' }));
if (process.argv.includes('--dry-run')) {
  console.log(JSON.stringify({ conditions: claimStyleConditions.length, jobs: jobs.length, manifestHash, compilerHash, planHash, gateHash }));
  process.exit(0);
}
const provider = modelConfig();
if (!provider.apiKey || provider.model !== model) throw new Error('Configured GPT-OSS 20B connection required.');
const path = 'research/two-clue-claim-style-results.json';
const result = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {
  startedAt: new Date().toISOString(), status: 'running', model, seed: claimStyleSeed,
  compilerHash, planHash, gateHash, manifestHash, jobs, observations: [], providerErrors: [],
};
if (result.manifestHash !== manifestHash) throw new Error('Existing result file has a different locked manifest.');
result.status = 'running';
const save = () => writeFileSync(path, JSON.stringify(result, null, 2));
save();
let lastCall = 0;
async function callProvider(body, key, requestHash) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const wait = 2600 - (Date.now() - lastCall);
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
    lastCall = Date.now();
    const started = performance.now();
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
    if (response.ok) return { rawReply: data.choices?.[0]?.message?.content?.trim() ?? null, latencyMs: Math.round(performance.now() - started), attempts: attempt };
    result.providerErrors.push({ key, requestHash, attempt, status: response.status, detail: data.error ?? null }); save();
    if (response.status === 429) throw Object.assign(new Error('Provider rate limit; resume this manifest later.'), { status: 429 });
    const transient = response.status === 400 && /Tool choice is none, but model called a tool/i.test(data.error?.message ?? '');
    if (!transient || attempt === 2) return { rawReply: null, latencyMs: null, attempts: attempt };
  }
}
try {
  const completed = new Map(result.observations.map(row => [row.key, row]));
  assert.equal(completed.size, result.observations.length);
  for (const job of jobs) {
    const key = `${job.stage}|${job.style}|${job.direction}|${job.repetition}`;
    if (completed.has(key)) continue;
    const request = compileTwoClueRequest({ world: worlds['intact-match'], inspected: job.inspected, arm: 'explicit' });
    const messages = [{ role: 'system', content: request.system }, ...request.messages];
    messages[messages.length - 1] = { role: 'user', content: claimStyleMessage(job.stage, job.style, job.direction) };
    const body = { model, messages, temperature: request.temperature, max_completion_tokens: 2048, stream: false, reasoning_effort: 'low', include_reasoning: false };
    const requestHash = digest(JSON.stringify(body));
    const reply = await callProvider(body, key, requestHash);
    const parsed = parseTwoClueLabel(reply.rawReply);
    const gate = reply.rawReply === null ? null : authorizeTwoClueDecision({ observed: request.observed, rawReply: reply.rawReply });
    result.observations.push({ key, ...job, observed: request.observed, expected: 'wait', requestHash, body,
      ...reply, parsedValue: parsed.value, exactFormat: parsed.exactFormat, gate });
    completed.set(key, result.observations.at(-1)); save();
    if (result.observations.length % 7 === 0) console.log(JSON.stringify({ done: result.observations.length, total: jobs.length, providerErrors: result.providerErrors.length }));
  }
  result.status = 'complete'; result.completedAt = new Date().toISOString(); save();
  console.log(JSON.stringify({ status: result.status, observations: result.observations.length, providerErrors: result.providerErrors.length }));
} catch (error) {
  result.status = error.status === 429 ? 'rate-limited' : 'incomplete'; result.lastError = error.message; save(); throw error;
}
