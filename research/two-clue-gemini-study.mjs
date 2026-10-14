import 'dotenv/config';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { auditTwoClueContract, compileTwoClueRequest, parseTwoClueLabel, twoClueWorlds } from './two-clue-contract.mjs';

const model = 'gemini-3.5-flash-lite';
const worlds = twoClueWorlds();
auditTwoClueContract(worlds);
const byId = Object.fromEntries(worlds.map(world => [world.id, world]));
const stages = [[], ['uv'], ['compare'], ['uv', 'compare']];
const jobs = worlds.flatMap(world => ['vague', 'explicit'].flatMap(arm => stages.map((inspected, stage) => ({ worldId: world.id, arm, stage, inspected }))));
const seed = 2773;
let randomState = seed;
const random = () => { randomState = (1664525 * randomState + 1013904223) >>> 0; return randomState / 2 ** 32; };
for (let i = jobs.length - 1; i > 0; i--) {
  const j = Math.floor(random() * (i + 1));
  [jobs[i], jobs[j]] = [jobs[j], jobs[i]];
}
function buildBody(job) {
  const request = compileTwoClueRequest({ world: byId[job.worldId], inspected: job.inspected, arm: job.arm });
  return {
    systemInstruction: { parts: [{ text: request.system }] },
    contents: request.messages.map(message => ({ role: 'user', parts: [{ text: message.content }] })),
    generationConfig: { temperature: 1, maxOutputTokens: 1024 },
  };
}
for (const arm of ['vague', 'explicit']) {
  const empty = worlds.map(world => buildBody({ worldId: world.id, arm, inspected: [] }));
  for (const body of empty) assert.deepEqual(body, empty[0]);
  const matching = worlds.find(world => world.id === 'intact-match');
  const signatureDifferent = worlds.find(world => world.id === 'intact-mismatch');
  assert.notEqual(matching.answer, signatureDifferent.answer);
  assert.deepEqual(buildBody({ worldId: matching.id, arm, inspected: ['uv'] }), buildBody({ worldId: signatureDifferent.id, arm, inspected: ['uv'] }));
  const uvDifferent = worlds.find(world => world.id === 'broken-match');
  assert.notEqual(matching.answer, uvDifferent.answer);
  assert.deepEqual(buildBody({ worldId: matching.id, arm, inspected: ['compare'] }), buildBody({ worldId: uvDifferent.id, arm, inspected: ['compare'] }));
}
const compilerHash = createHash('sha256').update(readFileSync('research/two-clue-contract.mjs')).digest('hex');
const manifestHash = createHash('sha256').update(JSON.stringify({ worlds, jobs, seed, compilerHash, model, generationConfig: { temperature: 1, maxOutputTokens: 1024 } })).digest('hex');
if (process.argv.includes('--dry-run')) {
  console.log(JSON.stringify({ worlds: worlds.length, jobs: jobs.length, manifestHash }, null, 2));
  process.exit(0);
}
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) throw new Error('GEMINI_API_KEY is not configured.');
const path = 'research/two-clue-gemini-results.json';
const result = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {
  startedAt: new Date().toISOString(), status: 'running', model, seed,
  compilerHash, manifestHash, worlds, jobs, observations: [], providerErrors: [],
};
if (result.manifestHash !== manifestHash) throw new Error('Existing Gemini two-clue file has a different manifest.');
result.status = 'running';
const save = () => writeFileSync(path, JSON.stringify(result, null, 2));
save();
let lastCall = 0;
async function callProvider(body, key, requestHash) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const wait = 8000 - (Date.now() - lastCall);
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
    lastCall = Date.now();
    const start = performance.now();
    let response;
    try {
      response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST', headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(60000),
      });
    } catch (error) {
      result.providerErrors.push({ key, requestHash, attempt, kind: 'network', detail: error.message }); save();
      if (attempt === 2) return { rawReply: null, latencyMs: null, attempts: attempt };
      continue;
    }
    const data = await response.json();
    if (response.ok) return {
      rawReply: data.candidates?.[0]?.content?.parts?.filter(part => typeof part.text === 'string').map(part => part.text).join('').trim() || null,
      latencyMs: Math.round(performance.now() - start), attempts: attempt,
      finishReason: data.candidates?.[0]?.finishReason ?? null, usageMetadata: data.usageMetadata ?? null,
    };
    result.providerErrors.push({ key, requestHash, attempt, status: response.status, detail: data.error ?? null }); save();
    if (response.status === 429) throw Object.assign(new Error('Gemini rate limit; resume this manifest later.'), { status: 429 });
    if (response.status < 500 || attempt === 2) return { rawReply: null, latencyMs: null, attempts: attempt };
  }
}
try {
  const rows = new Map(result.observations.map(row => [row.key, row]));
  assert.equal(rows.size, result.observations.length);
  for (const job of jobs) {
    const key = `${job.worldId}|${job.arm}|${job.stage}`;
    if (rows.has(key)) continue;
    const request = compileTwoClueRequest({ world: byId[job.worldId], inspected: job.inspected, arm: job.arm });
    const body = buildBody(job);
    const requestHash = createHash('sha256').update(JSON.stringify(body)).digest('hex');
    const reply = await callProvider(body, key, requestHash);
    const parsed = parseTwoClueLabel(reply.rawReply);
    const row = {
      key, ...job, worldAnswer: byId[job.worldId].answer, observed: request.observed, expected: request.expected,
      requestHash, body, ...reply, parsedValue: parsed.value, exactFormat: parsed.exactFormat,
      semanticCorrect: parsed.value === request.expected, exactCorrect: reply.rawReply === request.expected,
    };
    result.observations.push(row); rows.set(key, row); save();
    if (result.observations.length % 4 === 0) console.log(JSON.stringify({ done: result.observations.length, total: jobs.length, providerErrors: result.providerErrors.length }));
  }
  result.status = 'complete'; result.completedAt = new Date().toISOString(); save();
  console.log(JSON.stringify({ status: result.status, observations: result.observations.length, providerErrors: result.providerErrors.length }));
} catch (error) {
  result.status = error.status === 429 ? 'rate-limited' : 'incomplete'; result.lastError = error.message; save(); throw error;
}
