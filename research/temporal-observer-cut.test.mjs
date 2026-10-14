import assert from 'node:assert/strict';
import test from 'node:test';
import { auditTemporalObserverCut } from './temporal-observer-cut.mjs';

const capture = (pixels, hash = 'same') => ({ textHash: 'same', accessibilityHash: 'same', screenshotPixelHash: pixels,
  coverPixelHash: 'same', exifHash: null, network: [{ path: '/open-book.webp', status: 200, contentType: 'image/webp', hash }] });
const trace = (opened, card) => [
  { action: 'closed', capture: capture('closed') }, { action: 'open', capture: opened }, { action: 'card', capture: card },
];

test('a world-correlated open-book asset is a bypass witness before the card event', () => {
  const left = trace(capture('visible E', 'asset E'), capture('card E'));
  const right = trace(capture('visible N', 'asset N'), capture('card N'));
  const verdict = auditTemporalObserverCut(left, right, { requiredAction: 'card', channel: 'renderedPixels' });
  assert.equal(verdict.status, 'exposed-before-event');
  assert.deepEqual(verdict.precedingActions, ['closed', 'open']);
  assert.deepEqual(verdict.differingResources, ['/open-book.webp']);
});

test('when the open state is shared, the card is the first reveal', () => {
  const left = trace(capture('shared'), capture('card E'));
  const right = trace(capture('shared'), capture('card N'));
  assert.equal(auditTemporalObserverCut(left, right, { requiredAction: 'card', channel: 'renderedPixels' }).status, 'revealed-at-event');
});
