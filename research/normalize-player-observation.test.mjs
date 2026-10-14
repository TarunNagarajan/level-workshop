import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizePlayerActionResponse } from './normalize-player-observation.mjs';

const response = (signature, id) => ({ round: { id, accessToken: `token-${id}`, startedAt: id, deadline: id + 1000,
  messages: [{ id: `message-${id}`, createdAt: id, role: 'assistant', content: 'Welcome.' }] },
state: { events: [{ id: `event-${id}`, at: id, action: 'card', observation: `Signed ${signature}.` }] },
documents: { card: { signature } } });

test('normalization removes generated identifiers while retaining a world-changing document fact', () => {
  const a = response('E. Vale', 100), b = response('E. Vale', 200), c = response('N. Vale', 200);
  assert.deepEqual(normalizePlayerActionResponse(a), normalizePlayerActionResponse(b));
  assert.notDeepEqual(normalizePlayerActionResponse(a), normalizePlayerActionResponse(c));
  assert.equal(a.round.id, 100);
  assert.equal(a.documents.card.signature, 'E. Vale');
});
