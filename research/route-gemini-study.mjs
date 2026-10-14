import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { issueArtifact, verifyArtifact } from './handoff-contract.mjs';
import { routeWorlds } from './route-contract.mjs';

const source = JSON.parse(readFileSync('research/route-crossed-results.json', 'utf8'));
assert.equal(source.status, 'complete');
const worldsByPair = Object.fromEntries(source.cases.map(spec => [spec.pairId, routeWorlds(spec)]));
const sourceRows = new Map(source.observations.map(row => [row.key, row]));
const signingKey = randomBytes(32);
const model = process.argv.find(arg => arg.startsWith('--model='))?.slice('--model='.length) ?? 'gemini-3.8-flash';
if (!['gemini-3.8-flash', 'gemini-3.5-flash-lite'].includes(model)) throw new Error('Unsupported study model.');
const seed = model === 'gemini-3.8-flash' ? 22271 : 25371;
const jobs = [];
for (const spec of source.cases) for (const worldIndex of [0, 1]) for (const channel of ['user', 'system']) for (const format of ['narrative', 'typed']) for (const phase of ['before', 'after'])
  jobs.push({ pairId: spec.pairId, worldIndex, channel, format, phase });
let randomState = seed;
const random = () => { randomState = (1664525 * randomState + 1013904223) >>> 0; return randomState / 2 ** 32; };
for (let i = jobs.length - 1; i > 0; i--) {
  const j = Math.floor(random() * (i + 1));
  [jobs[i], jobs[j]] = [jobs[j], jobs[i]];
}

function buildBody(job) {
  const key = `${job.pairId}|${job.worldIndex}|${job.channel}|${job.format}|${job.phase}`;
  const sourceRow = sourceRows.get(key);
  assert(sourceRow, `Missing source row: ${key}`);
  const world = worldsByPair[job.pairId][job.worldIndex];
  if (job.phase === 'after') {
    const artifact = issueArtifact({ world, kind: 'route', sourceRole: 'A', sourceEventId: `oracle-${world.id}`, payload: { route: world.openRoute }, signingKey });
    const verified = verifyArtifact({ world, artifact, signingKey });
    assert(sourceRow.body.messages.some(message => message.content.includes(`Application handoff from A:`) && message.content.includes(verified.payload.route)));
  }
  let system = sourceRow.body.messages[0].content;
  const contents = [];
  for (const message of sourceRow.body.messages.slice(1)) {
    if (message.role === 'system') system += `\n${message.content}`;
    else if (message.role === 'user') contents.push({ role: 'user', parts: [{ text: message.content }] });
    else throw new Error(`Unsupported role: ${message.role}`);
  }
  return {
    systemInstruction: { parts: [{ text: system }] },
    contents,
    generationConfig: { temperature: 1, maxOutputTokens: 1024 },
  };
}

for (const spec of source.cases) for (const channel of ['user', 'system']) for (const format of ['narrative', 'typed']) {
  const pair = [0, 1].map(worldIndex => buildBody({ pairId: spec.pairId, worldIndex, channel, format, phase: 'before' }));
  assert.deepEqual(pair[0], pair[1], `${spec.pairId}/${channel}/${format}: pre-handoff Gemini requests differ`);
}
const manifestHash = createHash('sha256').update(JSON.stringify({ sourceManifest: source.manifestHash, model, seed, jobs, generationConfig: { temperature: 1, maxOutputTokens: 1024 } })).digest('hex');
if (process.argv.includes('--dry-run')) {
  console.log(JSON.stringify({ jobs: jobs.length, manifestHash, firstJobs: jobs.slice(0, 5) }, null, 2));
  process.exit(0);
}

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) throw new Error('GEMINI_API_KEY is not configured.');
const path = model === 'gemini-3.8-flash' ? 'research/route-gemini-results.json' : 'research/route-gemini-35lite-results.json';
const result = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {
  startedAt: new Date().toISOString(), status: 'running', model, sourceManifest: source.manifestHash,
  seed, manifestHash, cases: source.cases, jobs, observations: [], providerErrors: [],
};
if (result.manifestHash !== manifestHash) throw new Error('Existing Gemini study file has a different manifest.');
const save = () => writeFileSync(path, JSON.stringify(result, null, 2));
let lastCall = 0;

async function callProvider(body, key, requestHash) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const wait = (model === 'gemini-3.8-flash' ? 15000 : 8000) - (Date.now() - lastCall);
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
    if (response.status === 429) throw Object.assign(new Error('Gemini rate limit; resume the same manifest later.'), { status: 429 });
    if (response.status < 500 || attempt === 2) return { rawReply: null, latencyMs: null, attempts: attempt };
  }
}

try {
  const seen = new Set(result.observations.map(row => row.key));
  for (const job of jobs) {
    const key = `${job.pairId}|${job.worldIndex}|${job.channel}|${job.format}|${job.phase}`;
    if (seen.has(key)) continue;
    const body = buildBody(job);
    const requestHash = createHash('sha256').update(JSON.stringify(body)).digest('hex');
    const reply = await callProvider(body, key, requestHash);
    const world = worldsByPair[job.pairId][job.worldIndex];
    result.observations.push({ key, ...job, expected: world.vehicle, requestHash, body, ...reply });
    seen.add(key); save();
    if (result.observations.length % 8 === 0) console.log(JSON.stringify({ done: result.observations.length, total: jobs.length, providerErrors: result.providerErrors.length }));
  }
  result.status = 'complete'; result.completedAt = new Date().toISOString(); save();
  console.log(JSON.stringify({ status: result.status, observations: result.observations.length, providerErrors: result.providerErrors.length }));
} catch (error) {
  result.status = error.status === 429 ? 'rate-limited' : 'incomplete'; result.lastError = error.message; save(); throw error;
}
