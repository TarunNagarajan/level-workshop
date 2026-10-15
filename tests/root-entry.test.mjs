import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFixture } from './database-fixture.mjs';

const ownerKey = 'root-entry-owner-capability';
const sharingKey = 'root-entry-sharing-capability';
const provider = { model: 'private-test-model', baseUrl: 'https://private-provider.example.test/v1', apiKey: 'private-test-key' };

async function start(adapter, options = {}) {
  const fixture = await createFixture({ adapter, dbPath: ':memory:', provider, ...options });
  const server = fixture.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const request = async (path, { method = 'GET', body, cookie, origin } = {}) => {
    const response = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(origin ? { Origin: origin } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  return {
    ...fixture,
    request,
    async close() {
      await new Promise(resolve => server.close(resolve));
      await fixture.store.db.close();
    },
  };
}

async function createOwner(request) {
  const created = await request(`/owner/${ownerKey}`, { method: 'POST', body: { name: 'Workshop owner' } });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal(created.body.user.role, 'admin');
  return created;
}

test('root name-only admission stays opt-in and fails closed across SQLite and PGlite', async t => {
  for (const adapter of ['sqlite', 'pglite']) await t.test(adapter, async () => {
    const fixture = await start(adapter, { rootEntry: false, ownerKey, sharingKey });
    try {
      const beforeOwner = await fixture.request('/bootstrap');
      assert.equal(beforeOwner.body.rootEntry, false);
      assert.equal((await fixture.request('/setup', { method: 'POST', body: {} })).status, 403);
      assert.equal((await fixture.request('/entry')).status, 404);
      const owner = await createOwner(fixture.request);
      assert.equal((await fixture.request('/bootstrap')).body.rootEntry, false);
      assert.equal((await fixture.request('/entry', { method: 'POST', body: { name: 'Visitor' } })).status, 404);
      assert.equal((await fixture.request('/levels', { cookie: owner.cookie })).status, 200);
    } finally { await fixture.close(); }
  });
});

test('configured root entry creates isolated editor sessions without exposing owner or sharing credentials', async t => {
  for (const adapter of ['sqlite', 'pglite']) await t.test(adapter, async () => {
    const fixture = await start(adapter, { rootEntry: true, ownerKey });
    try {
      const anonymousBeforeOwner = await fixture.request('/bootstrap');
      assert.equal(anonymousBeforeOwner.body.rootEntry, false);
      assert.equal((await fixture.request('/entry')).status, 404);
      assert.equal((await fixture.request('/levels')).status, 401);
      assert.equal((await fixture.request('/team')).status, 401);
      assert.equal((await fixture.request('/setup', { method: 'POST', body: { name: 'Claimant', email: 'claimant@example.test', password: 'long-test-password' } })).status, 403);

      const owner = await createOwner(fixture.request);
      const anonymous = await fixture.request('/bootstrap');
      assert.equal(anonymous.body.rootEntry, true);
      assert.equal(anonymous.body.needsSetup, false);
      assert.equal(anonymous.body.user, null);
      assert.equal(anonymous.body.model.connected, true);
      assert.equal('model' in anonymous.body.model, false);
      assert.equal('provider' in anonymous.body.model, false);
      const bootstrapText = JSON.stringify(anonymous.body);
      for (const secret of [ownerKey, sharingKey, provider.apiKey, provider.model, 'private-provider.example.test']) assert.equal(bootstrapText.includes(secret), false);

      const readiness = await fixture.request('/entry');
      assert.deepEqual(readiness.body, { role: 'editor', ready: true });
      const listed = await fixture.request('/workshop-links', { cookie: owner.cookie });
      const rootLink = listed.body.find(link => link.id === 'root-workshop-entry');
      assert.ok(rootLink);
      assert.deepEqual(rootLink && { rootEntry: rootLink.rootEntry, enabled: rootLink.enabled, path: rootLink.path }, { rootEntry: true, enabled: true, path: '/' });
      assert.equal('expires' in rootLink, false);
      assert.equal('token' in rootLink, false);
      assert.equal((await fixture.store.get('SELECT expires FROM workshop_links WHERE id = ?', 'root-workshop-entry')).expires, Number.MAX_SAFE_INTEGER);
      const malformed = await fixture.request('/entry', { method: 'POST', body: { name: 'Valid name', role: 'admin' } });
      assert.equal(malformed.status, 400);

      const first = await fixture.request('/entry', { method: 'POST', body: { name: 'Workshop owner' } });
      const second = await fixture.request('/entry', { method: 'POST', body: { name: 'Workshop owner' } });
      assert.equal(first.status, 200); assert.equal(second.status, 200);
      assert.equal(first.body.user.role, 'editor'); assert.equal(second.body.user.role, 'editor');
      assert.notEqual(first.body.user.id, owner.body.user.id);
      assert.notEqual(first.body.user.id, second.body.user.id);
      assert.match(first.cookie, /^workshop=/);
      assert.equal((await fixture.request('/bootstrap', { cookie: first.cookie })).body.user.id, first.body.user.id);
      assert.equal((await fixture.request('/levels', { cookie: first.cookie })).status, 200);
      assert.equal((await fixture.request('/team', { cookie: first.cookie })).status, 200);
      assert.equal((await fixture.request('/workshop-links', { cookie: first.cookie })).status, 403);
      const resumed = await fixture.request('/entry', { method: 'POST', cookie: first.cookie, body: { name: 'Ignored name' } });
      assert.equal(resumed.body.user.id, first.body.user.id);
      assert.equal(resumed.body.user.name, first.body.user.name);
      assert.equal((await fixture.request('/levels', { cookie: owner.cookie })).status, 200);
      assert.equal((await fixture.store.get("SELECT COUNT(*) AS count FROM users WHERE role = 'admin'")).count, 1);

      assert.equal((await fixture.request('/entry', { method: 'PUT', body: { enabled: false } })).status, 401);
      assert.equal((await fixture.request('/entry', { method: 'PUT', cookie: first.cookie, body: { enabled: false } })).status, 403);
      assert.deepEqual((await fixture.request('/entry', { method: 'PUT', cookie: owner.cookie, body: { enabled: false } })).body, { enabled: false });
      assert.equal((await fixture.request('/bootstrap', { cookie: first.cookie })).body.user, null);
      const pausedGet = await fixture.request('/entry');
      const pausedPost = await fixture.request('/entry', { method: 'POST', body: { name: 'Paused visitor' } });
      assert.equal(pausedGet.status, 404); assert.match(pausedGet.body.error, /paused/i);
      assert.equal(pausedPost.status, 404); assert.match(pausedPost.body.error, /paused/i);
      assert.equal((await fixture.request('/entry', { method: 'PUT', cookie: first.cookie, body: { enabled: true } })).status, 401);
      assert.equal((await fixture.request('/entry', { method: 'PUT', cookie: owner.cookie, body: { enabled: true } })).body.enabled, true);
      assert.equal((await fixture.request('/bootstrap', { cookie: first.cookie })).body.user, null, 'paused sessions stay invalid after reopening');
      const newSession = await fixture.request('/entry', { method: 'POST', body: { name: 'Workshop owner' } });
      assert.equal(newSession.body.user.role, 'editor');
      assert.notEqual(newSession.body.user.id, first.body.user.id);
    } finally { await fixture.close(); }
  });
});

test('root entry persists until explicitly paused and reads do not reopen it across SQLite and PGlite', async t => {
  for (const adapter of ['sqlite', 'pglite']) {
    await t.test(adapter, async () => {
      const fixture = await start(adapter, { rootEntry: true, ownerKey });
      try {
        const owner = await createOwner(fixture.request);
        assert.equal((await fixture.request('/entry')).status, 200);
        await fixture.request('/entry', { method: 'PUT', cookie: owner.cookie, body: { enabled: false } });
        const pausedLink = await fixture.store.get('SELECT revoked, expires FROM workshop_links WHERE id = ?', 'root-workshop-entry');
        assert.equal(pausedLink.revoked, 1);
        assert.equal(pausedLink.expires, Number.MAX_SAFE_INTEGER);
        const paused = await fixture.request('/entry');
        assert.equal(paused.status, 404); assert.match(paused.body.error, /paused/i);
        await fixture.request('/bootstrap');
        assert.equal((await fixture.store.get('SELECT revoked FROM workshop_links WHERE id = ?', 'root-workshop-entry')).revoked, 1, 'bootstrap reads do not reactivate the root link');
        assert.equal((await fixture.request('/entry', { method: 'PUT', body: { enabled: true } })).status, 401);
        assert.equal((await fixture.request('/entry', { method: 'PUT', cookie: owner.cookie, body: { enabled: true } })).body.enabled, true);
        assert.equal((await fixture.request('/entry')).status, 200);
      } finally { await fixture.close(); }
    });
  }
});
