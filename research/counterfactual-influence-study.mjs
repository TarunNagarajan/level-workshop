import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { auditFactorInfluence } from './counterfactual-influence-matrix.mjs';
import { passportInfluenceFixture, equipmentInfluenceFixture } from './counterfactual-influence-fixtures.mjs';
import { equipmentWorlds } from './dynamic-evidence-fixture.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const sourceFiles = ['server/passport-reference.mjs', 'server/world-bound-template.mjs', 'server/levels.mjs', 'research/passport-dynamic-adapter.mjs', 'research/dynamic-evidence-fixture.mjs', 'research/counterfactual-influence-matrix.mjs', 'research/counterfactual-influence-fixtures.mjs', 'research/counterfactual-influence-study.mjs'];
const sourceHashes = Object.fromEntries(sourceFiles.map(path => [path, hash(readFileSync(path))]));
const passportFixture = passportInfluenceFixture(), equipmentFixture = equipmentInfluenceFixture();
const passport = auditFactorInfluence(passportFixture), equipment = auditFactorInfluence(equipmentFixture);
assert.equal(passport.status, 'satisfied'); assert.equal(equipment.status, 'satisfied');
const cellSummary = report => report.cells.map(({ fact, surface, rule, pairs, changedPairs, status }) => ({ fact, surface, rule, pairs, changedPairs, status }));
const failedCell = (report, fact, surface) => {
  const cell = report.cells.find(item => item.fact === fact && item.surface === surface);
  assert.equal(cell.status, 'violated');
  return { fact, surface, rule: cell.rule, changedPairs: cell.changedPairs, firstWitness: cell.witnesses[0] };
};
const earlyLeak = auditFactorInfluence({ ...passportFixture, surfaces: { ...passportFixture.surfaces,
  playerClosed: world => ({ ...passportFixture.surfaces.playerClosed(world), leakedUv: world.scenario.uvIntact }) } });
const crossCoupling = auditFactorInfluence({ ...passportFixture, surfaces: { ...passportFixture.surfaces,
  playerCard: world => ({ ...passportFixture.surfaces.playerCard(world), uvNote: world.scenario.uvIntact }) } });
const missingReveal = auditFactorInfluence({ ...passportFixture, surfaces: { ...passportFixture.surfaces,
  playerCard: world => passportFixture.surfaces.playerClosed(world) } });
const affordanceWorlds = equipmentWorlds({ leakFuseByAvailability: true }).map(world => ({ ...world, facts: { voltage: world.voltage, fuse: world.fuse } }));
const affordanceLeak = auditFactorInfluence({ ...equipmentFixture, worlds: affordanceWorlds, surfaces: { ...equipmentFixture.surfaces,
  playerClosed: world => ({ observation: world.observe(world.initialState), availableActions: world.enabled(world.initialState) }) } });
const controls = {
  initialUvPayloadLeak: failedCell(earlyLeak, 'uvAssessment', 'playerClosed'),
  cardUvCoupling: failedCell(crossCoupling, 'uvAssessment', 'playerCard'),
  missingCardReveal: failedCell(missingReveal, 'cardRelation', 'playerCard'),
  fuseButtonLeak: failedCell(affordanceLeak, 'fuse', 'playerClosed'),
};
assert.equal(controls.initialUvPayloadLeak.firstWitness.firstDifference.path, '$.leakedUv');
assert.match(controls.fuseButtonLeak.firstWitness.firstDifference.path, /availableActions/);
const report = {
  status: 'passed', sourceHashes,
  method: 'Cross complete four-world factor sets one fact at a time; compare actual player/verified-desk serializers and compiled target prompt at fixed action stages; enforce each declared hidden or revealed influence cell.',
  scope: 'Deterministic first-use passport reducer and separate equipment state machine. Four one-factor pairs per family. No image pixels, human observations, live provider replies, or stochastic state.',
  passport: { status: passport.status, worlds: passport.worlds, pairCount: passport.pairCount, cells: cellSummary(passport) },
  equipment: { status: equipment.status, worlds: equipment.worlds, pairCount: equipment.pairCount, cells: cellSummary(equipment) },
  controls,
};
writeFileSync('research/counterfactual-influence-study.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify({ status: report.status, families: 2, worlds: 8, oneFactorPairs: 8, passingCells: report.passport.cells.length + report.equipment.cells.length, detectedControls: Object.keys(controls).length }));
