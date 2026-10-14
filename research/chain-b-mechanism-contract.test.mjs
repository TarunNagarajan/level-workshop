import test from 'node:test';
import assert from 'node:assert/strict';
import { issueArtifact } from './handoff-contract.mjs';
import { chainWorlds, compileChainRequest } from './chain-contract.mjs';
import { arms, compileBMechanism } from './chain-b-mechanism-contract.mjs';

test('original cell is byte-identical to original chain instruction', () => {
  const world = chainWorlds()[0];
  assert.deepEqual(compileBMechanism({ world, arm: 'vague-plain' }), compileChainRequest({ world, role: 'B' }));
});

test('mechanism factors alter only system instruction and preserve before-handoff twin equality', () => {
  const worlds = chainWorlds(), key = 'mechanism-audit-key';
  for (const world of worlds) {
    const twin = worlds.find(item => item.color !== world.color && item.cipherFlip === world.cipherFlip && item.fleetFlip === world.fleetFlip);
    const artifact = issueArtifact({ world, kind: 'seal-color', sourceRole: 'A', sourceEventId: `A-${world.id}`, payload: { color: world.color }, signingKey: key });
    for (const arm of arms) {
      assert.deepEqual(compileBMechanism({ world, arm }), compileBMechanism({ world: twin, arm }));
      const before = compileBMechanism({ world, arm });
      const after = compileBMechanism({ world, arm, artifact, signingKey: key });
      assert.equal(after.system, before.system);
      assert.deepEqual(after.messages.filter((_, index) => index !== 1), before.messages);
      assert.equal(after.messages[1].content, `Application handoff from A: SEAL_COLOR=${world.color}.`);
    }
  }
});
