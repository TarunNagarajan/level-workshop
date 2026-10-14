import test from 'node:test';
import assert from 'node:assert/strict';
import { issueArtifact } from './handoff-contract.mjs';
import { chainWorlds } from './chain-contract.mjs';
import { afterArms, beforeArms, compileBAblation } from './chain-b-ablation-contract.mjs';

test('ablation has identical before views for color twins and distinct true after views', () => {
  const worlds = chainWorlds(), key = 'ablation-audit-key';
  for (const world of worlds) {
    const twin = worlds.find(item => item.color !== world.color && item.cipherFlip === world.cipherFlip && item.fleetFlip === world.fleetFlip);
    const make = item => issueArtifact({ world: item, kind: 'seal-color', sourceRole: 'A', sourceEventId: `A-${item.id}`, payload: { color: item.color }, signingKey: key });
    for (const arm of beforeArms) assert.deepEqual(compileBAblation({ world, arm }), compileBAblation({ world: twin, arm }));
    for (const arm of afterArms) assert.notDeepEqual(compileBAblation({ world, arm, artifact: make(world), signingKey: key }), compileBAblation({ world: twin, arm, artifact: make(twin), signingKey: key }));
  }
});

test('within an instruction, user and system delivery differ only by role of the same handoff', () => {
  const world = chainWorlds()[0], key = 'ablation-audit-key';
  const artifact = issueArtifact({ world, kind: 'seal-color', sourceRole: 'A', sourceEventId: 'A-source', payload: { color: world.color }, signingKey: key });
  for (const instruction of ['original', 'conditional']) {
    const user = compileBAblation({ world, arm: `${instruction}-user`, artifact, signingKey: key });
    const system = compileBAblation({ world, arm: `${instruction}-system`, artifact, signingKey: key });
    assert.equal(user.system, system.system);
    assert.deepEqual(user.messages.map(item => item.content), system.messages.map(item => item.content));
    assert.deepEqual(user.messages.map(item => item.role), ['user', 'user', 'user']);
    assert.deepEqual(system.messages.map(item => item.role), ['user', 'system', 'user']);
  }
});
