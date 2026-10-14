import { compilePrompt, emptyLevel } from '../server/levels.mjs';
import { bindWorldLevel } from '../server/world-bound-template.mjs';
import { applyPassportAction, initialPassportState, passportContext, passportStudyWorld } from '../server/passport-reference.mjs';
import { passportPlayerEvidence } from './passport-dynamic-adapter.mjs';
import { equipmentWorlds } from './dynamic-evidence-fixture.mjs';

const passportActions = {
  card: { action: 'card' },
  uv: { action: 'lamp', value: 'uv' },
};
function passportState(world, actions) {
  let state = initialPassportState();
  for (const action of actions) state = applyPassportAction(state, { revision: state.revision, ...passportActions[action] },
    { id: `influence-${state.revision}`, at: 0, scenario: world.scenario }).state;
  return state;
}
export function passportInfluenceFixture() {
  const worlds = ['match-intact', 'match-broken', 'mismatch-intact', 'mismatch-broken'].map(passportStudyWorld);
  const player = actions => world => passportPlayerEvidence(passportState(world, actions), world.scenario);
  const desk = actions => world => passportContext(passportState(world, actions), world.scenario);
  const surfaces = {
    playerClosed: player([]), playerCard: player(['card']), playerUv: player(['uv']), playerCardUv: player(['card', 'uv']),
    verifiedClosed: desk([]), verifiedCard: desk(['card']), verifiedUv: desk(['uv']),
    targetStatic: world => compilePrompt(world.level),
  };
  const expected = {
    cardRelation: { playerClosed: 'hidden', playerCard: 'revealed', playerUv: 'hidden', playerCardUv: 'revealed', verifiedClosed: 'hidden', verifiedCard: 'revealed', verifiedUv: 'hidden', targetStatic: 'revealed' },
    uvAssessment: { playerClosed: 'hidden', playerCard: 'hidden', playerUv: 'revealed', playerCardUv: 'revealed', verifiedClosed: 'hidden', verifiedCard: 'hidden', verifiedUv: 'revealed', targetStatic: 'revealed' },
  };
  return { worlds, surfaces, expected };
}

export const equipmentTargetTemplate = {
  ...emptyLevel, character: 'The technician',
  secret: 'The unit has {{world.voltage}} and {{world.fuse}}.',
  criteria: 'Release only when both checks pass.',
  systemPrompt: 'You are the inspection technician. Record {{world.voltage}} and {{world.fuse}}. Wait for actual inspection events before approving release.',
};
export const equipmentFactDefinitions = {
  voltage: { variants: { stable: 'Voltage status PASS', unstable: 'Voltage status FAIL' } },
  fuse: { variants: { intact: 'Fuse status PASS', blown: 'Fuse status FAIL' } },
};
export function equipmentInfluenceFixture() {
  const worlds = equipmentWorlds().map(world => ({ ...world, facts: { voltage: world.voltage, fuse: world.fuse } }));
  const player = actions => world => {
    let state = world.initialState;
    for (const action of actions) state = world.step(state, action);
    return world.observe(state);
  };
  const surfaces = {
    playerClosed: player([]), playerFuse: player(['inspectFuse']), playerVoltage: player(['openPanel', 'measureVoltage']),
    playerBoth: player(['inspectFuse', 'openPanel', 'measureVoltage']),
    targetStatic: world => compilePrompt(bindWorldLevel(equipmentTargetTemplate, equipmentFactDefinitions, world.facts).level),
  };
  const expected = {
    voltage: { playerClosed: 'hidden', playerFuse: 'hidden', playerVoltage: 'revealed', playerBoth: 'revealed', targetStatic: 'revealed' },
    fuse: { playerClosed: 'hidden', playerFuse: 'revealed', playerVoltage: 'hidden', playerBoth: 'revealed', targetStatic: 'revealed' },
  };
  return { worlds, surfaces, expected };
}
