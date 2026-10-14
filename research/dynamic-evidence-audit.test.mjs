import test from 'node:test';
import assert from 'node:assert/strict';
import { auditDynamicEvidence } from './dynamic-evidence-audit.mjs';
import { equipmentWorlds } from './dynamic-evidence-fixture.mjs';

const byId = report => Object.fromEntries(report.worlds.map(row => [row.worldId, row]));

test('dynamic decision audit distinguishes conditional evidence and prerequisite actions', () => {
  const report = auditDynamicEvidence({ worlds: equipmentWorlds() });
  assert.equal(report.status, 'analyzed');
  assert.equal(report.initialPartitions.length, 1);
  assert.equal(report.adaptivePolicyStatus, 'guaranteed');
  assert.equal(report.initialPartitions[0].adaptiveWorstCaseActions, 3);
  assert.equal(report.initialPartitions[0].recommendedFirstAction, 'inspectFuse');
  const rows = byId(report);
  assert.equal(rows['stable-intact'].shortestDecision.actions.length, 3);
  assert.deepEqual(rows['stable-intact'].requiredOnEveryResolvingPath, ['inspectFuse', 'measureVoltage', 'openPanel']);
  assert.deepEqual(rows['stable-blown'].shortestDecision.actions, ['inspectFuse']);
  assert.deepEqual(rows['stable-blown'].requiredOnEveryResolvingPath, ['inspectFuse']);
  assert.deepEqual(rows['unstable-intact'].requiredOnEveryResolvingPath, ['measureVoltage', 'openPanel']);
  assert.deepEqual(rows['unstable-blown'].requiredOnEveryResolvingPath, []);
  assert.deepEqual(rows['unstable-blown'].shortestDecision.actions, ['inspectFuse']);
  assert.ok(report.worlds.every(row => !row.requiredOnEveryResolvingPath.includes('moveClipboard')));
  assert.equal(rows['stable-intact'].shortestDecisionWithout.inspectFuse, null);
  assert.deepEqual(rows['unstable-blown'].shortestDecisionWithout.inspectFuse.actions, ['openPanel', 'measureVoltage']);
});

test('initial API data and action availability each create zero-click decision leaks', () => {
  const payloadLeak = byId(auditDynamicEvidence({ worlds: equipmentWorlds({ leakVoltage: true }) }));
  assert.equal(payloadLeak['unstable-intact'].initialSufficient, true);
  assert.deepEqual(payloadLeak['unstable-intact'].shortestDecision.actions, []);
  const controlLeak = auditDynamicEvidence({ worlds: equipmentWorlds({ leakFuseByAvailability: true }) });
  assert.equal(controlLeak.initialPartitions.length, 2);
  const rows = byId(controlLeak);
  assert.equal(rows['stable-blown'].initialSufficient, true);
  assert.deepEqual(rows['stable-blown'].shortestDecision.actions, []);
  assert.equal(rows['stable-intact'].initialSufficient, false);
});

test('hindsight paths are not mistaken for a guaranteed player policy', () => {
  const worlds = ['A', 'B', 'C'].map(id => ({
    id, answer: id, initialState: { tested: null },
    observe: state => ({ outcome: state.tested ? (state.tested === id ? 'positive' : 'negative') : null }),
    enabled: state => state.tested ? [] : ['testA', 'testB', 'testC'],
    step: (_state, action) => ({ tested: action.slice(-1) }),
  }));
  const report = auditDynamicEvidence({ worlds });
  assert.equal(report.status, 'analyzed');
  assert.equal(report.adaptivePolicyStatus, 'no-guaranteed-policy');
  assert.equal(report.initialPartitions[0].adaptiveWorstCaseActions, null);
  assert.equal(report.initialPartitions[0].recommendedFirstAction, null);
  assert.ok(report.worlds.every(row => row.shortestDecision.actions.length === 1));
});

test('a clipboard observation becomes a shortest bypass of the voltage test', () => {
  const rows = byId(auditDynamicEvidence({ worlds: equipmentWorlds({ shortcutViaClipboard: true }) }));
  assert.deepEqual(rows['unstable-intact'].shortestDecision.actions, ['moveClipboard']);
  assert.deepEqual(rows['unstable-intact'].shortestDecisionWithout.measureVoltage.actions, ['moveClipboard']);
  assert.equal(rows['unstable-intact'].requiredOnEveryResolvingPath.includes('measureVoltage'), false);
});

test('an exhausted state bound is inconclusive and never a pass', () => {
  const report = auditDynamicEvidence({ worlds: equipmentWorlds(), maxBeliefStates: 2 });
  assert.equal(report.status, 'inconclusive');
  assert.equal(report.reason, 'belief-state-limit');
  assert.equal(report.exploredBeliefStates, 2);
});

test('merged belief graph agrees with exhaustive unmerged action histories', () => {
  const groupsByView = members => {
    const groups = new Map();
    for (const member of members) {
      const snapshot = { observation: member.world.observe(member.state), actions: member.world.enabled(member.state).slice().sort() };
      const key = JSON.stringify(snapshot);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(member);
    }
    return [...groups.values()];
  };
  const unmergedPolicyCost = members => {
    if (new Set(members.map(member => member.world.answer)).size === 1) return 0;
    const choices = members[0].world.enabled(members[0].state);
    if (!choices.length) return Infinity;
    return Math.min(...choices.map(action => {
      const next = members.map(member => ({ world: member.world, state: member.world.step(member.state, action) }));
      return 1 + Math.max(...groupsByView(next).map(unmergedPolicyCost));
    }));
  };
  for (const options of [{}, { leakVoltage: true }, { leakFuseByAvailability: true }, { shortcutViaClipboard: true }]) {
    const worlds = equipmentWorlds(options);
    const report = auditDynamicEvidence({ worlds });
    const initialGroups = groupsByView(worlds.map(world => ({ world, state: world.initialState })));
    assert.deepEqual(report.initialPartitions.map(partition => partition.adaptiveWorstCaseActions),
      initialGroups.map(group => {
        const cost = unmergedPolicyCost(group);
        return Number.isFinite(cost) ? cost : null;
      }));
    for (const actual of worlds) {
      const resolving = [];
      const traceView = (world, actions) => {
        let state = structuredClone(world.initialState);
        const views = [];
        for (const action of [null, ...actions]) {
          if (action !== null) {
            if (!world.enabled(state).includes(action)) return null;
            state = world.step(state, action);
          }
          views.push({ observation: world.observe(state), availableActions: world.enabled(state).slice().sort() });
        }
        return views;
      };
      const visit = (state, actions) => {
        const observed = traceView(actual, actions);
        const candidates = worlds.filter(world => JSON.stringify(traceView(world, actions)) === JSON.stringify(observed));
        if (new Set(candidates.map(world => world.answer)).size === 1) resolving.push(actions);
        for (const action of actual.enabled(state)) visit(actual.step(state, action), [...actions, action]);
      };
      visit(actual.initialState, []);
      const row = report.worlds.find(item => item.worldId === actual.id);
      assert.equal(row.shortestDecision?.actions.length ?? null, resolving.length ? Math.min(...resolving.map(actions => actions.length)) : null);
      for (const action of report.allActions) {
        const brute = resolving.filter(actions => !actions.includes(action));
        assert.equal(row.shortestDecisionWithout[action]?.actions.length ?? null, brute.length ? Math.min(...brute.map(actions => actions.length)) : null,
          `${actual.id} ${action} disagrees with exhaustive histories`);
      }
    }
  }
});

test('invalid action lists and state outputs are rejected', () => {
  const duplicate = equipmentWorlds();
  duplicate[0].enabled = () => ['openPanel', 'openPanel'];
  assert.throws(() => auditDynamicEvidence({ worlds: duplicate }), /distinct/);
  const invalid = equipmentWorlds();
  invalid[0].step = () => undefined;
  assert.throws(() => auditDynamicEvidence({ worlds: invalid }), /no state/);
});
