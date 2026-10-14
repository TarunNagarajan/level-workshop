import { applyPassportAction, initialPassportState, passportContext, passportScenario, passportStudyWorld, playerDocuments } from '../server/passport-reference.mjs';

// First uses of these real reducer actions. Repeats, dialogue, filing, hints,
// and arbitrary movement coordinates are outside this adapter's action set.
const choices = {
  open: { action: 'open' },
  turn: { action: 'turn' },
  card: { action: 'card' },
  'lamp:uv': { action: 'lamp', value: 'uv' },
  compare: { action: 'compare' },
  'move:passport': { action: 'move', object: 'passport', position: { x: 44, y: 58 } },
};
const has = (state, action) => state.events.some(event =>
  action === 'lamp:uv' ? event.action === 'lamp' && event.value === 'uv' :
    action === 'move:passport' ? event.action === 'move' && event.object === 'passport' : event.action === action);

export function availablePassportEvidenceActions(state) {
  const actions = [];
  if (!has(state, 'open')) actions.push('open');
  if (state.page && !has(state, 'turn')) actions.push('turn');
  if (!state.cardRequested) actions.push('card');
  if (!has(state, 'lamp:uv')) actions.push('lamp:uv');
  if (state.cardRequested && state.page && !state.compared) actions.push('compare');
  if (!has(state, 'move:passport')) actions.push('move:passport');
  return actions;
}
export function passportPlayerEvidence(state, scenario = passportScenario) {
  return {
    documents: playerDocuments(state, scenario),
    desk: {
      page: state.page, lamp: state.lamp, cardRequested: state.cardRequested,
      compared: state.compared, presented: state.presented, selected: state.selected,
      positions: state.positions,
      events: state.events.map(({ action, object, value, page, observation }) => ({ action, object, value, page, observation })),
    },
  };
}
export function passportEvidenceWorlds({ boundary = 'player' } = {}) {
  if (!['player', 'verifiedDesk'].includes(boundary)) throw new Error('Choose player or verifiedDesk boundary.');
  return ['match-intact', 'match-broken', 'mismatch-intact', 'mismatch-broken'].map(id => {
    const { scenario, answer } = passportStudyWorld(id);
    return {
      id,
      scenario,
      answer,
      initialState: initialPassportState(),
      observe: state => boundary === 'player' ? passportPlayerEvidence(state, scenario) : passportContext(state, scenario),
      enabled: availablePassportEvidenceActions,
      step: (state, action) => {
        if (!availablePassportEvidenceActions(state).includes(action)) throw new Error(`Unavailable first-use action: ${action}`);
        return applyPassportAction(state, { revision: state.revision, ...choices[action] }, { id: `evidence-${state.revision}`, at: 0, scenario }).state;
      },
    };
  });
}
