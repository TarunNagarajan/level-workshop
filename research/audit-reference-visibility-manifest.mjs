import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const sqlite = JSON.parse(readFileSync('research/reference-visibility-manifest.json', 'utf8'));
const postgres = JSON.parse(readFileSync('research/reference-visibility-manifest-postgres.json', 'utf8'));
assert.equal(sqlite.databaseAdapter, 'Node SQLite');
assert.equal(postgres.databaseAdapter, 'PGlite PostgreSQL');
const a = structuredClone(sqlite);
const b = structuredClone(postgres);
delete a.databaseAdapter;
delete b.databaseAdapter;
assert.deepEqual(a, b, 'Storage adapters produced different exposure manifests.');
for (const [name, expected] of Object.entries(sqlite.sourceHashes)) {
  assert.equal(createHash('sha256').update(readFileSync(name)).digest('hex'), expected, `Source changed since visibility run: ${name}`);
}
for (const [name, expected] of Object.entries(sqlite.bundleHashes)) {
  assert.equal(createHash('sha256').update(readFileSync(`dist/client/${name}`)).digest('hex'), expected, `Built text asset changed since visibility run: ${name}`);
}
const first = (fact, boundary) => sqlite.firstByBoundary[fact][boundary]?.stage ?? null;
assert.equal(first('passportSignature', 'playerAccessible'), 'opened');
assert.equal(first('cardSignature', 'playerAccessible'), 'card');
assert.equal(first('cardSignature', 'modelVerifiedDesk'), 'card');
assert.equal(first('cardSignature', 'modelStaticPrompt'), 'closed');
assert.equal(first('signatureMismatch', 'playerAccessible'), 'card');
assert.equal(first('signatureMismatch', 'modelVerifiedDesk'), 'card');
assert.equal(first('signatureMismatch', 'modelFullRequest'), 'opened');
assert.equal(first('stampDate', 'playerAccessible'), 'turned');
assert.equal(first('stampDate', 'playerBundle'), null);
assert.equal(first('uvIntact', 'playerAccessible'), 'uv');
assert.equal(first('protectedTravellerName', 'playerAccessible'), null);
assert.equal(first('protectedTravellerName', 'modelFullRequest'), 'closed');

const browser = JSON.parse(readFileSync('research/reference-dom-visibility.json', 'utf8'));
for (const [name, expected] of Object.entries(browser.sourceHashes)) assert.equal(createHash('sha256').update(readFileSync(name)).digest('hex'), expected, `Browser study source changed: ${name}`);
for (const [name, expected] of Object.entries(browser.bundleHashes)) assert.equal(createHash('sha256').update(readFileSync(`dist/client/${name}`)).digest('hex'), expected, `Browser study bundle changed: ${name}`);
for (const [stage, expected] of Object.entries(browser.screenshotHashes)) assert.equal(createHash('sha256').update(readFileSync(`research/browser-visibility/${stage}.png`)).digest('hex'), expected, `Screenshot changed: ${stage}`);
assert.deepEqual(browser.pageErrors, []);
assert.equal(browser.firstByBoundary.passportSignature.visibleNow.stage, 'opened');
assert.equal(browser.firstByBoundary.cardSignature.visibleNow.stage, 'card');
assert.equal(browser.firstByBoundary.signatureMismatch.visibleHistory.stage, 'card');
assert.equal(browser.firstByBoundary.stampDate.visibleNow.stage, 'turned');
assert.equal(browser.firstByBoundary.uvIntact.visibleNow.stage, 'uv');
assert.equal(browser.firstByBoundary.protectedTravellerName.visibleHistory, null);
assert.equal(browser.firstByBoundary.passportSignature.browserNetworkAccessible.stage, 'opened');
assert.equal(browser.firstByBoundary.cardSignature.browserNetworkAccessible.stage, 'card');
assert.equal(browser.firstByBoundary.stampDate.browserNetworkAccessible.stage, 'turned');
assert.equal(browser.firstByBoundary.stampDate.browserNetworkAssets, null);

const orderSqlite = JSON.parse(readFileSync('research/reference-action-orders.json', 'utf8'));
const orderPostgres = JSON.parse(readFileSync('research/reference-action-orders-postgres.json', 'utf8'));
assert.equal(orderSqlite.databaseAdapter, 'Node SQLite');
assert.equal(orderPostgres.databaseAdapter, 'PGlite PostgreSQL');
for (const report of [orderSqlite, orderPostgres]) for (const [name, expected] of Object.entries(report.sourceHashes)) assert.equal(createHash('sha256').update(readFileSync(name)).digest('hex'), expected, `Action-order source changed: ${name}`);
const left = structuredClone(orderSqlite), right = structuredClone(orderPostgres);
delete left.databaseAdapter;
delete right.databaseAdapter;
assert.deepEqual(left, right, 'Action-order results differ between adapters.');
assert.equal(orderSqlite.ordersTested, 25);
assert.equal(orderSqlite.comparisonNeverFirstForPlayer, true);
assert.equal(orderSqlite.comparisonNeverFirstForVerifiedModel, true);
assert.equal(orderSqlite.uvAlwaysFirstAtItsAction, true);
const graphSqlite = JSON.parse(readFileSync('research/reference-reducer-graph.json', 'utf8'));
const graphPostgres = JSON.parse(readFileSync('research/reference-reducer-graph-postgres.json', 'utf8'));
assert.equal(graphSqlite.databaseAdapter, 'Node SQLite');
assert.equal(graphPostgres.databaseAdapter, 'PGlite PostgreSQL');
for (const report of [graphSqlite, graphPostgres]) for (const [name, expected] of Object.entries(report.sourceHashes)) assert.equal(createHash('sha256').update(readFileSync(name)).digest('hex'), expected, `Reducer-graph source changed: ${name}`);
const graphLeft = structuredClone(graphSqlite), graphRight = structuredClone(graphPostgres);
delete graphLeft.databaseAdapter;
delete graphRight.databaseAdapter;
assert.deepEqual(graphLeft, graphRight, 'Reducer-graph results differ between adapters.');
assert.equal(graphSqlite.abstractStates, 5745);
assert.equal(graphSqlite.transitionEdges, 66410);
assert.equal(graphSqlite.collisionChecks, 60666);
assert.equal(graphSqlite.moveCoordinateChecks, 34470);
assert.ok(graphSqlite.maxTraceLength < 200);
assert.deepEqual(graphSqlite.witnesses.mismatchBeforeCompare, ['open', 'card']);
assert.deepEqual(graphSqlite.witnesses.uvAfterLamp, ['lamp:uv']);
assert.deepEqual(graphSqlite.findings, {
  verifiedDeskUvOnlyAfterLamp: true,
  verifiedDeskExplicitMismatchOnlyAfterCompare: true,
  derivedMismatchBeforeCompare: true,
  protectedTravellerNameAbsentFromVerifiedDesk: true,
});
assert.deepEqual(graphSqlite.apiParity, { rounds: 23, actions: 352, staleRevisionRejections: 23 });
const prerequisite = JSON.parse(readFileSync('research/reference-prerequisite-audit.json', 'utf8'));
for (const [name, expected] of Object.entries(prerequisite.sourceHashes)) assert.equal(createHash('sha256').update(readFileSync(name)).digest('hex'), expected, `Prerequisite preflight source changed: ${name}`);
for (const boundary of ['playerAccessible', 'modelVerifiedDesk', 'modelFullRequest', 'visibleHistory']) assert.equal(prerequisite.boundaries[boundary].checks.compare.status, 'always-known-before');
assert.equal(prerequisite.boundaries.playerAccessible.checks.uv.status, 'not-proven-known-before');
assert.equal(prerequisite.boundaries.modelFullRequest.checks.uv.status, 'always-known-before');
const repair = JSON.parse(readFileSync('research/reference-reveal-repairs.json', 'utf8'));
for (const [name, expected] of Object.entries(repair.sourceHashes)) assert.equal(createHash('sha256').update(readFileSync(name)).digest('hex'), expected, `Reveal-repair source changed: ${name}`);
assert.equal(repair.boundaries.playerAccessible.repairs.turn.status, 'no-edit-needed-by-preflight');
for (const boundary of Object.values(repair.boundaries)) assert.equal(boundary.repairs.compare.status, 'infeasible-under-pins');
assert.equal(repair.boundaries.playerAccessible.repairs.uv.status, 'no-edit-needed-by-preflight');
const inspector = JSON.parse(readFileSync('research/author-inspector-preview.json', 'utf8'));
for (const [name, expected] of Object.entries(inspector.sourceHashes)) assert.equal(createHash('sha256').update(readFileSync(name)).digest('hex'), expected, `Inspector source changed: ${name}`);
for (const [name, expected] of Object.entries(inspector.screenshotHashes)) assert.equal(createHash('sha256').update(readFileSync(`research/inspector-visibility/${name}.png`)).digest('hex'), expected, `Inspector screenshot changed: ${name}`);
assert.deepEqual(inspector.pageErrors, []);
assert.equal(inspector.interactions.length, 4);
console.log(JSON.stringify({ matchingAdapters: true, sourceFiles: Object.keys(sqlite.sourceHashes).length, textAssets: Object.keys(sqlite.bundleHashes).length, facts: sqlite.factIds.length, stages: sqlite.stages.length, browserStages: browser.stages.length, screenshots: Object.keys(browser.screenshotHashes).length, legalActionOrders: orderSqlite.ordersTested, abstractReducerStates: graphSqlite.abstractStates, reducerEdges: graphSqlite.transitionEdges, apiParityActionsPerAdapter: graphSqlite.apiParity.actions, prerequisiteBoundaries: Object.keys(prerequisite.boundaries).length, repairBoundaries: Object.keys(repair.boundaries).length, inspectorScreenshots: Object.keys(inspector.screenshotHashes).length, status: sqlite.status }));
