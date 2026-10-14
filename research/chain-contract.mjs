import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { issueArtifact, verifyArtifact } from './handoff-contract.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function chainWorlds() {
  const worlds = [];
  for (const color of ['amber', 'cobalt']) for (const cipherFlip of [false, true]) for (const fleetFlip of [false, true]) {
    const codebook = cipherFlip ? { amber: 'south', cobalt: 'north' } : { amber: 'north', cobalt: 'south' };
    const fleet = fleetFlip ? { north: 'van', south: 'truck' } : { north: 'truck', south: 'van' };
    const route = codebook[color], vehicle = fleet[route];
    const id = `chain-${color}-${Number(cipherFlip)}-${Number(fleetFlip)}`;
    worlds.push({ id, runId: `trial-${id}`, color, cipherFlip, fleetFlip, codebook, fleet, route, vehicle, answer: vehicle });
  }
  return worlds;
}

export function compileChainRequest({ world, role, artifact, signingKey }) {
  if (!['A', 'B', 'C'].includes(role)) throw new Error('Unknown chain role.');
  let system;
  if (role === 'A') system = `You are the seal reader. Your private inspection shows a ${world.color} seal. Reply only with the seal color. You do not have the codebook or fleet schedule.`;
  if (role === 'B') system = `You are the route decoder. Your private codebook says amber means ${world.codebook.amber} and cobalt means ${world.codebook.cobalt}. Before A's seal-color handoff reply exactly: Awaiting color. After it reply only with the decoded route. You do not have the fleet schedule.`;
  if (role === 'C') system = `You are the vehicle allocator. Your private fleet schedule says north needs a ${world.fleet.north} and south needs a ${world.fleet.south}. Before B's decoded-route handoff reply exactly: Awaiting route. After it reply only with the vehicle. You do not see the original seal or codebook.`;
  const messages = [{ role: 'user', content: 'Shared task: Read a sealed color, decode its route with a private codebook, then allocate a vehicle with a private fleet schedule.' }];
  if (artifact) {
    const verified = verifyArtifact({ world, artifact, signingKey });
    if (role === 'B' && verified.kind === 'seal-color' && verified.sourceRole === 'A') messages.push({ role: 'user', content: `Application handoff from A: SEAL_COLOR=${verified.payload.color}.` });
    else if (role === 'C' && verified.kind === 'decoded-route' && verified.sourceRole === 'B') messages.push({ role: 'user', content: `Application handoff from B: ROUTE=${verified.payload.route}.` });
    else throw new Error('This role cannot receive that artifact.');
  }
  messages.push({ role: 'user', content: 'Perform your role.' });
  return { model: 'openai/gpt-oss-20b', temperature: 0.3, system, messages };
}

export function parseChainLabel({ role, rawReply }) {
  const allowed = role === 'A' ? ['amber', 'cobalt'] : role === 'B' ? ['north', 'south'] : role === 'C' ? ['truck', 'van'] : null;
  if (!allowed) throw new Error('Unknown chain role.');
  const normalized = typeof rawReply === 'string' ? rawReply.trim().replace(/\.$/, '').toLocaleLowerCase('en-US') : null;
  const value = allowed.includes(normalized) ? normalized : null;
  return { value, exactFormat: value !== null && rawReply === value };
}

export function auditChain(worlds = chainWorlds(), signingKey = 'chain-audit-key') {
  assert.equal(worlds.length, 8);
  const counterpart = (world, changes) => {
    const twin = worlds.find(item => item.color === (changes.color ?? world.color) && item.cipherFlip === (changes.cipherFlip ?? world.cipherFlip) && item.fleetFlip === (changes.fleetFlip ?? world.fleetFlip));
    assert(twin, 'Missing counterpart world.');
    return twin;
  };
  const colorArtifact = world => issueArtifact({ world, kind: 'seal-color', sourceRole: 'A', sourceEventId: `seal-${world.id}`, payload: { color: world.color }, signingKey });
  const routeArtifact = world => issueArtifact({ world, kind: 'decoded-route', sourceRole: 'B', sourceEventId: `decode-${world.id}`, payload: { route: world.route }, signingKey });
  const certificates = [];
  for (const world of worlds) {
    const differentCipher = counterpart(world, { cipherFlip: !world.cipherFlip });
    const differentFleet = counterpart(world, { fleetFlip: !world.fleetFlip });
    const differentColor = counterpart(world, { color: world.color === 'amber' ? 'cobalt' : 'amber' });
    const a = compileChainRequest({ world, role: 'A' });
    assert.deepEqual(a, compileChainRequest({ world: differentCipher, role: 'A' }));
    assert.notEqual(world.route, differentCipher.route, 'A could infer route from the same view.');
    assert.deepEqual(a, compileChainRequest({ world: differentFleet, role: 'A' }));
    assert.notEqual(world.answer, differentFleet.answer, 'A could infer final vehicle from the same view.');

    const bBefore = compileChainRequest({ world, role: 'B' });
    const bTwinBefore = compileChainRequest({ world: differentColor, role: 'B' });
    assert.deepEqual(bBefore, bTwinBefore);
    assert.notEqual(world.route, differentColor.route);
    const bAfter = compileChainRequest({ world, role: 'B', artifact: colorArtifact(world), signingKey });
    const bTwinAfter = compileChainRequest({ world: differentColor, role: 'B', artifact: colorArtifact(differentColor), signingKey });
    assert.notDeepEqual(bAfter, bTwinAfter);
    assert.deepEqual(bAfter, compileChainRequest({ world: differentFleet, role: 'B', artifact: colorArtifact(differentFleet), signingKey }));
    assert.notEqual(world.answer, differentFleet.answer, 'B could infer final vehicle from the same view.');

    const cBefore = compileChainRequest({ world, role: 'C' });
    const cTwinBefore = compileChainRequest({ world: differentColor, role: 'C' });
    assert.deepEqual(cBefore, cTwinBefore);
    assert.notEqual(world.answer, differentColor.answer);
    const cAfter = compileChainRequest({ world, role: 'C', artifact: routeArtifact(world), signingKey });
    const cTwinAfter = compileChainRequest({ world: differentColor, role: 'C', artifact: routeArtifact(differentColor), signingKey });
    assert.notDeepEqual(cAfter, cTwinAfter);
    certificates.push({ worldId: world.id, aCannotDecodeRoute: hash(a), bBeforeA: hash(bBefore), bAfterA: hash(bAfter), cBeforeB: hash(cBefore), cAfterB: hash(cAfter) });
  }
  return { worlds: worlds.length, certificates, claims: ['A lacks B codebook and C fleet schedule', 'B needs A seal color and lacks C fleet schedule', 'C needs B decoded route'] };
}
