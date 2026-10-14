import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFixture } from './database-fixture.mjs';

test('successful invitation entries from one network do not exhaust the failed-attempt budget', async () => {
  const { app, store } = await createFixture({ provider: { model: 'fixture-model', baseUrl: 'https://example.test/v1', apiKey: 'fixture-key' } });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function request(path, body, cookie) {
    const response = await fetch(origin + '/api' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  try {
    const owner = await request('/setup', { name: 'Owner', email: 'throttle@example.test', password: 'long-test-password' });
    assert.equal(owner.status, 200);
    const link = await request('/workshop-links', {}, owner.cookie);
    assert.equal(link.status, 200);
    for (let index = 0; index < 16; index++) {
      const entered = await request(link.body.path, { name: `Colleague ${index}` });
      assert.equal(entered.status, 200);
      assert.equal(entered.body.user.name, `Colleague ${index}`);
    }
    for (let index = 0; index < 12; index++) {
      const failed = await request('/login', { email: 'throttle@example.test', password: 'wrong-password' });
      assert.equal(failed.status, 401);
    }
    assert.equal((await request('/login', { email: 'throttle@example.test', password: 'wrong-password' })).status, 429);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await store.db.close();
  }
});
