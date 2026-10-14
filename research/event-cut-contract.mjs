import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';

function stable(value) {
  let text;
  try { text = JSON.stringify(value); } catch { throw new Error('Scene states and observations must be plain JSON values.'); }
  if (text === undefined || !isDeepStrictEqual(value, JSON.parse(text))) throw new Error('Scene states and observations must be plain JSON values.');
  return text;
}
const cloneJson = value => JSON.parse(stable(value));

function firstDifference(left, right, path = '$') {
  if (isDeepStrictEqual(left, right)) return null;
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) return { path: `${path}.length`, left: left.length, right: right.length };
    for (let index = 0; index < left.length; index++) {
      const difference = firstDifference(left[index], right[index], `${path}[${index}]`);
      if (difference) return difference;
    }
  }
  if (left !== null && right !== null && typeof left === 'object' && typeof right === 'object' && !Array.isArray(left) && !Array.isArray(right)) {
    for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) {
      if (!(key in left) || !(key in right)) return { path: `${path}.${key}`, left: key in left ? left[key] : '<missing>', right: key in right ? right[key] : '<missing>' };
      const difference = firstDifference(left[key], right[key], `${path}.${key}`);
      if (difference) return difference;
    }
  }
  return { path, left, right };
}

/**
 * Explore the paired state graph of two deterministic authored scenes.
 * The returned certificate applies only to the actions, observations, and
 * state transitions supplied here. A limit yields inconclusive, never pass.
 */
export function auditEventCut({ worlds, requiredAction, requiredActions, maxPairs = 10000 }) {
  assert.equal(worlds?.length, 2, 'Exactly two worlds are required.');
  const cut = requiredActions ?? [requiredAction];
  if (!Array.isArray(cut) || !cut.length || cut.some(action => typeof action !== 'string' || !action) || new Set(cut).size !== cut.length || !Number.isInteger(maxPairs) || maxPairs < 1) throw new Error('Required actions and a positive state limit are needed.');
  for (const world of worlds) {
    if (!world || !('initialState' in world) || !('answer' in world) || typeof world.observe !== 'function' || typeof world.enabled !== 'function' || typeof world.step !== 'function') throw new Error('Each world needs state, answer, observe, enabled, and step.');
  }
  if (isDeepStrictEqual(worlds[0].answer, worlds[1].answer)) throw new Error('Twin worlds need distinct answers.');

  const queue = [{ states: worlds.map(world => world.initialState), trace: [], usedRequiredAction: false }];
  let head = 0;
  const seen = new Set();
  let bypass = null;
  let reveal = null;
  let reachableRequiredAction = false;
  let exploredPairs = 0;

  while (head < queue.length) {
    const node = queue[head++];
    const key = stable({ states: node.states, used: node.usedRequiredAction });
    if (seen.has(key)) continue;
    seen.add(key);
    exploredPairs++;
    if (exploredPairs > maxPairs) return { status: 'inconclusive', reason: 'state-limit', exploredPairs: maxPairs, requiredActions: cut, shortestBypass: bypass, revealTrace: reveal };

    const observations = worlds.map((world, index) => world.observe(cloneJson(node.states[index])));
    observations.forEach(stable);
    const enabled = worlds.map((world, index) => {
      const actions = world.enabled(cloneJson(node.states[index]));
      if (!Array.isArray(actions) || actions.some(action => typeof action !== 'string') || new Set(actions).size !== actions.length) throw new Error('Enabled actions must be unique strings.');
      return actions.slice().sort();
    });
    const difference = !isDeepStrictEqual(observations[0], observations[1]) ? 'observation' :
      !isDeepStrictEqual(enabled[0], enabled[1]) ? 'action-availability' : null;
    if (difference) {
      const firstDifferingField = difference === 'observation'
        ? firstDifference(observations[0], observations[1], '$.observation')
        : firstDifference(enabled[0], enabled[1], '$.availableActions');
      const witness = { actions: node.trace, difference, firstDifferingField, observations, enabled };
      if (node.usedRequiredAction && !reveal) reveal = witness;
      if (!node.usedRequiredAction && !bypass) bypass = witness;
      continue;
    }
    if (enabled[0].some(action => cut.includes(action))) reachableRequiredAction = true;
    for (const action of enabled[0]) {
      const states = worlds.map((world, index) => world.step(cloneJson(node.states[index]), action));
      if (states.some(state => state === undefined)) throw new Error(`Action ${action} returned undefined state.`);
      queue.push({ states, trace: [...node.trace, action], usedRequiredAction: node.usedRequiredAction || cut.includes(action) });
    }
  }

  return {
    status: bypass ? 'bypass' : !reveal ? 'no-reveal' : 'certified',
    requiredAction: cut.length === 1 ? cut[0] : undefined, requiredActions: cut, exploredPairs, reachableRequiredAction,
    shortestBypass: bypass, revealTrace: reveal,
    claim: bypass ? 'An alternate modeled trace distinguishes the worlds without the required action.'
      : !reveal ? 'The required action did not create a modeled distinguishing trace.'
        : 'Every modeled distinguishing trace uses the required action, and one such trace exists.',
  };
}

export function findMinimalEventCuts({ worlds, candidateActions, maxCutSize = 3, maxPairs = 10000 }) {
  if (!Array.isArray(candidateActions) || !candidateActions.length || candidateActions.length > 10 || candidateActions.some(action => typeof action !== 'string' || !action) || new Set(candidateActions).size !== candidateActions.length || !Number.isInteger(maxCutSize) || maxCutSize < 1) throw new Error('Choose one to ten distinct candidate actions and a positive cut size.');
  const cuts = [];
  let tested = 0;
  let inconclusive = false;
  function combinations(size, start = 0, chosen = []) {
    if (chosen.length === size) {
      if (cuts.some(cut => cut.every(action => chosen.includes(action)))) return;
      const result = auditEventCut({ worlds, requiredActions: chosen, maxPairs });
      tested++;
      if (result.status === 'certified') cuts.push([...chosen]);
      if (result.status === 'inconclusive') inconclusive = true;
      return;
    }
    for (let index = start; index <= candidateActions.length - (size - chosen.length); index++) combinations(size, index + 1, [...chosen, candidateActions[index]]);
  }
  for (let size = 1; size <= Math.min(maxCutSize, candidateActions.length); size++) combinations(size);
  return { status: inconclusive ? 'inconclusive' : cuts.length ? 'found' : 'none', cuts, tested, candidates: candidateActions, maxCutSize };
}
