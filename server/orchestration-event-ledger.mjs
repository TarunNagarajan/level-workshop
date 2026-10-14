import { createHash } from 'node:crypto';
import { sealedCardId } from './orchestration-observation.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Check the append-only run prefixes and return the saved event links. */
export function verifyOrchestrationEventLedger(run, events) {
  if (!Array.isArray(events) || events.length !== Number(run.eventSeq)) return null;
  let messageCount = 0; let boardCount = 0;
  const turns = new Map(); const shares = new Map(); const observations = [];
  for (const [index, event] of events.entries()) {
    if (event.seq !== index + 1 || !Number.isInteger(event.messageCount) || !Number.isInteger(event.boardCount)) return null;
    const turn = event.kind === 'turn' && event.messageCount === messageCount + 2 && event.boardCount === boardCount
      && run.messages[event.messageCount - 1]?.id === event.sourceMessageId
      && run.messages[event.messageCount - 1]?.role === 'assistant';
    const share = event.kind === 'share' && event.messageCount === messageCount && event.boardCount === boardCount + 1
      && run.board[event.boardCount - 1]?.id === event.boardId
      && run.board[event.boardCount - 1]?.messageId === event.sourceMessageId;
    const observe = event.kind === 'observe' && event.messageCount === messageCount && event.boardCount === boardCount
      && event.objectId === sealedCardId && typeof event.factValue === 'string';
    if (!turn && !share && !observe) return null;
    if (digest(run.messages.slice(0, event.messageCount)) !== event.messagesHash
      || digest(run.board.slice(0, event.boardCount)) !== event.boardHash) return null;
    if (turn) turns.set(event.sourceMessageId, event.seq);
    if (share) shares.set(event.boardId, event.seq);
    if (observe) observations.push(event);
    messageCount = event.messageCount; boardCount = event.boardCount;
  }
  if (messageCount !== run.messages.length || boardCount !== run.board.length) return null;
  return { turns, shares, observations };
}
