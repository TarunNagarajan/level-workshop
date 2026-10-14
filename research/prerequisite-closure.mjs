/**
 * Fast authoring preflight: prove that a declared reveal is already derivable
 * from observations guaranteed by the action's prerequisites. This is a
 * lower-bound knowledge check over an authored fact/action contract, not an
 * exhaustive runtime path or client-surface certificate.
 */
export function auditPrerequisiteClosure({ actions, derived = [], initialFacts = [], targetAction, targetFact, boundary }) {
  if (!Array.isArray(actions) || !Array.isArray(derived) || !Array.isArray(initialFacts) || typeof targetAction !== 'string' || typeof targetFact !== 'string') throw new Error('Actions, derivations, initial facts, and target identifiers are required.');
  const byId = new Map();
  for (const action of actions) {
    if (!action || typeof action.id !== 'string' || !action.id || byId.has(action.id) || (!Array.isArray(action.reveals) && (!action.revealsTo || typeof action.revealsTo !== 'object')) || !Array.isArray(action.requiresAll ?? []) || (action.requiresAny !== undefined && (!Array.isArray(action.requiresAny) || !action.requiresAny.length || action.requiresAny.some(set => !Array.isArray(set))))) throw new Error('Invalid or duplicate action contract.');
    if (action.revealsTo && (!boundary || Object.values(action.revealsTo).some(facts => !Array.isArray(facts)))) throw new Error('Recipient-scoped reveals require a boundary and fact lists.');
    byId.set(action.id, action);
  }
  const target = byId.get(targetAction);
  if (!target) throw new Error('Target action is missing.');
  for (const action of actions) for (const id of [...(action.requiresAll ?? []), ...(action.requiresAny ?? []).flat()]) if (!byId.has(id)) throw new Error(`Unknown prerequisite action: ${id}`);
  for (const rule of derived) if (!rule || typeof rule.fact !== 'string' || !Array.isArray(rule.from) || !rule.from.length || rule.from.some(fact => typeof fact !== 'string')) throw new Error('Invalid derived-fact rule.');
  const alternatives = target.requiresAny ?? [[]];
  const paths = alternatives.map(alternative => {
    const required = new Set();
    function visit(id, stack = []) {
      if (stack.includes(id)) throw new Error(`Prerequisite cycle: ${[...stack, id].join(' -> ')}`);
      if (required.has(id)) return;
      const action = byId.get(id);
      if (action.requiresAny?.length) throw new Error('Alternative prerequisites on a nested action require path expansion before this preflight.');
      for (const parent of action.requiresAll ?? []) visit(parent, [...stack, id]);
      required.add(id);
    }
    for (const id of [...(target.requiresAll ?? []), ...alternative]) visit(id);
    const proofs = new Map();
    for (const fact of initialFacts) proofs.set(fact, { kind: 'initial', fact });
    for (const id of required) {
      const action = byId.get(id);
      const revealed = action.revealsTo ? action.revealsTo[boundary] ?? [] : action.reveals;
      for (const fact of revealed) if (!proofs.has(fact)) proofs.set(fact, { kind: 'action', fact, action: id });
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (const rule of derived) if (!proofs.has(rule.fact) && rule.from.every(fact => proofs.has(fact))) {
        proofs.set(rule.fact, { kind: 'derived', fact: rule.fact, from: rule.from.map(fact => proofs.get(fact)) });
        changed = true;
      }
    }
    return { prerequisiteActions: [...required], knownFacts: [...proofs.keys()], alreadyKnown: proofs.has(targetFact), proof: proofs.get(targetFact) ?? null };
  });
  const knownPaths = paths.filter(path => path.alreadyKnown).length;
  return { targetAction, targetFact, boundary: boundary ?? null,
    status: knownPaths === paths.length ? 'always-known-before' : knownPaths ? 'sometimes-known-before' : 'not-proven-known-before',
    paths, scope: 'Declarative prerequisite and fact-derivation lower bound. A negative result does not certify necessity; runtime guards, other routes, client assets, and model requests still require audit.' };
}
