import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFixture } from './database-fixture.mjs';
import { passportStudyWorld } from '../server/passport-reference.mjs';

async function fixture(researchWorlds, researchWorldId = '') {
  const calls = [];
  const { app, store } = await createFixture({
    researchWorlds, researchWorldId,
    provider: { model: 'fixture-model', baseUrl: 'https://example.test/v1', apiKey: 'fixture-key' },
    completion: async input => { calls.push(input); return { text: 'These are my documents.', model: 'fixture-model', latencyMs: 1, usage: 4 }; },
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, { method = 'GET', body, cookie, token } = {}) => {
    const response = await fetch(origin + '/api' + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(token ? { 'x-round-token': token } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  const owner = await request('/setup', { method: 'POST', body: { name: 'Owner', email: 'worlds@example.test', password: 'long-test-password' } });
  return { store, calls, request, cookie: owner.cookie, close: async () => { await new Promise(resolve => server.close(resolve)); await store.db.close(); } };
}

test('local research worlds have separate immutable versions and consistent player and target boundaries', async () => {
  const f = await fixture(true);
  try {
    assert.equal((await f.request('/reference/research/match-intact')).status, 401);
    assert.equal((await f.request('/reference/research/unknown', { cookie: f.cookie })).status, 404);
    const started = [];
    for (const id of ['match-intact', 'match-broken', 'mismatch-intact', 'mismatch-broken']) {
      const world = passportStudyWorld(id);
      const config = await f.request(`/reference/research/${id}`, { cookie: f.cookie });
      assert.equal(config.status, 200);
      assert.equal(config.body.documents.passport, null);
      assert.equal(config.body.documents.card, null);
      assert.equal(config.body.level.secret, undefined);
      assert.equal(config.body.canManageLinks, false);
      const first = await f.request(`/reference/research/${id}`, { method: 'POST', body: {}, cookie: f.cookie });
      assert.equal(first.status, 201);
      assert.equal(first.body.round.versionId, `reference-passport-study-v1-${id}`);
      assert.equal(first.body.documents.passport, null);
      assert.equal(first.body.documents.card, null);
      started.push({ id, world, first: first.body });
    }
    assert.equal((await f.request('/reference/active', { cookie: f.cookie })).body, null);
    assert.equal(new Set(started.map(item => item.first.round.versionId)).size, 4);
    for (const item of started) {
      const { id, world } = item;
      let current = item.first;
      const path = `/reference/rounds/${current.round.id}`;
      for (const [generic, body] of [
        ['messages', { content: 'Skip the desk.' }], ['hint', {}], ['submit', { answer: 'bypass' }], ['branch', { messageId: current.round.messages[0].id }],
      ]) assert.equal((await f.request(`/rounds/${current.round.id}/${generic}`, { method: 'POST', cookie: f.cookie, body })).status, 409);
      const act = async input => {
        const result = await f.request(path + '/action', { method: 'POST', cookie: f.cookie, body: { revision: current.state.revision, ...input } });
        assert.equal(result.status, 200); current = result.body; return result.body;
      };
      const before = await f.request(path + '/context', { cookie: f.cookie });
      assert.equal(before.status, 200);
      assert.equal(before.body.system.includes(world.signatureFact), true);
      assert.equal(before.body.system.includes(world.uvFact), true);
      assert.equal(before.body.observations.includes('arrival card'), false);
      assert.equal(before.body.observations.includes('UV thread'), false);
      await act({ action: 'open' });
      await act({ action: 'card' });
      assert.equal(current.documents.passport.signature, world.scenario.documents.passport.signature);
      assert.equal(current.documents.card.signature, world.scenario.documents.card.signature);
      await act({ action: 'lamp', value: 'uv' });
      const note = current.state.events.at(-1).observation;
      assert.equal(note.includes(world.scenario.uvIntact ? 'intact' : 'broken'), true);
      const reply = await f.request(path + '/messages', { method: 'POST', cookie: f.cookie, body: { content: 'Explain these documents.' } });
      assert.equal(reply.status, 200);
      const sent = f.calls.at(-1);
      assert.equal(sent.system.includes(world.signatureFact), true);
      assert.equal(sent.system.includes(world.uvFact), true);
      assert.equal(sent.system.includes(`signed ${world.scenario.documents.card.signature}`), true);
      assert.equal(sent.system.includes(world.scenario.uvIntact ? 'document is genuine and unaltered' : 'it is broken and the document may have been altered'), true);
      assert.equal(sent.system, (await f.request(path + '/context', { cookie: f.cookie })).body.system);
      assert.equal(reply.body.round.versionId, current.round.versionId);
      assert.equal((await f.request(`/attempts/${current.round.id}`, { cookie: f.cookie })).body.desk.cardRequested, true);
      assert.equal((await f.request(`/levels/reference-passport-study-${id}/rounds`, { method: 'POST', cookie: f.cookie, body: { versionId: current.round.versionId } })).status, 409);
    }
    const normal = await f.request('/reference/start', { method: 'POST', cookie: f.cookie, body: {} });
    assert.equal(normal.status, 201);
    assert.equal((await f.request('/reference/active', { cookie: f.cookie })).body.round.id, normal.body.round.id);
  } finally { await f.close(); }
});

test('production workshop does not register research world routes', async () => {
  const f = await fixture(false);
  try {
    assert.equal((await f.request('/reference/research/match-intact', { cookie: f.cookie })).status, 404);
    assert.equal((await f.request('/reference/research/preview')).status, 404);
    assert.equal((await f.request('/reference/research/preview', { method: 'POST', body: {} })).status, 404);
  }
  finally { await f.close(); }
});

test('isolated blind study preview uses a common route and hides its world version', async () => {
  const f = await fixture(true, 'match-broken');
  try {
    const config = await f.request('/reference/research/preview');
    assert.equal(config.status, 200);
    assert.equal(config.body.documents.card, null);
    assert.equal(JSON.stringify(config.body).includes('match-broken'), false);
    const started = await f.request('/reference/research/preview', { method: 'POST', body: {} });
    assert.equal(started.status, 201);
    assert.equal(started.body.round.versionId, 'reference-passport-study');
    assert.equal(started.body.round.source, 'reference-research-preview');
    const id = started.body.round.id, token = started.body.round.accessToken;
    assert.equal((await f.request(`/rounds/${id}`, { token })).body.versionId, 'reference-passport-study');
    assert.equal((await f.request(`/reference/rounds/${id}`, { token })).body.round.versionId, 'reference-passport-study');
    assert.equal((await f.request(`/reference/rounds/${id}/context`)).status, 401);
    assert.equal((await f.request(`/reference/rounds/${id}/context`, { token })).status, 401);
    const card = await f.request(`/reference/rounds/${id}/action`, { method: 'POST', token, body: { revision: 1, action: 'card' } });
    assert.equal(card.status, 200);
    assert.equal(card.body.documents.card.signature, 'E. Vale');
  } finally { await f.close(); }
});
