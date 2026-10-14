import assert from 'node:assert/strict';

export function normalizePlayerActionResponse(body) {
  assert.ok(body?.round && Array.isArray(body.round.messages), 'Expected a player round response.');
  const value = structuredClone(body);
  value.round.id = '<opaque-round-id>';
  if ('accessToken' in value.round) value.round.accessToken = '<opaque-capability>';
  value.round.startedAt = 0;
  value.round.deadline = 0;
  if (typeof value.round.endedAt === 'number') value.round.endedAt = 0;
  value.round.messages = value.round.messages.map(message => ({ ...message,
    id: '<opaque-message-id>', createdAt: 0 }));
  if (value.state?.events) value.state.events = value.state.events.map(event => ({ ...event,
    id: '<opaque-event-id>', at: 0 }));
  return value;
}
