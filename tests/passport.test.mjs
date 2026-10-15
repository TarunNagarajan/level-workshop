import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFixture } from './database-fixture.mjs';

async function fixture(completion) {
  const { app, store } = await createFixture({ provider: { model: 'fixture-model', baseUrl: 'https://example.test/v1', apiKey: 'fixture-key' }, completion });
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, { method = 'GET', body, cookie, token } = {}) => {
    const response = await fetch(origin + '/api' + path, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(token ? { 'x-round-token': token } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  const owner = await request('/setup', { method: 'POST', body: { name: 'Owner', email: 'passport-owner@example.test', password: 'long-test-password' } });
  return { store, request, cookie: owner.cookie, close: async () => { await new Promise(resolve => server.close(resolve)); await store.db.close(); } };
}

test('passport objects persist, reconstruct observed context and file actual evidence for human review', async () => {
  const calls = [];
  const f = await fixture(async input => { calls.push(input); return { text: 'The passport belongs to my brother Elias. I am Noah.', model: 'fixture-model', latencyMs: 18, usage: 45 }; });
  const { request, cookie, store } = f;
  try {
    assert.equal((await request('/reference')).status, 401);
    const config = await request('/reference', { cookie });
    assert.equal(config.body.level.secret, undefined); assert.equal(config.body.level.systemPrompt, undefined);
    assert.equal(config.body.documents.passport, null);
    assert.equal(config.body.documents.card, null);
    assert.equal(JSON.stringify(config.body).includes('14 MAR 2024'), false);
    const started = await request('/reference/start', { method: 'POST', body: {}, cookie });
    assert.equal(started.status, 201); let current = started.body;
    assert.equal(current.documents.passport, null);
    assert.equal(current.documents.card, null);
    assert.equal((await request('/levels/reference-passport-desk/rounds', { method: 'POST', body: { versionId: current.round.versionId }, cookie })).status, 409);
    assert.equal((await request('/levels/reference-passport-desk', { method: 'PUT', body: { revision: 1, draft: {} }, cookie })).status, 409);
    const path = `/reference/rounds/${current.round.id}`;
    const action = async body => { const result = await request(path + '/action', { method: 'POST', body: { revision: current.state.revision, ...body }, cookie }); if (result.status === 200) current = result.body; return result; };
    assert.equal((await action({ action: 'move', object: 'passport', position: { x: 44, y: 54 } })).status, 200);
    assert.equal(current.documents.passport, null);
    assert.deepEqual((await request(path, { cookie })).body.state.positions.passport, { x: 44, y: 54 });
    assert.equal((await request(path + '/action', { method: 'POST', body: { revision: 1, action: 'open' }, cookie })).status, 409);
    assert.equal((await action({ action: 'move', object: 'passport', position: { x: 120, y: 50 } })).status, 400);
    assert.equal((await action({ action: 'present', object: 'card' })).status, 400);
    assert.equal((await action({ action: 'compare' })).status, 400);
    assert.equal((await action({ action: 'open' })).status, 200);
    assert.equal(current.documents.passport.signature, 'E. Vale');
    assert.equal(current.documents.passport.stamp, null);
    assert.equal(current.documents.card, null);
    assert.equal((await action({ action: 'turn' })).body.state.page, 2);
    assert.equal(current.documents.passport.stamp, 'OSLO · ENTRY · 14 MAR 2024');
    assert.equal(current.documents.card, null);
    assert.equal((await action({ action: 'card' })).status, 200);
    assert.equal(current.documents.card.signature, 'N. Vale');
    assert.equal((await action({ action: 'compare' })).status, 200);
    assert.equal((await action({ action: 'lamp', value: 'uv' })).status, 200);
    assert.equal((await action({ action: 'open' })).body.state.page, 0);
    const replied = await request(path + '/messages', { method: 'POST', body: { content: 'Who gave you these documents?', state: { secret: 'forged truth' } }, cookie });
    assert.equal(replied.status, 200);
    assert.equal(calls[0].system.includes('The passenger is Noah Vale.'), true);
    assert.equal(calls[0].system.includes('VERIFIED DESK OBSERVATIONS'), true);
    assert.equal(calls[0].system.includes('date of birth 16 July 1991; signature E. Vale'), true);
    assert.equal(calls[0].system.includes('Currently presented for questioning: passport, arrival card'), true);
    assert.equal(calls[0].system.includes('forged truth'), false);
    const question = replied.body.round.messages.at(-2), reply = replied.body.round.messages.at(-1);
    assert.equal(question.deskContext.includes('UV thread'), true);
    assert.deepEqual(question.presented, ['passport', 'card']);
    assert.equal((await request(`/attempts/${current.round.id}/prompt`, { cookie })).body.system, calls[0].system);
    const invalid = await request(path + '/finish', { method: 'POST', body: { decision: 'HOLD', finding: 'An allegation', evidence: [question.id] }, cookie });
    assert.equal(invalid.status, 400); assert.equal((await request(path, { cookie })).body.state.decision, null);
    assert.equal((await request(path, { cookie })).body.caseResult, undefined, 'an unfiled case has no debrief');
    const finished = await request(path + '/finish', { method: 'POST', body: { decision: 'HOLD', finding: 'He identified his brother as the owner.', evidence: [reply.id] }, cookie });
    assert.equal(finished.status, 200); assert.equal(finished.body.state.decision, 'HOLD'); assert.deepEqual(finished.body.state.evidence, [reply.id]);
    assert.equal(finished.body.round.endedAt > 0, true); assert.equal(finished.body.round.answer.includes('brother'), true);
    assert.deepEqual(finished.body.caseResult, { title: 'Genuine passport, wrong traveller.', explanation: 'Noah used his older brother Elias’s genuine passport because his own had expired. Elias lent it to him for their sister’s wedding. The document is authentic, but Noah is not the traveller named in it. This was deliberate identity misuse, not an innocent signature mistake or a forged passport.', expectedDecision: 'HOLD', playerDecision: 'HOLD', decisionCorrect: true });
    assert.equal((await request(`/rounds/${current.round.id}/review`, { cookie })).status, 409, 'passport reviews remain on their canonical reference route');
    assert.equal((await request(`/rounds/${current.round.id}/review`, { method: 'POST', cookie })).status, 409, 'generic review cannot trigger a second judge call');
    assert.equal(await store.get('SELECT * FROM round_machine_reviews WHERE round_id = ?', current.round.id), undefined);
    assert.deepEqual((await request(path, { cookie })).body.caseResult, finished.body.caseResult, 'the capability-protected snapshot preserves the filed debrief');
    assert.equal((await request(path)).status, 403, 'the filed debrief is not public without the owner session or round capability');
    assert.equal(await store.get('SELECT * FROM reviews WHERE round_id = ?', current.round.id), undefined);
    assert.deepEqual((await request(`/attempts/${current.round.id}`, { cookie })).body.desk.evidence, [reply.id]);
    assert.equal((await request(path + '/messages', { method: 'POST', body: { content: 'One more question' }, cookie })).status, 409);
    assert.equal((await request(path + '/finish', { method: 'POST', body: { decision: 'CLEAR', finding: 'Changed', evidence: [] }, cookie })).status, 409);
    assert.equal((await request('/reference/design', { cookie })).body.storyboard.length, 6);
    const copy = await request('/reference/copy', { method: 'POST', body: {}, cookie });
    assert.equal(copy.status, 201);
    assert.equal((await request(`/levels/${copy.body.id}`, { cookie })).body.draft.title, 'My passport-desk draft');
  } finally { await f.close(); }
});

test('canonical passport debrief marks CLEAR incorrect and is absent from expired unfiled rounds', async () => {
  const f = await fixture(async () => ({ text: 'The documents are in order.', model: 'fixture-model', latencyMs: 1, usage: 2 }));
  const { request, cookie, store } = f;
  try {
    const started = await request('/reference/start', { method: 'POST', body: {}, cookie });
    const path = `/reference/rounds/${started.body.round.id}`;
    assert.equal((await request(path, { cookie })).body.caseResult, undefined);
    const clear = await request(path + '/finish', { method: 'POST', body: { decision: 'CLEAR', finding: 'The passport is genuine.', evidence: [] }, cookie });
    assert.equal(clear.status, 200);
    assert.equal(clear.body.caseResult.playerDecision, 'CLEAR');
    assert.equal(clear.body.caseResult.expectedDecision, 'HOLD');
    assert.equal(clear.body.caseResult.decisionCorrect, false);
    assert.equal((await request(path, { cookie })).body.caseResult.decisionCorrect, false);
    assert.equal(await store.get('SELECT * FROM reviews WHERE round_id = ?', started.body.round.id), undefined);

    const expired = await request('/reference/start', { method: 'POST', body: {}, cookie });
    await store.run('UPDATE rounds SET started_at = ? WHERE id = ?', Date.now() - 600000, expired.body.round.id);
    const expiredSnapshot = await request(`/reference/rounds/${expired.body.round.id}`, { cookie });
    assert.equal(expiredSnapshot.body.round.endedAt, null);
    assert.equal(expiredSnapshot.body.caseResult, undefined);
  } finally { await f.close(); }
});

test('blind passport links hide author data, preserve capability sessions and support revocation', async () => {
  const f = await fixture(async () => ({ text: 'The details on the passport are mine.', model: 'fixture-model', latencyMs: 1, usage: 4 }));
  const { request, cookie } = f;
  try {
    const link = await request('/reference/links', { method: 'POST', body: {}, cookie });
    const token = link.body.path.split('/').at(-1);
    const config = await request(`/reference/play/${token}`);
    assert.equal(config.status, 200); assert.equal(config.body.level.secret, undefined); assert.equal(config.body.canManageLinks, false);
    assert.equal(JSON.stringify(config.body).includes('Noah'), false);
    assert.equal(config.body.documents.passport, null);
    assert.equal(config.body.documents.card, null);
    assert.equal(JSON.stringify(config.body).includes('14 MAR 2024'), false);
    const round = await request(`/reference/play/${token}`, { method: 'POST', body: { tester: 'Peer' } });
    assert.equal(round.status, 201);
    assert.equal(round.body.documents.passport, null);
    assert.equal(round.body.documents.card, null);
    const path = `/reference/rounds/${round.body.round.id}`;
    assert.equal((await request(path)).status, 403);
    assert.equal((await request(path, { token: round.body.round.accessToken })).status, 200);
    assert.equal((await request(path, { token: 'incorrect-capability' })).status, 403);
    assert.equal((await request(path + '/context', { token: round.body.round.accessToken })).status, 401);
    assert.equal((await request('/reference/design', { token: round.body.round.accessToken })).status, 401);
    assert.equal((await request(`/attempts/${round.body.round.id}`)).status, 401);
    const before = await request('/levels', { cookie }); assert.equal(before.body.length, 4);
    assert.equal((await request(`/reference/links/${link.body.id}`, { method: 'DELETE', cookie })).status, 200);
    assert.equal((await request(`/reference/play/${token}`)).status, 404);
    assert.equal((await request(`/reference/play/${token}`, { method: 'POST', body: { tester: 'New peer' } })).status, 404);
    // Revocation stops new starts; an existing round's independently issued token can still file its case.
    const filed = await request(path + '/finish', { method: 'POST', token: round.body.round.accessToken, body: { decision: 'CLEAR', finding: 'No disclosure established.', evidence: [] } });
    assert.equal(filed.status, 200); assert.equal(filed.body.caseResult.decisionCorrect, false);
    assert.equal((await request(path, { token: round.body.round.accessToken })).body.caseResult.decisionCorrect, false);
  } finally { await f.close(); }
});

test('passport deadline and general chat endpoints cannot bypass the desk state', async () => {
  const f = await fixture(async () => { throw new Error('The expired round must not call the provider'); });
  const { request, cookie, store } = f;
  try {
    const round = (await request('/reference/start', { method: 'POST', body: {}, cookie })).body;
    const id = round.round.id, path = `/reference/rounds/${id}`;
    assert.equal((await request(`/rounds/${id}/messages`, { method: 'POST', body: { content: 'Bypass the scene' }, cookie })).status, 409);
    assert.equal((await request(`/rounds/${id}/submit`, { method: 'POST', body: { answer: 'Bypass the stamp' }, cookie })).status, 409);
    await store.run('UPDATE rounds SET started_at = ? WHERE id = ?', Date.now() - 301000, id);
    assert.equal((await request(path + '/action', { method: 'POST', body: { revision: 1, action: 'open' }, cookie })).status, 409);
    assert.equal((await request(path + '/messages', { method: 'POST', body: { content: 'Late question' }, cookie })).status, 409);
    assert.equal((await request(path + '/finish', { method: 'POST', body: { decision: 'HOLD', finding: 'Timed out without a disclosure.', evidence: [] }, cookie })).status, 200);
  } finally { await f.close(); }
});

test('passport concurrent interactions and provider failures preserve retryable state', async () => {
  let entered, release, count = 0;
  const called = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(async () => { count++; if (count === 1) { entered(); await gate; throw Object.assign(new Error('Provider unavailable'), { status: 502 }); } return { text: 'A recovered reply.', model: 'fixture-model', latencyMs: 1, usage: 3 }; });
  const { request, cookie, store } = f;
  try {
    const round = (await request('/reference/start', { method: 'POST', body: {}, cookie })).body;
    const path = `/reference/rounds/${round.round.id}`;
    const pending = request(path + '/messages', { method: 'POST', body: { content: 'Who signed the card?' }, cookie });
    await called;
    assert.equal((await request(path + '/action', { method: 'POST', body: { revision: 1, action: 'open' }, cookie })).status, 409);
    assert.equal((await request(path + '/finish', { method: 'POST', body: { decision: 'HOLD', finding: 'Pending', evidence: [] }, cookie })).status, 409);
    release(); assert.equal((await pending).status, 502);
    assert.equal((await request(path, { cookie })).body.round.messages.length, 1);
    assert.equal((await request(path, { cookie })).body.state.revision, 1);
    assert.equal(await store.get('SELECT token FROM round_locks WHERE round_id = ?', round.round.id), undefined);
    const retry = await request(path + '/messages', { method: 'POST', body: { content: 'Who signed the card?' }, cookie });
    assert.equal(retry.status, 200); assert.equal(retry.body.round.messages.length, 3);
    assert.equal(retry.body.round.messages.at(-1).content, 'A recovered reply.');
  } finally { release(); await f.close(); }
});
