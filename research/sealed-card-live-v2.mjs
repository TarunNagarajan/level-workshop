import 'dotenv/config';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createFixture } from '../tests/database-fixture.mjs';
import { buildCompletionBody, complete, modelConfig } from '../server/model.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const protocolHash = digest(readFileSync(new URL('./sealed-card-live-v2-protocol.md', import.meta.url)));
const model = modelConfig();
if (model.model !== 'openai/gpt-oss-20b' || !model.apiKey) throw new Error('Configured GPT-OSS 20B provider key required.');
const path = new URL('./sealed-card-live-v2-results.json', import.meta.url);
const result = { status: 'running', startedAt: new Date().toISOString(), protocolHash, model: model.model, baseUrl: model.baseUrl, calls: [], objects: [], shares: [], audit: null };
const save = () => writeFileSync(path, JSON.stringify(result, null, 2)); save();
let currentBody = null;
const { app, store } = await createFixture({ provider: model, completion: async input => {
  currentBody = buildCompletionBody({ config: model, ...input });
  return complete({ config: model, ...input });
} });
const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
const origin = `http://127.0.0.1:${server.address().port}/api`;
let cookie;
async function request(route, method = 'GET', body) {
  const response = await fetch(origin + route, {
    method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  cookie ||= response.headers.get('set-cookie')?.split(';')[0];
  if (!response.ok) throw Object.assign(new Error(`${method} ${route}: ${data.error || response.status}`), { status: response.status });
  return data;
}
async function ask(runId, lane, stage, world, content) {
  currentBody = null;
  const run = await request(`/orchestration/runs/${runId}/messages`, 'POST', { lane, content });
  const reply = run.messages.at(-1);
  const record = { stage, world, lane, runId, providerBody: currentBody, requestHash: digest(JSON.stringify(currentBody)), rawReply: reply.content, publication: reply.publication, model: reply.model, latencyMs: reply.latencyMs };
  result.calls.push(record); save();
  return reply;
}
try {
  await request('/setup', 'POST', { name: 'Sealed live owner', email: 'sealed-live@example.test', password: 'local-study-password' });
  const config = await request('/orchestration/configs', 'POST', {});
  const draft = { title: 'Sealed card live pair', task: 'Decode the dispatch seal after a verified inspection and saved share.',
    contract: { edges: [{ sourceLane: 'A', targetLane: 'B', waitLabel: 'Awaiting color.', choices: [
      { source: 'amber', output: 'north' }, { source: 'cobalt', output: 'south' },
    ] }] },
    slots: [
      { id: 'A', name: 'Seal reader', systemPrompt: 'You are the seal reader. Use only the verified object observation. After inspection, give the observed seal color as one lowercase whole label.', temperature: 0 },
      { id: 'B', name: 'Decoder', systemPrompt: 'You are the decoder. Use only the saved handoff state. Reply with one whole label.', temperature: 0 },
      { id: 'C', name: 'Observer', systemPrompt: 'Observe only.', temperature: 0 },
    ],
  };
  await request(`/orchestration/configs/${config.id}`, 'PUT', { revision: config.revision, draft });
  const pairInput = { testInput: 'Dispatch case 8.', sourceLane: 'A', targetLane: 'B', sourceValues: ['amber', 'cobalt'], observationMode: 'sealed-card' };
  const unopened = await request(`/orchestration/configs/${config.id}/world-pairs`, 'POST', pairInput);
  result.unopenedPairId = unopened.pairId; save();
  for (const [index, world] of ['amber', 'cobalt'].entries()) {
    const before = await request(`/orchestration/runs/${unopened.runIds[index]}/world-pair`);
    if (before.pair.factValue !== null || before.pair.observed !== false) throw new Error('Unopened pair metadata exposed the fact.');
    await ask(unopened.runIds[index], 'A', 'before-open', world, 'Read the dispatch seal.');
  }
  const clean = await request(`/orchestration/configs/${config.id}/world-pairs`, 'POST', pairInput);
  result.cleanPairId = clean.pairId; save();
  for (const [index, world] of ['amber', 'cobalt'].entries()) {
    const runId = clean.runIds[index];
    const object = await request(`/orchestration/runs/${runId}/objects/dispatch-seal/open`, 'POST', {});
    result.objects.push({ world, runId, objectId: object.objectId, factValue: object.factValue, eventSeq: object.eventSeq }); save();
    const source = await ask(runId, 'A', 'after-open', world, 'Read the dispatch seal.');
    if (source.publication.status !== 'published') throw new Error(`A source reply was not publishable in ${world}.`);
    const share = await request(`/orchestration/runs/${runId}/board`, 'POST', { messageId: source.id, targets: ['B'] });
    result.shares.push({ world, runId, eventSeq: share.eventSeq, boardId: share.board.at(-1).id }); save();
    await ask(runId, 'B', 'after-share', world, 'Decode the shared seal.');
  }
  result.audit = await request(`/orchestration/world-pairs/${clean.pairId}/audit`, 'POST', { content: 'Decode the shared seal.' });
  result.scorePreviews = await Promise.all(clean.runIds.map(runId => request(`/orchestration/runs/${runId}/score-preview`)));
  result.status = 'complete'; result.completedAt = new Date().toISOString(); save();
  console.log(JSON.stringify({ status: result.status, calls: result.calls.length, audit: result.audit.status, scores: result.scorePreviews.map(item => item.status) }));
} catch (error) {
  result.status = 'incomplete'; result.error = { status: error.status ?? null, message: error.message, requestHash: currentBody ? digest(JSON.stringify(currentBody)) : null, providerBody: currentBody }; save();
  console.error(JSON.stringify({ status: result.status, calls: result.calls.length, error: result.error }));
  process.exitCode = 1;
} finally {
  await new Promise(resolve => server.close(resolve)); await store.db.close();
}
