import { verifyArtifact } from './handoff-contract.mjs';

const label = /^[a-z][a-z0-9_-]*$/;

export function compileFiniteRolePrompt(spec) {
  if (!spec || typeof spec.roleName !== 'string' || !spec.roleName.trim() ||
    typeof spec.privateDescription !== 'string' || !spec.privateDescription.trim() ||
    typeof spec.factName !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(spec.factName) ||
    typeof spec.missingReply !== 'string' || !spec.missingReply.trim() ||
    !spec.table || typeof spec.table !== 'object' || Array.isArray(spec.table)) throw new Error('Invalid finite-role specification.');
  const entries = Object.entries(spec.table);
  if (entries.length < 2 || entries.length > 8 || entries.some(([value, output]) => !label.test(value) || typeof output !== 'string' || !label.test(output))) throw new Error('Finite role needs two to eight safe state/output labels.');
  const branches = entries.map(([value, output]) => `If the application handoff message says ${spec.factName}=${value}, reply exactly: ${output}.`).join(' ');
  return `You are the ${spec.roleName}. ${spec.privateDescription} If there is no separate application handoff message, reply exactly: ${spec.missingReply} ${branches} Return one complete label only. Do not combine a wait with an answer.`;
}

export function compileFiniteRoleRequest({ world, role, artifact, signingKey }) {
  const spec = role === 'B' ? {
    roleName: 'route decoder', privateDescription: `Your private codebook says amber means ${world.codebook.amber} and cobalt means ${world.codebook.cobalt}. You do not have the fleet schedule.`,
    factName: 'SEAL_COLOR', missingReply: 'Awaiting color.', table: world.codebook,
    kind: 'seal-color', sourceRole: 'A', field: 'color',
  } : role === 'C' ? {
    roleName: 'vehicle allocator', privateDescription: `Your private fleet schedule says north needs a ${world.fleet.north} and south needs a ${world.fleet.south}. You do not see the original seal or codebook.`,
    factName: 'ROUTE', missingReply: 'Awaiting route.', table: world.fleet,
    kind: 'decoded-route', sourceRole: 'B', field: 'route',
  } : null;
  if (!spec) throw new Error('Only downstream roles B and C are supported.');
  const messages = [{ role: 'user', content: 'Shared task: Read a sealed color, decode its route with a private codebook, then allocate a vehicle with a private fleet schedule.' }];
  if (artifact) {
    const verified = verifyArtifact({ world, artifact, signingKey });
    if (verified.kind !== spec.kind || verified.sourceRole !== spec.sourceRole || !Object.hasOwn(spec.table, verified.payload[spec.field])) throw new Error('Wrong source artifact or fact value.');
    messages.push({ role: 'user', content: `Application handoff from ${spec.sourceRole}: ${spec.factName}=${verified.payload[spec.field]}.` });
  }
  messages.push({ role: 'user', content: 'Perform your role.' });
  return { model: 'openai/gpt-oss-20b', temperature: 0.3, system: compileFiniteRolePrompt(spec), messages };
}
