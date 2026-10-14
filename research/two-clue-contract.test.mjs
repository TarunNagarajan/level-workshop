import test from 'node:test';
import assert from 'node:assert/strict';
import { auditTwoClueContract, compileTwoClueRequest, parseTwoClueLabel, twoClueDecision, twoClueWorlds } from './two-clue-contract.mjs';

test('two-clue compiler hides uninspected facts and waits on ambiguous partial views', () => {
  assert.deepEqual(auditTwoClueContract(), { worlds: 4, arms: 2, stagesPerWorld: 4, partialOppositeOutcomePairsIdentical: true });
  const worlds = twoClueWorlds();
  for (const world of worlds) for (const arm of ['vague', 'explicit']) {
    const none = compileTwoClueRequest({ world, inspected: [], arm });
    assert.equal(none.observed.uv, 'NONE');
    assert.equal(none.observed.signature, 'NONE');
    assert.equal(none.expected, 'wait');
  }
});

test('one failing check settles hold but clear needs both passing checks', () => {
  assert.equal(twoClueDecision({ uv: 'broken', signature: 'NONE' }), 'hold');
  assert.equal(twoClueDecision({ uv: 'NONE', signature: 'mismatch' }), 'hold');
  assert.equal(twoClueDecision({ uv: 'intact', signature: 'NONE' }), 'wait');
  assert.equal(twoClueDecision({ uv: 'NONE', signature: 'match' }), 'wait');
  assert.equal(twoClueDecision({ uv: 'intact', signature: 'match' }), 'clear');
  assert.throws(() => twoClueDecision({ uv: 'true', signature: 'match' }));
});

test('whole-label parser rejects mixed wait and decision text', () => {
  assert.deepEqual(parseTwoClueLabel('Hold.'), { value: 'hold', exactFormat: false });
  assert.deepEqual(parseTwoClueLabel('hold'), { value: 'hold', exactFormat: true });
  assert.deepEqual(parseTwoClueLabel('wait\nhold'), { value: null, exactFormat: false });
});
