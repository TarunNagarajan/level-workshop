import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalEquipmentLabel, canonicalEquipmentPublication } from './equipment-label-canonicalizer.mjs';

test('canonicalizes only one complete known equipment label', () => {
  assert.equal(canonicalEquipmentLabel(' Awaiting inspection '), 'Awaiting inspection.');
  assert.equal(canonicalEquipmentLabel('AWAITING INSPECTION.'), 'Awaiting inspection.');
  assert.equal(canonicalEquipmentLabel('Hold.'), 'hold');
  assert.equal(canonicalEquipmentLabel('release'), 'release');
  for (const raw of ['release and hold', 'not hold', 'release\nAwaiting inspection',
    'The answer is release', '"release"', 'releasе', 'Awaiting  inspection', '', null]) {
    assert.equal(canonicalEquipmentLabel(raw), null, JSON.stringify(raw));
  }
});

test('canonicalization never turns a false player claim into a verified decision', () => {
  const unknown = { observation: { voltage: null, fuse: null }, availableActions: [] };
  const clear = { observation: { voltage: 'stable', fuse: 'intact' }, availableActions: [] };
  assert.equal(canonicalEquipmentPublication('release', unknown).status, 'rejected');
  assert.equal(canonicalEquipmentPublication('hold', clear).status, 'rejected');
  assert.equal(canonicalEquipmentPublication('Awaiting inspection', unknown).status, 'waiting');
  assert.equal(canonicalEquipmentPublication('release', clear).status, 'published');
});
