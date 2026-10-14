import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditFactorInfluence } from './counterfactual-influence-matrix.mjs';
import { passportInfluenceFixture, equipmentInfluenceFixture } from './counterfactual-influence-fixtures.mjs';
import { equipmentWorlds } from './dynamic-evidence-fixture.mjs';

test('one-factor interventions isolate signature and UV effects on actual passport serializers', () => {
  const report = auditFactorInfluence(passportInfluenceFixture());
  assert.equal(report.status, 'satisfied');
  assert.equal(report.pairCount, 4);
  assert.equal(report.cells.length, 16);
  assert.equal(report.cells.find(cell => cell.fact === 'cardRelation' && cell.surface === 'playerCard').changedPairs, 2);
  assert.equal(report.cells.find(cell => cell.fact === 'uvAssessment' && cell.surface === 'playerCard').changedPairs, 0);
  assert.equal(report.cells.find(cell => cell.fact === 'uvAssessment' && cell.surface === 'targetStatic').changedPairs, 2);
});

test('the same matrix works for a separate equipment-inspection scene', () => {
  const report = auditFactorInfluence(equipmentInfluenceFixture());
  assert.equal(report.status, 'satisfied');
  assert.equal(report.pairCount, 4);
  assert.equal(report.cells.length, 10);
});

test('early payload leaks, cross-factor coupling, missing reveals, and affordance leaks produce witnesses', () => {
  const base = passportInfluenceFixture();
  const earlyLeak = auditFactorInfluence({ ...base, surfaces: { ...base.surfaces, playerClosed: world => ({ ...base.surfaces.playerClosed(world), leakedUv: world.scenario.uvIntact }) } });
  assert.equal(earlyLeak.status, 'violated');
  assert.equal(earlyLeak.cells.find(cell => cell.fact === 'uvAssessment' && cell.surface === 'playerClosed').witnesses[0].firstDifference.path, '$.leakedUv');
  const crossCoupling = auditFactorInfluence({ ...base, surfaces: { ...base.surfaces, playerCard: world => ({ ...base.surfaces.playerCard(world), uvNote: world.scenario.uvIntact }) } });
  assert.equal(crossCoupling.cells.find(cell => cell.fact === 'uvAssessment' && cell.surface === 'playerCard').status, 'violated');
  const missing = auditFactorInfluence({ ...base, surfaces: { ...base.surfaces, playerCard: world => base.surfaces.playerClosed(world) } });
  assert.equal(missing.cells.find(cell => cell.fact === 'cardRelation' && cell.surface === 'playerCard').status, 'violated');
  const equipment = equipmentInfluenceFixture();
  const worlds = equipmentWorlds({ leakFuseByAvailability: true }).map(world => ({ ...world, facts: { voltage: world.voltage, fuse: world.fuse } }));
  const affordance = auditFactorInfluence({ ...equipment, worlds, surfaces: { ...equipment.surfaces, playerClosed: world => ({ observation: world.observe(world.initialState), availableActions: world.enabled(world.initialState) }) } });
  assert.equal(affordance.cells.find(cell => cell.fact === 'fuse' && cell.surface === 'playerClosed').status, 'violated');
  assert.match(affordance.cells.find(cell => cell.fact === 'fuse' && cell.surface === 'playerClosed').witnesses[0].firstDifference.path, /availableActions/);
});
