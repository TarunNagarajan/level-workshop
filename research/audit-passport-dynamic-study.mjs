import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { compilePrompt } from '../server/levels.mjs';
import { passportLevel } from '../server/passport-reference.mjs';
import { auditDynamicEvidence } from './dynamic-evidence-audit.mjs';
import { passportEvidenceWorlds } from './passport-dynamic-adapter.mjs';

const sqlite = JSON.parse(readFileSync('research/passport-dynamic-study.json', 'utf8'));
const postgres = JSON.parse(readFileSync('research/passport-dynamic-study-postgres.json', 'utf8'));
const left = structuredClone(sqlite), right = structuredClone(postgres);
assert.equal(left.databaseAdapter, 'Node SQLite');
assert.equal(right.databaseAdapter, 'PGlite PostgreSQL');
delete left.databaseAdapter; delete right.databaseAdapter;
assert.deepEqual(left, right, 'Counterfactual study differs between storage adapters.');
for (const [name, expected] of Object.entries(sqlite.sourceHashes)) {
  assert.equal(createHash('sha256').update(readFileSync(name)).digest('hex'), expected, `Study source changed: ${name}`);
}
for (const [name, boundary] of [['playerAudit', 'player'], ['verifiedDeskAudit', 'verifiedDesk']]) {
  const current = auditDynamicEvidence({ worlds: passportEvidenceWorlds({ boundary }) });
  assert.equal(sqlite[name].exploredBeliefStates, current.exploredBeliefStates);
  assert.equal(sqlite[name].transitionEdges, current.transitionEdges);
  assert.deepEqual(sqlite[name].initialPartitions, current.initialPartitions);
  for (const saved of sqlite[name].worlds) {
    const fresh = current.worlds.find(row => row.worldId === saved.worldId);
    assert.deepEqual(saved.shortestDecision, fresh.shortestDecision);
    assert.deepEqual(saved.requiredOnEveryResolvingPath, fresh.requiredOnEveryResolvingPath);
    assert.deepEqual(saved.compareBypass, fresh.shortestDecisionWithout.compare);
  }
  assert.ok(sqlite[name].worlds.every(world => world.compareBypass !== null));
}
assert.equal(sqlite.checkedStages, 14);
assert.equal(sqlite.checkedActions, 12);
assert.equal(sqlite.modelStaticPromptHash, createHash('sha256').update(compilePrompt(passportLevel)).digest('hex'));
assert.equal(sqlite.modelWorldConsistency.filter(row => !row.consistentWithStaticPrompt).length, 3);
const browser = JSON.parse(readFileSync('research/reference-dom-visibility.json', 'utf8'));
for (const [name, expected] of Object.entries(browser.sourceHashes)) {
  assert.equal(createHash('sha256').update(readFileSync(name)).digest('hex'), expected, `Browser source changed: ${name}`);
}
for (const [name, expected] of Object.entries(browser.bundleHashes)) {
  assert.equal(createHash('sha256').update(readFileSync(`dist/client/${name}`)).digest('hex'), expected, `Browser bundle changed: ${name}`);
}
assert.equal(browser.firstByBoundary.cardSignature.browserNetworkAccessible.stage, 'card');
assert.equal(browser.firstByBoundary.signatureMismatch.browserNetworkAccessible.stage, 'card');
assert.equal(browser.firstByBoundary.uvIntact.browserNetworkAccessible.stage, 'uv');
console.log(JSON.stringify({ verified: true, adapters: 2, httpActionsPerAdapter: sqlite.checkedActions,
  counterfactualWorlds: sqlite.playerAudit.worlds.length, beliefStates: sqlite.playerAudit.exploredBeliefStates,
  decisionWorstCaseActions: sqlite.playerAudit.initialPartitions[0].adaptiveWorstCaseActions,
  compareNeededForDocumentDecision: false }));
