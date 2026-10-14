import assert from 'node:assert/strict';

const pointerPart = value => String(value).replaceAll('~', '~0').replaceAll('/', '~1');

export function stringLeaves(value, path = '') {
  if (typeof value === 'string') return [{ path: path || '/', text: value }];
  if (Array.isArray(value)) return value.flatMap((item, index) => stringLeaves(item, `${path}/${index}`));
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([key, item]) => stringLeaves(item, `${path}/${pointerPart(key)}`));
  return [];
}

function pathsForFact(fact, surface) {
  const leaves = stringLeaves(surface);
  const variants = fact.variants ?? [];
  const matched = leaves.filter(({ text }) => variants.some(variant => text.toLocaleLowerCase('en-US').includes(variant.toLocaleLowerCase('en-US')))).map(({ path }) => path);
  const derived = fact.derive?.(surface, leaves) ?? [];
  if (!Array.isArray(derived) || derived.some(path => typeof path !== 'string' || !path.startsWith('/'))) throw new Error(`Fact ${fact.id} returned invalid derived evidence paths.`);
  return [...new Set([...matched, ...derived])].sort();
}

export function compileVisibilityManifest({ facts, frames, boundaries, rules = [] }) {
  if (!Array.isArray(facts) || !facts.length || facts.some(fact => !fact || typeof fact.id !== 'string' || !fact.id || (!Array.isArray(fact.variants) && typeof fact.derive !== 'function') || (fact.variants ?? []).some(value => typeof value !== 'string' || !value))) throw new Error('Facts need unique IDs and literal variants or a derivation.');
  if (new Set(facts.map(fact => fact.id)).size !== facts.length) throw new Error('Fact IDs must be unique.');
  if (!Array.isArray(frames) || !frames.length || frames.some(frame => !frame || typeof frame.stage !== 'string' || !frame.stage || !frame.surfaces || typeof frame.surfaces !== 'object')) throw new Error('Ordered frames with stages and surfaces are required.');
  if (new Set(frames.map(frame => frame.stage)).size !== frames.length) throw new Error('Frame stages must be unique.');
  if (!boundaries || typeof boundaries !== 'object' || !Object.keys(boundaries).length || Object.entries(boundaries).some(([name, members]) => !name || !Array.isArray(members) || !members.length || members.some(member => typeof member !== 'string' || !member))) throw new Error('Named boundaries with surface members are required.');
  const stages = new Map(frames.map((frame, index) => [frame.stage, index]));
  const factIds = new Set(facts.map(fact => fact.id));
  const surfaceNames = new Set(frames.flatMap(frame => Object.keys(frame.surfaces)));
  for (const members of Object.values(boundaries)) for (const member of members) if (!surfaceNames.has(member)) throw new Error(`Unknown surface ${member}.`);
  for (const rule of rules) {
    if (!factIds.has(rule.factId) || !(rule.boundary in boundaries) || (rule.never === true) === (typeof rule.earliestStage === 'string') || (rule.earliestStage && !stages.has(rule.earliestStage))) throw new Error('Rule needs an existing fact, boundary, and either never or a known earliest stage.');
  }
  const firstBySurface = Object.fromEntries(facts.map(fact => [fact.id, {}]));
  const presentByStage = frames.map((frame, index) => ({
    stage: frame.stage,
    surfaces: Object.fromEntries(Object.entries(frame.surfaces).map(([name, value]) => [name, Object.fromEntries(facts.map(fact => {
      const paths = pathsForFact(fact, value);
      if (paths.length && !firstBySurface[fact.id][name]) firstBySurface[fact.id][name] = { stage: frame.stage, index, paths };
      return [fact.id, paths.length > 0];
    }))])),
  }));
  const firstByBoundary = Object.fromEntries(facts.map(fact => [fact.id, Object.fromEntries(Object.entries(boundaries).map(([boundary, members]) => {
    const found = members.flatMap(surface => firstBySurface[fact.id][surface] ? [{ surface, ...firstBySurface[fact.id][surface] }] : []);
    if (!found.length) return [boundary, null];
    const earliest = Math.min(...found.map(item => item.index));
    return [boundary, { stage: frames[earliest].stage, index: earliest, exposures: found.filter(item => item.index === earliest).map(({ surface, paths }) => ({ surface, paths })) }];
  }))]));
  const verdicts = rules.map(rule => {
    const first = firstByBoundary[rule.factId][rule.boundary];
    const status = rule.never
      ? first ? 'violated-early' : 'satisfied'
      : first && first.index < stages.get(rule.earliestStage) ? 'violated-early'
        : !first && rule.mustReveal ? 'missing-reveal' : 'satisfied';
    return { ...rule, status, firstExposure: first };
  });
  return {
    scope: 'Observed literal and declared derived facts on supplied surfaces and sampled frames only; no unseen action paths, unprovided browser state, image OCR, prior model memory, or outside knowledge.',
    stages: frames.map(frame => frame.stage), boundaries, firstBySurface, firstByBoundary, presentByStage, verdicts,
    status: verdicts.some(row => row.status === 'violated-early') ? 'violated' : verdicts.some(row => row.status === 'missing-reveal') ? 'inconclusive' : 'passes-sampled-trace',
  };
}
