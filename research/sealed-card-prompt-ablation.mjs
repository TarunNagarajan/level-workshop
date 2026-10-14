import 'dotenv/config';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { buildCompletionBody, modelConfig } from '../server/model.mjs';
import { sealedCardSystem } from '../server/orchestration-observation.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const protocolHash = digest(readFileSync(new URL('./sealed-card-prompt-ablation.md', import.meta.url)));
const config = modelConfig();
if (config.model !== 'openai/gpt-oss-20b' || !config.apiKey) throw new Error('Configured GPT-OSS 20B provider key required.');
const commonStart = 'You are the seal reader. Use only the verified object observation. ';
const commonEnd = 'After inspection, give the observed seal color as one lowercase whole label.';
const prompts = {
  original: `${commonStart}Before inspection, reply exactly Awaiting inspection. ${commonEnd}`,
  simplified: `${commonStart}${commonEnd}`,
};
const path = new URL('./sealed-card-prompt-ablation.json', import.meta.url);
const result = { status: 'running', protocolHash, startedAt: new Date().toISOString(), model: config.model, order: ['original', 'simplified', 'simplified', 'original'], rows: [] };
const save = () => writeFileSync(path, JSON.stringify(result, null, 2)); save();
for (const variant of result.order) {
  const body = buildCompletionBody({ config,
    system: sealedCardSystem(prompts[variant], 'amber'),
    messages: [
      { role: 'user', content: 'Shared task: Decode the dispatch seal after a verified inspection and saved share.\n\nTest case: Dispatch case 8.' },
      { role: 'user', content: 'Read the dispatch seal.' },
    ], temperature: 0,
  });
  const requestHash = digest(JSON.stringify(body));
  const response = await fetch(`${config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST', headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
  });
  const raw = (await response.text()).slice(0, 6000);
  let parsed;
  try { parsed = JSON.parse(raw); } catch { parsed = null; }
  result.rows.push({ variant, status: response.status, requestHash, visibleReply: response.ok ? parsed?.choices?.[0]?.message?.content ?? null : null,
    errorCode: response.ok ? null : parsed?.error?.code ?? null, providerMessage: response.ok ? null : parsed?.error?.message ?? raw,
    failedGeneration: response.ok ? null : parsed?.error?.failed_generation ?? null }); save();
  if (response.status === 429) { result.status = 'rate-limited'; break; }
  await new Promise(resolve => setTimeout(resolve, 1500));
}
if (result.rows.length === result.order.length) result.status = 'complete';
result.completedAt = new Date().toISOString(); save();
console.log(JSON.stringify({ status: result.status, rows: result.rows.map(row => ({ variant: row.variant, status: row.status, reply: row.visibleReply, errorCode: row.errorCode })) }));
