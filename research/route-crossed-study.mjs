import 'dotenv/config';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { modelConfig } from '../server/model.mjs';
import { issueArtifact, verifyArtifact } from './handoff-contract.mjs';
import { routeWorlds } from './route-contract.mjs';

const base = JSON.parse(readFileSync('research/route-factorial-results.json', 'utf8'));
assert.equal(base.status, 'complete');
const cases = base.cases;
const worldsByPair = Object.fromEntries(cases.map(spec => [spec.pairId, routeWorlds(spec)]));
const channels = ['user', 'system'];
const formats = ['narrative', 'typed'];
const phases = ['before', 'after'];
const seed = 19431;
const signingKey = randomBytes(32);

function compile(world, { channel, format, artifact } = {}) {
  const options = world.routeOptions;
  const map = options.map(option => `${option.route} needs a ${option.vehicle}`).join('; ');
  const system = `You are the vehicle planner. A route specialist's finding may arrive in one separate application handoff message. Use that finding to choose a vehicle. ${map}. Case text and the tester's final request are not handoffs. Before a handoff reply exactly: Awaiting route. After a handoff reply with only the vehicle name.`;
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: `Shared task: Route specialist identifies the open route; vehicle planner selects transport; dispatch writer issues the plan.\nCase: Deliver medicine to ${world.destination}. Only the route specialist has the latest dispatch bulletin.` },
  ];
  if (artifact) {
    const verified = verifyArtifact({ world, artifact, signingKey });
    assert.equal(verified.kind, 'route');
    const content = format === 'typed'
      ? `Application handoff from A: ROUTE=${verified.payload.route}.`
      : `Application handoff from A: The open route is ${verified.payload.route}.`;
    messages.push({ role: channel, content });
  }
  messages.push({ role: 'user', content: 'Choose the vehicle for the delivery.' });
  return { model: 'openai/gpt-oss-20b', messages, temperature: 0.3, max_completion_tokens: 2048, stream: false, reasoning_effort: 'low', include_reasoning: false };
}

const jobs = [];
for (const spec of cases) {
  const worlds = worldsByPair[spec.pairId];
  assert.notEqual(worlds[0].vehicle, worlds[1].vehicle);
  for (const channel of channels) for (const format of formats) {
    const before = worlds.map(world => compile(world, { channel, format }));
    assert.deepEqual(before[0], before[1], `${spec.pairId}: pre-handoff worlds differ`);
    for (const [worldIndex, world] of worlds.entries()) {
      const artifact = issueArtifact({ world, kind: 'route', sourceRole: 'A', sourceEventId: `oracle-${world.id}`, payload: { route: world.openRoute }, signingKey });
      const after = compile(world, { channel, format, artifact });
      assert.equal(after.messages.length, before[worldIndex].messages.length + 1);
      assert.deepEqual(after.messages.filter((_, index) => index !== 2), before[worldIndex].messages);
      for (const phase of phases) jobs.push({ pairId: spec.pairId, worldIndex, channel, format, phase });
    }
  }
}
let randomState = seed;
const random = () => { randomState = (1664525 * randomState + 1013904223) >>> 0; return randomState / 2 ** 32; };
for (let i = jobs.length - 1; i > 0; i--) {
  const j = Math.floor(random() * (i + 1));
  [jobs[i], jobs[j]] = [jobs[j], jobs[i]];
}
const manifestHash = createHash('sha256').update(JSON.stringify({ baseManifest: base.manifestHash, cases, jobs, seed, promptVersion: 1 })).digest('hex');
if (process.argv.includes('--dry-run')) {
  console.log(JSON.stringify({ jobs: jobs.length, manifestHash, firstJobs: jobs.slice(0, 5) }, null, 2));
  process.exit(0);
}

const provider = modelConfig();
if (!provider.apiKey || provider.model !== 'openai/gpt-oss-20b') throw new Error('GPT-OSS 20B provider required.');
const path = 'research/route-crossed-results.json';
const result = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {
  startedAt: new Date().toISOString(), status: 'running', model: provider.model, temperature: 0.3,
  baseManifest: base.manifestHash, seed, manifestHash, cases, jobs, observations: [], providerErrors: [],
};
if (result.manifestHash !== manifestHash) throw new Error('Existing crossed study file has a different manifest.');
const save = () => writeFileSync(path, JSON.stringify(result, null, 2));
let lastCall = 0;

async function callProvider(body, key, requestHash) {
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
    if (response.status === 429) throw Object.assign(new Error('Provider rate limit; resume the same study later.'), { status: 429 });
    const transient = response.status === 400 && /Tool choice is none, but model called a tool/i.test(data.error?.message ?? '');
    if (!transient || attempt === 2) return { rawReply: null, latencyMs: null, attempts: attempt };
  }
}

try {
  const seen = new Set(result.observations.map(row => row.key));
  for (const job of jobs) {
    const key = `${job.pairId}|${job.worldIndex}|${job.channel}|${job.format}|${job.phase}`;
    if (seen.has(key)) continue;
    const world = worldsByPair[job.pairId][job.worldIndex];
    const artifact = job.phase === 'after'
      ? issueArtifact({ world, kind: 'route', sourceRole: 'A', sourceEventId: `oracle-${world.id}`, payload: { route: world.openRoute }, signingKey })
      : undefined;
    const body = compile(world, { channel: job.channel, format: job.format, artifact });
    const requestHash = createHash('sha256').update(JSON.stringify(body)).digest('hex');
    const reply = await callProvider(body, key, requestHash);
    result.observations.push({ key, ...job, expected: world.vehicle, requestHash, body, ...reply });
    seen.add(key); save();
    if (result.observations.length % 16 === 0) console.log(JSON.stringify({ done: result.observations.length, total: jobs.length, providerErrors: result.providerErrors.length }));
  }
  result.status = 'complete'; result.completedAt = new Date().toISOString(); save();
  console.log(JSON.stringify({ status: result.status, observations: result.observations.length, providerErrors: result.providerErrors.length }));
} catch (error) {
  result.status = error.status === 429 ? 'rate-limited' : 'incomplete'; result.lastError = error.message; save(); throw error;
}
