import { createHash } from 'node:crypto';
import { auditRecipientRequestPair } from './recipient-request-audit.mjs';
import { resolveSavedHandoff } from '../server/orchestration-contract.mjs';
import { buildCompletionBody } from '../server/model.mjs';
import { compileOrchestrationContext } from '../server/orchestration-context.mjs';
import { sealedCardId } from '../server/orchestration-observation.mjs';
import { verifyOrchestrationEventLedger } from '../server/orchestration-event-ledger.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const canonical = value => typeof value === 'string' ? value.trim().toLocaleLowerCase('en-US') : null;

function atSavedShare(run, events, sourceLane, lane, requestedSeq) {
  if (!verifyOrchestrationEventLedger(run, events)) return null;
  const matching = events.filter(event => event.kind === 'share' && (requestedSeq === undefined || event.seq === requestedSeq)
    && run.board[event.boardCount - 1]?.id === event.boardId
    && run.board[event.boardCount - 1]?.from === sourceLane
    && run.board[event.boardCount - 1]?.targets?.includes(lane)
    && run.board[event.boardCount - 1]?.messageId === event.sourceMessageId);
  if (matching.length !== 1) return null;
  const share = matching[0];
  return { ...run, messages: run.messages.slice(0, share.messageCount), board: run.board.slice(0, share.boardCount), checkpointEvents: events.filter(event => event.seq <= share.seq) };
}

function inspectWorld({ run, binding, sourceLane, lane }) {
  const edge = run.snapshot?.contract?.edges?.find(item => item.sourceLane === sourceLane && item.targetLane === lane);
  const addressed = run.board?.filter(item => item.from === sourceLane && item.targets?.includes(lane)) ?? [];
  const bindingValid = Boolean(binding?.runId === run.id && binding?.snapshotHash === digest(run.snapshot));
  const declared = edge?.choices?.find(choice => canonical(choice.source) === canonical(binding?.factValue));
  const handoff = edge ? resolveSavedHandoff({ contract: run.snapshot.contract, lane, messages: run.messages, board: run.board }) : null;
  const oneShare = addressed.length === 1 && run.board.at(-1)?.id === addressed[0].id;
  const stageBoundaryValid = handoff?.status === 'valid' && run.messages.at(-1)?.id === handoff.sourceMessageId;
  const sourceTurn = run.checkpointEvents?.find(event => event.kind === 'turn' && event.sourceMessageId === handoff?.sourceMessageId);
  const observations = run.checkpointEvents?.filter(event => event.kind === 'observe' && event.seq < sourceTurn?.seq) ?? [];
  const observationValid = binding?.observationMode !== 'sealed-card' || Boolean(sourceTurn && observations.length === 1
    && observations[0].objectId === sealedCardId && observations[0].factValue === binding.factValue);
  const sourceTruth = bindingValid && Boolean(declared) && oneShare && handoff?.status === 'valid'
    && observationValid && canonical(handoff.sourceValue) === canonical(binding.factValue);
  return {
    runId: run.id, bindingValid, declaredFact: Boolean(declared), oneShare, stageBoundaryValid, observationValid,
    observationMode: binding?.observationMode ?? 'prompt', observationEventSeq: observations[0]?.seq ?? null,
    factValue: binding?.factValue ?? null, sourceSystemTemplate: binding?.sourceSystemTemplate ?? null,
    expectedOutcome: declared?.output ?? null,
    sourceStatus: handoff?.status ?? 'undeclared', sourceValue: handoff?.sourceValue ?? null,
    sourceMessageId: handoff?.sourceMessageId ?? null, sourceTruth,
    sourceContext: run.messages.find(message => message.id === handoff?.sourceMessageId)?.context ?? null,
    snapshotHash: digest(run.snapshot),
  };
}

function sourceRequestContrast(worlds, runs, sourceLane, provider) {
  const sourceBodies = worlds.map(world => world.sourceContext && buildCompletionBody({ config: provider, ...world.sourceContext }));
  const available = sourceBodies.every(Boolean);
  const different = available && digest(sourceBodies[0]) !== digest(sourceBodies[1]);
  const templateMatched = available && sourceBodies.every((body, index) => {
    const { factValue, sourceSystemTemplate } = worlds[index];
    return typeof factValue === 'string' && typeof sourceSystemTemplate === 'string'
      && sourceSystemTemplate.split('{{FACT}}').length === 2
      && body.messages[0]?.content === sourceSystemTemplate.replace('{{FACT}}', factValue);
  });
  const normalized = sourceBodies.map((body, index) => {
    if (!body || !templateMatched) return null;
    const copy = structuredClone(body);
    copy.messages[0].content = worlds[index].sourceSystemTemplate;
    return copy;
  });
  const onlyFactDifference = different && templateMatched && JSON.stringify(normalized[0]) === JSON.stringify(normalized[1]);
  const beforeObservation = worlds.every(world => world.observationMode === 'sealed-card' && world.sourceContext)
    ? runs.map((run, index) => buildCompletionBody({ config: provider,
      ...compileOrchestrationContext({ snapshot: run.snapshot, testInput: run.testInput, messages: [], board: [], lane: sourceLane,
        content: worlds[index].sourceContext.messages.at(-1)?.content, model: provider.model, sourceObservation: { factValue: null } }),
    })) : null;
  return {
    available, different, templateMatched, onlyFactDifference,
    requestHashes: sourceBodies.map(body => body && digest(body)),
    identicalBeforeObservation: beforeObservation ? digest(beforeObservation[0]) === digest(beforeObservation[1]) : null,
    beforeObservationRequestHashes: beforeObservation?.map(digest) ?? null,
    scope: 'The saved source provider requests match a server-owned one-slot system template and differ only at that fact slot. This proves request exposure for these two records, not model attention or perception.',
  };
}

function inspectRecipientUptake(run, stage, lane, content, expected, expectedRequestHash, provider) {
  const later = run.messages.slice(stage.messages.length);
  const index = later.findIndex((message, at) => message.role === 'assistant' && message.lane === lane
    && later[at - 1]?.role === 'user' && later[at - 1]?.lane === lane && later[at - 1]?.content === content);
  if (index < 0) return { tested: false };
  const reply = later[index];
  const actualHash = reply.context ? digest(buildCompletionBody({ config: provider, ...reply.context })) : null;
  return {
    tested: true, replyId: reply.id, rawReply: reply.content,
    bodyMatchesAuditedAfter: actualHash === expectedRequestHash,
    actualRequestHash: actualHash,
    wholeLabelCorrect: canonical(reply.content) === canonical(expected),
    publication: reply.publication?.status ?? null,
    scoreEligible: reply.publication?.scoreEligible ?? null,
  };
}

/**
 * The caller must load `binding` from a server-owned world/version record and
 * `run` from the saved run store. This function checks their linkage; it cannot
 * authenticate an arbitrary caller-supplied binding or independently sense a fact.
 */
export function auditSavedRunWorldPair({ runs, bindings, eventLogs, shareEventSeqs, sourceLane, lane, content, provider }) {
  if (!provider?.model || !provider?.baseUrl) throw new Error('Supply the provider used by the saved runs.');
  if (!Array.isArray(runs) || runs.length !== 2 || !Array.isArray(bindings) || bindings.length !== 2) {
    throw new Error('Supply two saved runs and their server-owned world bindings.');
  }
  for (const run of runs) if (!run?.id || !run.snapshot || !Array.isArray(run.messages) || !Array.isArray(run.board)) {
    throw new Error('Each run needs its saved snapshot, messages, and board.');
  }
  if (eventLogs && (!Array.isArray(eventLogs) || eventLogs.length !== 2 || (shareEventSeqs && shareEventSeqs.length !== 2))) {
    throw new Error('Supply one event log and optional share sequence for each saved run.');
  }
  const stagedRuns = eventLogs ? runs.map((run, index) => atSavedShare(run, eventLogs[index], sourceLane, lane, shareEventSeqs?.[index])) : runs;
  if (stagedRuns.some(run => !run)) return {
    status: 'invalid-checkpoint', requestNecessity: null, sourceTruth: null, sourceAccess: null, expectedDiffer: null,
    worlds: [], requestAudit: null,
    scope: 'The event sequence, count transitions, prefix hashes, or requested share could not be verified against the saved run.',
  };
  const worlds = stagedRuns.map((run, index) => ({
    ...inspectWorld({ run, binding: bindings[index], sourceLane, lane }),
    providerMatchesRun: run.model === provider?.model,
  }));
  const stageValid = worlds.every(world => world.stageBoundaryValid);
  const validWorlds = worlds.every(world => world.bindingValid && world.declaredFact && world.oneShare && world.observationValid && world.sourceStatus === 'valid' && world.providerMatchesRun && world.sourceContext?.model === provider.model);
  const expectedDiffer = Boolean(worlds[0].expectedOutcome && worlds[1].expectedOutcome && canonical(worlds[0].expectedOutcome) !== canonical(worlds[1].expectedOutcome));
  const sourceAccess = sourceRequestContrast(worlds, stagedRuns, sourceLane, provider);
  if (!stageValid) return {
    status: 'inconclusive-stage', requestNecessity: null, sourceAccess,
    sourceTruth: worlds.every(world => world.sourceTruth), expectedDiffer,
    worlds: worlds.map(({ sourceContext, ...world }) => world), requestAudit: null,
    scope: 'The saved runs must be captured immediately after the declared share, with the source reply as the last message. A later run cannot be rewound reliably from two append-only arrays without a cross-event sequence or saved stage checkpoint.',
  };
  const requestAudit = auditRecipientRequestPair({
    worlds: stagedRuns.map((run, index) => ({
      snapshot: run.snapshot, testInput: run.testInput, messages: run.messages,
      boardBefore: run.board.slice(0, -1), boardAfter: run.board,
      expectedOutcome: worlds[index].expectedOutcome,
    })),
    sourceLane, lane, content, provider,
  });
  const recipientUptake = runs.map((run, index) => inspectRecipientUptake(run, stagedRuns[index], lane, content,
    worlds[index].expectedOutcome, requestAudit.afterRequestHashes[index], provider));
  const requestNecessity = validWorlds && expectedDiffer && requestAudit.status === 'passes-request-preflight';
  return {
    status: requestNecessity && sourceAccess.onlyFactDifference && sourceAccess.identicalBeforeObservation !== false && worlds.every(world => world.sourceTruth) ? 'source-true-necessary-handoff' : 'fails-audit',
    requestNecessity, sourceAccess, sourceTruth: worlds.every(world => world.sourceTruth),
    expectedDiffer, worlds: worlds.map(({ sourceContext, ...world }) => world), requestAudit, recipientUptake,
    scope: `Two saved local HTTP runs ${eventLogs ? 'rewound to verified share checkpoints' : 'captured immediately after one share'}, with bindings loaded by the caller, at source and recipient provider-body boundaries. The app audit route loads those bindings from its database. It checks fact delivery through the source system prompt. It does not exhaust all worlds or histories or establish model uptake.`,
  };
}

export function bindSavedRunToWorld(run, factValue, sourceSystemTemplate) {
  if (typeof sourceSystemTemplate !== 'string' || sourceSystemTemplate.split('{{FACT}}').length !== 2) {
    throw new Error('The source system template must contain one {{FACT}} slot.');
  }
  return { runId: run.id, snapshotHash: digest(run.snapshot), factValue, sourceSystemTemplate };
}
