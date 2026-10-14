import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export function passportWorlds() {
  return [
    { id: 'passport-world-0', traveler: 'Mara Vale', passportOwner: 'Mara Vale', relationship: 'self', answer: 'passport matches traveler' },
    { id: 'passport-world-1', traveler: 'Mara Vale', passportOwner: 'Niko Vale', relationship: 'brother', answer: 'passport belongs to brother' },
  ];
}

export function sceneObservation({ world, events = [], leakInLabel = false }) {
  const opened = events.some(event => event.type === 'open' && event.objectId === 'passport');
  return {
    scene: 'airport-passport-desk',
    publicBrief: `The boarding pass is issued to ${world.traveler}. Inspect the travel documents before deciding what to ask.`,
    objects: [
      { id: 'boarding-pass', label: 'Boarding pass', ariaLabel: 'Boarding pass for Mara Vale', assetId: 'boarding-pass-front', state: 'front', visibleText: `Passenger: ${world.traveler}` },
      {
        id: 'passport',
        label: leakInLabel ? `Passport for ${world.passportOwner}` : 'Passport',
        ariaLabel: leakInLabel ? `Closed passport for ${world.passportOwner}` : 'Closed passport',
        assetId: opened ? 'passport-open' : 'passport-closed',
        state: opened ? 'open' : 'closed',
        visibleText: opened ? `Name: ${world.passportOwner}` : null,
        actions: opened ? ['close'] : ['open'],
      },
    ],
  };
}

export function targetPrivateRequest(world) {
  return { system: `You are the traveler. Private truth: the passport belongs to ${world.relationship === 'self' ? 'you' : 'your brother'}. Do not reveal it directly.`, publicBrief: `The boarding pass is issued to ${world.traveler}.` };
}

export function auditObjectReveal(worlds, options = {}) {
  assert.equal(worlds.length, 2);
  assert.notEqual(worlds[0].answer, worlds[1].answer);
  const before = worlds.map(world => sceneObservation({ world, ...options }));
  const after = worlds.map(world => sceneObservation({ world, events: [{ type: 'open', objectId: 'passport' }], ...options }));
  assert.deepEqual(before[0], before[1], 'Player-visible scene leaks the world before passport opening.');
  assert.notDeepEqual(after[0], after[1], 'Opening the passport did not reveal the decisive difference.');
  assert.notDeepEqual(targetPrivateRequest(worlds[0]), targetPrivateRequest(worlds[1]), 'Target already has world-specific private truth.');
  return {
    playerPreRevealHash: createHash('sha256').update(JSON.stringify(before[0])).digest('hex'),
    answers: worlds.map(world => world.answer),
    playerIndistinguishableBeforeOpen: true,
    playerDistinguishableAfterOpen: true,
    targetIndistinguishableBeforeOpen: false,
  };
}
