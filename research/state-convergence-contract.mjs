import assert from 'node:assert/strict';
import { compareObserverBoundary } from './observer-relative-cut.mjs';

function adjacentSwapBeforeCommonAction(left, right) {
  if (left.length !== right.length || left.length < 3 || left.at(-1) !== right.at(-1)) return false;
  const differing = left.map((action, index) => action === right[index] ? null : index).filter(index => index !== null);
  return differing.length === 2 && differing[1] === differing[0] + 1
    && differing[1] < left.length - 1
    && left[differing[0]] === right[differing[1]]
    && left[differing[1]] === right[differing[0]];
}

/** Discover observed adjacent-action swaps that converge in reducer state before a shared final click. */
export function auditStateConvergences(rows, world) {
  assert.ok(Array.isArray(rows) && rows.length);
  const buckets = new Map();
  for (const row of rows) {
    assert.equal(row.worldId, world.id);
    assert.deepEqual(row.trace.map(stage => stage.action), ['intro', ...row.path]);
    let state = structuredClone(world.initialState);
    for (let index = 1; index < row.trace.length; index++) {
      const action = row.trace[index].action;
      assert.ok(world.enabled(state).includes(action), `${world.id}: illegal ${action}`);
      state = world.step(state, action);
      const prefix = row.path.slice(0, index);
      const key = JSON.stringify({ state, lastAction: action, length: index });
      if (!buckets.has(key)) buckets.set(key, new Map());
      buckets.get(key).set(prefix.join(','), { prefix, stage: row.trace[index] });
    }
  }
  const comparisons = [];
  for (const [stateKey, prefixes] of buckets) {
    const items = [...prefixes.values()].sort((a, b) => a.prefix.join(',').localeCompare(b.prefix.join(',')));
    for (let a = 0; a < items.length; a++) for (let b = a + 1; b < items.length; b++) {
      if (!adjacentSwapBeforeCommonAction(items[a].prefix, items[b].prefix)) continue;
      const comparison = compareObserverBoundary(items[a].stage.capture, items[b].stage.capture);
      comparisons.push({ worldId: world.id, stageIndex: items[a].prefix.length,
        left: items[a].prefix, right: items[b].prefix, stateKey,
        equalByChannel: comparison.channels,
        differingResources: comparison.differingResources,
        differingRequests: comparison.differingRequests });
    }
  }
  return comparisons;
}
