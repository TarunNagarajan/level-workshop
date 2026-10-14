import 'dotenv/config';
import { createHash, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { modelConfig } from '../server/model.mjs';
import { issueArtifact } from './handoff-contract.mjs';
import { auditRoutePair, compileRouteRequest, routeWorlds } from './route-contract.mjs';

const provider = modelConfig();
if (!provider.apiKey || provider.model !== 'openai/gpt-oss-20b') throw new Error('GPT-OSS 20B provider required.');
const handoffChannel = process.argv[2] || 'user';
if (!['user', 'system', 'state'].includes(handoffChannel)) throw new Error('Channel must be user, system, or state.');
const worlds = routeWorlds();
const signingKey = randomBytes(32);
const result = { sampledAt: new Date().toISOString(), model: provider.model, handoffChannel, worlds, staticAudit: auditRoutePair(worlds), observations: [], providerErrors: [], protocolErrors: [], status: 'running' };
const save = () => writeFileSync(`research/route-${handoffChannel}-pilot.json`, JSON.stringify(result, null, 2));
let lastCall = 0;

async function probe({ world, role, phase, visibility, artifact, prompt }) {
  const request = compileRouteRequest({ world, role, phase, visibility, artifact, signingKey, handoffChannel, prompt });
  const hash = createHash('sha256').update(JSON.stringify(request)).digest('hex');
  const body = {
    model: provider.model, messages: [{ role: 'system', content: request.system }, ...request.messages],
    temperature: request.temperature, max_completion_tokens: 2048, stream: false,
    reasoning_effort: 'low', include_reasoning: false,
  };
  let responseText = null; let latencyMs = null; let attempts = 0;
  for (let attempt = 1; attempt <= 3; attempt++) {
    attempts = attempt;
    const wait = 2500 - (Date.now() - lastCall);
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
    lastCall = Date.now();
    const start = performance.now();
    const response = await fetch(`${provider.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST', headers: { Authorization: `Bearer ${provider.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
    });
    const data = await response.json();
    if (response.ok) {
      responseText = data.choices?.[0]?.message?.content?.trim() ?? null;
      latencyMs = Math.round(performance.now() - start);
      break;
    }
    result.providerErrors.push({ world: world.id, role, phase, status: response.status, attempt, detail: data.error ?? null, requestHash: hash });
    save();
    if (response.status !== 400 || !/Tool choice is none, but model called a tool/i.test(data.error?.message ?? '')) break;
  }
  const observation = { world: world.id, expectedAnswer: world.answer, role, phase, visibility, requestHash: hash, request, response: responseText, providerMs: latencyMs, attempts };
  result.observations.push(observation); save();
  return observation;
}

try {
  for (const world of worlds) for (const role of ['B', 'C']) await probe({ world, role, phase: 'before handoff', visibility: 'full-case' });
  for (const world of worlds) for (const role of ['B', 'C']) await probe({ world, role, phase: 'before handoff', visibility: 'gated' });
  for (const world of worlds) {
    const a = await probe({ world, role: 'A', phase: 'extract', visibility: 'gated', prompt: 'Name the open route.' });
    const route = a.response?.trim();
    if (!['Ridge Road', 'Canal Ferry'].includes(route)) { result.protocolErrors.push(`${world.id}: route reply invalid`); continue; }
    const routeArtifact = issueArtifact({ world, kind: 'route', sourceRole: 'A', sourceEventId: `route-${world.id}`, payload: { route }, signingKey });
    const b = await probe({ world, role: 'B', phase: 'after route handoff', visibility: 'gated', artifact: routeArtifact, prompt: 'Choose the vehicle for the handed-off route.' });
    const vehicle = b.response?.trim();
    if (!['pickup truck', 'cargo van'].includes(vehicle)) { result.protocolErrors.push(`${world.id}: vehicle reply invalid`); continue; }
    const planArtifact = issueArtifact({ world, kind: 'plan', sourceRole: 'B', sourceEventId: `vehicle-${world.id}`, payload: { route, vehicle }, signingKey });
    await probe({ world, role: 'C', phase: 'after plan handoff', visibility: 'gated', artifact: planArtifact, prompt: 'Write the final delivery plan in one sentence.' });
  }
  result.status = 'complete'; save();
  console.log(JSON.stringify({ status: result.status, calls: result.observations.length, providerErrors: result.providerErrors.length, protocolErrors: result.protocolErrors, observations: result.observations.map(({ world, role, phase, visibility, response }) => ({ world, role, phase, visibility, response })) }));
} catch (error) {
  result.status = 'incomplete'; result.error = error.message; save(); throw error;
}
