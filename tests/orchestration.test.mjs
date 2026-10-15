import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createFixture } from './database-fixture.mjs';

test('orchestration receipt recovery bypasses the new-turn limit without invoking the model twice', async () => {
  let calls = 0;
  const { app, store } = await createFixture({
    provider: { model: 'fixture-model', baseUrl: 'https://example.test/v1', apiKey: 'fixture-key' },
    completion: async () => { calls++; return { text: 'The final reply.', model: 'fixture-model', latencyMs: 6, usage: 3 }; },
  });
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, { method = 'GET', body, cookie } = {}) => {
    const response = await fetch(origin + '/api' + path, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  try {
    const owner = await request('/setup', { method: 'POST', body: { name: 'Owner', email: 'receipt-limit@example.test', password: 'long-test-password' } });
    const config = await request('/orchestration/configs', { method: 'POST', body: {}, cookie: owner.cookie });
    const run = await request(`/orchestration/configs/${config.body.id}/runs`, { method: 'POST', body: { testInput: 'Test the final allowed turn.' }, cookie: owner.cookie });
    const priorTurns = Array.from({ length: 19 }, (_, index) => ({ id: randomUUID(), lane: 'A', role: 'user', content: `Prior question ${index + 1}`, createdAt: Date.now() }));
    await store.run('UPDATE orchestration_runs SET messages=? WHERE id=?', JSON.stringify(priorTurns), run.body.id);
    const submission = { lane: 'A', content: 'The twentieth and final question.', requestId: randomUUID() };
    const first = await request(`/orchestration/runs/${run.body.id}/messages`, { method: 'POST', body: submission, cookie: owner.cookie });
    assert.equal(first.status, 200);
    assert.equal(calls, 1);
    const journalEntry = await store.get('SELECT id,status,transcript_saved FROM durable_submissions WHERE orchestration_run_id=? AND client_request_id=?', run.body.id, submission.requestId);
    assert.equal(journalEntry.status, 'succeeded');
    assert.equal(journalEntry.transcript_saved, 1);

    const recovered = await request(`/orchestration/runs/${run.body.id}/messages`, { method: 'POST', body: submission, cookie: owner.cookie });
    assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
    assert.equal(recovered.body.submissionId, journalEntry.id);
    assert.equal(calls, 1, 'receipt recovery must not invoke the model a second time');
    assert.equal((await store.all('SELECT id FROM durable_submissions WHERE orchestration_run_id=? AND client_request_id=?', run.body.id, submission.requestId)).length, 1);
  } finally { await new Promise(resolve => server.close(resolve)); await store.db.close(); }
});

test('orchestration lab keeps prompt versions, tests and deliberate handoffs separate', async () => {
  const calls = [];
  const { app, store } = await createFixture({ provider: { model: 'fixture-model', baseUrl: 'https://example.test/v1', apiKey: 'fixture-key' }, completion: async input => {
    calls.push(input); return { text: `Reply ${calls.length}`, model: 'fixture-model', latencyMs: 18, usage: 45 };
  } });
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, { method = 'GET', body, cookie } = {}) => {
    const response = await fetch(origin + '/api' + path, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  try {
    assert.equal((await request('/orchestration/configs')).status, 401);
    const owner = await request('/setup', { method: 'POST', body: { name: 'Owner', email: 'orchestration-owner@example.test', password: 'long-test-password' } });
    const cookie = owner.cookie;
    const created = await request('/orchestration/configs', { method: 'POST', body: {}, cookie });
    assert.equal(created.status, 201);
    const configId = created.body.id;
    const draft = { ...created.body.draft, title: 'Dispatch test', task: 'Choose a route, vehicle and authorization.', slots: created.body.draft.slots.map((slot, index) => ({ ...slot, name: ['Map', 'Fleet', 'Permit'][index], systemPrompt: `Private instruction ${slot.id}` })) };
    assert.equal((await request(`/orchestration/configs/${configId}`, { method: 'PUT', body: { revision: created.body.revision, draft }, cookie })).status, 200);
    assert.equal((await request(`/orchestration/configs/${configId}`, { method: 'PUT', body: { revision: created.body.revision, draft }, cookie })).status, 409);
    const version = await request(`/orchestration/configs/${configId}/versions`, { method: 'POST', body: { revision: 2, note: 'Original prompts' }, cookie });
    assert.equal(version.status, 200);
    const changed = { ...draft, slots: [{ ...draft.slots[0], systemPrompt: 'A new prompt' }, draft.slots[1], draft.slots[2]] };
    assert.equal((await request(`/orchestration/configs/${configId}`, { method: 'PUT', body: { revision: 2, draft: changed }, cookie })).status, 200);
    const original = await request(`/orchestration/configs/${configId}/runs`, { method: 'POST', body: { testInput: 'Close road 7.', versionId: version.body.versionId }, cookie });
    const current = await request(`/orchestration/configs/${configId}/runs`, { method: 'POST', body: { testInput: 'Close road 7.' }, cookie });
    assert.equal(original.status, 201); assert.equal(current.status, 201);
    assert.equal(original.body.snapshot.slots[0].systemPrompt, 'Private instruction A');
    assert.equal(current.body.snapshot.slots[0].systemPrompt, 'A new prompt');
    const runId = original.body.id;
    const answerA = await request(`/orchestration/runs/${runId}/messages`, { method: 'POST', body: { lane: 'A', content: 'Which road is open?' }, cookie });
    assert.equal(answerA.status, 200); assert.equal(calls[0].system, 'Private instruction A');
    assert.equal(calls[0].messages[0].content.includes('Close road 7.'), true);
    const replyId = answerA.body.messages[1].id;
    assert.equal((await request(`/orchestration/runs/${runId}/board`, { method: 'POST', body: { messageId: 'made-up', targets: ['B'] }, cookie })).status, 400);
    const shared = await request(`/orchestration/runs/${runId}/board`, { method: 'POST', body: { messageId: replyId, targets: ['B'] }, cookie });
    assert.equal(shared.status, 200); assert.equal(shared.body.board.length, 1);
    const answerB = await request(`/orchestration/runs/${runId}/messages`, { method: 'POST', body: { lane: 'B', content: 'Which vehicle?' }, cookie });
    assert.equal(answerB.status, 200);
    assert.equal(calls[1].system, 'Private instruction B');
    assert.deepEqual(calls[1].messages, [
      { role: 'user', content: 'Shared task: Choose a route, vehicle and authorization.\n\nTest case: Close road 7.' },
      { role: 'user', content: 'Shared finding from A: Reply 1' },
      { role: 'user', content: 'Which vehicle?' },
    ]);
    assert.equal(calls[1].messages.some(message => message.content.includes('Shared finding from A: Reply 1')), true);
    assert.equal(calls[1].messages.some(message => message.content.includes('Private instruction A')), false);
    assert.equal(answerB.body.messages.at(-1).context.messages.some(message => message.content.includes('Shared finding from A: Reply 1')), true);
    assert.equal((await request(`/orchestration/runs/${runId}` , { cookie })).body.board[0].from, 'A');
    const invitation = await request('/invites', { method: 'POST', body: {}, cookie });
    const editor = await request(`/invite/${invitation.body.path.split('/')[2]}`, { method: 'POST', body: { name: 'Colleague', email: 'orchestration-editor@example.test', password: 'long-editor-password' } });
    assert.equal((await request(`/orchestration/configs/${configId}`, { method: 'PUT', body: { revision: 3, draft }, cookie: editor.cookie })).status, 403);
    assert.equal((await request(`/orchestration/runs/${runId}/messages`, { method: 'POST', body: { lane: 'C', content: 'Try to change this run' }, cookie: editor.cookie })).status, 403);
    assert.equal((await request(`/orchestration/runs/${runId}/board`, { method: 'POST', body: { messageId: replyId, targets: ['C'] }, cookie: editor.cookie })).status, 403);
    await store.run('INSERT INTO orchestration_locks VALUES (?, ?, ?)', runId, 'other-worker', Date.now() + 45000);
    assert.equal((await request(`/orchestration/runs/${runId}/messages`, { method: 'POST', body: { lane: 'C', content: 'A blocked question' }, cookie })).status, 409);
    await store.run('UPDATE orchestration_locks SET expires = ? WHERE run_id = ?', Date.now() - 1, runId);
    assert.equal((await request(`/orchestration/runs/${runId}/messages`, { method: 'POST', body: { lane: 'C', content: 'A recovered question' }, cookie })).status, 200);
    const runs = await request(`/orchestration/configs/${configId}/runs`, { cookie });
    assert.equal(runs.body.length, 2);
  } finally { await new Promise(resolve => server.close(resolve)); await store.db.close(); }
});

test('overlapping requests and a provider outage leave a run retryable', async () => {
  let beginCall, releaseCall;
  const entered = new Promise(resolve => { beginCall = resolve; });
  const gate = new Promise(resolve => { releaseCall = resolve; });
  let calls = 0;
  const { app, store } = await createFixture({
    provider: { model: 'fixture-model', baseUrl: 'https://example.test/v1', apiKey: 'fixture-key' },
    completion: async () => {
      calls += 1;
      if (calls === 1) { beginCall(); await gate; throw Object.assign(new Error('Provider outage'), { status: 502 }); }
      return { text: 'Recovered reply', model: 'fixture-model', latencyMs: 5, usage: 4 };
    },
  });
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, method = 'GET', body, cookie) => {
    const response = await fetch(origin + '/api' + path, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  try {
    const owner = await request('/setup', 'POST', { name: 'Owner', email: 'outage@example.test', password: 'long-test-password' });
    const config = await request('/orchestration/configs', 'POST', {}, owner.cookie);
    const testRun = await request(`/orchestration/configs/${config.body.id}/runs`, 'POST', { testInput: 'A synthetic case' }, owner.cookie);
    const path = `/orchestration/runs/${testRun.body.id}`;
    const first = request(`${path}/messages`, 'POST', { lane: 'A', content: 'First question' }, owner.cookie);
    await entered;
    assert.equal((await request(`${path}/messages`, 'POST', { lane: 'B', content: 'Overlapping question' }, owner.cookie)).status, 409);
    assert.equal((await request(`${path}/board`, 'POST', { messageId: 'unknown', targets: ['B'] }, owner.cookie)).status, 409);
    releaseCall();
    assert.equal((await first).status, 502);
    assert.deepEqual((await request(path, 'GET', undefined, owner.cookie)).body.messages, []);
    assert.equal(await store.get('SELECT token FROM orchestration_locks WHERE run_id = ?', testRun.body.id), undefined);
    const retry = await request(`${path}/messages`, 'POST', { lane: 'A', content: 'First question' }, owner.cookie);
    assert.equal(retry.status, 200);
    assert.equal(retry.body.messages.length, 2);
    assert.equal(retry.body.messages[1].content, 'Recovered reply');
  } finally {
    releaseCall?.();
    await new Promise(resolve => server.close(resolve)); await store.db.close();
  }
});
