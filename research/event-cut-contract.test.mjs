import test from 'node:test';
import assert from 'node:assert/strict';
import { auditEventCut, findMinimalEventCuts } from './event-cut-contract.mjs';

function scene(matched, { alternateLeak = false, availabilityLeak = false, delayedReveal = false } = {}) {
  return {
    answer: matched ? 'admit' : 'hold',
    initialState: { badge: false, ticket: false, compared: false, report: false },
    enabled(state) {
      const actions = [];
      if (!state.badge) actions.push('open-badge');
      if (!state.ticket) actions.push('open-ticket');
      if (state.badge && state.ticket && !state.compared) actions.push('compare-seals');
      if (state.compared && delayedReveal && !state.report) actions.push('read-report');
      if (alternateLeak && !state.report) actions.push('inspect-seal');
      if (availabilityLeak && matched) actions.push('special-check');
      return actions;
    },
    step(state, action) {
      if (action === 'open-badge') return { ...state, badge: true };
      if (action === 'open-ticket') return { ...state, ticket: true };
      if (action === 'compare-seals') return { ...state, compared: true };
      if (action === 'read-report' || action === 'inspect-seal') return { ...state, report: true };
      if (action === 'special-check') return state;
      throw new Error(`Unknown action: ${action}`);
    },
    observe(state) {
      return {
        badge: state.badge ? 'Badge displayed: Mira' : 'Badge closed',
        ticket: state.ticket ? 'Ticket displayed: Mira' : 'Ticket closed',
        sealResult: (delayedReveal ? state.report : state.compared) || state.report ? (matched ? 'match' : 'mismatch') : null,
      };
    },
  };
}

test('certifies a required comparison across every modeled click order', () => {
  const result = auditEventCut({ worlds: [scene(true), scene(false)], requiredAction: 'compare-seals' });
  assert.equal(result.status, 'certified');
  assert.equal(result.shortestBypass, null);
  assert.deepEqual(result.revealTrace.actions, ['open-badge', 'open-ticket', 'compare-seals']);
});

test('returns the shortest alternative inspection that leaks the answer', () => {
  const result = auditEventCut({ worlds: [scene(true, { alternateLeak: true }), scene(false, { alternateLeak: true })], requiredAction: 'compare-seals' });
  assert.equal(result.status, 'bypass');
  assert.deepEqual(result.shortestBypass.actions, ['inspect-seal']);
  assert.equal(result.shortestBypass.difference, 'observation');
  assert.equal(result.shortestBypass.firstDifferingField.path, '$.observation.sealResult');
});

test('treats world-specific action availability as an initial leak', () => {
  const result = auditEventCut({ worlds: [scene(true, { availabilityLeak: true }), scene(false, { availabilityLeak: true })], requiredAction: 'compare-seals' });
  assert.equal(result.status, 'bypass');
  assert.deepEqual(result.shortestBypass.actions, []);
  assert.equal(result.shortestBypass.difference, 'action-availability');
  assert.match(result.shortestBypass.firstDifferingField.path, /^\$\.availableActions/);
});

test('permits a later reveal as long as the required action is on every reveal path', () => {
  const result = auditEventCut({ worlds: [scene(true, { delayedReveal: true }), scene(false, { delayedReveal: true })], requiredAction: 'compare-seals' });
  assert.equal(result.status, 'certified');
  assert.deepEqual(result.revealTrace.actions, ['open-badge', 'open-ticket', 'compare-seals', 'read-report']);
});

test('returns inconclusive when the finite-state audit limit is reached', () => {
  const result = auditEventCut({ worlds: [scene(true), scene(false)], requiredAction: 'compare-seals', maxPairs: 2 });
  assert.equal(result.status, 'inconclusive');
  assert.equal(result.reason, 'state-limit');
});

test('rejects state values that JSON keys would silently collapse', () => {
  const worlds = [scene(true), scene(false)];
  worlds[0].initialState = { hidden: undefined };
  assert.throws(() => auditEventCut({ worlds, requiredAction: 'compare-seals' }), /plain JSON values/);
});

test('isolates queued states from reducers that mutate their input', () => {
  const worlds = [scene(true), scene(false)];
  for (const world of worlds) {
    const step = world.step;
    world.step = (state, action) => Object.assign(state, step(state, action));
  }
  const result = auditEventCut({ worlds, requiredAction: 'compare-seals' });
  assert.equal(result.status, 'certified');
  assert.deepEqual(result.revealTrace.actions, ['open-badge', 'open-ticket', 'compare-seals']);
});

test('finds an inclusion-minimal action set when two legitimate reveal paths exist', () => {
  const worlds = [scene(true, { alternateLeak: true }), scene(false, { alternateLeak: true })];
  const result = findMinimalEventCuts({ worlds, candidateActions: ['compare-seals', 'inspect-seal', 'open-ticket'] });
  assert.equal(result.status, 'found');
  assert.deepEqual(result.cuts, [['compare-seals', 'inspect-seal'], ['inspect-seal', 'open-ticket']]);
  assert.equal(auditEventCut({ worlds, requiredActions: result.cuts[0] }).status, 'certified');
});
