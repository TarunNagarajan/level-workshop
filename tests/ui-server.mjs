import 'dotenv/config';
import express from 'express';
import { resolve } from 'node:path';
import { createWorkshop } from '../server/app.mjs';

// Browser tests use an isolated database and an explicit fixture; the production app has no simulated model mode.
const { app, store } = createWorkshop({ dbPath: ':memory:', researchWorlds: true, provider: { model: 'openai/gpt-oss-20b', baseUrl: 'https://api.groq.com/openai/v1', apiKey: 'ui-fixture' }, completion: async input => {
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
const server = app.listen(4318, '127.0.0.1', () => console.log('Isolated UI verification: http://127.0.0.1:4318'));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => { store.db.close(); process.exit(0); }));
