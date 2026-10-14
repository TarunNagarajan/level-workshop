import assert from 'node:assert/strict';
import { compareObserverBoundary, observationChannels } from './observer-relative-cut.mjs';

export function auditTemporalObserverCut(leftTrace, rightTrace, { requiredAction, channel }) {
  assert.ok(observationChannels.includes(channel), `Unknown observation channel: ${channel}`);
  assert.equal(leftTrace.length, rightTrace.length, 'Paired traces must have the same stages.');
  assert.deepEqual(leftTrace.map(stage => stage.action), rightTrace.map(stage => stage.action),
    'Paired traces must take the same actions.');
  const comparisons = leftTrace.map((stage, index) => ({ action: stage.action,
    ...compareObserverBoundary(stage.capture, rightTrace[index].capture) }));
  const firstIndex = comparisons.findIndex(comparison => !comparison.channels[channel]);
  const eventIndex = comparisons.findIndex(comparison => comparison.action === requiredAction);
  assert.ok(eventIndex >= 0, `Trace omits declared event: ${requiredAction}`);
  const first = firstIndex < 0 ? null : comparisons[firstIndex];
  return {
    channel, requiredAction, status: firstIndex < 0 ? 'unrevealed' : firstIndex < eventIndex ? 'exposed-before-event' : firstIndex === eventIndex ? 'revealed-at-event' : 'revealed-after-event',
    firstDifferentAction: first?.action ?? null,
    firstDifferentStage: firstIndex < 0 ? null : firstIndex,
    precedingActions: firstIndex < 0 ? [] : comparisons.slice(0, firstIndex + 1).map(row => row.action),
    differingResources: first?.differingResources ?? [],
    differingRequests: first?.differingRequests ?? [],
  };
}
