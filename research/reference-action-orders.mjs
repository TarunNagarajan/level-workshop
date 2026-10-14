import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createFixture } from '../tests/database-fixture.mjs';
import { compileVisibilityManifest } from './visibility-manifest.mjs';

const actions = ['open', 'turn', 'card', 'uv', 'compare'];
function permutations(items) {
  if (!items.length) return [[]];
  return items.flatMap((item, index) => permutations(items.filter((_, other) => other !== index)).map(rest => [item, ...rest]));
}
const orders = permutations(actions).filter(order => order.indexOf('open') < order.indexOf('turn') && order.indexOf('open') < order.indexOf('compare') && order.indexOf('card') < order.indexOf('compare'));
assert.equal(orders.length, 25);
const sourceFiles = ['server/passport-reference.mjs', 'server/levels.mjs', 'server/workshop.mjs', 'research/visibility-manifest.mjs', 'research/reference-action-orders.mjs'];
const sourceHashes = Object.fromEntries(sourceFiles.map(name => [name, createHash('sha256').update(readFileSync(name)).digest('hex')]));
const { app, store } = await createFixture({
  provider: { model: 'fixture-model', baseUrl: 'https://example.test/v1', apiKey: 'fixture-key' },
  completion: async () => ({ text: 'The documents are mine.', model: 'fixture-model', latencyMs: 1, usage: 1 }),
});
const server = app.listen(0, '127.0.0.1');
await new Promise(done => server.once('listening', done));
const base = `http://127.0.0.1:${server.address().port}`;
async function request(path, { method = 'GET', body, cookie, token } = {}) {
  const response = await fetch(`${base}/api${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(token ? { 'x-round-token': token } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
}
const mismatch = (_, leaves) => {
  const passport = leaves.filter(leaf => leaf.text.includes('E. Vale'));
  const card = leaves.filter(leaf => leaf.text.includes('N. Vale'));
  return passport.length && card.length ? [passport[0].path, card[0].path] : [];
};
const facts = [
  { id: 'passportSignature', variants: ['E. Vale'] },
  { id: 'cardSignature', variants: ['N. Vale'] },
  { id: 'signatureMismatch', derive: mismatch },
  { id: 'stampDate', variants: ['14 MAR 2024', '14 March 2024'] },
  { id: 'uvIntact', variants: ['thread is intact', 'document is genuine and unaltered'] },
  { id: 'protectedTravellerName', variants: ['Noah Vale'] },
];
try {
  const owner = await request('/setup', { method: 'POST', body: { name: 'Order owner', email: 'order-study@example.test', password: 'long-test-password' } });
  assert.equal(owner.status, 200);
  const link = await request('/reference/links', { method: 'POST', body: {}, cookie: owner.cookie });
  assert.equal(link.status, 200);
  const blind = await request(link.body.path);
  assert.equal(blind.status, 200);
  const reports = [];
  for (const order of orders) {
    const started = await request(link.body.path, { method: 'POST', body: { tester: 'Order observer' } });
    assert.equal(started.status, 201);
    const id = started.body.round.id, token = started.body.round.accessToken;
    let state = started.body.state;
    const frames = [];
    async function snapshot(stage, actionResponse = null) {
      const context = await request(`/reference/rounds/${id}/context`, { cookie: owner.cookie });
      assert.equal(context.status, 200);
      const round = await request(`/reference/rounds/${id}`, { token });
      assert.equal(round.status, 200);
      frames.push({ stage, surfaces: {
        playerBootstrapApi: blind.body,
        playerRoundApi: round.body,
        playerActionApi: actionResponse,
        modelVerifiedDesk: context.body.observations,
        modelFullSystem: context.body.system,
      } });
    }
    await snapshot('closed');
    for (const action of order) {
      const input = action === 'uv' ? { action: 'lamp', value: 'uv' } : { action };
      const response = await request(`/reference/rounds/${id}/action`, { method: 'POST', body: { revision: state.revision, ...input }, token });
      assert.equal(response.status, 200, `${order.join(',')}: ${action} failed: ${JSON.stringify(response.body)}`);
      state = response.body.state;
      await snapshot(action, response.body);
    }
    const boundaries = { playerApi: ['playerBootstrapApi', 'playerRoundApi', 'playerActionApi'], modelVerifiedDesk: ['modelVerifiedDesk'], modelFullRequest: ['modelFullSystem'] };
    const manifest = compileVisibilityManifest({
      facts, frames, boundaries,
      rules: [
        { factId: 'signatureMismatch', boundary: 'playerApi', earliestStage: 'compare', mustReveal: true },
        { factId: 'signatureMismatch', boundary: 'modelVerifiedDesk', earliestStage: 'compare', mustReveal: true },
        { factId: 'uvIntact', boundary: 'playerApi', earliestStage: 'uv', mustReveal: true },
        { factId: 'uvIntact', boundary: 'modelVerifiedDesk', earliestStage: 'uv', mustReveal: true },
      ],
    });
    const first = fact => Object.fromEntries(Object.keys(boundaries).map(boundary => [boundary, manifest.firstByBoundary[fact][boundary]?.stage ?? null]));
    assert.equal(first('signatureMismatch').playerApi, order.indexOf('open') > order.indexOf('card') ? 'open' : 'card');
    assert.equal(first('signatureMismatch').modelVerifiedDesk, order.indexOf('open') > order.indexOf('card') ? 'open' : 'card');
    assert.equal(first('signatureMismatch').modelFullRequest, 'open');
    assert.equal(first('uvIntact').playerApi, 'uv');
    assert.equal(first('uvIntact').modelVerifiedDesk, 'uv');
    assert.equal(first('protectedTravellerName').playerApi, null);
    reports.push({ order, firstExposure: Object.fromEntries(facts.map(fact => [fact.id, first(fact.id)])), verdicts: manifest.verdicts.map(({ factId, boundary, status }) => ({ factId, boundary, status })) });
  }
  const report = {
    scope: 'All legal permutations of first-use open, turn, card, UV, and compare on actual local Express routes. No repeated toggles, move/hint/present actions, browser rendering, provider calls, live deployment, or alternate authored worlds.',
    databaseAdapter: process.env.TEST_DATABASE === 'postgres' ? 'PGlite PostgreSQL' : 'Node SQLite',
    sourceHashes, actionCount: actions.length, ordersTested: reports.length,
    comparisonNeverFirstForPlayer: reports.every(row => row.firstExposure.signatureMismatch.playerApi !== 'compare'),
    comparisonNeverFirstForVerifiedModel: reports.every(row => row.firstExposure.signatureMismatch.modelVerifiedDesk !== 'compare'),
    uvAlwaysFirstAtItsAction: reports.every(row => row.firstExposure.uvIntact.playerApi === 'uv' && row.firstExposure.uvIntact.modelVerifiedDesk === 'uv'),
    reports,
  };
  const outputPath = process.env.TEST_DATABASE === 'postgres' ? 'research/reference-action-orders-postgres.json' : 'research/reference-action-orders.json';
  writeFileSync(outputPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ outputPath, ordersTested: report.ordersTested, comparisonNeverFirstForPlayer: report.comparisonNeverFirstForPlayer, comparisonNeverFirstForVerifiedModel: report.comparisonNeverFirstForVerifiedModel, uvAlwaysFirstAtItsAction: report.uvAlwaysFirstAtItsAction }));
} finally {
  await new Promise(done => server.close(done));
  await store.db.close();
}
