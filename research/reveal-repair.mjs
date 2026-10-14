import { auditPrerequisiteClosure } from './prerequisite-closure.mjs';

/**
 * Enumerate cardinality-minimal edits that remove a fact before an action.
 * Each source is one distinct pre-action occurrence of a fact. The caller must
 * provide all relevant sources and pin those that cannot be delayed without
 * breaking an earlier intended reveal. This is a design repair suggestion,
 * not a rewrite of application code or an exhaustive visibility audit.
 */
export function synthesizeRevealRepair({ actions, derived = [], sources, targetAction, targetFact, maxCandidates = 16 }) {
  if (!Array.isArray(actions) || !Array.isArray(sources) || !Number.isInteger(maxCandidates) || maxCandidates < 0 || maxCandidates > 20) throw new Error('Actions, sources, and a candidate bound from zero to twenty are required.');
  const ids = new Set();
  const actionsById = new Map(actions.map(action => [action.id, action]));
  if (actionsById.size !== actions.length || !actionsById.has(targetAction)) throw new Error('Action IDs must be unique and include the target.');
  for (const source of sources) {
    if (!source || typeof source.id !== 'string' || !source.id || ids.has(source.id) || typeof source.fact !== 'string' || !source.fact || (source.at !== 'initial' && !actionsById.has(source.at)) || typeof source.editable !== 'boolean') throw new Error('Invalid source declaration.');
    ids.add(source.id);
  }
  const editable = sources.filter(source => source.editable).map(source => source.id);
  function evaluate(removed) {
    const remaining = sources.filter(source => !removed.has(source.id));
    const built = actions.map(action => ({ ...action, reveals: remaining.filter(source => source.at === action.id).map(source => source.fact) }));
    return auditPrerequisiteClosure({ actions: built, derived,
      initialFacts: remaining.filter(source => source.at === 'initial').map(source => source.fact),
      targetAction, targetFact });
  }
  const baseline = evaluate(new Set());
  if (baseline.status === 'not-proven-known-before') return { status: 'no-edit-needed-by-preflight', targetAction, targetFact, baseline, minimalEditCount: 0, plans: [{ remove: [], after: baseline.status }], candidatesConsidered: editable.length };
  if (editable.length > maxCandidates) return { status: 'inconclusive-candidate-limit', targetAction, targetFact, baseline, candidatesConsidered: editable.length, maxCandidates };
  for (let size = 1; size <= editable.length; size++) {
    const plans = [];
    function combinations(start, chosen) {
      if (chosen.length === size) {
        const after = evaluate(new Set(chosen));
        if (after.status === 'not-proven-known-before') plans.push({ remove: [...chosen], after: after.status });
        return;
      }
      for (let index = start; index <= editable.length - (size - chosen.length); index++) combinations(index + 1, [...chosen, editable[index]]);
    }
    combinations(0, []);
    if (plans.length) return { status: 'repair-candidates', targetAction, targetFact, baseline, minimalEditCount: size, plans, candidatesConsidered: editable.length };
  }
  const unavoidable = evaluate(new Set(editable));
  return { status: 'infeasible-under-pins', targetAction, targetFact, baseline, unavoidable, minimalEditCount: null, plans: [], candidatesConsidered: editable.length };
}
