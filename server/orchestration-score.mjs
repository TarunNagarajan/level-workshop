import { createHash } from 'node:crypto';
import { verifyOrchestrationEventLedger } from './orchestration-event-ledger.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const canonical = value => typeof value === 'string' ? value.trim().toLocaleLowerCase('en-US') : null;

/** Local score eligibility is recalculated from a saved observation and handoff chain. */
export function scoreOrchestrationRun({ run, binding, events, lane, expected }) {
  const final = run.messages.filter(message => message.lane === lane && message.role === 'assistant'
    && message.publication?.status === 'published').at(-1);
  const base = { lane, expected, actual: final?.publication?.value ?? null, finalMessageId: final?.id ?? null };
  if (!final) return { ...base, status: 'incomplete', eligible: false, reason: 'No published final reply has been saved.' };
  const diagnostic = reason => ({ ...base, status: 'diagnostic-only', eligible: false, reason });
  if (binding.observation_mode !== 'sealed-card') return diagnostic('No server-recorded object observation is attached to this run.');
  if (binding.snapshot_hash !== digest(run.snapshot)) return diagnostic('The frozen run snapshot no longer matches its world binding.');
  const ledger = verifyOrchestrationEventLedger(run, events);
  if (!ledger) return diagnostic('The saved event order or prefix hashes do not match this run.');
  if (ledger.observations.length !== 1 || ledger.observations[0].factValue !== binding.fact_value) {
    return diagnostic('The server observation is missing, repeated, or disagrees with the world binding.');
  }
  const observation = ledger.observations[0];
  const messages = new Map(run.messages.filter(message => message.role === 'assistant').map(message => [message.id, message]));
  const visited = new Set();
  function grounded(message, currentLane, requiredValue) {
    if (!message || visited.has(message.id) || message.lane !== currentLane) return false;
    visited.add(message.id);
    const turnSeq = ledger.turns.get(message.id);
    if (!turnSeq || message.publication?.status !== 'published'
      || message.publication.scoreEligible !== true || message.publication.sourceTruth !== true
      || canonical(message.content) !== canonical(requiredValue)
      || canonical(message.publication.value) !== canonical(requiredValue)) return false;
    if (currentLane === binding.source_lane) {
      return canonical(requiredValue) === canonical(binding.fact_value)
        && message.publication.observationEventSeq === observation.seq
        && observation.seq < turnSeq
        && message.context?.system === binding.source_system_template.replace('{{FACT}}', binding.fact_value)
        && message.context?.model === run.model;
    }
    const incoming = run.snapshot.contract?.edges.filter(edge => edge.targetLane === currentLane) ?? [];
    if (incoming.length !== 1) return false;
    const edge = incoming[0];
    const source = messages.get(message.publication.sourceMessageId);
    if (!source || source.lane !== edge.sourceLane) return false;
    const choice = edge.choices.find(item => canonical(item.source) === canonical(source.publication?.value));
    if (!choice || canonical(choice.output) !== canonical(requiredValue)) return false;
    const sourceTurnSeq = ledger.turns.get(source.id);
    const shared = run.board.some(item => item.messageId === source.id && item.from === source.lane
      && item.content === source.content && item.targets.includes(currentLane)
      && sourceTurnSeq < ledger.shares.get(item.id) && ledger.shares.get(item.id) < turnSeq);
    return shared && grounded(source, edge.sourceLane, choice.source);
  }
  if (!grounded(final, lane, expected)) return diagnostic('The final reply lacks a true, ordered observation-to-handoff lineage.');
  return { ...base, status: 'eligible', eligible: true,
    reason: 'The observed fact, saved handoffs, and mapped final reply agree.' };
}
