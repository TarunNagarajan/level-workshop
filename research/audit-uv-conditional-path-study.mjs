import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { passportEvidenceWorlds } from './passport-dynamic-adapter.mjs';
import { auditEventCut } from './event-cut-contract.mjs';
import { auditTemporalObserverCut } from './temporal-observer-cut.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const report = JSON.parse(readFileSync('research/uv-conditional-path-study.json', 'utf8'));
assert.equal(report.status, 'passed');
assert.equal(report.rows.length, 6);
assert.equal(report.verdicts.length, 15);
for (const [path, hash] of Object.entries(report.sourceHashes)) assert.equal(digest(readFileSync(path)), hash, `Source changed: ${path}`);
for (const [path, hash] of Object.entries(report.bundleHashes)) assert.equal(digest(readFileSync(`dist/client/${path}`)), hash, `Bundle changed: ${path}`);
const worlds = passportEvidenceWorlds({ boundary: 'player' }).filter(world => ['match-intact', 'match-broken'].includes(world.id));
const graph = auditEventCut({ worlds, requiredAction: 'lamp:uv', maxPairs: 50000 });
assert.deepEqual({ status: graph.status, exploredPairs: graph.exploredPairs, shortestReveal: graph.revealTrace.actions }, report.graph);
for (const row of report.rows) {
  assert.deepEqual(row.trace.map(stage => stage.action), ['intro', 'closed', ...row.path]);
  const world = worlds.find(item => item.id === row.worldId);
  let state = world.initialState;
  for (const [index, stage] of row.trace.entries()) {
    const png = readFileSync(`research/browser-uv-paths/${row.name}-${stage.action.replace(':', '-')}.png`);
    assert.equal(digest(png), stage.screenshotHash);
    assert.equal(digest(await sharp(png).ensureAlpha().raw().toBuffer()), stage.capture.screenshotPixelHash);
    assert.equal(stage.capture.actionPayload ? digest(JSON.stringify(stage.capture.actionPayload)) : null, stage.capture.actionPayloadHash);
    if (index < 2) continue;
    assert.ok(world.enabled(state).includes(stage.action));
    state = world.step(state, stage.action);
    const expected = world.observe(state);
    assert.deepEqual(stage.capture.actionPayload.documents, expected.documents);
    assert.deepEqual(stage.capture.actionPayload.state.events.map(({ action, object, value, page, observation }) => ({ action, object, value, page, observation })), expected.desk.events);
  }
}
for (const verdict of report.verdicts) {
  const [left, right] = report.rows.filter(row => row.path.join(',') === verdict.path.join(','));
  assert.deepEqual({ path: verdict.path,
    ...auditTemporalObserverCut(left.trace, right.trace, { requiredAction: 'lamp:uv', channel: verdict.channel }) }, verdict);
}
assert.equal(report.verdicts.filter(item => item.status === 'exposed-before-event').length, 0);
assert.equal(report.verdicts.filter(item => item.status === 'revealed-at-event').length, 12);
console.log(JSON.stringify({ status: 'fresh', graphPairs: graph.exploredPairs, browserFixtures: report.rows.length, verdicts: report.verdicts.length }));
