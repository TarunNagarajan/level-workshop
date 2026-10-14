import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditRecipientRequestPair } from './recipient-request-audit.mjs';

const contract = { edges: [
  { sourceLane: 'A', targetLane: 'B', waitLabel: 'Awaiting color.', choices: [{ source: 'amber', output: 'north' }, { source: 'cobalt', output: 'south' }] },
  { sourceLane: 'B', targetLane: 'C', waitLabel: 'Awaiting route.', choices: [{ source: 'north', output: 'truck' }, { source: 'south', output: 'van' }] },
] };
const snapshot = color => ({ title: 'Dispatch', task: 'Choose a route using the shared seal observation.', contract, slots: [
  { id: 'A', systemPrompt: `Private seal: ${color}`, temperature: 0.3 },
  { id: 'B', systemPrompt: 'Use the route codebook only after a shared observation.', temperature: 0.3 },
  { id: 'C', systemPrompt: 'Wait for the route.', temperature: 0.3 },
] });
function world(color, expectedOutcome) {
  const content = color;
  return {
    snapshot: snapshot(color), testInput: 'Case 7', expectedOutcome,
    messages: [{ id: `${color}-source`, lane: 'A', role: 'assistant', content, publication: { status: 'published' } }],
    boardBefore: [],
    boardAfter: [{ id: `${color}-board`, messageId: `${color}-source`, from: 'A', targets: ['B'], content }],
  };
}
const pair = () => [world('amber', 'Ridge Road'), world('cobalt', 'Canal Road')];
const provider = { model: 'fixture-model', baseUrl: 'https://example.test/v1' };
const audit = worlds => auditRecipientRequestPair({ worlds, sourceLane: 'A', lane: 'B', content: 'Which route?', provider });

test('production compiler shows an absent fact before a linked handoff and a differing fact after', () => {
  const result = audit(pair());
  assert.equal(result.status, 'passes-request-preflight');
  assert.equal(result.identicalBefore, true);
  assert.equal(result.divergesAfter, true);
  assert.equal(result.afterDifference.path, '$.messages[0].content');
  assert.deepEqual(result.sourceExtensions.map(item => item.valid), [true, true]);
});

test('shared task, recipient prompt, test case, and prior recipient history each expose an early counterexample', () => {
  for (const [change, path] of [
    [world => { world.snapshot.task += ' Seal is cobalt.'; }, '$.messages[1].content'],
    [world => { world.snapshot.slots[1].systemPrompt += ' Seal is cobalt.'; }, '$.messages[0].content'],
    [world => { world.testInput += ' Seal is cobalt.'; }, '$.messages[1].content'],
    [world => { world.messages.push({ id: 'prior', lane: 'B', role: 'assistant', content: 'Seal is cobalt.' }); }, '$.messages[2].role'],
  ]) {
    const worlds = pair(); change(worlds[1]);
    const result = audit(worlds);
    assert.equal(result.status, 'fails-request-preflight');
    assert.equal(result.beforeDifference.path, path);
  }
});

test('unshared or fabricated board entries do not pass as a saved recipient handoff', () => {
  const unshared = pair(); unshared[1].boardAfter[0].targets = ['C'];
  assert.equal(audit(unshared).status, 'fails-request-preflight');
  const fabricated = pair(); fabricated[0].boardAfter[0].content = 'Seal is cobalt.';
  assert.equal(audit(fabricated).status, 'fails-request-preflight');
  assert.match(audit(fabricated).sourceExtensions[0].reason, /differs from the saved reply/);
});

test('different expected outcomes are required for a meaningful twin', () => {
  const worlds = pair(); worlds[1].expectedOutcome = worlds[0].expectedOutcome;
  assert.equal(audit(worlds).status, 'fails-request-preflight');
});

test('a self handoff or a different source lane cannot satisfy the declared edge', () => {
  assert.throws(() => auditRecipientRequestPair({ worlds: pair(), sourceLane: 'B', lane: 'B', content: 'Which route?', provider }), /two distinct/);
  const worlds = pair(); worlds[1].messages[0].lane = 'C'; worlds[1].boardAfter[0].from = 'C';
  assert.equal(audit(worlds).status, 'fails-request-preflight');
  assert.match(audit(worlds).sourceExtensions[1].reason, /declared source/);
});
