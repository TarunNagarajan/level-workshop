import test from 'node:test';
import assert from 'node:assert/strict';
import { synthesizeRevealRepair } from './reveal-repair.mjs';

const actions = [
  { id: 'open' }, { id: 'card' },
  { id: 'turn', requiresAll: ['open'] },
  { id: 'compare', requiresAll: ['open', 'card'] },
  { id: 'uv' },
];
const derived = [{ fact: 'mismatch', from: ['passportSignature', 'cardSignature'] }];

test('both independent early stamp sources must be delayed', () => {
  const result = synthesizeRevealRepair({ actions, sources: [
    { id: 'api-stamp', fact: 'stampDate', at: 'initial', editable: true },
    { id: 'bundle-stamp', fact: 'stampDate', at: 'initial', editable: true },
    { id: 'turn-stamp', fact: 'stampDate', at: 'turn', editable: false },
  ], targetAction: 'turn', targetFact: 'stampDate' });
  assert.equal(result.status, 'repair-candidates');
  assert.equal(result.minimalEditCount, 2);
  assert.deepEqual(result.plans, [{ remove: ['api-stamp', 'bundle-stamp'], after: 'not-proven-known-before' }]);
});

test('comparison cannot become informational while both earlier signatures stay pinned', () => {
  const result = synthesizeRevealRepair({ actions, derived, sources: [
    { id: 'api-passport', fact: 'passportSignature', at: 'initial', editable: true },
    { id: 'api-card', fact: 'cardSignature', at: 'initial', editable: true },
    { id: 'open-signature', fact: 'passportSignature', at: 'open', editable: false },
    { id: 'card-signature', fact: 'cardSignature', at: 'card', editable: false },
    { id: 'compare-result', fact: 'mismatch', at: 'compare', editable: false },
  ], targetAction: 'compare', targetFact: 'mismatch' });
  assert.equal(result.status, 'infeasible-under-pins');
  assert.deepEqual(result.unavoidable.paths[0].proof.from.map(item => item.action), ['open', 'card']);
});

test('no-edit, single-edit, and alternative-route repairs stay distinct', () => {
  const noEdit = synthesizeRevealRepair({ actions, sources: [
    { id: 'uv-result', fact: 'uvIntact', at: 'uv', editable: false },
  ], targetAction: 'uv', targetFact: 'uvIntact' });
  assert.equal(noEdit.status, 'no-edit-needed-by-preflight');
  const oneEdit = synthesizeRevealRepair({ actions, sources: [
    { id: 'static-uv', fact: 'uvIntact', at: 'initial', editable: true },
    { id: 'uv-result', fact: 'uvIntact', at: 'uv', editable: false },
  ], targetAction: 'uv', targetFact: 'uvIntact' });
  assert.deepEqual(oneEdit.plans[0].remove, ['static-uv']);
  const alternate = synthesizeRevealRepair({ actions: [
    { id: 'read-label' }, { id: 'read-record' }, { id: 'inspect', requiresAny: [['read-label'], ['read-record']] },
  ], sources: [
    { id: 'label-owner', fact: 'owner', at: 'read-label', editable: true },
    { id: 'record-owner', fact: 'owner', at: 'read-record', editable: true },
    { id: 'inspect-owner', fact: 'owner', at: 'inspect', editable: false },
  ], targetAction: 'inspect', targetFact: 'owner' });
  assert.equal(alternate.status, 'repair-candidates');
  assert.deepEqual(alternate.plans[0].remove, ['label-owner', 'record-owner']);
});
