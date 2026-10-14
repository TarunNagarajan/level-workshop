import 'dotenv/config';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createFixture } from '../tests/database-fixture.mjs';
import { buildCompletionBody, complete, modelConfig } from '../server/model.mjs';
import { liveGateJobs, liveGateModel, liveGateQuestion, liveGateSeed, liveGateSnapshot, liveGateWorlds } from './orchestration-gate-live-plan.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const sourceFiles = ['research/orchestration-gate-live-protocol.md', 'research/orchestration-gate-live-plan.mjs', 'research/orchestration-gate-live-plan.test.mjs', 'research/orchestration-gate-live-study.mjs', 'research/analyze-orchestration-gate-live.mjs', 'server/orchestration.mjs', 'server/orchestration-context.mjs', 'server/orchestration-contract.mjs', 'server/model.mjs'];
const sourceHashes = Object.fromEntries(sourceFiles.map(path => [path, digest(readFileSync(path))]));
const jobs = liveGateJobs();
const model = modelConfig();
assert.equal(model.model, liveGateModel);
const manifestHash = digest(JSON.stringify({ jobs, liveGateSeed, sourceHashes, model: model.model, baseUrl: model.baseUrl }));
if (process.argv.includes('--dry-run')) {
  console.log(JSON.stringify({ jobs: jobs.length, worlds: liveGateWorlds().length, manifestHash, sourceHashes }));
  process.exit(0);
}
if (!model.apiKey) throw new Error('Configured GPT-OSS 20B provider key required.');
const path = 'research/orchestration-gate-live-results.json';
const result = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {
  startedAt: new Date().toISOString(), status: 'running', model: model.model, baseUrl: model.baseUrl,
  manifestHash, sourceHashes, seed: liveGateSeed, jobs, observations: [], providerErrors: [],
};
if (result.manifestHash !== manifestHash) throw new Error('Existing result has a different locked manifest.');
const save = () => writeFileSync(path, JSON.stringify(result, null, 2));
result.status = 'running'; save();
let fixtureColor = null;
let captured = null;
let lastProviderCall = 0;
const { app, store } = await createFixture({ provider: model, completion: async input => {
  if (input.system.startsWith('SOURCE FIXTURE.')) return { text: fixtureColor, model: 'deterministic-fixture', latencyMs: 0, usage: 0 };
  captured = buildCompletionBody({ config: model, ...input });
  const wait = 2600 - (Date.now() - lastProviderCall);
  if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
  lastProviderCall = Date.now();
  return complete({ config: model, ...input });
} });
const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let cookie;
async function request(route, { method = 'GET', body } = {}) {
  const response = await fetch(`${origin}/api${route}`, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
}
const worldById = Object.fromEntries(liveGateWorlds().map(world => [world.id, world]));
const completed = new Set(result.observations.map(row => row.key));
assert.equal(completed.size, result.observations.length);
async function runJob(job) {
  const world = worldById[job.worldId];
  const created = await request('/orchestration/configs', { method: 'POST', body: {} });
  assert.equal(created.status, 201);
  const configured = await request(`/orchestration/configs/${created.body.id}`, { method: 'PUT', body: { revision: created.body.revision, draft: liveGateSnapshot(world) } });
  assert.equal(configured.status, 200);
  const started = await request(`/orchestration/configs/${created.body.id}/runs`, { method: 'POST', body: { testInput: 'Dispatch case 7.' } });
  assert.equal(started.status, 201);
  const runPath = `/orchestration/runs/${started.body.id}`;
  let source = null, share = null;
  if (job.condition.startsWith('after')) {
    fixtureColor = world.color;
    source = await request(`${runPath}/messages`, { method: 'POST', body: { lane: 'A', content: 'Read the private seal.' } });
    assert.equal(source.status, 200);
    const message = source.body.messages.at(-1);
    assert.equal(message.content, world.color);
    assert.equal(message.publication.status, 'published');
    share = await request(`${runPath}/board`, { method: 'POST', body: { messageId: message.id, targets: ['B'] } });
    assert.equal(share.status, 200);
  }
  captured = null;
  const answer = await request(`${runPath}/messages`, { method: 'POST', body: { lane: 'B', content: liveGateQuestion(world, job.condition) } });
  const body = captured;
  assert(body, 'B provider body was not captured.');
  const expected = job.condition.startsWith('before') ? 'Awaiting color.' : world.route;
  if (answer.status !== 200) return { status: answer.status, body, requestHash: digest(JSON.stringify(body)), error: answer.body.error, expected };
  const message = answer.body.messages.at(-1);
  assert.equal(message.lane, 'B'); assert.equal(message.role, 'assistant');
  return { status: 200, body, requestHash: digest(JSON.stringify(body)), rawReply: message.content,
    publication: message.publication, latencyMs: message.latencyMs, expected,
    runId: started.body.id, sourceMessageId: source?.body.messages.at(-1).id ?? null,
    boardId: share?.body.board.at(-1).id ?? null };
}
try {
  const owner = await request('/setup', { method: 'POST', body: { name: 'Gate study owner', email: 'gate-study@example.test', password: 'local-study-password' } });
  assert.equal(owner.status, 200); cookie = owner.cookie;
  for (const job of jobs) {
    const key = `${job.worldId}|${job.condition}|${job.repetition}`;
    if (completed.has(key)) continue;
    let observation;
    for (let attempt = 1; attempt <= 2; attempt++) {
      observation = await runJob(job);
      if (observation.status === 200) break;
      result.providerErrors.push({ key, attempt, status: observation.status, requestHash: observation.requestHash, error: observation.error }); save();
      if (observation.status === 429) throw Object.assign(new Error('Provider rate limit; resume identical manifest later.'), { status: 429 });
      if (observation.status !== 502) break;
    }
    result.observations.push({ key, ...job, ...observation }); completed.add(key); save();
    if (result.observations.length % 8 === 0) console.log(JSON.stringify({ done: result.observations.length, total: jobs.length, providerErrors: result.providerErrors.length }));
  }
  result.status = 'complete'; result.completedAt = new Date().toISOString(); save();
  console.log(JSON.stringify({ status: result.status, observations: result.observations.length, providerErrors: result.providerErrors.length }));
} catch (error) {
  result.status = error.status === 429 ? 'rate-limited' : 'incomplete'; result.lastError = error.message; save(); throw error;
} finally {
  await new Promise(resolve => server.close(resolve)); await store.db.close();
}
