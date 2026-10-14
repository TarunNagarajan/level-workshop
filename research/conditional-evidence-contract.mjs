import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';

function plainJson(value) {
  let encoded;
  try { encoded = JSON.stringify(value); } catch { throw new Error('Observations and answers must be plain JSON values.'); }
  if (encoded === undefined || !isDeepStrictEqual(value, JSON.parse(encoded))) throw new Error('Observations and answers must be plain JSON values.');
  return JSON.parse(encoded);
}

export function inspectEvidenceBelief({ worlds, actions, publicView, trueWorldId, inspected = [] }) {
  const actual = worlds.find(world => world.id === trueWorldId);
  if (!actual) throw new Error('Unknown actual world.');
  if (new Set(inspected).size !== inspected.length || inspected.some(id => !actions.some(action => action.id === id))) throw new Error('Unknown or repeated inspected action.');
  const initial = plainJson(publicView(actual));
  const observations = Object.fromEntries(inspected.map(id => {
    const action = actions.find(candidate => candidate.id === id);
    return [id, plainJson(action.observe(actual))];
  }));
  const candidates = worlds.filter(world => isDeepStrictEqual(plainJson(publicView(world)), initial) &&
    inspected.every(id => isDeepStrictEqual(plainJson(actions.find(action => action.id === id).observe(world)), observations[id])));
  const possibleAnswers = [];
  for (const world of candidates) if (!possibleAnswers.some(answer => isDeepStrictEqual(answer, world.answer))) possibleAnswers.push(plainJson(world.answer));
  return { actualWorldId: trueWorldId, inspected, observations, candidateWorldIds: candidates.map(world => world.id), possibleAnswers, sufficient: possibleAnswers.length === 1 };
}

export function auditConditionalEvidence({ worlds, actions, publicView, maxActions = 10 }) {
  if (!Array.isArray(worlds) || worlds.length < 2 || worlds.some(world => !world || typeof world.id !== 'string' || !world.id || !('answer' in world)) || new Set(worlds.map(world => world.id)).size !== worlds.length) throw new Error('Two or more uniquely named worlds with answers are required.');
  if (!Array.isArray(actions) || !actions.length || actions.some(action => !action || typeof action.id !== 'string' || !action.id || typeof action.observe !== 'function') || new Set(actions.map(action => action.id)).size !== actions.length || typeof publicView !== 'function') throw new Error('Unique observable actions and a public view are required.');
  if (!Number.isInteger(maxActions) || maxActions < 1) throw new Error('Action limit must be positive.');
  if (actions.length > maxActions) return { status: 'inconclusive', reason: 'action-limit', actions: actions.length, maxActions };
  for (const world of worlds) {
    plainJson(world.answer); plainJson(publicView(world));
    for (const action of actions) plainJson(action.observe(world));
  }
  if (worlds.every(world => isDeepStrictEqual(world.answer, worlds[0].answer))) throw new Error('Worlds need different correct answers.');

  const byWorld = [];
  for (const world of worlds) {
    const minimal = [];
    for (let size = 0; size <= actions.length; size++) {
      const choose = (start, selected) => {
        if (selected.length === size) {
          if (minimal.some(cut => cut.every(id => selected.includes(id)))) return;
          const belief = inspectEvidenceBelief({ worlds, actions, publicView, trueWorldId: world.id, inspected: selected });
          if (belief.sufficient) minimal.push([...selected]);
          return;
        }
        for (let index = start; index <= actions.length - (size - selected.length); index++) choose(index + 1, [...selected, actions[index].id]);
      };
      choose(0, []);
    }
    const initial = inspectEvidenceBelief({ worlds, actions, publicView, trueWorldId: world.id });
    const necessaryOnEveryMinimalPath = actions.map(action => action.id).filter(id => minimal.length > 0 && minimal.every(set => set.includes(id)));
    byWorld.push({ worldId: world.id, answer: world.answer, initialCandidateWorldIds: initial.candidateWorldIds, initialSufficient: initial.sufficient, minimalSufficientActionSets: minimal, necessaryOnEveryMinimalPath, shortestClickCount: minimal.length ? Math.min(...minimal.map(set => set.length)) : null });
  }
  const neverInMinimalSet = actions.map(action => action.id).filter(id => byWorld.every(row => row.minimalSufficientActionSets.every(set => !set.includes(id))));
  return { status: byWorld.some(row => !row.minimalSufficientActionSets.length) ? 'unresolvable' : 'analyzed', worlds: byWorld, neverInMinimalSet, scope: 'Finite static observations and authored worlds; no timing, memory, external information, or human discoverability claim.' };
}
