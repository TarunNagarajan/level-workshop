import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createFixture } from '../tests/database-fixture.mjs';
import { buildCompletionBody } from '../server/model.mjs';

const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const sourceFiles = ['server/passport-reference.mjs', 'server/world-bound-template.mjs', 'server/workshop.mjs', 'server/levels.mjs', 'server/model.mjs', 'src/PassportReference.tsx', 'src/App.tsx', 'research/passport-routed-worlds-study.mjs'];
const sourceHashes = Object.fromEntries(sourceFiles.map(path => [path, hash(readFileSync(path))]));
const expected = {
  'match-intact': { signature: 'E. Vale', uv: 'intact' },
  'match-broken': { signature: 'E. Vale', uv: 'broken' },
  'mismatch-intact': { signature: 'N. Vale', uv: 'intact' },
  'mismatch-broken': { signature: 'N. Vale', uv: 'broken' },
};
const calls = [];
const { app, store } = await createFixture({
  researchWorlds: true,
  provider: { model: 'fixture-model', baseUrl: 'https://example.test/v1', apiKey: 'fixture-key' },
  completion: async input => { calls.push(input); return { text: 'These documents are mine.', model: 'fixture-model', latencyMs: 1, usage: 5 }; },
});
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
async function request(path, { method = 'GET', body, cookie } = {}) {
  const response = await fetch(origin + '/api' + path, {
    method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
}
const rows = [];
try {
  const owner = await request('/setup', { method: 'POST', body: { name: 'Research owner', email: 'routed-worlds@example.test', password: 'long-test-password' } });
  assert.equal(owner.status, 200);
  for (const [id, fact] of Object.entries(expected)) {
    const config = await request(`/reference/research/${id}`, { cookie: owner.cookie });
    assert.equal(config.status, 200);
    assert.equal(config.body.documents.passport, null);
    assert.equal(config.body.documents.card, null);
    const start = await request(`/reference/research/${id}`, { method: 'POST', body: {}, cookie: owner.cookie });
    assert.equal(start.status, 201);
    assert.equal(start.body.round.versionId, `reference-passport-study-v1-${id}`);
    let current = start.body;
    const roundPath = `/reference/rounds/${current.round.id}`;
    const bypass = await request(`/rounds/${current.round.id}/messages`, { method: 'POST', body: { content: 'Skip the desk.' }, cookie: owner.cookie });
    assert.equal(bypass.status, 409);
    const before = await request(`${roundPath}/context`, { cookie: owner.cookie });
    assert.equal(before.status, 200);
    assert.equal(before.body.observations.includes('arrival card'), false);
    assert.equal(before.body.observations.includes('UV thread'), false);
    async function act(input) {
      const next = await request(`${roundPath}/action`, { method: 'POST', body: { revision: current.state.revision, ...input }, cookie: owner.cookie });
      assert.equal(next.status, 200); current = next.body; return next;
    }
    await act({ action: 'open' });
    const card = await act({ action: 'card' });
    assert.equal(card.body.documents.card.signature, fact.signature);
    const lamp = await act({ action: 'lamp', value: 'uv' });
    assert.equal(lamp.body.observation.includes(fact.uv), true);
    const preview = await request(`${roundPath}/context`, { cookie: owner.cookie });
    assert.equal(preview.status, 200);
    const reply = await request(`${roundPath}/messages`, { method: 'POST', body: { content: 'Explain these documents.' }, cookie: owner.cookie });
    assert.equal(reply.status, 200);
    const call = calls.at(-1);
    assert.equal(call.system, preview.body.system);
    assert.equal(call.system.includes(`signed ${fact.signature}`), true);
    assert.equal(call.system.includes(fact.uv === 'intact' ? 'UV thread is intact' : 'UV thread is broken'), true);
    assert.equal(call.system.includes(fact.uv === 'intact' ? 'UV thread is broken' : 'UV thread is intact'), false);
    assert.equal(call.system.includes(fact.signature === 'N. Vale' ? 'arrival card is signed E. Vale' : 'arrival card is signed N. Vale'), false);
    rows.push({
      id, versionId: start.body.round.versionId,
      initialPlayerHash: hash(config.body), closedPlayerHash: hash(start.body.documents),
      afterCardPlayerHash: hash(card.body.documents), afterUvPlayerHash: hash(lamp.body.documents),
      initialTargetHash: hash(before.body.system), afterInspectionTargetHash: hash(call.system),
      providerRequestHash: hash(buildCompletionBody(call)),
      cardSignature: card.body.documents.card.signature, uvObservation: lamp.body.observation,
    });
  }
  assert.equal(new Set(rows.map(row => row.initialPlayerHash)).size, 1);
  assert.equal(new Set(rows.map(row => row.closedPlayerHash)).size, 1);
  assert.equal(new Set(rows.map(row => row.initialTargetHash)).size, 4);
  assert.equal(new Set(rows.map(row => row.providerRequestHash)).size, 4);
  assert.equal((await request('/reference/active', { cookie: owner.cookie })).body, null);
  const report = {
    status: 'passed', databaseAdapter: process.env.TEST_DATABASE === 'postgres' ? 'PGlite PostgreSQL' : 'Node SQLite',
    scope: 'Four local admin-only passport versions. Real HTTP routes, physical reducer, player document serialization, context preview, completion stub input, and the production provider-body builder. No live provider, human player, or deployment.',
    sourceHashes, rows,
    conclusions: {
      initialPlayerViewsEqual: true, closedPlayerDocumentsEqual: true,
      targetStaticPromptsDifferBeforeInspection: true, targetPromptsMatchWorld: true,
      ordinaryReferenceActiveSessionUnaffected: true, genericChatBypassBlocked: true,
    },
  };
  const outputPath = process.env.TEST_DATABASE === 'postgres' ? 'research/passport-routed-worlds-postgres.json' : 'research/passport-routed-worlds.json';
  writeFileSync(outputPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ outputPath, status: report.status, worlds: rows.length, providerRequests: calls.length, initialPlayerViewsEqual: true, targetPromptsMatchWorld: true }));
} finally {
  await new Promise(resolve => server.close(resolve));
  await store.db.close();
}
