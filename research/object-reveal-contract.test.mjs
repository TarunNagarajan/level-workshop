import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditObjectReveal, passportWorlds, sceneObservation, targetPrivateRequest } from './object-reveal-contract.mjs';

test('closed desk is identical while passport opening reveals owner to the player', () => {
  const worlds = passportWorlds();
  const audit = auditObjectReveal(worlds);
  assert.equal(audit.playerIndistinguishableBeforeOpen, true);
  assert.equal(audit.targetIndistinguishableBeforeOpen, false);
  assert.notDeepEqual(targetPrivateRequest(worlds[0]), targetPrivateRequest(worlds[1]));
  const closed = sceneObservation({ world: worlds[1] });
  assert.equal(JSON.stringify(closed).includes('Niko'), false);
  const opened = sceneObservation({ world: worlds[1], events: [{ type: 'open', objectId: 'passport' }] });
  assert.equal(JSON.stringify(opened).includes('Niko'), true);
});

test('world-specific object labels invalidate the reveal dependency', () => {
  assert.throws(() => auditObjectReveal(passportWorlds(), { leakInLabel: true }), /Player-visible scene leaks/);
});
