import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createFixture } from '../tests/database-fixture.mjs';

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
  const owner = await request('/setup', { method: 'POST', body: { name: 'Visibility owner', email: 'visibility@example.test', password: 'long-test-password' } });
  assert.equal(owner.status, 200);
  const link = await request('/reference/links', { method: 'POST', body: {}, cookie: owner.cookie });
  assert.equal(link.status, 200);
  const blind = await request(link.body.path);
  assert.equal(blind.status, 200);
  const started = await request('/reference/start', { method: 'POST', body: {}, cookie: owner.cookie });
  assert.equal(started.status, 201);
  const roundId = started.body.round.id;
  let state = started.body.state;
  const frames = [];
  async function snapshot(stage, eventObservation = null) {
    const context = await request(`/reference/rounds/${roundId}/context`, { cookie: owner.cookie });
    assert.equal(context.status, 200);
    const desk = context.body.observations;
    frames.push({
      stage, page: state.page, cardRequested: state.cardRequested, compared: state.compared,
      eventCount: context.body.events.length,
      eventObservationMentionsPassportName: eventObservation?.includes('Elias Vale') ?? false,
      eventObservationMentionsCardSignature: eventObservation?.includes('N. Vale') ?? false,
      modelDeskMentionsPassportName: desk.includes('Elias Vale'),
      modelDeskMentionsIdentityPage: desk.includes('identity page:'),
      modelDeskMentionsCardSignature: desk.includes('N. Vale'),
      modelDeskMentionsSignatureComparison: desk.includes('initial differs'),
    });
  }
  await snapshot('closed');
  async function action(stage, input) {
    const reply = await request(`/reference/rounds/${roundId}/action`, { method: 'POST', body: { revision: state.revision, ...input }, cookie: owner.cookie });
    assert.equal(reply.status, 200);
    state = reply.body.state;
    await snapshot(stage, reply.body.observation);
  }
  await action('passport-opened', { action: 'open', object: 'passport' });
  await action('card-requested', { action: 'card' });
  await action('signatures-compared', { action: 'compare' });
  const report = {
    boundary: 'Actual local Express reference routes with in-memory database, no provider call or live deployment.',
    databaseAdapter: process.env.TEST_DATABASE === 'postgres' ? 'PGlite PostgreSQL' : 'Node SQLite',
    initialBlindApi: {
      passportNamePresent: blind.body.documents?.passport?.name === 'ELIAS VALE',
      cardSignaturePresent: blind.body.documents?.card?.signature === 'N. Vale',
      protectedBrotherTruthPresent: JSON.stringify(blind.body).includes('Noah Vale'),
    },
    frames,
  };
  assert.deepEqual(report.initialBlindApi, { passportNamePresent: false, cardSignaturePresent: false, protectedBrotherTruthPresent: false });
  assert.deepEqual(frames.map(frame => frame.modelDeskMentionsIdentityPage), [false, true, true, true]);
  assert.deepEqual(frames.map(frame => frame.modelDeskMentionsCardSignature), [false, false, true, true]);
  assert.deepEqual(frames.map(frame => frame.modelDeskMentionsSignatureComparison), [false, false, false, true]);
  const outputPath = process.env.TEST_DATABASE === 'postgres' ? 'research/reference-visibility-timeline-postgres.json' : 'research/reference-visibility-timeline.json';
  writeFileSync(outputPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await new Promise(resolve => server.close(resolve));
  await store.db.close();
}
