import { compileOrchestrationContext } from '../server/orchestration-context.mjs';
import { buildCompletionBody } from '../server/model.mjs';
import { createHash } from 'node:crypto';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function firstDifference(left, right, path = '$') {
  if (Object.is(left, right)) return null;
  if (typeof left !== typeof right || left === null || right === null || typeof left !== 'object') return { path, left, right };
  if (Array.isArray(left) !== Array.isArray(right)) return { path, left, right };
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    const nested = firstDifference(left[key], right[key], Array.isArray(left) ? `${path}[${key}]` : `${path}.${key}`);
    if (nested) return nested;
  }
  return null;
}

function savedReplyExtension(world, lane, sourceLane) {
  const before = world.boardBefore ?? [];
  const after = world.boardAfter ?? [];
  if (after.length !== before.length + 1 || firstDifference(before, after.slice(0, -1))) return { valid: false, reason: 'The after board must append exactly one entry.' };
  const item = after.at(-1);
  const source = world.messages.find(message => message.id === item.messageId);
  if (!source || source.role !== 'assistant' || source.lane !== item.from || source.lane !== sourceLane || source.publication?.status !== 'published') return { valid: false, reason: 'The new entry is not linked to a published saved reply from the declared source.' };
  if (!Array.isArray(item.targets) || !item.targets.includes(lane) || item.content !== source.content.slice(0, 2500)) return { valid: false, reason: 'The target or shared text differs from the saved reply.' };
  return { valid: true, sourceMessageId: source.id, from: source.lane };
}

/**
 * Check paired-world handoff necessity against the production request compiler.
 * This is an author-time request-boundary preflight. Supplied records are not
 * authenticated against the live database and model uptake is not tested.
 */
export function auditRecipientRequestPair({ worlds, sourceLane, lane, content, provider }) {
  if (!Array.isArray(worlds) || worlds.length !== 2 || !worlds.every(world => world?.snapshot && Array.isArray(world.messages))) throw new Error('Supply exactly two complete authored worlds.');
  if (!['A', 'B', 'C'].includes(sourceLane) || !['A', 'B', 'C'].includes(lane) || sourceLane === lane) throw new Error('Declare two distinct source and recipient roles.');
  if (!provider?.model || !provider?.baseUrl) throw new Error('Supply the exact model and provider base URL.');
  const [left, right] = worlds;
  const build = (world, board) => buildCompletionBody({ config: provider,
    ...compileOrchestrationContext({ snapshot: world.snapshot, testInput: world.testInput, messages: world.messages, board, lane, content, model: provider.model }),
  });
  const before = worlds.map(world => build(world, world.boardBefore ?? []));
  const after = worlds.map(world => build(world, world.boardAfter ?? []));
  const beforeDifference = firstDifference(...before);
  const afterDifference = firstDifference(...after);
  const sourceExtensions = worlds.map(world => savedReplyExtension(world, lane, sourceLane));
  const differentOutcomes = typeof left.expectedOutcome === 'string' && typeof right.expectedOutcome === 'string' && Boolean(left.expectedOutcome) && Boolean(right.expectedOutcome) && left.expectedOutcome !== right.expectedOutcome;
  return {
    status: differentOutcomes && !beforeDifference && afterDifference && sourceExtensions.every(item => item.valid) ? 'passes-request-preflight' : 'fails-request-preflight',
    sourceLane, lane, differentOutcomes, identicalBefore: !beforeDifference, divergesAfter: Boolean(afterDifference),
    beforeDifference, afterDifference, sourceExtensions,
    beforeRequestHashes: before.map(hash), afterRequestHashes: after.map(hash),
    scope: 'Exact production orchestration and provider-body compilers for the supplied two worlds, role, histories, and board entries. No runtime provenance, exhaustive world coverage, model uptake, or publication guarantee.',
  };
}
