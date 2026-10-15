import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFixture } from './database-fixture.mjs';
import { openStore } from '../server/store.mjs';
import { createWorkshop } from '../server/workshop.mjs';

test('durable submissions capture before provider, preserve errors, deduplicate requests and enforce recording consent', async () => {
  let calls = 0, failNext = false;
  const { app, store } = await createFixture({ recordingNoticeRequired: true, provider: { model: 'fixture', baseUrl: 'https://example.test/v1', apiKey: 'fixture' }, completion: async input => {
    calls++;
    if (failNext) { failNext = false; throw Object.assign(new Error('provider outage'), { status: 429, providerCode: 'rate_limited' }); }
    return { text: 'A reply from the target.', model: input.config.model, latencyMs: 3, usage: 1 };
  } });
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}/api`;
  const request = async (path, { method = 'GET', body, cookie, token } = {}) => {
    const response = await fetch(origin + path, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(token ? { 'x-round-token': token } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  try {
    const setup = await request('/setup', { method: 'POST', body: { name: 'Owner', email: 'journal@example.test', password: 'long-test-password' } });
    const cookie = setup.cookie;
    assert.equal((await request('/bootstrap', { cookie })).body.recordingAccepted, false);
    assert.equal((await request('/bootstrap', { cookie })).body.recordingNoticeRequired, true);
    const levels = await request('/levels', { cookie });
    const detail = await request(`/levels/${levels.body[0].id}`, { cookie });
    assert.equal((await request(`/levels/${detail.body.id}/rounds`, { method: 'POST', body: { versionId: detail.body.versions[0].id }, cookie })).status, 428);
    assert.equal(calls, 0);
    assert.deepEqual((await request('/recording/acknowledge', { method: 'POST', body: { version: 'recording-notice-v1', accepted: true }, cookie })).body, { accepted: true, version: 'recording-notice-v1' });
    const round = await request(`/levels/${detail.body.id}/rounds`, { method: 'POST', body: { versionId: detail.body.versions[0].id }, cookie });
    const requestId = '22222222-2222-4222-8222-222222222222';
    const accepted = await request(`/rounds/${round.body.id}/messages`, { method: 'POST', body: { content: 'What did you say?', requestId }, cookie });
    assert.equal(accepted.status, 200); assert.ok(accepted.body.submissionId);
    const duplicate = await request(`/rounds/${round.body.id}/messages`, { method: 'POST', body: { content: 'What did you say?', requestId }, cookie });
    assert.equal(duplicate.status, 200); assert.equal(calls, 1);
    assert.equal((await request(`/rounds/${round.body.id}/messages`, { method: 'POST', body: { content: 'Different prompt', requestId }, cookie })).status, 409);
    const journal = await request('/submissions?limit=1', { cookie });
    assert.equal(journal.status, 200); assert.equal(journal.body.items[0].content, 'What did you say?');
    assert.equal(journal.body.items[0].reply, 'A reply from the target.');
    assert.equal(journal.body.items[0].transcriptSaved, true);
    assert.equal((await request('/submissions', { auth: null })).status, 401);

    failNext = true;
    const failed = await request(`/rounds/${round.body.id}/messages`, { method: 'POST', body: { content: 'Keep this when the model fails', requestId: '33333333-3333-4333-8333-333333333333' }, cookie });
    assert.equal(failed.status, 429); assert.equal(failed.body.submissionStatus, 'failed'); assert.equal(failed.body.receiptConfirmed, true);
    const savedFailure = await store.get('SELECT status, content, error_code FROM durable_submissions WHERE id = ?', failed.body.submissionId);
    assert.deepEqual({ ...savedFailure }, { status: 'failed', content: 'Keep this when the model fails', error_code: 'rate_limited' });
    const unauthorized = await request(`/rounds/${round.body.id}/messages`, { method: 'POST', auth: null, body: { content: 'Do not record this', requestId: '44444444-4444-4444-8444-444444444444' } });
    assert.equal(unauthorized.status, 403);
    assert.equal(await store.get('SELECT id FROM durable_submissions WHERE client_request_id = ?', '44444444-4444-4444-8444-444444444444'), undefined);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await store.db.close();
  }
});

test('anonymous round consent is persisted and required again for existing rounds', async () => {
  const { app, store } = await createFixture({ recordingNoticeRequired: true, provider: { model: 'fixture', baseUrl: 'https://example.test/v1', apiKey: 'fixture' }, completion: async input => ({ text: 'Reply', model: input.config.model, latencyMs: 1, usage: 1 }) });
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}/api`;
  const request = async (path, { method = 'GET', body, cookie, token } = {}) => {
    const response = await fetch(origin + path, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(token ? { 'x-round-token': token } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  try {
    const owner = await request('/setup', { method: 'POST', body: { name: 'Owner', email: 'consent@example.test', password: 'long-test-password' } });
    const cookie = owner.cookie, levels = await request('/levels', { cookie }), detail = await request(`/levels/${levels.body[0].id}`, { cookie });
    const link = await request(`/levels/${detail.body.id}/links`, { method: 'POST', body: { versionId: detail.body.versions[0].id }, cookie });
    const token = link.body.path.split('/')[2];
    assert.equal((await request(`/play/${token}`, { method: 'POST', auth: null, body: { tester: 'Anonymous' } })).status, 428);
    const started = await request(`/play/${token}`, { method: 'POST', auth: null, body: { tester: 'Anonymous', consent: true } });
    assert.equal(started.status, 201);
    assert.deepEqual((await request(`/rounds/${started.body.id}/recording`, { auth: null, token: started.body.accessToken })).body, { accepted: true, version: 'recording-notice-v1' });
    await store.run('UPDATE rounds SET recording_accepted_at = NULL, recording_notice_version = NULL WHERE id = ?', started.body.id);
    assert.equal((await request(`/rounds/${started.body.id}/messages`, { method: 'POST', auth: null, token: started.body.accessToken, body: { content: 'Before resumed consent', requestId: '55555555-5555-4555-8555-555555555555' } })).status, 428);
    assert.deepEqual((await request(`/rounds/${started.body.id}/recording`, { method: 'POST', auth: null, token: started.body.accessToken, body: { version: 'recording-notice-v1', accepted: true } })).body, { accepted: true, version: 'recording-notice-v1' });
  } finally {
    await new Promise(resolve => server.close(resolve));
    await store.db.close();
  }
});

test('database uniqueness captures lock contention, prevents cross-instance duplicate calls, and preserves a reply if transcript save fails', async () => {
  const store = openStore(':memory:'); let callCount = 0, releaseFirst, startedFirst;
  const firstStarted = new Promise(resolve => { startedFirst = resolve; });
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  const completion = async input => {
    callCount++;
    if (callCount === 1) {
      const captured = store.get('SELECT content,status FROM durable_submissions WHERE client_request_id = ?', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
      assert.equal(captured.content, 'Same request delivered once.'); assert.equal(captured.status, 'running');
      startedFirst(); await firstGate;
    }
    return { text: `Target reply ${callCount}.`, model: input.config.model, latencyMs: 2, usage: 1 };
  };
  const options = { store, recordingNoticeRequired: true, provider: { model: 'fixture', baseUrl: 'https://example.test/v1', apiKey: 'fixture' }, completion };
  const first = createWorkshop(options), second = createWorkshop(options);
  const servers = [first.app.listen(0, '127.0.0.1'), second.app.listen(0, '127.0.0.1')];
  await Promise.all(servers.map(server => new Promise(resolve => server.once('listening', resolve))));
  const origins = servers.map(server => `http://127.0.0.1:${server.address().port}/api`);
  const request = async (index, path, { method = 'GET', body, cookie, token } = {}) => {
    const response = await fetch(origins[index] + path, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(token ? { 'x-round-token': token } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  try {
    const owner = await request(0, '/setup', { method: 'POST', body: { name: 'Owner', email: 'cross-instance@example.test', password: 'long-test-password' } });
    const cookie = owner.cookie;
    await request(0, '/recording/acknowledge', { method: 'POST', cookie, body: { version: 'recording-notice-v1', accepted: true } });
    const levels = await request(0, '/levels', { cookie }), detail = await request(0, `/levels/${levels.body[0].id}`, { cookie });
    const round = await request(0, `/levels/${detail.body.id}/rounds`, { method: 'POST', cookie, body: { versionId: detail.body.versions[0].id } });
    const firstRequest = request(0, `/rounds/${round.body.id}/messages`, { method: 'POST', cookie, body: { content: 'Same request delivered once.', requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } });
    await firstStarted;
    const duplicate = await request(1, `/rounds/${round.body.id}/messages`, { method: 'POST', cookie, body: { content: 'Same request delivered once.', requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } });
    assert.equal(duplicate.status, 409); assert.equal(duplicate.body.submissionStatus, 'running');
    const contended = await request(1, `/rounds/${round.body.id}/messages`, { method: 'POST', cookie, body: { content: 'Separate valid question during lock contention.', requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' } });
    assert.equal(contended.status, 409); assert.equal(contended.body.submissionStatus, 'rejected');
    releaseFirst();
    const completed = await firstRequest;
    assert.equal(completed.status, 200); assert.equal(callCount, 1);
    assert.equal((await store.get('SELECT content FROM durable_submissions WHERE client_request_id = ?', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')).content, 'Separate valid question during lock contention.');

    await store.db.exec("CREATE TRIGGER force_transcript_failure BEFORE UPDATE OF messages ON rounds BEGIN SELECT RAISE(ABORT, 'test save failure'); END");
    const lostSave = await request(0, `/rounds/${round.body.id}/messages`, { method: 'POST', cookie, body: { content: 'Reply remains in journal.', requestId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' } });
    assert.equal(lostSave.status, 409); assert.equal(lostSave.body.submissionStatus, 'succeeded'); assert.equal(lostSave.body.receiptConfirmed, true);
    const persistedReply = await store.get('SELECT reply, transcript_saved FROM durable_submissions WHERE id = ?', lostSave.body.submissionId);
    assert.equal(persistedReply.reply, 'Target reply 2.'); assert.equal(persistedReply.transcript_saved, 0);
    await store.db.exec('DROP TRIGGER force_transcript_failure');

    await store.run("INSERT INTO durable_submissions (id,client_request_id,scope_key,round_id,content,created_at,status) VALUES (?,?,?,?,?,?,?)", 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', `round:${round.body.id}`, round.body.id, 'Was running when process stopped.', Date.now() - 180000, 'running');
    const ownerPage = await request(0, '/submissions?limit=2', { cookie });
    assert.equal(ownerPage.status, 200); assert.ok(ownerPage.body.nextCursor);
    const allItems = [...ownerPage.body.items]; let cursor = ownerPage.body.nextCursor;
    while (cursor) {
      const page = await request(1, `/submissions?limit=2&cursor=${encodeURIComponent(cursor)}`, { cookie });
      allItems.push(...page.body.items); cursor = page.body.nextCursor;
    }
    assert.ok(allItems.some(item => item.id === 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' && item.status === 'interrupted'));
    assert.ok(allItems.some(item => item.id === lostSave.body.submissionId && item.reply === 'Target reply 2.' && item.transcriptSaved === false));
    assert.equal(new Set(allItems.map(item => item.id)).size, allItems.length);
    const invitation = await request(0, '/invites', { method: 'POST', cookie, body: {} });
    const editorToken = invitation.body.path.split('/')[2];
    const editor = await request(0, `/invite/${editorToken}`, { method: 'POST', body: { name: 'Editor', email: 'journal-editor@example.test', password: 'long-test-password' } });
    assert.equal((await request(1, '/submissions', { cookie: editor.cookie })).status, 403);
  } finally {
    releaseFirst();
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
    await store.db.close();
  }
});


test('logged-in standalone participant consent persists globally and round consent remains sufficient for its messages', async () => {
  const { app, store } = await createFixture({ recordingNoticeRequired: true, metricsEnabled: true, provider: { model: 'fixture', baseUrl: 'https://example.test/v1', apiKey: 'fixture' }, completion: async input => ({ text: 'Reply', model: input.config.model, latencyMs: 1, usage: 1 }) });
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}/api`;
  const request = async (path, { method = 'GET', body, cookie, token } = {}) => {
    const response = await fetch(origin + path, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(token ? { 'x-round-token': token } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  try {
    const owner = await request('/setup', { method: 'POST', body: { name: 'Visitor', email: 'visitor@example.test', password: 'long-test-password' } });
    const cookie = owner.cookie;
    assert.equal((await request('/telemetry/session', { method: 'POST', cookie })).status, 428);
    const levels = await request('/levels', { cookie }), detail = await request(`/levels/${levels.body[0].id}`, { cookie });
    const link = await request(`/levels/${detail.body.id}/links`, { method: 'POST', body: { versionId: detail.body.versions[0].id }, cookie });
    const raw = link.body.path.split('/').at(-1);
    const started = await request(`/play/${raw}`, { method: 'POST', cookie, body: { tester: 'Visitor', consent: true } });
    assert.equal(started.status, 201);
    assert.ok(await store.get('SELECT user_id FROM user_recording_acknowledgements WHERE user_id = ? AND version = ?', owner.body.user.id, 'recording-notice-v1'));
    await store.run('DELETE FROM user_recording_acknowledgements WHERE user_id = ?', owner.body.user.id);
    const response = await request(`/rounds/${started.body.id}/messages`, { method: 'POST', cookie, token: started.body.accessToken, body: { content: 'Question after standalone consent', requestId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' } });
    assert.equal(response.status, 200, 'round-bound consent remains valid for this participant session');
    assert.equal((await request('/telemetry/session', { method: 'POST', cookie })).status, 428, 'deleting the global acknowledgement does not affect standalone round authorization');
  } finally {
    await new Promise(resolve => server.close(resolve));
    await store.db.close();
  }
});
