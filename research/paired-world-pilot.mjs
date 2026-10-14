import 'dotenv/config';
import { createHash, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { modelConfig } from '../server/model.mjs';
import { auditTwinPair, compileRequest, issueArtifact, twinWorlds } from './handoff-contract.mjs';

const provider = modelConfig();
if (!provider.apiKey || provider.model !== 'openai/gpt-oss-20b') throw new Error('This pilot requires a configured GPT-OSS 20B provider.');
const worlds = twinWorlds();
const signingKey = randomBytes(32);
const result = { sampledAt: new Date().toISOString(), model: provider.model, worlds: worlds.map(({ id, red, blue, answer }) => ({ id, red, blue, answer })), staticAudit: auditTwinPair(worlds), observations: [], status: 'running' };
const save = () => writeFileSync('research/paired-world-pilot.json', JSON.stringify(result, null, 2));
let lastCall = 0;

async function providerCall(request) {
  const body = {
    model: provider.model,
    messages: [{ role: 'system', content: request.system }, ...request.messages],
    temperature: request.temperature,
    max_completion_tokens: 2048,
    stream: false,
    reasoning_effort: 'low',
    include_reasoning: false,
  };
  for (let attempt = 1; attempt <= 3; attempt++) {
    const wait = 2500 - (Date.now() - lastCall);
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
    lastCall = Date.now();
    const start = performance.now();
    const response = await fetch(`${provider.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${provider.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    const data = await response.json();
    if (response.ok) return { text: data.choices?.[0]?.message?.content?.trim(), latencyMs: Math.round(performance.now() - start), attempt };
    result.providerErrors ??= [];
    result.providerErrors.push({ status: response.status, detail: data.error ?? null, attempt, requestHash: createHash('sha256').update(JSON.stringify(request)).digest('hex') });
    save();
    const transientToolError = response.status === 400 && /Tool choice is none, but model called a tool/i.test(data.error?.message ?? '');
    if (!transientToolError || attempt === 3) throw new Error(`Provider returned HTTP ${response.status}: ${data.error?.message ?? 'unknown error'}`);
  }
}

async function probe({ world, role, phase, visibility, artifact, prompt }) {
  const request = compileRequest({ world, role, visibility, artifact, signingKey, prompt });
  let response;
  try { response = await providerCall(request); }
  catch (error) { response = { text: null, latencyMs: null, attempt: 3, error: error.message }; }
  const observation = {
    world: world.id, expectedAnswer: world.answer, role, phase, visibility,
    requestHash: createHash('sha256').update(JSON.stringify(request)).digest('hex'),
    request, response: response.text, providerMs: response.latencyMs, attempt: response.attempt, error: response.error ?? null,
  };
  result.observations.push(observation);
  save();
  return observation;
}

try {
  for (const world of worlds) for (const role of ['B', 'C']) await probe({ world, role, phase: 'before handoff', visibility: 'full-case' });
  for (const world of worlds) for (const role of ['B', 'C']) await probe({ world, role, phase: 'before handoff', visibility: 'gated' });
  for (const world of worlds) {
    const extraction = await probe({ world, role: 'A', phase: 'extract', visibility: 'gated', prompt: 'Provide the two card counts for the calculator.' });
    const pair = /^\s*(\d+)\s*,\s*(\d+)\s*$/.exec(extraction.response ?? '');
    if (!pair) { result.protocolErrors ??= []; result.protocolErrors.push(`Extractor response could not be parsed in ${world.id}.`); continue; }
    const operandArtifact = issueArtifact({ world, kind: 'operand-pair', sourceRole: 'A', sourceEventId: `extract-${world.id}`, payload: { red: Number(pair[1]), blue: Number(pair[2]) }, signingKey });
    const calculation = await probe({ world, role: 'B', phase: 'after extractor handoff', visibility: 'gated', artifact: operandArtifact, prompt: 'Add the verified card counts.' });
    const total = /^\s*(\d+)\s*$/.exec(calculation.response ?? '');
    if (!total) { result.protocolErrors ??= []; result.protocolErrors.push(`Calculator response could not be parsed in ${world.id}.`); continue; }
    const totalArtifact = issueArtifact({ world, kind: 'total', sourceRole: 'B', sourceEventId: `calculate-${world.id}`, payload: { total: Number(total[1]) }, signingKey });
    await probe({ world, role: 'C', phase: 'after calculator handoff', visibility: 'gated', artifact: totalArtifact, prompt: 'Write one sentence from the verified total.' });
  }
  result.status = 'complete';
  save();
  console.log(JSON.stringify({ status: result.status, staticAudit: result.staticAudit, calls: result.observations.length, observations: result.observations.map(({ world, role, phase, visibility, response, providerMs }) => ({ world, role, phase, visibility, response, providerMs })) }));
} catch (error) {
  result.status = 'incomplete'; result.error = error.message;
  save();
  throw error;
}
