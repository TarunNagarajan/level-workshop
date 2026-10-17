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

async function inviteMember(request, ownerCookie, name, email) {
  const invitation = await request('/invites', { method: 'POST', cookie: ownerCookie, body: {} });
  const token = invitation.body.path.split('/').at(-1);
  const joined = await request(`/invite/${token}`, { method: 'POST', body: { name, email, password: 'member-password-12345' } });
  assert.equal(joined.status, 200);
  return joined.cookie;
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
    const metricsSession=await fixture.request('/telemetry/session',{method:'POST'});
    const scopedEvent=(view='workshop',interaction)=>({events:[{eventId:uuid(),tabId:uuid(),pageId:uuid(),kind:interaction?'interaction':'heartbeat',view,roundId:started.body.id,elapsedMs:1000,activeMs:500,visibleMs:1000,...(interaction?{interaction}:{})}]});
    assert.equal((await fixture.request('/telemetry/events',{method:'POST',cookie:metricsSession.cookie,body:{sessionId:metricsSession.body.sessionId,roundId:started.body.id,...scopedEvent()}})).status,403,'round-scoped telemetry requires a capability');
    assert.equal((await fixture.request('/telemetry/events',{method:'POST',cookie:metricsSession.cookie,headers:{'x-round-token':'wrong'},body:{sessionId:metricsSession.body.sessionId,roundId:started.body.id,...scopedEvent()}})).status,403,'wrong capabilities are rejected');
    assert.equal((await fixture.request('/telemetry/events',{method:'POST',cookie:metricsSession.cookie,headers:{'x-round-token':started.body.accessToken},body:{sessionId:metricsSession.body.sessionId,roundId:started.body.id,...scopedEvent()}})).status,200);
    assert.equal((await fixture.request('/telemetry/events',{method:'POST',cookie:metricsSession.cookie,headers:{'x-round-token':started.body.accessToken},body:{sessionId:metricsSession.body.sessionId,roundId:started.body.id,...scopedEvent('diary','inspect')}})).status,200,'the diary route and inspect interaction categories are accepted for scoped telemetry');
    assert.equal((await fixture.store.get("SELECT interaction FROM metrics_events WHERE round_id=? AND view_category='diary'",started.body.id)).interaction,'inspect');
    assert.equal((await fixture.request('/telemetry/events',{method:'POST',cookie:metricsSession.cookie,headers:{'x-round-token':started.body.accessToken},body:{sessionId:metricsSession.body.sessionId,roundId:started.body.id,...scopedEvent('inception','review')}})).status,200,'Inception review interactions are accepted as route-scoped telemetry');
    assert.equal((await fixture.store.get("SELECT interaction FROM metrics_events WHERE round_id=? AND view_category='inception'",started.body.id)).interaction,'review');
    const scopedRow=await fixture.store.get('SELECT collection_id,profile_id,source,version_id FROM metrics_events WHERE round_id=?',started.body.id);
    assert.equal(scopedRow.source,'participant');
    assert.equal(scopedRow.version_id,detail.versions[0].id,'Postgres preserves camelCase DTO aliases during round inference');
    await fixture.store.run('UPDATE metrics_sessions SET last_seen_at=?,expires_at=? WHERE token_hash=?',Date.now()-31*60*1000,Date.now()-1,(await fixture.store.get('SELECT token_hash FROM metrics_sessions ORDER BY created_at DESC LIMIT 1')).token_hash);
    assert.equal((await fixture.request('/telemetry/events',{method:'POST',cookie:metricsSession.cookie,headers:{'x-round-token':started.body.accessToken},body:{sessionId:metricsSession.body.sessionId,roundId:started.body.id,...scopedEvent()}})).status,401,'sessions idle for over 30 minutes have expired');
    const refreshedSession=await fixture.request('/telemetry/session',{method:'POST',cookie:metricsSession.cookie});
    const refreshedHash=(await fixture.store.get('SELECT token_hash FROM metrics_sessions ORDER BY created_at DESC LIMIT 1')).token_hash;
    await fixture.store.run('UPDATE metrics_sessions SET created_at=?,expires_at=? WHERE token_hash=?',Date.now()-24*60*60*1000-1,Date.now()+60000,refreshedHash);
    assert.equal((await fixture.request('/telemetry/events',{method:'POST',cookie:refreshedSession.cookie,headers:{'x-round-token':started.body.accessToken},body:{sessionId:refreshedSession.body.sessionId,roundId:started.body.id,...scopedEvent()}})).status,401,'sessions older than 24 hours have expired even if idle expiry was extended');
    const path=`/rounds/${started.body.id}/messages`;
    const failed=await fixture.request(path,{method:'POST',headers:{'x-round-token':started.body.accessToken},body:{content:'Retry this question'}});
    assert.equal(failed.status,429);
    const succeeded=await fixture.request(path,{method:'POST',headers:{'x-round-token':started.body.accessToken},body:{content:'Retry this question'}});
    assert.equal(succeeded.status,200);
    assert.equal(succeeded.body.messages.at(-1).content,'A visible answer.');
    const nextTurn=await fixture.request(path,{method:'POST',headers:{'x-round-token':started.body.accessToken},body:{content:'A new successful turn'}});
    assert.equal(nextTurn.status,200);
    const rows=await fixture.store.all('SELECT id,source,context_kind,round_id,actor_user_id,status,error_category,input_tokens,output_tokens,total_tokens,transcript_saved,retry_of_id,request_fingerprint FROM metrics_model_calls WHERE round_id=?',started.body.id);
    assert.equal(rows.length,3);
    const failedCall=rows.find(row=>row.status==='failed');
    const retriedCall=rows.find(row=>row.retry_of_id===failedCall.id);
    const independentCall=rows.find(row=>row.id!==failedCall.id&&row.id!==retriedCall.id);
    assert.equal(failedCall.error_category,'rate_limited');
    assert.equal(retriedCall.status,'succeeded');
    assert.equal(retriedCall.request_fingerprint,failedCall.request_fingerprint);
    assert.equal(independentCall.status,'succeeded');
    assert.equal(independentCall.retry_of_id,null,'a later successful turn is not an inferred retry');
    assert.equal(retriedCall.source,'participant');
    assert.equal(retriedCall.context_kind,'round');
    assert.equal(retriedCall.actor_user_id,null,'anonymous participant calls are not attributed to the round author');
    assert.equal(retriedCall.input_tokens,4);
    assert.equal(retriedCall.output_tokens,3);
    assert.equal(retriedCall.total_tokens,7);
    assert.equal(retriedCall.transcript_saved,1);
    assert.ok(!JSON.stringify(await fixture.store.all('SELECT * FROM metrics_model_calls WHERE round_id=?',started.body.id)).includes('Retry this question'));
    const calls=await fixture.request(`/metrics/calls?from=${Date.now()-60000}`,{cookie:ownerCookie});
    assert.equal(calls.status,200);
    assert.equal(calls.body.items.length,3);
    await fixture.store.run("INSERT INTO metrics_model_calls (id,context_kind,round_id,started_at,requested_model,status,request_fingerprint) VALUES (?,?,?,?,?,?,?)",uuid(),'round',started.body.id,Date.now()-5*60*1000,'test/model','started',uuid());
    await fixture.store.run('INSERT INTO rounds (id,token,level_id,author_id,source,data,config,tester,messages,started_at) VALUES (?,?,?,?,?,?,?,?,?,?)',uuid(),uuid(),level.id,(await fixture.request('/bootstrap',{cookie:ownerCookie})).body.user.id,'reference-research',JSON.stringify({duration:600,privatePrompt:'must not be loaded'}),'{}','diagnostic fixture','[]',Date.now());
    for (const source of ['diary-play','diary-blind']) await fixture.store.run('INSERT INTO rounds (id,token,level_id,author_id,source,data,config,tester,messages,started_at) VALUES (?,?,?,?,?,?,?,?,?,?)',uuid(),uuid(),level.id,(await fixture.request('/bootstrap',{cookie:ownerCookie})).body.user.id,source,JSON.stringify({duration:600}),'{}','diary participant','[]',Date.now());
    const summary=await fixture.request(`/metrics/summary?from=${Date.now()-60000}`,{cookie:ownerCookie});
    assert.equal(summary.body.rounds.started,3,'diary play and blind sources are counted as participant rounds');
    assert.equal(summary.body.rounds.questions,2);
    assert.equal(summary.body.rounds.diagnostics.started,1);
    assert.equal(summary.body.rounds.diagnostics.questions,0);
    assert.equal(summary.body.rounds.bySource.find(item=>item.source==='reference-research').started,1);
    assert.equal(summary.body.rounds.bySource.find(item=>item.source==='diary-play').started,1);
    assert.equal(summary.body.rounds.bySource.find(item=>item.source==='diary-blind').started,1);
    const collectionInput={levelId:level.id,versionId:detail.versions[0].id,profiles:[{id:'same-profile',label:'Same label',notes:'test notes',moduleIds:['secret-boundary'],additionalInstructions:''}]};
    const collectionA=await fixture.request('/collections',{method:'POST',cookie:ownerCookie,body:collectionInput});
    const collectionB=await fixture.request('/collections',{method:'POST',cookie:ownerCookie,body:collectionInput});
    assert.equal(collectionA.status,201,JSON.stringify(collectionA.body));
    assert.equal(collectionB.status,201,JSON.stringify(collectionB.body));
    const callStart=Date.now();
    for(const [collectionId,latency,status] of [[collectionA.body.id,20,'succeeded'],[collectionA.body.id,40,'failed'],[collectionB.body.id,100,'succeeded']]) {
      await fixture.store.run('INSERT INTO metrics_model_calls (id,context_kind,collection_id,profile_id,source,started_at,latency_ms,requested_model,status,request_fingerprint) VALUES (?,?,?,?,?,?,?,?,?,?)',uuid(),'round',collectionId,'same-profile','participant',callStart,latency,'test-model',status,uuid());
    }
    await fixture.store.run("INSERT INTO metrics_model_calls (id,context_kind,round_id,started_at,requested_model,status,request_fingerprint) VALUES (?,?,?,?,?,?,?)",uuid(),'round',started.body.id,Date.now(),'test/model','started',uuid());
    const profileSummary=await fixture.request(`/metrics/summary?from=${Date.now()-60000}`,{cookie:ownerCookie});
    assert.equal(profileSummary.body.modelCalls.inFlight,1);
    const profiles=profileSummary.body.byProfile;
    assert.equal(profiles.length,2,'identically named profile IDs in separate collections stay separate');
    const profileA=profiles.find(item=>item.collectionId===collectionA.body.id);
    assert.equal(profileA.calls,2);
    assert.equal(profileA.succeeded,1);
    assert.equal(profileA.failed,1);
    assert.equal(profileA.latency.count,2);
    assert.equal(profileA.latency.meanMs,30);
    assert.equal(profileA.latency.p50Ms,20);
    assert.equal(profileA.latency.p95Ms,40);
    assert.equal(profiles.find(item=>item.collectionId===collectionB.body.id).latency.p95Ms,100);
    assert.equal((await fixture.store.get("SELECT status FROM metrics_model_calls WHERE status='interrupted' AND round_id=?",started.body.id))?.status,'interrupted','stale started provider calls are reconciled, not shown as failures');
  } finally { await fixture.close(); }
});

for (const adapter of ['sqlite','pglite']) test(`${adapter}: resumed authenticated round telemetry keeps owner isolation and anonymous capabilities`, async () => {
  const fixture=await start(adapter);
  try {
    const ownerCookie=await owner(fixture.request);
    const level=(await fixture.request('/levels',{cookie:ownerCookie})).body[0];
    const detail=(await fixture.request(`/levels/${level.id}`,{cookie:ownerCookie})).body;
    const memberCookie=await inviteMember(fixture.request,ownerCookie,'Metrics member',`metrics-member-${adapter}@example.test`);
    const memberRound=await fixture.request(`/levels/${level.id}/rounds`,{method:'POST',cookie:memberCookie,body:{versionId:detail.versions[0].id}});
    assert.equal(memberRound.status,201);
    const event=()=>({events:[{eventId:uuid(),tabId:uuid(),pageId:uuid(),kind:'heartbeat',view:'workshop',roundId:memberRound.body.id,elapsedMs:1000,activeMs:500,visibleMs:1000}]});
    const memberMetrics=await fixture.request('/telemetry/session',{method:'POST',cookie:memberCookie});
    assert.equal((await fixture.request('/telemetry/events',{method:'POST',cookie:`${memberCookie}; ${memberMetrics.cookie}`,body:{sessionId:memberMetrics.body.sessionId,...event()}})).status,200,'authenticated author can record their own round without a recoverable round token');

    const otherCookie=await inviteMember(fixture.request,ownerCookie,'Other member',`metrics-other-${adapter}@example.test`);
    const otherMetrics=await fixture.request('/telemetry/session',{method:'POST',cookie:otherCookie});
    assert.equal((await fixture.request('/telemetry/events',{method:'POST',cookie:`${otherCookie}; ${otherMetrics.cookie}`,body:{sessionId:otherMetrics.body.sessionId,...event()}})).status,403,'a different member cannot record this round');

    const anonymousMetrics=await fixture.request('/telemetry/session',{method:'POST'});
    assert.equal((await fixture.request('/telemetry/events',{method:'POST',cookie:anonymousMetrics.cookie,body:{sessionId:anonymousMetrics.body.sessionId,...event()}})).status,403,'anonymous sessions still require the round capability');
    assert.equal((await fixture.request('/telemetry/events',{method:'POST',cookie:anonymousMetrics.cookie,headers:{'x-round-token':memberRound.body.accessToken},body:{sessionId:anonymousMetrics.body.sessionId,...event()}})).status,200,'valid anonymous round capability still authorizes scoped telemetry');
  } finally { await fixture.close(); }
});

for (const adapter of ['sqlite', 'pglite']) test(`${adapter}: metrics session, event validation/idempotency, and owner-only reads`, async t => {
  const fixture = await start(adapter);
  try {
    assert.equal((await fixture.request('/metrics/summary')).status, 403);
    const ownerCookie = await owner(fixture.request);
    assert.equal((await fixture.request('/metrics/summary', { cookie: 'workshop=bad' })).status, 403);
    const encoded=payload=>Buffer.from(JSON.stringify(payload)).toString('base64url');
    for(const cursor of [
      {at:Date.now(),id:'x',from:0,to:Date.now()},
      {at:Date.now()+10000,id:'x',from:Date.now()-1000,to:Date.now(),type:'model_call'},
      {at:Date.now()-100,id:'x',from:Date.now()-1000,to:Date.now(),type:'event'},
      {at:Date.now()-100,id:'x',from:Date.now()-1000},
    ]) assert.equal((await fixture.request(`/metrics/calls?cursor=${encoded(cursor)}`,{cookie:ownerCookie})).status,400);
    assert.equal((await fixture.request(`/metrics/export?cursor=${encoded({at:Date.now()-100,id:'x',from:Date.now()-1000,to:Date.now()})}`,{cookie:ownerCookie})).status,400,'export cursors include a valid record type');
    const session = await fixture.request('/telemetry/session', { method: 'POST', cookie: ownerCookie });
    assert.deepEqual(session.body, { enabled: true, heartbeatSeconds: 18, idleAfterMs: 30000, sessionId: session.body.sessionId });
    assert.match(session.body.sessionId,/^[0-9a-f-]{36}$/i);
    assert.match(session.cookie, /^workshop_metrics=/);
    const cookie = `${session.cookie}; ${ownerCookie}`;
    const uppercaseEventId = uuid().toUpperCase();
    const event = { eventId: uppercaseEventId, tabId: uuid(), pageId: uuid(), kind: 'heartbeat', view: 'workshop', elapsedMs: 18000, activeMs: 17000, visibleMs: 18000, idleMs: 0 };
    const marker = { eventId: uuid(), tabId: event.tabId, pageId: event.pageId, kind: 'phase', view: 'workshop', phase: 'read_think' };
    assert.deepEqual((await fixture.request('/telemetry/events', { method: 'POST', cookie, body: { sessionId:session.body.sessionId,events: [event,marker] } })).body, { accepted: 2, duplicates: 0 });
    assert.equal((await fixture.store.get('SELECT event_id FROM metrics_events WHERE event_id=?',uppercaseEventId.toLowerCase()))?.event_id,uppercaseEventId.toLowerCase(),'UUID event IDs are stored in canonical lowercase');
    assert.deepEqual((await fixture.request('/telemetry/events', { method: 'POST', cookie, body: { sessionId:session.body.sessionId,events: [{...event,eventId:uppercaseEventId.toLowerCase()},marker] } })).body, { accepted: 0, duplicates: 2 },'uppercase and lowercase spellings share the same idempotency key');
    const invalid = await fixture.request('/telemetry/events', { method: 'POST', cookie, body: { sessionId:session.body.sessionId,events: [{ ...event, activeMs: 19000 }] } });
    assert.equal(invalid.status, 400);
    const leak = await fixture.request('/telemetry/events', { method: 'POST', cookie, body: { sessionId:session.body.sessionId,events: [{ ...event, eventId: uuid(), message: 'unsent secret' }] } });
    assert.equal(leak.status, 400);
    const summary = await fixture.request('/metrics/summary', { cookie: ownerCookie });
    assert.equal(summary.status, 200);
    assert.equal(summary.body.browser.activeMs, 17000);
    assert.equal(summary.body.browser.visibleMs, 18000);
    assert.equal(summary.body.browser.timedIntervals, 1);
    assert.equal(summary.body.browser.missingIntervals, 0,'phase markers are not missing interval measurements');
    assert.equal(summary.body.browser.events, 2);
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
    assert.equal(exported.length, 208);
    assert.equal(exported.filter(item => item.type === 'model_call').length, 102);
    assert.equal(exported.filter(item => item.type === 'event').length, 104);
    assert.equal(exported.filter(item => item.type === 'session').length, 2);
    assert.equal(exported.filter(item => item.id === sharedId).map(item=>item.type).sort().join(','),'event,model_call,session');
    assert.equal(JSON.stringify(exported).includes('private-api-key'), false);
    const dbText = JSON.stringify(await fixture.store.all('SELECT * FROM metrics_events'));
    assert.equal(dbText.includes('unsent secret'), false);
    const orderingAt=Date.now()-60000,uppercaseId='F0000000-0000-4000-8000-000000000001',lowercaseId='a0000000-0000-4000-8000-000000000001';
    await fixture.store.batch([
      ['INSERT INTO metrics_events (event_id,session_id,tab_id,page_id,event_kind,view_category,created_at) VALUES (?,?,?,?,?,?,?)',uppercaseId,sessionId,uuid(),uuid(),'page_enter','workshop',orderingAt],
      ['INSERT INTO metrics_model_calls (id,context_kind,started_at,requested_model,status,request_fingerprint) VALUES (?,?,?,?,?,?)',lowercaseId,'round',orderingAt,'test-model','failed','case-ordering'],
    ]);
    let orderingCursor,ordered=[];
    do {
      const page=await fixture.request(`/metrics/export?limit=1&from=${orderingAt}&to=${orderingAt+1}${orderingCursor?`&cursor=${encodeURIComponent(orderingCursor)}`:''}`,{cookie:ownerCookie});
      assert.equal(page.status,200);
      ordered.push(...page.body.items.map(item=>item.id));
      orderingCursor=page.body.nextCursor;
    } while(orderingCursor);
    assert.deepEqual(ordered,[lowercaseId,uppercaseId],'mixed-case UUIDs at one timestamp stay in deterministic database/cursor order without skipped rows');
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
    assert.notEqual(anonymous.body.sessionId,rotated.body.sessionId);

    const sessionCookie=`${rotated.cookie}; ${ownerCookie}`;
    const makeBatch=()=>({sessionId:rotated.body.sessionId,events:Array.from({length:50},()=>({eventId:uuid(),tabId:uuid(),pageId:uuid(),kind:'heartbeat',view:'workshop',elapsedMs:1000,activeMs:900,visibleMs:1000}))});
    assert.equal((await fixture.request('/telemetry/events',{method:'POST',cookie:sessionCookie,body:{...makeBatch(),sessionId:anonymous.body.sessionId}})).status,401,'queued events from a previous identity session cannot attach to the rotated cookie');
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
