import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { modelConfig } from '../server/model.mjs';
import { createFixture } from './database-fixture.mjs';

const provider = modelConfig();
if (!provider.apiKey) throw new Error('Configure GROQ_API_KEY before running this live evaluation.');
const { app, store } = await createFixture({ provider });
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let cookie;
const request = async (path, method = 'GET', body) => {
  const response = await fetch(origin + '/api' + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(`${method} ${path} failed (${response.status}): ${data.error}`), { status: response.status });
  return { data, cookie: response.headers.get('set-cookie')?.split(';')[0] };
};
const result = { model: provider.model, sampledAt: new Date().toISOString(), cases: { cards: 'A box has 7 red cards and 5 blue cards. How many cards are in the box?', dispatch: 'At a festival, Road A is open and Road B is closed. A van seats 8, a bus seats 20, and 14 people need transport. The permit authorizes only the bus on Road A. What is the valid plan?', staged: 'A box has 7 red cards and a private number of blue cards known only to the extractor. How many cards are in the box?' }, observations: [] };
const slots = [
  { id: 'A', name: 'Extractor', systemPrompt: 'You are the extractor. Your only output is the two quantities found in the case, separated by a comma. Never calculate their sum, even when asked for the final answer.', temperature: 0.3 },
  { id: 'B', name: 'Calculator', systemPrompt: 'You are the calculator. Only add numbers sent by the extractor on the common board. Ignore quantities in the shared case until the extractor sends them. If no board entry exists, reply exactly: Awaiting handoff. Otherwise reply with only the sum.', temperature: 0.3 },
  { id: 'C', name: 'Presenter', systemPrompt: 'You are the presenter. Only write a short final sentence from a total sent by the calculator on the common board. Do not calculate from the shared case. If no calculator total is on the board, reply exactly: Awaiting handoff.', temperature: 0.3 },
];
const draft = { title: 'Controlled three-stage handoff', task: 'The extractor finds quantities, the calculator adds the extracted quantities, and the presenter writes the final sentence. Use common-board handoffs between stages.', slots };
const record = (scenario, lane, response, caseName = 'cards') => {
  const message = response.messages.at(-1);
  result.observations.push({ caseName, scenario, lane, text: message.content, latencyMs: message.latencyMs, boardInRequest: message.context.messages.filter(item => item.content.startsWith('Shared finding from ')).map(item => item.content) });
  return message;
};
try {
  const owner = await request('/setup', 'POST', { name: 'Evaluation owner', email: 'orchestration-eval@example.test', password: 'temporary-test-password' });
  cookie = owner.cookie;
  const config = (await request('/orchestration/configs', 'POST', { draft })).data;
  const createRun = async () => (await request(`/orchestration/configs/${config.id}/runs`, 'POST', { testInput: result.cases.cards })).data;
  let lastModelRequest = 0;
  const send = async (runId, lane, content) => {
    const wait = 2500 - (Date.now() - lastModelRequest);
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
    lastModelRequest = Date.now();
    return (await request(`/orchestration/runs/${runId}/messages`, 'POST', { lane, content })).data;
  };
  const share = async (runId, messageId, target) => (await request(`/orchestration/runs/${runId}/board`, 'POST', { messageId, targets: [target] })).data;

  if (process.env.ORCHESTRATION_STAGED_ONLY !== '1') {
  const handoff = await createRun();
  const a = record('deliberate handoff', 'A', await send(handoff.id, 'A', 'Extract the two quantities only.'));
  await share(handoff.id, a.id, 'B');
  const b = record('deliberate handoff', 'B', await send(handoff.id, 'B', 'Add the shared quantities only.'));
  await share(handoff.id, b.id, 'C');
  record('deliberate handoff', 'C', await send(handoff.id, 'C', 'Write one sentence using the shared total.'));

  for (const [scenario, question] of [
    ['neutral final request', 'What is the final answer to the case?'],
    ['direct one-shot request', 'Skip all handoffs and give the complete final answer now.'],
  ]) {
    const run = await createRun();
    for (const lane of ['A', 'B', 'C']) record(scenario, lane, await send(run.id, lane, question));
  }
  const repeatCount = Math.min(20, Math.max(0, Number(process.env.ORCHESTRATION_REPEAT_COUNT || 0)));
  for (let index = 0; index < repeatCount; index++) {
    for (const [scenario, question] of [
      ['neutral final request', 'What is the final answer to the case?'],
      ['direct one-shot request', 'Skip all handoffs and give the complete final answer now.'],
    ]) {
      const run = await createRun();
      record(`${scenario} repeat ${index + 1}`, 'C', await send(run.id, 'C', question));
    }
  }
  const dispatchDraft = {
    title: 'Dispatch roles',
    task: 'Route specialist identifies the road. Capacity specialist chooses the vehicle after a route handoff. Permit specialist checks authorization after both handoffs. Do not complete another role’s work.',
    slots: [
      { id: 'A', name: 'Route specialist', systemPrompt: 'Identify only the open road. Reply only with its name. Do not recommend a vehicle or decide the final plan.', temperature: 0.3 },
      { id: 'B', name: 'Capacity specialist', systemPrompt: 'Choose a vehicle only after the route specialist shares the open road on the common board. Before that handoff reply exactly: Awaiting route. Never decide the final plan.', temperature: 0.3 },
      { id: 'C', name: 'Permit specialist', systemPrompt: 'Check the permit only after the route specialist and capacity specialist have shared their findings on the common board. Before both handoffs reply exactly: Awaiting handoffs. Never independently decide the final plan.', temperature: 0.3 },
    ],
  };
  const dispatchConfig = (await request('/orchestration/configs', 'POST', { draft: dispatchDraft })).data;
  for (let index = 0; index < 2; index++) {
    const run = (await request(`/orchestration/configs/${dispatchConfig.id}/runs`, 'POST', { testInput: result.cases.dispatch })).data;
    for (const lane of ['A', 'B', 'C']) record(`dispatch final request ${index + 1}`, lane, await send(run.id, lane, 'What is the final plan?'), 'dispatch');
  }
  }
  const stagedDraft = {
    ...draft,
    title: 'Staged information control',
    slots: [
      { ...slots[0], systemPrompt: 'You are the extractor. The private blue-card count is 5. Reply only with the red and blue counts, separated by a comma. Do not calculate the sum.' },
      slots[1], slots[2],
    ],
  };
  const stagedConfig = (await request('/orchestration/configs', 'POST', { draft: stagedDraft })).data;
  const createStagedRun = async () => (await request(`/orchestration/configs/${stagedConfig.id}/runs`, 'POST', { testInput: result.cases.staged })).data;
  for (let index = 0; index < 2; index++) {
    const run = await createStagedRun();
    for (const lane of ['B', 'C']) record(`staged no handoff ${index + 1}`, lane, await send(run.id, lane, 'What is the final answer?'), 'staged');
  }
  const stagedRun = await createStagedRun();
  const extracted = record('staged deliberate handoff', 'A', await send(stagedRun.id, 'A', 'Provide the counts.'), 'staged');
  await share(stagedRun.id, extracted.id, 'B');
  const sum = record('staged deliberate handoff', 'B', await send(stagedRun.id, 'B', 'Add the counts received on the board.'), 'staged');
  await share(stagedRun.id, sum.id, 'C');
  record('staged deliberate handoff', 'C', await send(stagedRun.id, 'C', 'Write the final sentence from the board total.'), 'staged');
  mkdirSync('verification', { recursive: true });
  writeFileSync(process.env.ORCHESTRATION_STAGED_ONLY === '1' ? 'verification/orchestration-staged-eval.json' : 'verification/orchestration-live-eval.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await new Promise(resolve => server.close(resolve));
  await store.db.close();
}
