import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';

function normalized(value) {
  let encoded;
  try { encoded = JSON.stringify(value); } catch { throw new Error('World states and observations must be plain JSON values.'); }
  if (encoded === undefined || !isDeepStrictEqual(value, JSON.parse(encoded))) throw new Error('World states and observations must be plain JSON values.');
  const sort = item => Array.isArray(item) ? item.map(sort) :
    item !== null && typeof item === 'object' ? Object.fromEntries(Object.keys(item).sort().map(key => [key, sort(item[key])])) : item;
  return sort(value);
}
const keyOf = value => JSON.stringify(normalized(value));
const clone = value => structuredClone(value);

function view(world, state) {
  const observation = normalized(world.observe(clone(state)));
  const actions = world.enabled(clone(state));
  if (!Array.isArray(actions) || actions.some(action => typeof action !== 'string' || !action) || new Set(actions).size !== actions.length) throw new Error('Enabled actions must be distinct nonempty strings.');
  return { observation, availableActions: actions.slice().sort() };
}

/**
 * Explore a finite deterministic world family as player belief states.
 * Each node contains only worlds consistent with every prior observation and
 * available-action set. An exhausted bound returns inconclusive.
 */
export function auditDynamicEvidence({ worlds, maxBeliefStates = 10000 } = {}) {
  if (!Array.isArray(worlds) || worlds.length < 2 || worlds.some(world => !world || typeof world.id !== 'string' || !world.id || !('answer' in world) || !('initialState' in world) || typeof world.observe !== 'function' || typeof world.enabled !== 'function' || typeof world.step !== 'function') || new Set(worlds.map(world => world.id)).size !== worlds.length) throw new Error('Two or more uniquely named deterministic worlds are required.');
  if (!Number.isInteger(maxBeliefStates) || maxBeliefStates < 1) throw new Error('Belief-state bound must be a positive integer.');
  const worldById = new Map(worlds.map(world => [world.id, world]));
  for (const world of worlds) { normalized(world.answer); normalized(world.initialState); }
  if (worlds.every(world => isDeepStrictEqual(world.answer, worlds[0].answer))) throw new Error('Worlds need at least two different decisions.');

  const nodes = [], ids = new Map(), queue = [];
  const add = (members, sharedView) => {
    members.sort((a, b) => a.worldId.localeCompare(b.worldId));
    const signature = keyOf(members);
    if (ids.has(signature)) return ids.get(signature);
    if (nodes.length >= maxBeliefStates) return null;
    const possibleAnswers = [];
    for (const { worldId } of members) {
      const answer = normalized(worldById.get(worldId).answer);
      if (!possibleAnswers.some(existing => isDeepStrictEqual(existing, answer))) possibleAnswers.push(answer);
    }
    const id = nodes.length;
    nodes.push({ id, members, view: sharedView, possibleAnswers, sufficient: possibleAnswers.length === 1, edges: [] });
    ids.set(signature, id);
    queue.push(id);
    return id;
  };
  const partitions = candidates => {
    const groups = new Map();
    for (const member of candidates) {
      const observation = view(worldById.get(member.worldId), member.state);
      const key = keyOf(observation);
      if (!groups.has(key)) groups.set(key, { view: observation, members: [] });
      groups.get(key).members.push(member);
    }
    return [...groups.values()];
  };
  const initial = worlds.map(world => ({ worldId: world.id, state: clone(world.initialState) }));
  const roots = [];
  for (const group of partitions(initial)) {
    const id = add(group.members, group.view);
    if (id === null) return { status: 'inconclusive', reason: 'belief-state-limit', exploredBeliefStates: nodes.length, maxBeliefStates };
    roots.push(id);
  }
  let edges = 0;
  for (let head = 0; head < queue.length; head++) {
    const node = nodes[queue[head]];
    for (const action of node.view.availableActions) {
      const successors = node.members.map(({ worldId, state }) => {
        const next = worldById.get(worldId).step(clone(state), action);
        if (next === undefined) throw new Error(`Action ${action} returned no state in world ${worldId}.`);
        return { worldId, state: normalized(next) };
      });
      for (const group of partitions(successors)) {
        const target = add(group.members, group.view);
        if (target === null) return { status: 'inconclusive', reason: 'belief-state-limit', exploredBeliefStates: nodes.length, maxBeliefStates };
        node.edges.push({ action, to: target, worldIds: group.members.map(member => member.worldId) });
        edges++;
      }
    }
  }

  // A shortest trace for a known world may prescribe the right first click
  // only in hindsight. Compute a uniform adaptive policy over belief nodes:
  // the player chooses one visible action, then may branch on its observation.
  const worstCase = nodes.map(node => node.sufficient ? 0 : Infinity);
  const bestAction = nodes.map(() => null);
  for (let iteration = 0; iteration < nodes.length; iteration++) {
    let changed = false;
    for (const node of nodes) {
      if (node.sufficient) continue;
      for (const action of node.view.availableActions) {
        const successors = node.edges.filter(edge => edge.action === action).map(edge => worstCase[edge.to]);
        if (!successors.length || successors.some(value => !Number.isFinite(value))) continue;
        const cost = 1 + Math.max(...successors);
        if (cost < worstCase[node.id]) {
          worstCase[node.id] = cost;
          bestAction[node.id] = action;
          changed = true;
        }
      }
    }
    if (!changed) break;
  }

  const allActions = [...new Set(nodes.flatMap(node => node.view.availableActions))].sort();
  function shortest(worldId, omittedAction = null) {
    const root = roots.find(id => nodes[id].members.some(member => member.worldId === worldId));
    const pending = [{ id: root, actions: [] }], seen = new Set([root]);
    for (let head = 0; head < pending.length; head++) {
      const current = pending[head], node = nodes[current.id];
      if (node.sufficient) return { actions: current.actions, beliefNode: current.id, candidateWorldIds: node.members.map(member => member.worldId), decision: node.possibleAnswers[0] };
      for (const edge of node.edges) {
        if (edge.action === omittedAction || !edge.worldIds.includes(worldId) || seen.has(edge.to)) continue;
        seen.add(edge.to);
        pending.push({ id: edge.to, actions: [...current.actions, edge.action] });
      }
    }
    return null;
  }
  const byWorld = worlds.map(world => {
    const root = roots.find(id => nodes[id].members.some(member => member.worldId === world.id));
    const shortestDecision = shortest(world.id);
    const bypasses = Object.fromEntries(allActions.map(action => [action, shortest(world.id, action)]));
    return { worldId: world.id, answer: normalized(world.answer), initialCandidateWorldIds: nodes[root].members.map(member => member.worldId),
      initialView: nodes[root].view, initialSufficient: nodes[root].sufficient,
      adaptiveWorstCaseActions: Number.isFinite(worstCase[root]) ? worstCase[root] : null,
      recommendedFirstAction: bestAction[root], shortestDecision,
      requiredOnEveryResolvingPath: shortestDecision ? allActions.filter(action => bypasses[action] === null) : [],
      shortestDecisionWithout: bypasses };
  });
  return { status: byWorld.every(row => row.shortestDecision) ? 'analyzed' : 'unresolvable',
    adaptivePolicyStatus: roots.every(id => Number.isFinite(worstCase[id])) ? 'guaranteed' : 'no-guaranteed-policy',
    exploredBeliefStates: nodes.length, transitionEdges: edges, allActions, initialPartitions: roots.map(id => ({ node: id, worldIds: nodes[id].members.map(member => member.worldId), view: nodes[id].view,
      adaptiveWorstCaseActions: Number.isFinite(worstCase[id]) ? worstCase[id] : null, recommendedFirstAction: bestAction[id] })),
    worlds: byWorld,
    scope: 'Finite deterministic authored worlds and the supplied observation and action serializers. Action availability is visible. No timing, network, image, model behavior, or human discovery guarantee.' };
}
