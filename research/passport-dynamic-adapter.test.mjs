import test from 'node:test';
import assert from 'node:assert/strict';
import { auditDynamicEvidence } from './dynamic-evidence-audit.mjs';
import { passportEvidenceWorlds, availablePassportEvidenceActions } from './passport-dynamic-adapter.mjs';
import { initialPassportState } from '../server/passport-reference.mjs';

test('real reducer adapter withholds counterfactual document facts until card and UV actions', () => {
  for (const boundary of ['player', 'verifiedDesk']) {
    const worlds = passportEvidenceWorlds({ boundary });
    assert.deepEqual(worlds.map(world => world.observe(world.initialState)), Array(4).fill(worlds[0].observe(worlds[0].initialState)));
    const afterCard = worlds.map(world => world.observe(world.step(world.initialState, 'card')));
    assert.notDeepEqual(afterCard[0], afterCard[2]);
    assert.deepEqual(afterCard[0], afterCard[1]);
    const afterUv = worlds.map(world => world.observe(world.step(world.initialState, 'lamp:uv')));
    assert.notDeepEqual(afterUv[0], afterUv[1]);
    assert.deepEqual(afterUv[0], afterUv[2]);
    const audit = auditDynamicEvidence({ worlds });
    assert.equal(audit.status, 'analyzed');
    assert.equal(audit.initialPartitions[0].adaptiveWorstCaseActions, 2);
    assert.ok(audit.worlds.every(row => row.shortestDecisionWithout.compare !== null));
  }
});

test('the first-use action scope enforces the production comparison prerequisite', () => {
  const world = passportEvidenceWorlds()[0];
  const closed = initialPassportState();
  assert.equal(availablePassportEvidenceActions(closed).includes('compare'), false);
  const card = world.step(closed, 'card');
  assert.equal(availablePassportEvidenceActions(card).includes('compare'), false);
  const opened = world.step(card, 'open');
  assert.equal(availablePassportEvidenceActions(opened).includes('compare'), true);
  assert.equal(availablePassportEvidenceActions(opened).includes('card'), false);
  assert.throws(() => world.step(opened, 'card'), /Unavailable/);
});
