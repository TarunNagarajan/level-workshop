import 'dotenv/config';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { modelConfig } from '../server/model.mjs';
import { issueArtifact } from './handoff-contract.mjs';
import { auditRoutePair, compileRouteRequest, routeWorlds } from './route-contract.mjs';

const cases = [
  { pairId: 'ridge', destination: 'East Clinic', options: [{ route: 'Ridge Road', vehicle: 'pickup truck' }, { route: 'Canal Ferry', vehicle: 'cargo van' }] },
  { pairId: 'bridge', destination: 'West Clinic', options: [{ route: 'North Bridge', vehicle: 'box truck' }, { route: 'River Shuttle', vehicle: 'delivery van' }] },
  { pairId: 'hill', destination: 'Valley Clinic', options: [{ route: 'Hill Pass', vehicle: 'utility jeep' }, { route: 'Harbor Barge', vehicle: 'cargo van' }] },
  { pairId: 'orchard', destination: 'Lakeside Clinic', options: [{ route: 'Orchard Lane', vehicle: 'pickup truck' }, { route: 'Bay Ferry', vehicle: 'compact van' }] },
  { pairId: 'quarry', destination: 'Quarry Clinic', options: [{ route: 'Quarry Road', vehicle: 'flatbed truck' }, { route: 'Creek Ferry', vehicle: 'delivery van' }] },
  { pairId: 'alpine', destination: 'Summit Clinic', options: [{ route: 'Alpine Tunnel', vehicle: 'refrigerated truck' }, { route: 'Water Taxi', vehicle: 'insulated van' }] },
  { pairId: 'causeway', destination: 'Island Clinic', options: [{ route: 'West Causeway', vehicle: 'cargo truck' }, { route: 'Island Ferry', vehicle: 'compact van' }] },
  { pairId: 'forest', destination: 'South Clinic', options: [{ route: 'Forest Track', vehicle: 'utility jeep' }, { route: 'Marsh Ferry', vehicle: 'cargo van' }] },
];
const worldsByPair = Object.fromEntries(cases.map(spec => [spec.pairId, routeWorlds(spec)]));
const arms = ['user', 'system', 'state'];
const prompt = 'Choose the vehicle for the delivery.';
const signingKey = randomBytes(32);
const jobs = [];

for (const spec of cases) {
  const worlds = worldsByPair[spec.pairId];
  auditRoutePair(worlds);
  for (const arm of arms) {
    const before = worlds.map(world => compileRouteRequest({ world, role: 'B', handoffChannel: arm, prompt }));
    assert.deepEqual(before[0], before[1], `${spec.pairId}/${arm} leaks before handoff`);
    for (const [worldIndex, world] of worlds.entries()) {
      const artifact = issueArtifact({ world, kind: 'route', sourceRole: 'A', sourceEventId: `oracle-${world.id}`, payload: { route: world.openRoute }, signingKey });
      const after = compileRouteRequest({ world, role: 'B', handoffChannel: arm, artifact, signingKey, prompt });
      assert.notDeepEqual(before[worldIndex], after, `${spec.pairId}/${arm} handoff changed nothing`);
      jobs.push({ pairId: spec.pairId, arm, worldIndex, phase: 'gated-before' });
      jobs.push({ pairId: spec.pairId, arm, worldIndex, phase: 'gated-after' });
      if (arm === 'state') jobs.push({ pairId: spec.pairId, arm, worldIndex, phase: 'full-case-before' });
    }
  }
}

let randomState = 7331;
const random = () => { randomState = (1664525 * randomState + 1013904223) >>> 0; return randomState / 2 ** 32; };
for (let i = jobs.length - 1; i > 0; i--) {
  const j = Math.floor(random() * (i + 1));
  [jobs[i], jobs[j]] = [jobs[j], jobs[i]];
}
const jobKey = job => `${job.pairId}|${job.arm}|${job.worldIndex}|${job.phase}`;
const manifestHash = createHash('sha256').update(JSON.stringify({ cases, jobs, prompt, seed: 7331 })).digest('hex');
if (process.argv.includes('--dry-run')) {
  console.log(JSON.stringify({ pairs: cases.length, jobs: jobs.length, manifestHash, firstJobs: jobs.slice(0, 5) }, null, 2));
  process.exit(0);
}

const provider = modelConfig();
if (!provider.apiKey || provider.model !== 'openai/gpt-oss-20b') throw new Error('GPT-OSS 20B provider required.');
const path = 'research/route-factorial-results.json';
const result = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {
  startedAt: new Date().toISOString(), status: 'running', model: provider.model, temperature: 0.3,
  seed: 7331, manifestHash, cases, jobs, observations: [], providerErrors: [],
};
if (result.manifestHash !== manifestHash) throw new Error('Existing study file has a different manifest.');
const save = () => writeFileSync(path, JSON.stringify(result, null, 2));
let lastCall = 0;

async function callProvider(body, requestHash, key) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const wait = 2600 - (Date.now() - lastCall);
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
    lastCall = Date.now();
    const start = performance.now();
    const response = await fetch(`${provider.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST', headers: { Authorization: `Bearer ${provider.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
    });
    const data = await response.json();
    if (response.ok) return { rawReply: data.choices?.[0]?.message?.content?.trim() ?? null, latencyMs: Math.round(performance.now() - start), attempts: attempt };
    result.providerErrors.push({ key, requestHash, attempt, status: response.status, detail: data.error ?? null }); save();
    if (response.status === 429) throw Object.assign(new Error('Provider rate limit; resume the same study file later.'), { status: 429 });
    const transient = response.status === 400 && /Tool choice is none, but model called a tool/i.test(data.error?.message ?? '');
    if (!transient || attempt === 2) return { rawReply: null, latencyMs: null, attempts: attempt };
  }
}

try {
  const seen = new Set(result.observations.map(row => row.key));
  for (const job of jobs) {
    const key = jobKey(job);
    if (seen.has(key)) continue;
    const world = worldsByPair[job.pairId][job.worldIndex];
    const artifact = job.phase === 'gated-after' ? issueArtifact({ world, kind: 'route', sourceRole: 'A', sourceEventId: `oracle-${world.id}`, payload: { route: world.openRoute }, signingKey }) : undefined;
    const request = compileRouteRequest({ world, role: 'B', visibility: job.phase === 'full-case-before' ? 'full-case' : 'gated', artifact, signingKey, handoffChannel: job.arm, prompt });
    const requestHash = createHash('sha256').update(JSON.stringify(request)).digest('hex');
    const body = { model: provider.model, messages: [{ role: 'system', content: request.system }, ...request.messages], temperature: request.temperature, max_completion_tokens: 2048, stream: false, reasoning_effort: 'low', include_reasoning: false };
    const reply = await callProvider(body, requestHash, key);
    result.observations.push({ key, ...job, expected: world.vehicle, requestHash, request, ...reply });
    seen.add(key); save();
    if (result.observations.length % 8 === 0) console.log(JSON.stringify({ done: result.observations.length, total: jobs.length, providerErrors: result.providerErrors.length }));
  }
  result.status = 'complete'; result.completedAt = new Date().toISOString(); save();
  console.log(JSON.stringify({ status: result.status, observations: result.observations.length, providerErrors: result.providerErrors.length }));
} catch (error) {
  result.status = error.status === 429 ? 'rate-limited' : 'incomplete'; result.lastError = error.message; save(); throw error;
}
