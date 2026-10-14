import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canShareContractReply, evaluateOrchestrationReply, orchestrationContractSchema } from '../server/orchestration-contract.mjs';

const contract = orchestrationContractSchema.parse({ edges: [
  { sourceLane: 'A', targetLane: 'B', waitLabel: 'Awaiting color.', choices: [
    { source: 'amber', output: 'north' }, { source: 'cobalt', output: 'south' },
  ] },
  { sourceLane: 'B', targetLane: 'C', waitLabel: 'Awaiting route.', choices: [
    { source: 'north', output: 'truck' }, { source: 'south', output: 'van' },
  ] },
] });
const a = { id: 'a-reply', lane: 'A', role: 'assistant', content: 'Amber', publication: { status: 'published' } };
const b = { id: 'b-reply', lane: 'B', role: 'assistant', content: 'north', publication: { status: 'published' } };
const share = (source, target) => ({ id: `to-${target}`, messageId: source.id, from: source.lane, targets: [target], content: source.content });
const judge = (lane, rawReply, messages = [], board = []) => evaluateOrchestrationReply({ contract, lane, rawReply, messages, board });

test('finite contract keeps raw early decisions separate from published handoffs', () => {
  assert.equal(judge('A', 'Amber').status, 'published');
  assert.equal(judge('B', 'north').status, 'rejected');
  assert.equal(judge('B', 'Awaiting color.').status, 'waiting');
  assert.equal(judge('B', 'north', [a], [share(a, 'B')]).status, 'published');
  assert.equal(judge('B', 'North', [a], [share(a, 'B')]).exactFormat, false);
  assert.equal(judge('B', 'Awaiting color.\nNorth', [a], [share(a, 'B')]).status, 'rejected');
  assert.equal(judge('B', 'south', [a], [share(a, 'B')]).status, 'rejected');
  assert.equal(judge('C', 'truck', [b], [share(b, 'C')]).status, 'published');
  assert.equal(judge('C', 'van', [b], [share(b, 'C')]).status, 'rejected');
});

test('fabricated, unpublished, and wrong-recipient entries do not authorize an answer', () => {
  assert.equal(judge('B', 'north', [a], [{ ...share(a, 'B'), content: 'cobalt' }]).status, 'rejected');
  assert.equal(judge('B', 'north', [{ ...a, publication: { status: 'rejected' } }], [share(a, 'B')]).status, 'rejected');
  assert.equal(judge('B', 'north', [a], [share(a, 'C')]).status, 'rejected');
  assert.equal(judge('B', 'north', [a], [{ ...share(a, 'B'), messageId: 'absent' }]).status, 'rejected');
  assert.equal(judge('B', 'north', [a], [{ ...share(a, 'B'), from: 'C' }]).status, 'rejected');
});

test('schema rejects ambiguous edges and an incoherent finite chain', () => {
  assert.equal(orchestrationContractSchema.safeParse({ edges: [{ ...contract.edges[0], sourceLane: 'B' }] }).success, false);
  assert.equal(orchestrationContractSchema.safeParse({ edges: [contract.edges[0], { ...contract.edges[1], targetLane: 'B' }] }).success, false);
  assert.equal(orchestrationContractSchema.safeParse({ edges: [contract.edges[0], { ...contract.edges[1], sourceLane: 'B', targetLane: 'A' }] }).success, false);
  assert.equal(orchestrationContractSchema.safeParse({ edges: [{ ...contract.edges[0], choices: [{ source: 'amber', output: 'north' }, { source: 'Amber', output: 'south' }] }] }).success, false);
  assert.equal(orchestrationContractSchema.safeParse({ edges: [contract.edges[0], { ...contract.edges[1], choices: [{ source: 'east', output: 'truck' }, { source: 'west', output: 'van' }] }] }).success, false);
});

test('old configurations retain unconstrained behavior', () => {
  assert.equal(evaluateOrchestrationReply({ contract: undefined, lane: 'B', rawReply: 'anything', messages: [], board: [] }).status, 'unconstrained');
});

test('a published source label only crosses an edge that declares it', () => {
  assert.equal(canShareContractReply({ contract, sourceLane: 'A', targetLane: 'B', rawReply: 'Amber' }), true);
  assert.equal(canShareContractReply({ contract, sourceLane: 'A', targetLane: 'C', rawReply: 'Amber' }), false);
  const fork = orchestrationContractSchema.parse({ edges: [contract.edges[0], { sourceLane: 'A', targetLane: 'C', waitLabel: 'Awaiting seal.', choices: [{ source: 'red', output: 'go' }, { source: 'blue', output: 'stop' }] }] });
  assert.equal(canShareContractReply({ contract: fork, sourceLane: 'A', targetLane: 'C', rawReply: 'Amber' }), false);
});
