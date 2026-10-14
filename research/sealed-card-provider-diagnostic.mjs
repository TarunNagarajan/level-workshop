import 'dotenv/config';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { compileOrchestrationContext } from '../server/orchestration-context.mjs';
import { buildCompletionBody, modelConfig } from '../server/model.mjs';

const config = modelConfig();
if (!config.apiKey) throw new Error('Configured provider key required.');
const snapshot = { task: 'Decode the dispatch seal after a verified inspection and saved share.',
  contract: { edges: [{ sourceLane: 'A', targetLane: 'B', waitLabel: 'Awaiting color.', choices: [
    { source: 'amber', output: 'north' }, { source: 'cobalt', output: 'south' },
  ] }] },
  slots: [
    { id: 'A', name: 'Seal reader', systemPrompt: 'You are the seal reader. Use only the verified object observation. Before inspection, reply exactly Awaiting inspection. After inspection, give the observed seal color as one lowercase whole label.', temperature: 0 },
    { id: 'B', name: 'Decoder', systemPrompt: 'You are the decoder. Use only the saved handoff state. Reply with one whole label.', temperature: 0 },
    { id: 'C', name: 'Observer', systemPrompt: 'Observe only.', temperature: 0 },
  ],
};
const context = compileOrchestrationContext({ snapshot, testInput: 'Dispatch case 8.', messages: [], board: [], lane: 'A', content: 'Read the dispatch seal.', model: config.model, sourceObservation: { factValue: 'amber' } });
const body = buildCompletionBody({ config, ...context });
const requestHash = createHash('sha256').update(JSON.stringify(body)).digest('hex');
const response = await fetch(`${config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
  method: 'POST', headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
});
const rawResponse = (await response.text()).slice(0, 6000);
const record = { status: response.status, requestHash, body, rawResponse, at: new Date().toISOString(), scope: 'One separate provider diagnostic call, not part of the fixed six-call protocol.' };
writeFileSync(new URL('./sealed-card-provider-diagnostic.json', import.meta.url), JSON.stringify(record, null, 2));
console.log(JSON.stringify({ status: record.status, requestHash, responseExcerpt: rawResponse.slice(0, 700) }));
