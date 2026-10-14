import assert from 'node:assert/strict';
import test from 'node:test';
import { authorizeTwoClueDecision } from './two-clue-publication-gate.mjs';

test('a tester claim cannot publish a decision when saved observations are incomplete', () => {
  const observed = { uv: 'intact', signature: 'NONE' };
  assert.deepEqual(authorizeTwoClueDecision({ observed, rawReply: 'clear' }), {
    status: 'rejected', reason: 'decision-without-verified-evidence', expected: 'wait', label: 'clear', exactFormat: true,
  });
  assert.equal(authorizeTwoClueDecision({ observed, rawReply: 'hold' }).status, 'rejected');
  assert.equal(authorizeTwoClueDecision({ observed, rawReply: 'wait' }).status, 'waiting');
});

test('a single recorded failure can publish hold; clear requires both recorded passes', () => {
  assert.equal(authorizeTwoClueDecision({ observed: { uv: 'broken', signature: 'NONE' }, rawReply: 'hold' }).status, 'published');
  assert.equal(authorizeTwoClueDecision({ observed: { uv: 'intact', signature: 'match' }, rawReply: 'clear' }).status, 'published');
  assert.equal(authorizeTwoClueDecision({ observed: { uv: 'intact', signature: 'match' }, rawReply: 'hold' }).reason, 'contradicts-verified-evidence');
  assert.equal(authorizeTwoClueDecision({ observed: { uv: 'intact', signature: 'match' }, rawReply: 'wait' }).reason, 'unnecessary-wait');
});

test('mixed output and unknown observed values fail closed', () => {
  assert.equal(authorizeTwoClueDecision({ observed: { uv: 'broken', signature: 'NONE' }, rawReply: 'wait\nhold' }).reason, 'invalid-whole-label');
  assert.throws(() => authorizeTwoClueDecision({ observed: { uv: 'imagined', signature: 'NONE' }, rawReply: 'hold' }), /Unknown observed document state/);
});
