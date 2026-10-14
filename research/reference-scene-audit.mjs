import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createFixture } from '../tests/database-fixture.mjs';
import { passportContext } from '../server/passport-reference.mjs';

const { app, store } = await createFixture({
  provider: { model: 'fixture-model', baseUrl: 'https://example.test/v1', apiKey: 'fixture-key' },
  completion: async () => ({ text: 'The documents are mine.', model: 'fixture-model', latencyMs: 1, usage: 1 }),
});
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
async function request(path, { method = 'GET', body, cookie } = {}) {
  const response = await fetch(`${origin}/api${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
}

try {
  const owner = await request('/setup', { method: 'POST', body: { name: 'Research owner', email: 'scene-audit@example.test', password: 'long-test-password' } });
  assert.equal(owner.status, 200);
  const link = await request('/reference/links', { method: 'POST', body: {}, cookie: owner.cookie });
  assert.equal(link.status, 200);
  const blind = await request(link.body.path);
  assert.equal(blind.status, 200);
  const started = await request(link.body.path, { method: 'POST', body: { tester: 'Audit player' } });
  assert.equal(started.status, 201);
  assert.equal(started.body.state.page, 0);
  assert.equal(started.body.state.cardRequested, false);
  const initialContext = passportContext(started.body.state);
  const report = {
    boundary: 'initial blind player API response and model desk context, in local in-memory fixture',
    initialPassportClosed: started.body.state.page === 0,
    initialArrivalCardUnrequested: started.body.state.cardRequested === false,
    protectedTruthAbsentFromBlindConfig: !JSON.stringify(blind.body).includes('Noah Vale'),
    passportNameInBlindConfig: blind.body.documents?.passport?.name === 'ELIAS VALE',
    arrivalSignatureInBlindConfig: blind.body.documents?.card?.signature === 'N. Vale',
    passportNameInInitialModelDeskContext: initialContext.includes('Both name Elias Vale'),
  };
  assert.equal(report.protectedTruthAbsentFromBlindConfig, true);
  assert.equal(report.passportNameInBlindConfig, false);
  assert.equal(report.arrivalSignatureInBlindConfig, false);
  assert.equal(report.passportNameInInitialModelDeskContext, true);
  writeFileSync('research/reference-scene-audit.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await new Promise(resolve => server.close(resolve));
  await store.db.close();
}
