import 'dotenv/config';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createFixture } from '../tests/database-fixture.mjs';
import { buildCompletionBody, complete, modelConfig } from '../server/model.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const protocolHash = digest(readFileSync(new URL('./server-bound-pair-live-protocol.md', import.meta.url)));
const model = modelConfig();
if (model.model !== 'openai/gpt-oss-20b' || !model.apiKey) throw new Error('Configured GPT-OSS 20B provider key required.');
const resultPath = new URL('./server-bound-pair-live-smoke.json', import.meta.url);
const result = { status: 'running', startedAt: new Date().toISOString(), protocolHash, model: model.model, baseUrl: model.baseUrl, calls: [], shares: [], audit: null };
const save = () => writeFileSync(resultPath, JSON.stringify(result, null, 2));
save();
let currentBody = null;
const { app, store } = await createFixture({ provider: model, completion: async input => {
  currentBody = buildCompletionBody({ config: model, ...input });
  return complete({ config: model, ...input });
} });
const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
const origin = `http://127.0.0.1:${server.address().port}/api`;
let cookie;
async function request(path, method = 'GET', body) {
  const response = await fetch(origin + path, {
    method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  cookie ||= response.headers.get('set-cookie')?.split(';')[0];
  if (!response.ok) throw Object.assign(new Error(`${method} ${path}: ${data.error || response.status}`), { status: response.status });
  return data;
}
try {
  await request('/setup', 'POST', { name: 'Paired smoke owner', email: 'paired-smoke@example.test', password: 'local-smoke-password' });
  const config = await request('/orchestration/configs', 'POST', {});
  const draft = {
    title: 'Paired seal smoke', task: 'Decode the private seal after the reader shares a saved finding.',
    contract: { edges: [{ sourceLane: 'A', targetLane: 'B', waitLabel: 'Awaiting color.', choices: [
      { source: 'amber', output: 'north' }, { source: 'cobalt', output: 'south' },
    ] }] },
    slots: [
      { id: 'A', name: 'Reader', systemPrompt: 'You are the seal reader. The private seal is {{FACT}}. Reply with exactly its lowercase color: amber or cobalt. Do not explain.', temperature: 0 },
      { id: 'B', name: 'Decoder', systemPrompt: 'You are the decoder. Use the verified saved handoff state. Reply with one whole label only.', temperature: 0 },
      { id: 'C', name: 'Observer', systemPrompt: 'Observe only.', temperature: 0 },
    ],
  };
  await request(`/orchestration/configs/${config.id}`, 'PUT', { revision: config.revision, draft });
  const pair = await request(`/orchestration/configs/${config.id}/world-pairs`, 'POST', { testInput: 'Dispatch case 7.', sourceLane: 'A', targetLane: 'B', sourceValues: ['amber', 'cobalt'] });
  result.pairId = pair.pairId;
  for (const [index, fact] of ['amber', 'cobalt'].entries()) {
    const runId = pair.runIds[index];
    currentBody = null;
    const source = await request(`/orchestration/runs/${runId}/messages`, 'POST', { lane: 'A', content: 'Read the private seal.' });
    const sourceReply = source.messages.at(-1);
    result.calls.push({ world: fact, lane: 'A', requestHash: currentBody && digest(JSON.stringify(currentBody)), rawReply: sourceReply.content, publication: sourceReply.publication, model: sourceReply.model }); save();
    if (sourceReply.publication.status !== 'published') throw new Error(`A's reply was not publishable in ${fact}.`);
    const shared = await request(`/orchestration/runs/${runId}/board`, 'POST', { messageId: sourceReply.id, targets: ['B'] });
    result.shares.push({ world: fact, runId, boardId: shared.board.at(-1).id, eventSeq: shared.eventSeq }); save();
    currentBody = null;
    const recipient = await request(`/orchestration/runs/${runId}/messages`, 'POST', { lane: 'B', content: 'Decode the shared seal.' });
    const reply = recipient.messages.at(-1);
    result.calls.push({ world: fact, lane: 'B', requestHash: currentBody && digest(JSON.stringify(currentBody)), rawReply: reply.content, publication: reply.publication, model: reply.model }); save();
  }
  result.audit = await request(`/orchestration/world-pairs/${pair.pairId}/audit`, 'POST', { content: 'Decode the shared seal.' });
  result.status = 'complete'; result.completedAt = new Date().toISOString(); save();
  console.log(JSON.stringify({ status: result.status, calls: result.calls.length, sourceTruth: result.audit.sourceTruth, requestNecessity: result.audit.requestNecessity, verdict: result.audit.status }));
} catch (error) {
  result.status = 'incomplete'; result.error = { status: error.status ?? null, message: error.message }; save();
  console.error(JSON.stringify({ status: result.status, calls: result.calls.length, error: result.error }));
  process.exitCode = 1;
} finally {
  await new Promise(resolve => server.close(resolve)); await store.db.close();
}
