import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { equipmentWorlds } from './dynamic-evidence-fixture.mjs';
import { auditTemporalObserverCut } from './temporal-observer-cut.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const report = JSON.parse(readFileSync('research/equipment-first-use-study.json', 'utf8'));
const protocol = JSON.parse(readFileSync('research/equipment-first-use-protocol.json', 'utf8'));
assert.equal(report.status, 'passed');
for (const [path, saved] of Object.entries(report.sourceHashes)) assert.equal(hash(readFileSync(path)), saved, `stale source: ${path}`);
let stages = 0;
for (const row of report.rows) for (const stage of row.trace) {
  const screenshot = readFileSync(`research/browser-equipment/${row.name}-${stage.action}.png`);
  assert.equal(hash(screenshot), stage.screenshotHash, `${row.name} ${stage.action}: changed screenshot`);
  assert.equal(hash(await sharp(screenshot).ensureAlpha().raw().toBuffer()), stage.capture.screenshotPixelHash,
    `${row.name} ${stage.action}: changed pixels`);
  if (stage.capture.actionPayload) assert.equal(hash(JSON.stringify(stage.capture.actionPayload)), stage.capture.actionPayloadHash);
  stages++;
}
for (const factor of protocol.factors) {
  const paths = report.pathsByFactor[factor.name];
  assert.equal(paths.length, protocol.expectedLegalFullOrdersPerPair);
  const worlds = equipmentWorlds().filter(world => [factor.left, factor.right].includes(world.id));
  for (const world of worlds) {
    const enumerated = [];
    function visit(state, path) {
      if (path.length === protocol.actionSet.length) { enumerated.push(path.join(',')); return; }
      for (const action of world.enabled(state)) visit(world.step(state, action), [...path, action]);
    }
    visit(world.initialState, []);
    assert.deepEqual(new Set(paths.map(path => path.join(','))), new Set(enumerated),
      `${world.id}: saved paths do not exhaust legal first-use orders`);
  }
  for (const path of paths) {
    for (const world of worlds) {
      let state = world.initialState;
      for (const action of path) {
        assert.ok(world.enabled(state).includes(action), `${world.id}: saved path is illegal`);
        state = world.step(state, action);
      }
      assert.deepEqual(new Set(path), new Set(protocol.actionSet));
    }
    const rows = report.rows.filter(row => row.condition === `orders-${factor.name}` && row.path.join(',') === path.join(','));
    assert.deepEqual(rows.map(row => row.worldId), [factor.left, factor.right]);
    for (const channel of protocol.channels) {
      const actual = auditTemporalObserverCut(rows[0].trace, rows[1].trace, { requiredAction: factor.event, channel });
      const saved = report.verdicts.find(item => item.factor === factor.name && item.path.join(',') === path.join(',') && item.channel === channel);
      assert.deepEqual(saved, { factor: factor.name, path, ...actual });
    }
  }
}
assert.equal(report.verdicts.length, protocol.factors.length * protocol.expectedLegalFullOrdersPerPair * protocol.channels.length);
console.log(JSON.stringify({ status: 'fresh', browserFixtures: report.rows.length, screenshotStages: stages,
  legalFullOrders: Object.values(report.pathsByFactor).reduce((sum, paths) => sum + paths.length, 0), verdicts: report.verdicts.length }));
