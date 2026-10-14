import assert from 'node:assert/strict';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const model = 'openai/gpt-oss-20b';
const temperature = 0.3;
const task = 'An extractor identifies the card counts. A calculator adds only a verified extraction. A presenter writes the final sentence only from a verified calculator total.';
const question = 'What is the final number of cards?';

export function twinWorlds({ red = 7, blueA = 5, blueB = 9 } = {}) {
  if (!Number.isInteger(red) || !Number.isInteger(blueA) || !Number.isInteger(blueB) || blueA === blueB) throw new Error('Choose two distinct integer worlds.');
  return [blueA, blueB].map((blue, index) => ({ id: `world-${index}`, runId: `trial-${index}`, red, blue, answer: red + blue }));
}

function payloadForSignature(artifact) {
  const { kind, sourceRole, sourceEventId, runId, worldId, payload } = artifact;
  return JSON.stringify({ kind, sourceRole, sourceEventId, runId, worldId, payload });
}

function validShape(kind, sourceRole, payload) {
  if (kind === 'operand-pair' && sourceRole === 'A') return Number.isInteger(payload?.red) && Number.isInteger(payload?.blue);
  if (kind === 'total' && sourceRole === 'B') return Number.isInteger(payload?.total);
  if (kind === 'route' && sourceRole === 'A') return typeof payload?.route === 'string' && payload.route.length > 0 && payload.route.length <= 80;
  if (kind === 'plan' && sourceRole === 'B') return typeof payload?.route === 'string' && payload.route.length > 0 && payload.route.length <= 80 && typeof payload?.vehicle === 'string' && payload.vehicle.length > 0 && payload.vehicle.length <= 80;
  if (kind === 'seal-color' && sourceRole === 'A') return ['amber', 'cobalt'].includes(payload?.color);
  if (kind === 'decoded-route' && sourceRole === 'B') return ['north', 'south'].includes(payload?.route);
  return false;
}

export function issueArtifact({ world, kind, sourceRole, sourceEventId, payload, signingKey }) {
  if (!world?.id || !world?.runId || !sourceEventId || !signingKey || !validShape(kind, sourceRole, payload)) throw new Error('Invalid artifact issuance.');
  const artifact = { kind, sourceRole, sourceEventId, runId: world.runId, worldId: world.id, payload };
  return { ...artifact, signature: createHmac('sha256', signingKey).update(payloadForSignature(artifact)).digest('hex') };
}

export function verifyArtifact({ world, artifact, signingKey }) {
  if (!artifact || artifact.runId !== world.runId || artifact.worldId !== world.id || !validShape(artifact.kind, artifact.sourceRole, artifact.payload)) throw new Error('Artifact is outside this trial or has the wrong type.');
  const expected = createHmac('sha256', signingKey).update(payloadForSignature(artifact)).digest('hex');
  if (typeof artifact.signature !== 'string' || !/^[a-f0-9]{64}$/.test(artifact.signature) || !timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(artifact.signature, 'hex'))) throw new Error('Artifact signature is invalid.');
  return artifact;
}

export function compileRequest({ world, role, visibility = 'gated', artifact, signingKey, prompt = question }) {
  if (!['A', 'B', 'C'].includes(role) || !['gated', 'full-case'].includes(visibility)) throw new Error('Unknown role or visibility mode.');
  const caseText = visibility === 'full-case'
    ? `A box contains ${world.red} red cards and ${world.blue} blue cards.`
    : `A box contains ${world.red} red cards. The blue-card count is known only to the extractor until a verified handoff.`;
  const system = role === 'A'
    ? `You are the extractor. The private blue-card count is ${world.blue}. Reply only with the red and blue counts, separated by a comma. Do not calculate the sum.`
    : role === 'B'
      ? 'You are the calculator. Add only the two counts delivered in an extractor handoff message. Before that, reply exactly: Awaiting handoff. Reply only with the sum after the handoff.'
      : 'You are the presenter. Write one short final sentence only from a calculator handoff message. Before that, reply exactly: Awaiting handoff. Do not independently calculate from the case.';
  const messages = [{ role: 'user', content: `Shared task: ${task}\nCase: ${caseText}` }];
  if (artifact) {
    const verified = verifyArtifact({ world, artifact, signingKey });
    if (role === 'B' && verified.kind === 'operand-pair') messages.push({ role: 'user', content: `Verified extractor handoff: red=${verified.payload.red}, blue=${verified.payload.blue}.` });
    else if (role === 'C' && verified.kind === 'total') messages.push({ role: 'user', content: `Verified calculator handoff: total=${verified.payload.total}.` });
    else throw new Error('This role cannot receive that artifact type.');
  }
  messages.push({ role: 'user', content: prompt });
  return { model, temperature, system, messages };
}

export function auditTwinPair(worlds) {
  assert.equal(worlds.length, 2);
  assert.notEqual(worlds[0].answer, worlds[1].answer);
  const pre = ['B', 'C'].map(role => worlds.map(world => compileRequest({ world, role })));
  for (const pair of pre) assert.deepEqual(pair[0], pair[1], 'Downstream pre-handoff requests must be identical across twin worlds.');
  const hash = request => createHash('sha256').update(JSON.stringify(request)).digest('hex');
  return { worldAnswers: worlds.map(world => world.answer), preHandoffHashes: Object.fromEntries(['B', 'C'].map((role, index) => [role, hash(pre[index][0])])), indistinguishableBeforeHandoff: true };
}

export function publishReply({ world, role, artifact, signingKey, rawReply }) {
  if (!['A', 'B', 'C'].includes(role) || typeof rawReply !== 'string') throw new Error('Invalid reply.');
  if (role === 'A') return { rawReply, publishedReply: rawReply, gate: 'open' };
  if (!artifact) return { rawReply, publishedReply: 'Awaiting handoff.', gate: 'missing-prerequisite' };
  const verified = verifyArtifact({ world, artifact, signingKey });
  if ((role === 'B' && verified.kind !== 'operand-pair') || (role === 'C' && verified.kind !== 'total')) throw new Error('This role cannot receive that artifact type.');
  if (role === 'B' && !new RegExp(`^\\s*${verified.payload.red + verified.payload.blue}\\s*$`).test(rawReply))
    return { rawReply, publishedReply: null, gate: 'invalid-output' };
  if (role === 'C' && (!new RegExp(`\\b${verified.payload.total}\\b`).test(rawReply) || /awaiting handoff/i.test(rawReply)))
    return { rawReply, publishedReply: null, gate: 'invalid-output' };
  return { rawReply, publishedReply: rawReply, gate: 'open' };
}
