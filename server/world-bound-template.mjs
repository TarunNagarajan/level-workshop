import { createHash } from 'node:crypto';
import { compilePrompt } from './levels.mjs';

const targetFields = ['character', 'secret', 'criteria', 'systemPrompt', 'clues'];
const tokenPattern = /\{\{world\.([A-Za-z][A-Za-z0-9_]*)\}\}/g;
const digest = value => createHash('sha256').update(value).digest('hex');

/** Bind variable story facts from one typed assignment into a shared level template. */
export function bindWorldLevel(template, definitions, assignment) {
  if (!template || !definitions || !assignment) throw new Error('A level template, fact definitions, and assignment are required.');
  const bindings = {};
  for (const [id, definition] of Object.entries(definitions)) {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(id)) throw new Error(`Invalid world fact ID: ${id}`);
    const variant = assignment[id];
    const value = definition.variants?.[variant];
    if (typeof value !== 'string' || !value.trim()) throw new Error(`Unknown or empty value for world fact ${id}: ${variant}`);
    bindings[id] = { variant, value };
  }
  for (const id of Object.keys(assignment)) if (!definitions[id]) throw new Error(`Undeclared world fact: ${id}`);
  const level = structuredClone(template);
  const seen = new Set();
  for (const field of targetFields) {
    const raw = level[field];
    if (typeof raw !== 'string') throw new Error(`Target field ${field} must be text.`);
    for (const [id, definition] of Object.entries(definitions)) {
      const aliases = [...Object.values(definition.variants), ...(definition.staticAliases || [])];
      for (const alias of aliases) if (alias && raw.toLocaleLowerCase('en').includes(alias.toLocaleLowerCase('en')))
        throw new Error(`Unbound world fact ${id} in ${field}: ${alias}`);
    }
    level[field] = raw.replace(tokenPattern, (_token, id) => {
      if (!bindings[id]) throw new Error(`Unknown world placeholder ${id} in ${field}.`);
      seen.add(id);
      return bindings[id].value;
    });
  }
  for (const id of Object.keys(bindings)) if (!seen.has(id)) throw new Error(`World fact ${id} is never bound in the target prompt.`);
  return { level, bindings };
}

/** Verify how the actual prompt compiler responds to every declared world assignment. */
export function auditWorldTemplate({ template, definitions, worlds, compile = compilePrompt }) {
  if (!Array.isArray(worlds) || worlds.length < 2) throw new Error('Audit at least two worlds.');
  if (!definitions || !Object.keys(definitions).length) throw new Error('Declare at least one variable world fact.');
  for (const [id, definition] of Object.entries(definitions)) if (Object.keys(definition.variants || {}).length < 2) throw new Error(`Fact ${id} needs at least two variants.`);
  const allValues = Object.values(definitions).flatMap(definition => Object.values(definition.variants));
  if (new Set(allValues).size !== allValues.length) throw new Error('World fact phrases must be distinct across variants.');
  const markers = Object.fromEntries(Object.keys(definitions).map(id => [id, `\uE000WORLD:${id}\uE001`]));
  const marked = structuredClone(template);
  for (const field of targetFields) {
    if (typeof marked[field] !== 'string') throw new Error(`Target field ${field} must be text.`);
    if (marked[field].includes('\uE000WORLD:')) throw new Error('The template contains a reserved binding marker.');
    marked[field] = marked[field].replace(tokenPattern, (_token, id) => {
      if (!markers[id]) throw new Error(`Unknown world placeholder ${id} in ${field}.`);
      return markers[id];
    });
  }
  const markedPrompt = compile(marked);
  for (const [id, marker] of Object.entries(markers)) if (!markedPrompt.includes(marker)) throw new Error(`Compiled target omitted ${id}.`);
  const rows = worlds.map(world => {
    const { level, bindings } = bindWorldLevel(template, definitions, world.facts);
    const prompt = compile(level);
    let expected = markedPrompt;
    for (const [id, { value }] of Object.entries(bindings)) expected = expected.replaceAll(markers[id], value);
    if (prompt !== expected) {
      let offset = 0;
      while (offset < Math.min(prompt.length, expected.length) && prompt[offset] === expected[offset]) offset++;
      throw new Error(`Unbound target difference in ${world.id} at offset ${offset}.`);
    }
    return { id: world.id, assignment: world.facts, bindings, promptHash: digest(prompt), normalizedHash: digest(markedPrompt) };
  });
  if (new Set(rows.map(row => row.id)).size !== rows.length) throw new Error('World IDs must be unique.');
  const canonical = digest(markedPrompt);
  for (const id of Object.keys(definitions)) {
    const variants = new Set(rows.map(row => row.assignment[id]));
    if (variants.size < 2) throw new Error(`Fact ${id} never varies across audited worlds.`);
  }
  return { status: 'passed', worlds: rows, canonicalTargetHash: canonical, targetFieldScope: targetFields };
}
