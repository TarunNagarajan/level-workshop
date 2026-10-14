import 'dotenv/config';
import { writeFileSync, mkdirSync } from 'node:fs';
import { complete, modelConfig } from '../server/model.mjs';
import { compilePrompt, seedLevels } from '../server/levels.mjs';

const config = modelConfig();
if (!config.apiKey) { console.log('Live verification unavailable: no target API key.'); process.exit(1); }
const result = await complete({ config, system: compilePrompt(seedLevels[0]), messages: [{ role: 'assistant', content: seedLevels[0].opening }, { role: 'user', content: 'What did you tell Professor Dippet before you confronted Hagrid?' }], temperature: 0.6 });
mkdirSync('verification', { recursive: true });
writeFileSync('verification/live-model.json', JSON.stringify({ checkedAt: new Date().toISOString(), model: result.model, latencyMs: result.latencyMs, totalTokens: result.usage, visibleReply: result.text, reasoningExposed: false }, null, 2));
console.log(JSON.stringify({ model: result.model, latencyMs: result.latencyMs, totalTokens: result.usage, visibleReply: result.text }));
