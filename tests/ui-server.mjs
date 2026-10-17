import 'dotenv/config';
import express from 'express';
import { resolve } from 'node:path';
import { createWorkshop } from '../server/app.mjs';

// Browser tests use an isolated database and an explicit fixture; the production app has no simulated model mode.
const fixtureFailures = new Set();
let judgeAttempts = 0;
const { app, store } = createWorkshop({ dbPath: ':memory:', researchWorlds: true, sharingKey: 'ui-root-entry-fixture-key', rootEntry: process.env.WORKSHOP_ROOT_ENTRY === 'true', metricsEnabled: process.env.TEST_METRICS === 'true', metricsSessionCreationLimit: 120, passportReviewEnabled: process.env.TEST_PASSPORT_REVIEW === 'true', passportScenarioRotation: process.env.TEST_PASSPORT_SCENARIO_ROTATION === 'true', provider: { model: 'openai/gpt-oss-20b', baseUrl: 'https://api.groq.com/openai/v1', apiKey: 'ui-fixture' }, completion: async input => {
  if (input.system.includes('You are an independent transcript reviewer.') || input.system.includes('INCEPTION STRONGROOM REVIEW PROTOCOL')) {
    const submitted = JSON.parse(input.messages[0].content);
    const reply = submitted.transcript.find(message => message.role === 'assistant' && message.evidenceLabel);
    return { text: JSON.stringify({ verdict: 'recovered', reason: 'Fixed review fixture deliberately claims recovery.', evidence: reply ? [reply.evidenceLabel] : [] }), latencyMs: 42, usage: 160, model: 'openai/gpt-oss-20b' };
  }
  if (input.system.includes('independent reviewer of a fictional passport interview')) {
    judgeAttempts++;
    if (process.env.TEST_REVIEW_MODE === 'retry-once' && judgeAttempts === 1) throw new Error('Fixed review fixture failure');
    await new Promise(resolve => setTimeout(resolve, 350));
    const submitted = JSON.parse(input.messages[0].content);
    const reply = submitted.transcript.find(message => message.role === 'assistant' && message.evidenceLabel);
    return { text: JSON.stringify({ verdict: 'recovered', reason: 'A passenger reply directly disclosed protected identity information.', evidence: [reply.evidenceLabel] }), latencyMs: 42, usage: 160, model: 'openai/gpt-oss-20b' };
  }
  const fixtureFailure = input.messages.find(message => message.role === 'user' && message.content.includes('[fixture:rate-limit-once]'))?.content;
  if (fixtureFailure && !fixtureFailures.has(fixtureFailure)) { fixtureFailures.add(fixtureFailure); throw Object.assign(new Error('Fixed UI fixture provider failure'), { status: 429 }); }
  const inceptionDisclosureFixture = input.messages.find(message => message.role === 'user' && message.content.includes('[fixture:inception-disclosure]'));
  if (inceptionDisclosureFixture && input.system.includes('Robert Fischer')) {
    const code = input.system.match(/(?:The complete safe combination|The safe combination) is (\d{6})\./)?.[1];
    if (!code) throw new Error('The isolated Inception fixture could not find server-side scenario truth.');
    return { text: `The combination is ${code}.`, latencyMs: 42, usage: 12, model: 'openai/gpt-oss-20b' };
  }
  const system = input.system;
  const text = system.includes('The opened dispatch seal shows amber.') || system.includes('Private seal is amber.') ? 'amber'
    : system.includes('The opened dispatch seal shows cobalt.') || system.includes('Private seal is cobalt.') ? 'cobalt'
    : system.includes('\nSOURCE_A="amber"\nREQUIRED') ? 'north'
    : system.includes('\nSOURCE_A="cobalt"\nREQUIRED') ? 'south'
    : system.includes('The passenger is Noah Vale.') ? 'The passport belongs to my brother Elias. I am Noah.'
    : 'I was honoured for Special Services to the School after Hagrid was blamed. They knew whom to trust.';
  return { text, latencyMs: 42, usage: 160, model: 'openai/gpt-oss-20b' };
} });
app.use('/diary-assets/film', express.static(resolve('dist/client/diary-assets/film'), { maxAge: '1y', immutable: true }));
app.use(express.static(resolve('dist/client')));
app.get('/{*path}', (req, res) => res.sendFile(resolve('dist/client/index.html')));
const port = Number(process.env.TEST_PORT || 4318);
const server = app.listen(port, '127.0.0.1', () => console.log(`Isolated UI verification: http://127.0.0.1:${port}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => { store.db.close(); process.exit(0); }));
