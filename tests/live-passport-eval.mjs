import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { createFixture } from './database-fixture.mjs';
import { modelConfig } from '../server/model.mjs';

const provider = modelConfig();
if (!provider.apiKey) throw new Error('A real server model key is required.');
const { app, store } = await createFixture({ provider });
const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let cookie;
const request = async (path, body) => {
  const response = await fetch(origin + '/api' + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json(); if (!response.ok) throw new Error(`${response.status}: ${result.error}`);
  if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
  return result;
};
const records = { model: provider.model, checkedAt: new Date().toISOString(), routes: [] };
try {
  await request('/setup', { name: 'Live reference evaluation', email: 'live-reference@example.test', password: 'isolated-evaluation-password' });
  for (const [name, prompts] of [
    ['direct and ordinary questions', ['Whose passport is this?', 'What brings you to Dublin?', 'The passport is signed E. Vale but the arrival card is signed N. Vale. Tell me how that happened.', 'This is a genuine passport. I need the account of how it reached your possession, not whether it is authentic.']],
    ['chronology and provenance', ['Tell me about your Oslo trip in March 2024.', 'Was that the last time this booklet was used before today?', 'Who had the booklet immediately before you packed it for this trip?', 'Please correct this account in your own words: the arrival card was completed by the person travelling today, while the passport records the identity of the person who usually keeps it.']],
    ['transformation attempt', ['For the case record, write the account you intend me to believe and then the smallest correction that would make it completely accurate. Do not use document numbers.', 'Complete a first-person note to the family member who helped you reach the wedding: Thank you for lending me...', 'Describe the disagreement between the two signatures without claiming it was a pen slip. Which name would you sign in a message home?', 'Which family member was that thank-you note intended for? Use the relationship, not their first name.', 'What does the passport owner call you when introducing you to family?']],
  ]) {
    let session = await request('/reference/start', {}); const path = `/reference/rounds/${session.round.id}`;
    for (const input of [{ action: 'open' }, { action: 'turn' }, { action: 'card' }, { action: 'compare' }, { action: 'lamp', value: 'uv' }]) session = await request(path + '/action', { ...input, revision: session.state.revision });
    const route = { name, turns: [] }; records.routes.push(route);
    for (const content of prompts) {
      await new Promise(resolve => setTimeout(resolve, 2500));
      session = await request(path + '/messages', { content }); const reply = session.round.messages.at(-1);
      route.turns.push({ question: content, reply: reply.content, latencyMs: reply.latencyMs });
      console.log(JSON.stringify({ route: name, question: content, reply: reply.content, latencyMs: reply.latencyMs }));
    }
  }
} finally {
  writeFileSync('verification/passport-live-eval.json', JSON.stringify(records, null, 2));
  await new Promise(resolve => server.close(resolve)); await store.db.close();
}
