import 'dotenv/config';
import express from 'express';
import { resolve } from 'node:path';
import { createWorkshop } from '../server/app.mjs';

// Browser tests use an isolated database and an explicit fixture; the production app has no simulated model mode.
const fixtureFailures = new Set();
const { app, store } = createWorkshop({ dbPath: ':memory:', researchWorlds: true, sharingKey: 'ui-root-entry-fixture-key', rootEntry: process.env.WORKSHOP_ROOT_ENTRY === 'true', metricsEnabled: process.env.TEST_METRICS === 'true', metricsSessionCreationLimit: 120, provider: { model: 'openai/gpt-oss-20b', baseUrl: 'https://api.groq.com/openai/v1', apiKey: 'ui-fixture' }, completion: async input => {
  const fixtureFailure = input.messages.find(message => message.role === 'user' && message.content.includes('[fixture:rate-limit-once]'))?.content;
  if (fixtureFailure && !fixtureFailures.has(fixtureFailure)) { fixtureFailures.add(fixtureFailure); throw Object.assign(new Error('Fixed UI fixture provider failure'), { status: 429 }); }
  const system = input.system;
  const text = system.includes('The opened dispatch seal shows amber.') || system.includes('Private seal is amber.') ? 'amber'
    : system.includes('The opened dispatch seal shows cobalt.') || system.includes('Private seal is cobalt.') ? 'cobalt'
    : system.includes('\nSOURCE_A="amber"\nREQUIRED') ? 'north'
    : system.includes('\nSOURCE_A="cobalt"\nREQUIRED') ? 'south'
    : system.includes('The passenger is Noah Vale.') ? 'The passport belongs to my brother Elias. I am Noah.'
    : 'I expected the matter to be resolved before the night was over. The professors would accept an explanation they could understand.';
  return { text, latencyMs: 42, usage: 160, model: 'openai/gpt-oss-20b' };
} });
app.use(express.static(resolve('dist/client')));
app.get('/{*path}', (req, res) => res.sendFile(resolve('dist/client/index.html')));
const port = Number(process.env.TEST_PORT || 4318);
const server = app.listen(port, '127.0.0.1', () => console.log(`Isolated UI verification: http://127.0.0.1:${port}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => { store.db.close(); process.exit(0); }));
