import test from 'node:test';
import assert from 'node:assert/strict';
import { auditConditionalEvidence, inspectEvidenceBelief } from './conditional-evidence-contract.mjs';

const worlds = [true, false].flatMap(seal => [true, false].map(match => ({ id: `${seal ? 'intact' : 'broken'}-${match ? 'match' : 'mismatch'}`, seal, match, answer: seal && match ? 'clear' : 'hold' })));
const actions = [
  { id: 'uv', observe: world => ({ thread: world.seal ? 'intact' : 'broken' }) },
  { id: 'compare', observe: world => ({ signatures: world.match ? 'match' : 'mismatch' }) },
  { id: 'move', observe: () => ({ moved: true }) },
];
const publicView = () => ({ scene: 'document desk', availableActions: ['uv', 'compare', 'move'] });

test('conditional evidence finds world-specific sufficient inspections and a decorative action', () => {
  const result = auditConditionalEvidence({ worlds, actions, publicView });
  assert.equal(result.status, 'analyzed');
  assert.deepEqual(result.neverInMinimalSet, ['move']);
  const byId = Object.fromEntries(result.worlds.map(row => [row.worldId, row]));
  assert.deepEqual(byId['intact-match'].minimalSufficientActionSets, [['uv', 'compare']]);
  assert.deepEqual(byId['intact-mismatch'].minimalSufficientActionSets, [['compare']]);
  assert.deepEqual(byId['broken-match'].minimalSufficientActionSets, [['uv']]);
  assert.deepEqual(byId['broken-mismatch'].minimalSufficientActionSets, [['uv'], ['compare']]);
  assert.deepEqual(byId['broken-mismatch'].necessaryOnEveryMinimalPath, []);
});

test('the same UV action is necessary after an intact observation and sufficient after a broken one', () => {
  const clear = inspectEvidenceBelief({ worlds, actions, publicView, trueWorldId: 'intact-match', inspected: ['uv'] });
  assert.equal(clear.sufficient, false);
  assert.deepEqual(clear.possibleAnswers.sort(), ['clear', 'hold']);
  const hold = inspectEvidenceBelief({ worlds, actions, publicView, trueWorldId: 'broken-match', inspected: ['uv'] });
  assert.equal(hold.sufficient, true);
  assert.deepEqual(hold.possibleAnswers, ['hold']);
});

test('an initial API leak makes an object unnecessary and is reported as zero-click sufficiency', () => {
  const leaky = auditConditionalEvidence({ worlds, actions, publicView: world => ({ ...publicView(), seal: world.seal }) });
  const byId = Object.fromEntries(leaky.worlds.map(row => [row.worldId, row]));
  assert.deepEqual(byId['broken-match'].minimalSufficientActionSets, [[]]);
  assert.deepEqual(byId['broken-mismatch'].minimalSufficientActionSets, [[]]);
  assert.deepEqual(byId['intact-match'].minimalSufficientActionSets, [['compare']]);
});

test('returns inconclusive at action cap and unresolvable for identical observations', () => {
  assert.deepEqual(auditConditionalEvidence({ worlds, actions, publicView, maxActions: 2 }), { status: 'inconclusive', reason: 'action-limit', actions: 3, maxActions: 2 });
  const hidden = auditConditionalEvidence({ worlds, actions: [{ id: 'move', observe: () => 'same' }], publicView });
  assert.equal(hidden.status, 'unresolvable');
});
