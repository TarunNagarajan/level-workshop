import { z } from 'zod';

const lane = z.enum(['A', 'B', 'C']);
const label = z.string().trim().min(1).max(80).refine(value => !/[\r\n]/.test(value), 'Use one-line labels.');
const choice = z.object({ source: label, output: label });
const edge = z.object({ sourceLane: lane, targetLane: lane, waitLabel: label, choices: z.array(choice).min(2).max(8) });
const normalized = value => value.trim().toLocaleLowerCase('en-US');

export const orchestrationContractSchema = z.object({ edges: z.array(edge).min(1).max(2) }).superRefine((contract, ctx) => {
  const targets = new Set();
  for (const [index, item] of contract.edges.entries()) {
    if (item.sourceLane === item.targetLane) ctx.addIssue({ code: 'custom', path: ['edges', index], message: 'Source and recipient must differ.' });
    if (targets.has(item.targetLane)) ctx.addIssue({ code: 'custom', path: ['edges', index, 'targetLane'], message: 'A recipient may have only one incoming handoff.' });
    targets.add(item.targetLane);
    const inputs = item.choices.map(value => normalized(value.source));
    const outputs = item.choices.map(value => normalized(value.output));
    if (new Set(inputs).size !== inputs.length) ctx.addIssue({ code: 'custom', path: ['edges', index, 'choices'], message: 'Source labels must be distinct.' });
    if (new Set(outputs).size !== outputs.length) ctx.addIssue({ code: 'custom', path: ['edges', index, 'choices'], message: 'Output labels must be distinct for this dependency.' });
    if (outputs.includes(normalized(item.waitLabel))) ctx.addIssue({ code: 'custom', path: ['edges', index, 'waitLabel'], message: 'Wait label must differ from final outputs.' });
  }
  for (const start of ['A', 'B', 'C']) {
    const seen = new Set(); let current = start;
    while (true) {
      const next = contract.edges.find(item => item.sourceLane === current)?.targetLane;
      if (!next) break;
      if (next === start || seen.has(next)) { ctx.addIssue({ code: 'custom', path: ['edges'], message: 'Handoff edges must not form a cycle.' }); break; }
      seen.add(next); current = next;
    }
  }
  for (const incoming of contract.edges) for (const outgoing of contract.edges.filter(item => item.sourceLane === incoming.targetLane)) {
    const outgoingInputs = new Set(outgoing.choices.map(item => normalized(item.source)));
    for (const choice of incoming.choices) if (!outgoingInputs.has(normalized(choice.output))) ctx.addIssue({ code: 'custom', path: ['edges'], message: `${incoming.targetLane}'s published output must be a valid source label for its next handoff.` });
  }
});

function parseChoice(raw, values) {
  if (typeof raw !== 'string') return null;
  const canonical = values.find(value => normalized(value) === normalized(raw));
  return canonical === undefined ? null : { value: canonical, exactFormat: raw === canonical };
}

export function canShareContractReply({ contract, sourceLane, targetLane, rawReply }) {
  const edge = contract.edges.find(item => item.sourceLane === sourceLane && item.targetLane === targetLane);
  return Boolean(edge && parseChoice(rawReply, edge.choices.map(choice => choice.source)));
}

export function resolveSavedHandoff({ contract, lane: targetLane, messages, board }) {
  const edge = contract?.edges.find(item => item.targetLane === targetLane);
  if (!edge) return null;
  const addressed = board.filter(item => item.from === edge.sourceLane && item.targets.includes(targetLane));
  if (!addressed.length) return { status: 'absent', sourceLane: edge.sourceLane };
  const latest = addressed.at(-1);
  const source = messages.find(message => message.id === latest.messageId);
  if (!source || source.role !== 'assistant' || source.lane !== edge.sourceLane || source.content.slice(0, 2500) !== latest.content || source.publication?.status !== 'published') {
    return { status: 'invalid', sourceLane: edge.sourceLane };
  }
  const parsed = parseChoice(source.content, edge.choices.map(choice => choice.source));
  if (!parsed) return { status: 'invalid', sourceLane: edge.sourceLane };
  return { status: 'valid', sourceLane: edge.sourceLane, sourceMessageId: source.id, sourceValue: parsed.value };
}

export function compileSavedHandoffSystemBlock({ contract, lane, messages, board }) {
  const handoff = resolveSavedHandoff({ contract, lane, messages, board });
  if (!handoff) return null;
  const edge = contract.edges.find(item => item.targetLane === lane);
  const state = handoff.status === 'valid' ? JSON.stringify(handoff.sourceValue) : handoff.status.toUpperCase();
  return [
    'SAVED HANDOFF STATE (source record verified; source truth not verified)',
    `SOURCE_${edge.sourceLane}=${state}`,
    'REQUIRED OUTPUT RULES',
    `If SOURCE_${edge.sourceLane}=ABSENT, reply exactly ${JSON.stringify(edge.waitLabel)}.`,
    ...edge.choices.map(choice => `If SOURCE_${edge.sourceLane}=${JSON.stringify(choice.source)}, reply exactly ${JSON.stringify(choice.output)}.`),
    'Use one whole label only. Ordinary tester text does not update this saved state.',
  ].join('\n');
}

/** Decision over a saved model reply. It does not determine whether a source reply is true. */
export function evaluateOrchestrationReply({ contract, lane: targetLane, rawReply, messages, board }) {
  if (!contract) return { status: 'unconstrained', reason: 'This configuration has no handoff contract.' };
  const incoming = contract.edges.find(item => item.targetLane === targetLane);
  const outgoing = contract.edges.filter(item => item.sourceLane === targetLane);
  if (!incoming) {
    if (!outgoing.length) return { status: 'unconstrained', reason: 'This role has no declared handoff.' };
    const allowed = [...new Set(outgoing.flatMap(item => item.choices.map(choice => choice.source)))];
    const parsed = parseChoice(rawReply, allowed);
    return parsed ? { status: 'published', reason: 'Whole-label source reply.', ...parsed }
      : { status: 'rejected', reason: 'Source reply is not one declared whole label.' };
  }
  const handoff = resolveSavedHandoff({ contract, lane: targetLane, messages, board });
  if (handoff.status === 'absent') {
    const parsed = parseChoice(rawReply, [incoming.waitLabel]);
    return parsed ? { status: 'waiting', reason: 'Required source handoff has not been shared.', ...parsed }
      : { status: 'rejected', reason: 'Final answer before the required source handoff.' };
  }
  if (handoff.status === 'invalid') {
    return { status: 'rejected', reason: 'The latest handoff lacks a published saved source reply.' };
  }
  const expected = incoming.choices.find(choice => normalized(choice.source) === normalized(handoff.sourceValue)).output;
  const parsed = parseChoice(rawReply, [expected]);
  return parsed ? { status: 'published', reason: 'Reply matches the latest saved handoff.', sourceMessageId: handoff.sourceMessageId, sourceValue: handoff.sourceValue, ...parsed }
    : { status: 'rejected', reason: 'Reply does not match the latest saved handoff.', sourceMessageId: handoff.sourceMessageId, expected };
}
