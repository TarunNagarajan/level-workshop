import { parseTwoClueLabel, twoClueDecision } from './two-clue-contract.mjs';

// The caller must supply observations reconstructed from saved application events.
// Never accept this object from a tester message or model reply.
export function authorizeTwoClueDecision({ observed, rawReply }) {
  const expected = twoClueDecision(observed);
  const parsed = parseTwoClueLabel(rawReply);
  if (parsed.value === null) return { status: 'rejected', reason: 'invalid-whole-label', expected, label: null, exactFormat: false };
  if (expected === 'wait') {
    return parsed.value === 'wait'
      ? { status: 'waiting', reason: 'evidence-incomplete', expected, label: parsed.value, exactFormat: parsed.exactFormat }
      : { status: 'rejected', reason: 'decision-without-verified-evidence', expected, label: parsed.value, exactFormat: parsed.exactFormat };
  }
  if (parsed.value !== expected) return { status: 'rejected', reason: parsed.value === 'wait' ? 'unnecessary-wait' : 'contradicts-verified-evidence', expected, label: parsed.value, exactFormat: parsed.exactFormat };
  return { status: 'published', reason: 'supported-decision', expected, label: parsed.value, exactFormat: parsed.exactFormat };
}
