import test from 'node:test';
import assert from 'node:assert/strict';
import { applyPassportAction, initialPassportState } from '../server/passport-reference.mjs';
import { auditPrerequisiteClosure } from './prerequisite-closure.mjs';

const actions = [
  { id: 'open', reveals: ['passportSignature'] },
  { id: 'card', reveals: ['cardSignature'] },
  { id: 'compare', requiresAll: ['open', 'card'], reveals: ['signatureMismatch'] },
  { id: 'turn', requiresAll: ['open'], reveals: ['stampDate'] },
  { id: 'uv', reveals: ['uvIntact'] },
];
const derived = [{ fact: 'signatureMismatch', from: ['passportSignature', 'cardSignature'] }];

test('comparison prerequisites already reveal both ingredients, while stamp and UV can add information', () => {
  const compare = auditPrerequisiteClosure({ actions, derived, targetAction: 'compare', targetFact: 'signatureMismatch' });
  assert.equal(compare.status, 'always-known-before');
  assert.deepEqual(compare.paths[0].prerequisiteActions, ['open', 'card']);
  assert.deepEqual(compare.paths[0].proof, { kind: 'derived', fact: 'signatureMismatch', from: [
    { kind: 'action', fact: 'passportSignature', action: 'open' },
    { kind: 'action', fact: 'cardSignature', action: 'card' },
  ] });
  assert.equal(auditPrerequisiteClosure({ actions, derived, targetAction: 'turn', targetFact: 'stampDate' }).status, 'not-proven-known-before');
  assert.equal(auditPrerequisiteClosure({ actions, derived, targetAction: 'uv', targetFact: 'uvIntact' }).status, 'not-proven-known-before');
});

test('alternative prerequisites reveal a fact on only one path', () => {
  const result = auditPrerequisiteClosure({ actions: [
    { id: 'read-label', reveals: ['owner'] },
    { id: 'use-key', reveals: [] },
    { id: 'inspect', requiresAny: [['read-label'], ['use-key']], reveals: ['owner'] },
  ], targetAction: 'inspect', targetFact: 'owner' });
  assert.equal(result.status, 'sometimes-known-before');
  assert.deepEqual(result.paths.map(path => path.alreadyKnown), [true, false]);
});

test('a source inspection does not make a handoff redundant for the receiving specialist', () => {
  const scopedActions = [
    { id: 'inspect-color', revealsTo: { A: ['color'] } },
    { id: 'share-color', requiresAll: ['inspect-color'], revealsTo: { B: ['color'] } },
  ];
  const forB = auditPrerequisiteClosure({ actions: scopedActions, targetAction: 'share-color', targetFact: 'color', boundary: 'B' });
  const forA = auditPrerequisiteClosure({ actions: scopedActions, targetAction: 'share-color', targetFact: 'color', boundary: 'A' });
  assert.equal(forB.status, 'not-proven-known-before');
  assert.equal(forA.status, 'always-known-before');
  assert.deepEqual(forA.paths[0].proof, { kind: 'action', fact: 'color', action: 'inspect-color' });
  assert.throws(() => auditPrerequisiteClosure({ actions: scopedActions, targetAction: 'share-color', targetFact: 'color' }), /boundary/);
});

test('the authored comparison guard matches the actual reducer on its key prerequisite states', () => {
  const first = initialPassportState();
  assert.equal(catchStatus(() => applyPassportAction(first, { revision: first.revision, action: 'compare' })), 400);
  const opened = applyPassportAction(first, { revision: first.revision, action: 'open' }).state;
  assert.equal(catchStatus(() => applyPassportAction(opened, { revision: opened.revision, action: 'compare' })), 400);
  const cardOnly = applyPassportAction(first, { revision: first.revision, action: 'card' }).state;
  assert.equal(catchStatus(() => applyPassportAction(cardOnly, { revision: cardOnly.revision, action: 'compare' })), 400);
  const ready = applyPassportAction(opened, { revision: opened.revision, action: 'card' }).state;
  assert.equal(applyPassportAction(ready, { revision: ready.revision, action: 'compare' }).state.compared, true);
});

function catchStatus(callback) { try { callback(); return null; } catch (error) { return error.status ?? null; } }
