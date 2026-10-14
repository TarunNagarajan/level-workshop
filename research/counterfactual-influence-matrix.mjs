import { isDeepStrictEqual } from 'node:util';

function firstDifference(left, right, path = '$') {
  if (isDeepStrictEqual(left, right)) return null;
  if (typeof left === 'string' && typeof right === 'string') {
    let offset = 0;
    while (offset < Math.min(left.length, right.length) && left[offset] === right[offset]) offset++;
    return { path, offset, left: left.slice(offset, offset + 90), right: right.slice(offset, offset + 90) };
  }
  if (left && right && typeof left === 'object' && typeof right === 'object' && Array.isArray(left) === Array.isArray(right)) {
    const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
    for (const key of keys) {
      const child = firstDifference(left[key], right[key], Array.isArray(left) ? `${path}[${key}]` : `${path}.${key}`);
      if (child) return child;
    }
  }
  return { path, left, right };
}

/** One-factor interventions reveal which actual serialized boundaries depend on each authored fact. */
export function auditFactorInfluence({ worlds, surfaces, expected }) {
  if (!Array.isArray(worlds) || worlds.length < 2) throw new Error('Audit at least two worlds.');
  if (!surfaces || !Object.keys(surfaces).length) throw new Error('Declare at least one runtime surface.');
  const factIds = Object.keys(worlds[0].facts || {});
  if (!factIds.length) throw new Error('Declare at least one world factor.');
  for (const world of worlds) if (factIds.some(id => world.facts[id] === undefined) || Object.keys(world.facts).length !== factIds.length)
    throw new Error(`World ${world.id} has a different factor schema.`);
  const pairs = worlds.flatMap((left, index) => worlds.slice(index + 1).flatMap(right => {
    const changed = factIds.filter(id => left.facts[id] !== right.facts[id]);
    return changed.length === 1 ? [{ left, right, fact: changed[0] }] : [];
  }));
  for (const id of factIds) if (!pairs.some(pair => pair.fact === id)) throw new Error(`No one-factor counterfactual pair for ${id}.`);
  const surfaceNames = Object.keys(surfaces);
  for (const id of factIds) for (const name of surfaceNames) if (!['hidden', 'revealed', 'unconstrained'].includes(expected?.[id]?.[name]))
    throw new Error(`Declare hidden, revealed, or unconstrained for ${id} on ${name}.`);
  const views = new Map(worlds.map(world => [world.id, Object.fromEntries(surfaceNames.map(name => [name, surfaces[name](world)]))]));
  const comparisons = pairs.flatMap(pair => surfaceNames.map(name => {
    const left = views.get(pair.left.id)[name], right = views.get(pair.right.id)[name];
    return { fact: pair.fact, surface: name, left: pair.left.id, right: pair.right.id,
      changed: !isDeepStrictEqual(left, right), firstDifference: firstDifference(left, right) };
  }));
  const cells = factIds.flatMap(fact => surfaceNames.map(surface => {
    const rows = comparisons.filter(row => row.fact === fact && row.surface === surface);
    const rule = expected[fact][surface];
    const violations = rule === 'hidden' ? rows.filter(row => row.changed) : rule === 'revealed' ? rows.filter(row => !row.changed) : [];
    return { fact, surface, rule, pairs: rows.length, changedPairs: rows.filter(row => row.changed).length,
      status: violations.length ? 'violated' : 'satisfied', witnesses: violations.map(row => ({ left: row.left, right: row.right, firstDifference: row.firstDifference })) };
  }));
  return { status: cells.some(cell => cell.status === 'violated') ? 'violated' : 'satisfied',
    worlds: worlds.map(world => world.id), pairCount: pairs.length, cells, comparisons };
}
