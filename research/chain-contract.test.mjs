import test from 'node:test';
import assert from 'node:assert/strict';
import { issueArtifact } from './handoff-contract.mjs';
import { auditChain, chainWorlds, compileChainRequest, parseChainLabel } from './chain-contract.mjs';

test('eight-world chain certifies that each specialist lacks a needed fact', () => {
  const result = auditChain();
  assert.equal(result.worlds, 8);
  assert.equal(result.certificates.length, 8);
  const worlds = chainWorlds();
  const first = worlds.find(world => world.color === 'amber' && !world.cipherFlip && !world.fleetFlip);
  const fleetTwin = worlds.find(world => world.color === 'amber' && !world.cipherFlip && world.fleetFlip);
  const key = 'chain-test-key';
  const color = world => issueArtifact({ world, kind: 'seal-color', sourceRole: 'A', sourceEventId: `seal-${world.id}`, payload: { color: world.color }, signingKey: key });
  assert.deepEqual(compileChainRequest({ world: first, role: 'B', artifact: color(first), signingKey: key }), compileChainRequest({ world: fleetTwin, role: 'B', artifact: color(fleetTwin), signingKey: key }));
  assert.notEqual(first.answer, fleetTwin.answer);
});

test('chain artifacts stay in their world and intended handoff edge', () => {
  const [world, twin] = chainWorlds();
  const signingKey = 'chain-test-key';
  const color = issueArtifact({ world, kind: 'seal-color', sourceRole: 'A', sourceEventId: 'seal-read', payload: { color: world.color }, signingKey });
  assert.match(compileChainRequest({ world, role: 'B', artifact: color, signingKey }).messages[1].content, /SEAL_COLOR=amber/);
  assert.throws(() => compileChainRequest({ world: twin, role: 'B', artifact: color, signingKey }), /outside this trial/);
  assert.throws(() => compileChainRequest({ world, role: 'C', artifact: color, signingKey }), /cannot receive/);
  const route = issueArtifact({ world, kind: 'decoded-route', sourceRole: 'B', sourceEventId: 'route-decoded', payload: { route: world.route }, signingKey });
  assert.match(compileChainRequest({ world, role: 'C', artifact: route, signingKey }).messages[1].content, /ROUTE=north/);
});

test('chain source parser accepts only one complete finite label', () => {
  assert.deepEqual(parseChainLabel({ role: 'A', rawReply: 'Amber.' }), { value: 'amber', exactFormat: false });
  assert.deepEqual(parseChainLabel({ role: 'B', rawReply: 'north' }), { value: 'north', exactFormat: true });
  assert.deepEqual(parseChainLabel({ role: 'C', rawReply: 'Awaiting route.\nTruck' }), { value: null, exactFormat: false });
  assert.deepEqual(parseChainLabel({ role: 'C', rawReply: 'van or truck' }), { value: null, exactFormat: false });
});
