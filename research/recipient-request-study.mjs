import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { chainWorlds } from './chain-contract.mjs';
import { auditRecipientRequestPair } from './recipient-request-audit.mjs';

const sourceHash = createHash('sha256').update(readFileSync('server/orchestration-context.mjs')).digest('hex');
const providerBodyHash = createHash('sha256').update(readFileSync('server/model.mjs')).digest('hex');
const auditHash = createHash('sha256').update(readFileSync('research/recipient-request-audit.mjs')).digest('hex');
const provider = { model: 'openai/gpt-oss-20b', baseUrl: 'https://api.groq.com/openai/v1' };
const worlds = chainWorlds();
const snapshots = world => ({ title: 'Seal dispatch', task: 'Read a seal, decode its route, then allocate a vehicle.', contract: { edges: [
  { sourceLane: 'A', targetLane: 'B', waitLabel: 'Awaiting color.', choices: [{ source: 'amber', output: world.codebook.amber }, { source: 'cobalt', output: world.codebook.cobalt }] },
  { sourceLane: 'B', targetLane: 'C', waitLabel: 'Awaiting route.', choices: [{ source: 'north', output: world.fleet.north }, { source: 'south', output: world.fleet.south }] },
] }, slots: [
  { id: 'A', name: 'Seal reader', systemPrompt: `Private observed seal: ${world.color}.`, temperature: 0.3 },
  { id: 'B', name: 'Route decoder', systemPrompt: `Private codebook: amber=${world.codebook.amber}; cobalt=${world.codebook.cobalt}.`, temperature: 0.3 },
  { id: 'C', name: 'Vehicle allocator', systemPrompt: `Private schedule: north=${world.fleet.north}; south=${world.fleet.south}.`, temperature: 0.3 },
] });
const authored = (world, lane) => {
  const from = lane === 'B' ? 'A' : 'B';
  const content = lane === 'B' ? world.color : world.route;
  const messageId = `${world.id}-${from}-reply`;
  return {
    id: world.id, expectedOutcome: lane === 'B' ? world.route : world.vehicle,
    snapshot: snapshots(world), testInput: 'Case 7: perform your role.',
    messages: [{ id: messageId, lane: from, role: 'assistant', content, publication: { status: 'published' } }],
    boardBefore: [],
    boardAfter: [{ id: `${world.id}-${lane}-share`, messageId, from, targets: [lane], content }],
  };
};
const sample = [];
for (const lane of ['B', 'C']) {
  for (const world of worlds.filter(world => world.color === 'amber')) {
    const twin = worlds.find(item => item.color === 'cobalt' && item.cipherFlip === world.cipherFlip && item.fleetFlip === world.fleetFlip);
    assert(twin);
    const result = auditRecipientRequestPair({ worlds: [authored(world, lane), authored(twin, lane)], sourceLane: lane === 'B' ? 'A' : 'B', lane, content: 'Perform your role.', provider });
    assert.equal(result.status, 'passes-request-preflight');
    assert.equal(result.afterDifference.path, '$.messages[0].content');
    sample.push({ role: lane, worldIds: [world.id, twin.id], result });
  }
}
const controls = [];
for (const lane of ['B', 'C']) {
  const left = worlds.find(world => world.color === 'amber' && !world.cipherFlip && !world.fleetFlip);
  const right = worlds.find(world => world.color === 'cobalt' && !world.cipherFlip && !world.fleetFlip);
  const mutations = {
    'shared-task-leak': world => { world.snapshot.task += ` Hidden seal: ${right.color}.`; },
    'recipient-prompt-leak': world => { world.snapshot.slots.find(slot => slot.id === lane).systemPrompt += ` Hidden seal: ${right.color}.`; },
    'test-case-leak': world => { world.testInput += ` Hidden seal: ${right.color}.`; },
    'prior-history-leak': world => { world.messages.push({ id: 'early', lane, role: 'assistant', content: `Hidden seal: ${right.color}.` }); },
    'wrong-recipient': world => { world.boardAfter[0].targets = [lane === 'B' ? 'C' : 'B']; },
    'fabricated-board-text': world => { world.boardAfter[0].content = 'fabricated'; },
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    const pair = [authored(left, lane), authored(right, lane)]; mutate(pair[1]);
    const result = auditRecipientRequestPair({ worlds: pair, sourceLane: lane === 'B' ? 'A' : 'B', lane, content: 'Perform your role.', provider });
    assert.equal(result.status, 'fails-request-preflight', `${lane} ${name}`);
    controls.push({ role: lane, name, result });
  }
}
const report = {
  scope: 'Local production request-compiler preflight for eight authored world pairs and twelve mutation controls. Saved replies and board links are constructed fixtures, not live database provenance or model replies.',
  productionCompilerHash: sourceHash, providerBodyHash, auditSourceHash: auditHash,
  validPairs: sample.length, failingControls: controls.length, sample, controls,
};
if (process.argv.includes('--check')) assert.deepEqual(JSON.parse(readFileSync('research/recipient-request-study.json', 'utf8')), report);
else writeFileSync('research/recipient-request-study.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify({ validPairs: sample.length, failingControls: controls.length, productionCompilerHash: sourceHash, auditSourceHash: auditHash }));
