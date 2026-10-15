import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFixture } from './database-fixture.mjs';
import { createMetricsService } from '../server/metrics.mjs';

const ownerKey = 'metrics-test-owner-key';
const provider = { model: 'private-model', baseUrl: 'https://provider.private.test/v1', apiKey: 'private-api-key' };

async function start(adapter, options = {}) {
  const fixture = await createFixture({ adapter, dbPath: ':memory:', provider, ownerKey, metricsEnabled: true, ...options });
  const server = fixture.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const request = async (path, { method = 'GET', body, cookie, headers = {} } = {}) => {
    const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  return { ...fixture, request, async close() { await new Promise(resolve => server.close(resolve)); await fixture.store.db.close(); } };
}

async function owner(request) {
  const result = await request(`/owner/${ownerKey}`, { method: 'POST', body: { name: 'Metrics owner' } });
  assert.equal(result.status, 200);
  return result.cookie;
}

const uuid = () => crypto.randomUUID();

for (const adapter of ['sqlite','pglite']) test(`${adapter}: workshop completion hook records successful and failed round calls`, async () => {
  const inputs=[];
  const fixture=await start(adapter,{completion:async input=>{
    inputs.push(input);
    if(inputs.length===1)throw Object.assign(new Error('Provider rate limit'),{status:429,providerCode:'rate_limited'});
    return {text:'A visible answer.',model:input.config.model,usageDetails:{inputTokens:4,outputTokens:3,totalTokens:7}};
  }});
  try {
    const ownerCookie=await owner(fixture.request);
    const levels=(await fixture.request('/levels',{cookie:ownerCookie})).body;
    const level=levels[0];
    const detail=(await fixture.request(`/levels/${level.id}`,{cookie:ownerCookie})).body;
    const link=(await fixture.request(`/levels/${level.id}/links`,{method:'POST',cookie:ownerCookie,body:{versionId:detail.versions[0].id}})).body;
    const rawLink=link.path.split('/').at(-1);
    const started=await fixture.request(`/play/${rawLink}`,{method:'POST',body:{tester:'anonymous participant'}});
    assert.equal(started.status,201);
    const path=`/rounds/${started.body.id}/messages`;
    const failed=await fixture.request(path,{method:'POST',headers:{'x-round-token':started.body.accessToken},body:{content:'First question'}});
    assert.equal(failed.status,429);
    const succeeded=await fixture.request(path,{method:'POST',headers:{'x-round-token':started.body.accessToken},body:{content:'Second question'}});
    assert.equal(succeeded.status,200);
    assert.equal(succeeded.body.messages.at(-1).content,'A visible answer.');
    const rows=await fixture.store.all('SELECT source,context_kind,round_id,actor_user_id,status,error_category,input_tokens,output_tokens,total_tokens,transcript_saved FROM metrics_model_calls WHERE round_id=? ORDER BY started_at,id',started.body.id);
    assert.equal(rows.length,2);
    assert.deepEqual(rows.map(row=>row.status),['failed','succeeded']);
    assert.equal(rows[0].error_category,'rate_limited');
    assert.equal(rows[1].source,'participant');
    assert.equal(rows[1].context_kind,'round');
    assert.equal(rows[1].actor_user_id,null,'anonymous participant calls are not attributed to the round author');
    assert.equal(rows[1].input_tokens,4);
    assert.equal(rows[1].output_tokens,3);
    assert.equal(rows[1].total_tokens,7);
    assert.equal(rows[1].transcript_saved,1);
    assert.ok(!JSON.stringify(await fixture.store.all('SELECT * FROM metrics_model_calls WHERE round_id=?',started.body.id)).includes('First question'));
    const calls=await fixture.request(`/metrics/calls?from=${Date.now()-60000}`,{cookie:ownerCookie});
    assert.equal(calls.status,200);
    assert.deepEqual(calls.body.items.map(item=>item.status),['succeeded','failed']);
    await fixture.store.run('INSERT INTO rounds (id,token,level_id,author_id,source,data,config,tester,messages,started_at) VALUES (?,?,?,?,?,?,?,?,?,?)',uuid(),uuid(),level.id,(await fixture.request('/bootstrap',{cookie:ownerCookie})).body.user.id,'reference-research',JSON.stringify({duration:600,privatePrompt:'must not be loaded'}),'{}','diagnostic fixture','[]',Date.now());
    const summary=await fixture.request(`/metrics/summary?from=${Date.now()-60000}`,{cookie:ownerCookie});
    assert.equal(summary.body.rounds.started,1);
    assert.equal(summary.body.rounds.diagnostics.started,1);
    assert.equal(summary.body.rounds.bySource.find(item=>item.source==='reference-research').started,1);
  } finally { await fixture.close(); }
});

for (const adapter of ['sqlite', 'pglite']) test(`${adapter}: metrics session, event validation/idempotency, and owner-only reads`, async t => {
  const fixture = await start(adapter);
  try {
    assert.equal((await fixture.request('/metrics/summary')).status, 403);
    const ownerCookie = await owner(fixture.request);
    assert.equal((await fixture.request('/metrics/summary', { cookie: 'workshop=bad' })).status, 403);
    const session = await fixture.request('/telemetry/session', { method: 'POST', cookie: ownerCookie });
    assert.deepEqual(session.body, { enabled: true, heartbeatSeconds: 18, idleAfterMs: 30000 });
    assert.match(session.cookie, /^workshop_metrics=/);
    const cookie = `${session.cookie}; ${ownerCookie}`;
    const event = { eventId: uuid(), tabId: uuid(), pageId: uuid(), kind: 'heartbeat', view: 'workshop', elapsedMs: 18000, activeMs: 17000, visibleMs: 18000, idleMs: 0 };
    assert.deepEqual((await fixture.request('/telemetry/events', { method: 'POST', cookie, body: { events: [event] } })).body, { accepted: 1, duplicates: 0 });
    assert.deepEqual((await fixture.request('/telemetry/events', { method: 'POST', cookie, body: { events: [event] } })).body, { accepted: 0, duplicates: 1 });
    const invalid = await fixture.request('/telemetry/events', { method: 'POST', cookie, body: { events: [{ ...event, activeMs: 19000 }] } });
    assert.equal(invalid.status, 400);
    const leak = await fixture.request('/telemetry/events', { method: 'POST', cookie, body: { events: [{ ...event, eventId: uuid(), message: 'unsent secret' }] } });
    assert.equal(leak.status, 400);
    const summary = await fixture.request('/metrics/summary', { cookie: ownerCookie });
    assert.equal(summary.status, 200);
    assert.equal(summary.body.browser.activeMs, 17000);
    assert.equal(summary.body.browser.visibleMs, 18000);
    assert.equal(summary.body.browser.timedIntervals, 1);
    const page = await fixture.request('/metrics/sessions?limit=1', { cookie: ownerCookie });
    assert.equal(page.body.items.length, 1);
    assert.equal(page.body.items[0].userId, (await fixture.request('/bootstrap', { cookie: ownerCookie })).body.user.id);
    const calls = await fixture.request('/metrics/calls?limit=1.5', { cookie: ownerCookie });
    assert.equal(calls.status, 400);
    const recordedAt = Date.now() - 1000, sessionId = (await fixture.store.get('SELECT id FROM metrics_sessions WHERE user_id IS NOT NULL')).id;
    await fixture.store.batch([
      ...Array.from({ length: 101 }, () => ['INSERT INTO metrics_events (event_id,session_id,user_id,tab_id,page_id,event_kind,view_category,elapsed_ms,active_ms,visible_ms,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)', uuid(), sessionId, null, uuid(), uuid(), 'heartbeat', 'workshop', 1000, 900, 1000, recordedAt]),
      ...Array.from({ length: 101 }, (_, index) => ['INSERT INTO metrics_model_calls (id,context_kind,started_at,completed_at,latency_ms,requested_model,status,request_fingerprint,input_tokens,output_tokens,total_tokens,response_chars,response_words) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', uuid(), 'round', recordedAt, recordedAt + index + 1, index + 1, 'test-model', 'succeeded', `fingerprint-${index}`, index % 2 ? index : null, index, index * 2, 14, 2]),
    ]);
    const sharedId=uuid();
    await fixture.store.batch([
      ['INSERT INTO metrics_sessions (id,token_hash,user_id,created_at,last_seen_at,expires_at,event_window_started_at,event_window_count) VALUES (?,?,?,?,?,?,?,0)',sharedId,uuid(),null,recordedAt,recordedAt,recordedAt+60000,recordedAt],
      ['INSERT INTO metrics_events (event_id,session_id,tab_id,page_id,event_kind,view_category,created_at) VALUES (?,?,?,?,?,?,?)',sharedId,sessionId,uuid(),uuid(),'page_enter','workshop',recordedAt],
      ['INSERT INTO metrics_model_calls (id,context_kind,started_at,requested_model,status,request_fingerprint) VALUES (?,?,?,?,?,?)',sharedId,'round',recordedAt,'test-model','failed','shared-fingerprint'],
    ]);
    const aggregate = await fixture.request('/metrics/summary', { cookie: ownerCookie });
    assert.equal(aggregate.body.modelCalls.total, 102);
    assert.equal(aggregate.body.modelCalls.latency.p50Ms, 51, JSON.stringify(aggregate.body.modelCalls.latency));
    assert.equal(aggregate.body.modelCalls.latency.p95Ms, 96);
    assert.equal(aggregate.body.modelCalls.tokens.input.covered, 50);
    assert.equal(aggregate.body.modelCalls.tokens.input.missing, 52);
    assert.equal(aggregate.body.modelCalls.tokens.total.sum, 10100);
    let cursor, exported = [];
    do {
      const path = `/metrics/export?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const result = await fixture.request(path, { cookie: ownerCookie });
      assert.equal(result.status, 200);
      exported.push(...result.body.items); cursor = result.body.nextCursor;
    } while (cursor);
    assert.equal(exported.length, 207);
    assert.equal(exported.filter(item => item.type === 'model_call').length, 102);
    assert.equal(exported.filter(item => item.type === 'event').length, 103);
    assert.equal(exported.filter(item => item.type === 'session').length, 2);
    assert.equal(exported.filter(item => item.id === sharedId).map(item=>item.type).sort().join(','),'event,model_call,session');
    assert.equal(JSON.stringify(exported).includes('private-api-key'), false);
    const dbText = JSON.stringify(await fixture.store.all('SELECT * FROM metrics_events'));
    assert.equal(dbText.includes('unsent secret'), false);
  } finally { await fixture.close(); }
});

test('metrics persistence failure cannot block a valid provider completion', async () => {
  const store = {
    async get(sql, ...args) { if (sql.includes('metrics_model_calls')) throw new Error('metrics database unavailable'); return null; },
    async run(sql, ...args) { if (sql.includes('metrics_model_calls')) throw new Error('metrics database unavailable'); return { changes: 0 }; },
  };
  const metrics = createMetricsService({ store, enabled: true });
  const expected = { text: 'Visible answer', model: 'model-a', usage: 12, usageDetails: { inputTokens: 5, outputTokens: 7, totalTokens: 12 } };
  const result = await metrics.recordCompletion(async () => expected, { config: provider, system: 'private system', messages: [{ role: 'user', content: 'private request' }], temperature: 0.4, metricsContext: { kind: 'round', roundId: 'round' } });
  assert.equal(result.text, expected.text);
});

for (const adapter of ['sqlite','pglite']) test(`${adapter}: session identity, anonymous session creation bound, and atomic event rate reservation`, async () => {
  const fixture=await start(adapter,{metricsSessionCreationLimit:3});
  try {
    const anonymous=await fixture.request('/telemetry/session',{method:'POST'});
    assert.equal(anonymous.status,200);
    const ownerCookie=await owner(fixture.request);
    const rotated=await fixture.request('/telemetry/session',{method:'POST',cookie:`${anonymous.cookie}; ${ownerCookie}`});
    assert.equal(rotated.status,200);
    const sessions=await fixture.store.all('SELECT id,user_id,closed_at,created_at,expires_at FROM metrics_sessions ORDER BY created_at');
    assert.equal(sessions.length,2);
    assert.ok(sessions[0].closed_at);
    assert.equal(sessions[1].user_id,(await fixture.request('/bootstrap',{cookie:ownerCookie})).body.user.id);

    const sessionCookie=`${rotated.cookie}; ${ownerCookie}`;
    const makeBatch=()=>({events:Array.from({length:50},()=>({eventId:uuid(),tabId:uuid(),pageId:uuid(),kind:'heartbeat',view:'workshop',elapsedMs:1000,activeMs:900,visibleMs:1000}))});
    assert.equal((await fixture.request('/telemetry/events',{method:'POST',cookie:sessionCookie,body:makeBatch()})).status,200);
    assert.equal((await fixture.request('/telemetry/events',{method:'POST',cookie:sessionCookie,body:makeBatch()})).status,200);
    assert.equal((await fixture.request('/telemetry/events',{method:'POST',cookie:sessionCookie,body:makeBatch()})).status,200);
    const parallel=await Promise.all([
      fixture.request('/telemetry/events',{method:'POST',cookie:sessionCookie,body:makeBatch()}),
      fixture.request('/telemetry/events',{method:'POST',cookie:sessionCookie,body:makeBatch()}),
    ]);
    assert.deepEqual(parallel.map(r=>r.status).sort(),[200,429]);
    assert.equal(Number((await fixture.store.get('SELECT COUNT(*) AS n FROM metrics_events')).n),200);

    await fixture.request('/telemetry/session',{method:'POST'});
    const rateLimited=await fixture.request('/telemetry/session',{method:'POST'});
    assert.equal(rateLimited.status,429);
  } finally { await fixture.close(); }
});
