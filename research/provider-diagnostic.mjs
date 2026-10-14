import 'dotenv/config';
import { modelConfig } from '../server/model.mjs';
import { compileRequest, twinWorlds } from './handoff-contract.mjs';

const config = modelConfig();
if (!config.apiKey) throw new Error('Provider is not configured.');
const request = compileRequest({ world: twinWorlds()[0], role: 'C', visibility: 'full-case' });
const body = {
  model: config.model,
  messages: [{ role: 'system', content: request.system }, ...request.messages],
  temperature: request.temperature,
  max_completion_tokens: 2048,
  stream: false,
  reasoning_effort: 'low',
  include_reasoning: false,
};
const response = await fetch(`${config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const output = await response.json();
console.log(JSON.stringify({ status: response.status, error: output.error ?? null, text: output.choices?.[0]?.message?.content ?? null }));
