import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createFixture } from './database-fixture.mjs';
import { ensureInception } from '../server/inception.mjs';

const ownerKey = 'statistics-owner-key-fixture';
const hash = value => createHash('sha256').update(value).digest('hex');

async function harness(adapter) {
  const fixture = await createFixture({ adapter, dbPath: ':memory:', ownerKey, metricsEnabled: true, provider: { model: 'fixture-model', baseUrl: 'https://api.groq.com/openai/v1', apiKey: 'never-return-this-provider-key' }, completion: async () => { throw new Error('Statistics routes must not invoke a model.'); } });
  const server = fixture.app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}/api`;
  const request = async (path, { method = 'GET', body, cookie, originHeader } = {}) => {
    const response = await fetch(origin + path, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(originHeader ? { Origin: originHeader } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  const created = await request(`/owner/${ownerKey}`, { method: 'POST', body: { name: 'Workshop owner' } });
  assert.equal(created.status, 200);
  const inceptionVersion = (await ensureInception(fixture.store))[0];
  const now = Date.now();
  const insertAttempt = async ({ name, actorId = randomUUID(), startedAt = now - 60_000, endedAt = startedAt + 20_000, verdict = 'recovered', reviewStatus = 'complete', finished = true, safeOpened = true, content = 'What should I ask?', includeReveal = true, firstPlayerText = null } = {}) => {
    await fixture.store.run('INSERT INTO users (id,name,email,password,role,created_at) VALUES (?,?,?,?,?,?)', actorId, name, `${actorId}@test.invalid`, 'link-only', 'inception_participant', now);
    const id = randomUUID();
    const userText = firstPlayerText ?? content;
    const messages = [{ id: randomUUID(), role: 'assistant', content: 'Opening line', createdAt: startedAt, opening: true }, { id: randomUUID(), role: 'user', content: userText, createdAt: startedAt + 2000 }];
    let evidence = [];
    if (includeReveal) { const reply = { id: randomUUID(), role: 'assistant', content: 'The safe opens with 528491.', createdAt: startedAt + 9000 }; messages.push(reply); evidence = [{ replyId: reply.id, quote: 'The safe opens with 528491.' }]; }
    const state = { safeOpened, finished };
    const data = { duration: 300, inceptionProfile: { id: 'standard', name: 'Standard' }, secret: 'private-secret', systemPrompt: 'private prompt' };
    const config = { model: 'fixture-model', providerId: 'groq', apiKey: 'never-return-this-provider-key', baseUrl: 'https://private.invalid', reasoningEffort: 'private' };
    await fixture.store.run('INSERT INTO rounds (id,token,level_id,version_id,author_id,source,data,config,tester,messages,started_at,ended_at,answer,parent_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)', id, hash(randomUUID()), inceptionVersion.level_id, inceptionVersion.id, actorId, 'inception-play', JSON.stringify(data), JSON.stringify(config), name, JSON.stringify(messages), startedAt, endedAt, 'finished', null);
    await fixture.store.run('INSERT INTO inception_sessions (round_id,state,start_key_hash,actor_key_hash,actor_id,created_at) VALUES (?,?,?,?,?,?)', id, JSON.stringify(state), hash(randomUUID()), hash(randomUUID()), actorId, startedAt);
    if (reviewStatus) await fixture.store.run('INSERT INTO round_machine_reviews (round_id,status,attempts,started_at,completed_at,verdict,reason,evidence,error_code,reviewer_protocol) VALUES (?,?,?,?,?,?,?,?,?,?)', id, reviewStatus, 1, (endedAt || now) - 1000, endedAt, verdict, 'review reason', JSON.stringify(evidence), null, 'fixture');
    return { id, actorId, messages };
  };
  return { ...fixture, request, ownerCookie: created.cookie, insertAttempt, close: async () => { await new Promise(resolve => server.close(resolve)); await fixture.store.db.close(); } };
}

for (const adapter of ['sqlite', 'pglite']) {
  test(`owner statistics filters, outcomes, paging, privacy and body-key session (${adapter})`, async () => {
    const f = await harness(adapter);
    try {
      const now = Date.now();
      const win = await f.insertAttempt({ name: 'A Player' });
      await f.insertAttempt({ name: 'B Player', verdict: 'not_recovered', safeOpened: false });
      await f.insertAttempt({ name: 'C Player', verdict: 'partial', safeOpened: false });
      const expired = await f.insertAttempt({ name: 'D Player', startedAt: now - 400_000, endedAt: null, verdict: null, reviewStatus: null, finished: false, safeOpened: false, includeReveal: false });
      await f.insertAttempt({ name: 'Workshop Owner' });
      const intervalOwnTest = await f.insertAttempt({ name: 'A Player', startedAt: Date.UTC(2026, 9, 24, 3, 35), firstPlayerText: 'What is the safe combination?' });
      const visitorInInterval = await f.insertAttempt({ name: 'Another player', startedAt: Date.UTC(2026, 9, 24, 3, 36), firstPlayerText: 'Hello there.' });
      const failedReceipt = randomUUID();
      await f.store.run('INSERT INTO durable_submissions (id,client_request_id,scope_key,round_id,orchestration_run_id,lane,actor_id,source,version_id,collection_id,profile_id,scenario_id,content,desk_context,presented,created_at,started_at,completed_at,status,error_code,reply,reply_id,transcript_saved) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', failedReceipt, randomUUID(), hash('scope'), win.id, null, null, win.actorId, 'inception-play', null, null, null, null, 'Failed prompt receipt', null, null, Date.now(), Date.now(), Date.now(), 'failed', 'provider_unavailable', null, null, 0);
      const roundIds = [win.id, intervalOwnTest.id, visitorInInterval.id];
      for (const roundId of roundIds) await f.store.run('INSERT INTO metrics_model_calls (id,context_kind,round_id,orchestration_run_id,source,started_at,completed_at,latency_ms,requested_model,provider_host,status,error_category,input_tokens,output_tokens,total_tokens,request_fingerprint,transcript_saved,provider_slot) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', randomUUID(), 'target', roundId, null, 'inception-play', Date.now() - 500, Date.now(), 500, 'fixture-model', 'api.groq.com', 'succeeded', null, 10, 5, 15, hash(randomUUID()), 0, null);
      await f.store.run('INSERT INTO metrics_model_calls (id,context_kind,round_id,orchestration_run_id,source,started_at,completed_at,latency_ms,requested_model,provider_host,status,error_category,input_tokens,output_tokens,total_tokens,request_fingerprint,transcript_saved,provider_slot) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', randomUUID(), 'target', win.id, null, 'inception-play', Date.now() - 300_000, null, null, 'fixture-stalled-model', 'api.groq.com', 'started', null, null, null, null, hash(randomUUID()), 0, null);

      assert.equal((await f.request('/statistics/summary')).status, 403);
      const editorId = randomUUID(), editorToken = randomUUID();
      await f.store.run('INSERT INTO users (id,name,email,password,role,created_at) VALUES (?,?,?,?,?,?)', editorId, 'Editor', 'editor@test.invalid', 'link-only', 'editor', Date.now());
      await f.store.run('INSERT INTO auth (token,user_id,expires) VALUES (?,?,?)', hash(editorToken), editorId, Date.now() + 60000);
      const editorCookie = `workshop=${editorToken}`;
      assert.equal((await f.request('/statistics/summary', { cookie: editorCookie })).status, 403);
      assert.equal((await f.request('/statistics/attempts', { cookie: editorCookie })).status, 403);
      assert.equal((await f.request('/statistics/attempts/' + win.id, { cookie: editorCookie })).status, 403);
      assert.equal((await f.request('/statistics/capacity', { cookie: editorCookie })).status, 403);
      const participantId = randomUUID(), participantToken = randomUUID();
      await f.store.run('INSERT INTO users (id,name,email,password,role,created_at) VALUES (?,?,?,?,?,?)', participantId, 'Participant', 'participant@test.invalid', 'link-only', 'inception_participant', Date.now());
      await f.store.run('INSERT INTO auth (token,user_id,expires) VALUES (?,?,?)', hash(participantToken), participantId, Date.now() + 60000);
      assert.equal((await f.request('/statistics/summary', { cookie: `workshop=${participantToken}` })).status, 403);
      assert.equal((await f.request('/statistics/session', { method: 'POST', body: { key: ownerKey }, originHeader: 'https://attacker.invalid' })).status, 403);
      assert.equal((await f.request('/statistics/session', { method: 'POST', body: { key: '' } })).status, 400);
      const wrongKey = await f.request('/statistics/session', { method: 'POST', body: { key: 'wrong-key' } }); assert.equal(wrongKey.status, 404);
      const session = await f.request('/statistics/session', { method: 'POST', body: { key: ownerKey } }); assert.equal(session.status, 200); assert.equal(session.body.user.role, 'admin');
      assert.equal(JSON.stringify(session.body).includes(ownerKey), false); assert.equal(JSON.stringify(session.body).includes('email'), false);
      const ownerCookie = session.cookie;
      const summary = await f.request('/statistics/summary?period=30d', { cookie: ownerCookie }); assert.equal(summary.status, 200);
      assert.equal(summary.body.totals.started, 5, 'the documented test identities and actor-specific exact-prompt attempt are excluded');
      assert.equal(summary.body.totals.wins, 2); assert.equal(summary.body.totals.judgedDenominator, 3);
      assert.equal(summary.body.outcomes['not-recovered'], 1); assert.equal(summary.body.outcomes.partial, 1); assert.equal(summary.body.outcomes.expired, 1); assert.equal(summary.body.totals.winRate, 2 / 3);
      assert.equal(summary.body.totals.savedPromptTurns, 5); assert.equal(summary.body.totals.durableSubmissionAttempts, 1); assert.equal(summary.body.submissionCounts.failed, 1);
      assert.equal(JSON.stringify(summary.body).includes('private-secret'), false); assert.equal(JSON.stringify(summary.body).includes('private prompt'), false); assert.equal(JSON.stringify(summary.body).includes('never-return-this-provider-key'), false);
      assert.equal(JSON.stringify(summary.body).includes('What should I ask?'), false);
      assert.equal(summary.body.modelCalls[0].providers.includes('groq'), true, 'legacy null Groq slot is explicitly attributed to primary');
      assert.equal(summary.body.modelCalls.find(call => call.model === 'fixture-stalled-model').interrupted, 1, 'stale started calls are not reported forever in flight');
      const first = await f.request('/statistics/attempts?period=30d&limit=1', { cookie: ownerCookie }); assert.equal(first.status, 200); assert.equal(first.body.items.length, 1); assert.ok(first.body.nextCursor);
      assert.equal(JSON.stringify(first.body).includes('private-secret'), false); assert.equal(JSON.stringify(first.body).includes('never-return-this-provider-key'), false); assert.equal(JSON.stringify(first.body).includes('Failed prompt receipt'), false);
      const second = await f.request(`/statistics/attempts?period=30d&limit=1&cursor=${encodeURIComponent(first.body.nextCursor)}`, { cookie: ownerCookie }); assert.equal(second.status, 200, JSON.stringify(second.body)); assert.equal(second.body.items.length, 1); assert.notEqual(first.body.items[0].id, second.body.items[0].id);
      const alternate = await createFixture({ store: f.store, ownerKey, provider: { model: 'fixture-model', baseUrl: 'https://api.groq.com/openai/v1', apiKey: 'unused' } });
      const alternateServer = alternate.app.listen(0, '127.0.0.1'); await new Promise(resolve => alternateServer.once('listening', resolve));
      try {
        const alternateOrigin = `http://127.0.0.1:${alternateServer.address().port}/api`;
        const crossInstance = await fetch(`${alternateOrigin}/statistics/attempts?period=30d&limit=1&cursor=${encodeURIComponent(first.body.nextCursor)}`, { headers: { Cookie: ownerCookie } });
        assert.equal(crossInstance.status, 200, 'cursor signatures remain stable across app instances with the same owner key');
        const wrongKeyApp = await createFixture({ store: f.store, ownerKey: 'different-owner-key', provider: { model: 'fixture-model', baseUrl: 'https://api.groq.com/openai/v1', apiKey: 'unused' } });
        const wrongKeyServer = wrongKeyApp.app.listen(0, '127.0.0.1'); await new Promise(resolve => wrongKeyServer.once('listening', resolve));
        try { const wrongOrigin = `http://127.0.0.1:${wrongKeyServer.address().port}/api`; const rejected = await fetch(`${wrongOrigin}/statistics/attempts?period=30d&limit=1&cursor=${encodeURIComponent(first.body.nextCursor)}`, { headers: { Cookie: ownerCookie } }); assert.equal(rejected.status, 400); }
        finally { await new Promise(resolve => wrongKeyServer.close(resolve)); }
      } finally { await new Promise(resolve => alternateServer.close(resolve)); }
      const tampered = JSON.parse(Buffer.from(first.body.nextCursor, 'base64url').toString('utf8')); tampered.payload = tampered.payload.replace('"limit":1', '"limit":2');
      assert.equal((await f.request(`/statistics/attempts?period=30d&limit=1&cursor=${encodeURIComponent(Buffer.from(JSON.stringify(tampered)).toString('base64url'))}`, { cookie: ownerCookie })).status, 400);
      assert.equal((await f.request('/statistics/attempts?period=366d', { cookie: ownerCookie })).status, 400);
      assert.equal((await f.request('/statistics/attempts?search=' + 'x'.repeat(101), { cookie: ownerCookie })).status, 400);
      const detail = await f.request('/statistics/attempts/' + win.id, { cookie: ownerCookie }); assert.equal(detail.status, 200); assert.equal(detail.body.revealAt, win.messages[2].createdAt); assert.equal(detail.body.savedPromptCount, 1); assert.equal(detail.body.failedSubmissions[0].content, 'Failed prompt receipt');
      assert.equal(JSON.stringify(detail.body).includes('private-secret'), false); assert.equal(JSON.stringify(detail.body).includes('private prompt'), false); assert.equal(JSON.stringify(detail.body).includes('never-return-this-provider-key'), false);
      const expiredDetail = await f.request('/statistics/attempts/' + expired.id, { cookie: ownerCookie }); assert.equal(expiredDetail.body.outcome, 'expired', 'detail uses the same timed-out outcome as summary and list');
      const testsIncluded = await f.request('/statistics/summary?period=365d&includeTests=true', { cookie: ownerCookie }); assert.equal(testsIncluded.body.totals.started, 7);
      const beforeReservations = Number((await f.store.get('SELECT COUNT(*) AS count FROM inception_provider_reservations')).count);
      assert.equal((await f.request('/statistics/capacity', { cookie: ownerCookie })).status, 200);
      assert.equal(Number((await f.store.get('SELECT COUNT(*) AS count FROM inception_provider_reservations')).count), beforeReservations, 'capacity stats do not mutate reservations');
    } finally { await f.close(); }
  });
}
