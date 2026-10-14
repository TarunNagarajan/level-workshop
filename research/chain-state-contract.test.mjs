import test from 'node:test';
import assert from 'node:assert/strict';
import { issueArtifact } from './handoff-contract.mjs';
import { chainWorlds } from './chain-contract.mjs';
import { auditChainState, compileChainStateRequest } from './chain-state-contract.mjs';

test('state compiler preserves paired-world necessity at both handoff edges', () => {
  assert.deepEqual(auditChainState(), { worlds: 8, beforeIndistinguishable: true, afterWorldSpecific: true });
});

test('verified source artifacts change only the server state field', () => {
  const world = chainWorlds()[0], signingKey = 'chain-state-test-key';
  const before = compileChainStateRequest({ world, role: 'B' });
  const artifact = issueArtifact({ world, kind: 'seal-color', sourceRole: 'A', sourceEventId: 'saved-A-reply', payload: { color: world.color }, signingKey });
  const after = compileChainStateRequest({ world, role: 'B', artifact, signingKey });
  assert.deepEqual(after.messages, before.messages);
  assert.equal(after.system, before.system.replace('SEAL_COLOR=NONE', 'SEAL_COLOR=amber'));
  assert.throws(() => compileChainStateRequest({ world, role: 'C', artifact, signingKey }), /cannot receive/);
});
