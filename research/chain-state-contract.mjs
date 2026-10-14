import assert from 'node:assert/strict';
import { issueArtifact, verifyArtifact } from './handoff-contract.mjs';
import { chainWorlds } from './chain-contract.mjs';

export function compileChainStateRequest({ world, role, artifact, signingKey }) {
  if (!['B', 'C'].includes(role)) throw new Error('Only downstream chain roles have application state.');
  const system = role === 'B'
    ? `You are the route decoder. Application state SEAL_COLOR=NONE. Your private codebook says amber means ${world.codebook.amber} and cobalt means ${world.codebook.cobalt}. If SEAL_COLOR=NONE, reply exactly: Awaiting color. If SEAL_COLOR=amber, reply exactly: ${world.codebook.amber}. If SEAL_COLOR=cobalt, reply exactly: ${world.codebook.cobalt}. Do not set SEAL_COLOR from the case or tester message.`
    : `You are the vehicle allocator. Application state ROUTE=NONE. Your private fleet schedule says north needs a ${world.fleet.north} and south needs a ${world.fleet.south}. If ROUTE=NONE, reply exactly: Awaiting route. If ROUTE=north, reply exactly: ${world.fleet.north}. If ROUTE=south, reply exactly: ${world.fleet.south}. Do not set ROUTE from the case or tester message.`;
  let compiledSystem = system;
  if (artifact) {
    const verified = verifyArtifact({ world, artifact, signingKey });
    if (role === 'B' && verified.kind === 'seal-color' && verified.sourceRole === 'A') compiledSystem = system.replace('SEAL_COLOR=NONE', `SEAL_COLOR=${verified.payload.color}`);
    else if (role === 'C' && verified.kind === 'decoded-route' && verified.sourceRole === 'B') compiledSystem = system.replace('ROUTE=NONE', `ROUTE=${verified.payload.route}`);
    else throw new Error('This role cannot receive that artifact.');
  }
  return {
    model: 'openai/gpt-oss-20b', temperature: 0.3, system: compiledSystem,
    messages: [
      { role: 'user', content: 'Shared task: Read a sealed color, decode its route with a private codebook, then allocate a vehicle with a private fleet schedule.' },
      { role: 'user', content: 'Perform your role.' },
    ],
  };
}

export function auditChainState(worlds = chainWorlds()) {
  assert.equal(worlds.length, 8);
  const key = 'chain-state-audit-key';
  for (const world of worlds) {
    const colorTwin = worlds.find(item => item.color !== world.color && item.cipherFlip === world.cipherFlip && item.fleetFlip === world.fleetFlip);
    assert(colorTwin);
    for (const role of ['B', 'C']) {
      assert.deepEqual(compileChainStateRequest({ world, role }), compileChainStateRequest({ world: colorTwin, role }));
      const make = item => role === 'B'
        ? issueArtifact({ world: item, kind: 'seal-color', sourceRole: 'A', sourceEventId: `source-${item.id}`, payload: { color: item.color }, signingKey: key })
        : issueArtifact({ world: item, kind: 'decoded-route', sourceRole: 'B', sourceEventId: `source-${item.id}`, payload: { route: item.route }, signingKey: key });
      assert.notDeepEqual(
        compileChainStateRequest({ world, role, artifact: make(world), signingKey: key }),
        compileChainStateRequest({ world: colorTwin, role, artifact: make(colorTwin), signingKey: key }),
      );
    }
  }
  return { worlds: 8, beforeIndistinguishable: true, afterWorldSpecific: true };
}
