import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFixture } from './database-fixture.mjs';

const ownerKey = 'inception-direct-entry-owner-key';
const provider = { model: 'fixture-model', baseUrl: 'https://fixture.example.test/v1', apiKey: 'fixture-only' };
const uuid = () => crypto.randomUUID();

async function start(adapter, options = {}) {
  const fixture = await createFixture({ adapter, dbPath: ':memory:', ownerKey, rootEntry: true, metricsEnabled: true, passportReviewEnabled: true, recordingNoticeRequired: true, provider, completion: async input => input.system.includes('INCEPTION STRONGROOM REVIEW PROTOCOL')
    ? { text: JSON.stringify({ verdict: 'not_recovered', reason: 'The saved transcript contains no disclosure.', evidence: [] }), latencyMs: 1, usage: 1, model: 'fixture-model' }
    : { text: 'Fischer pauses, then asks what you noticed in the room.', latencyMs: 1, usage: 1, model: 'fixture-model' }, ...options });
  const server = fixture.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const request = async (path, { method = 'GET', body, cookie, headers = {} } = {}) => {
    const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0], setCookie: response.headers.get('set-cookie') || '' };
  };
  return { ...fixture, request, async close() { await new Promise(resolve => server.close(resolve)); await fixture.store.db.close(); } };
}

async function owner(request) {
  const response = await request(`/owner/${ownerKey}`, { method: 'POST', body: { name: 'Workspace owner' } });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response;
}

for (const adapter of ['sqlite', 'pglite']) test(`${adapter}: direct Inception entry is scoped, reusable, recorded under its actor, and revocable`, async () => {
  const fixture = await start(adapter);
  try {
    assert.equal((await fixture.request('/inception/entry', { method: 'POST', body: {} })).status, 404, 'entry fails closed before an owner exists');
    const ownerSession = await owner(fixture.request);
    assert.equal((await fixture.request('/inception/entry', { method: 'POST', body: {}, headers: { Origin: 'https://other.example' } })).status, 403, 'cross-origin entry is rejected');

    const ownerEntry = await fixture.request('/inception/entry', { method: 'POST', cookie: ownerSession.cookie, body: {} });
    assert.equal(ownerEntry.status, 200);
    assert.equal(ownerEntry.body.actorId, ownerSession.body.user.id, 'a signed-in owner keeps their actual account identity');
    assert.match(ownerEntry.cookie, /^inception_entry=/, 'entry uses a separate scoped cookie');
    assert.match(ownerEntry.setCookie, /HttpOnly/i);
    assert.match(ownerEntry.setCookie, /SameSite=Strict/i);
    const substitutedOwnerCookie = ownerEntry.cookie.replace(/^inception_entry=/, 'workshop=');
    assert.equal((await fixture.request('/bootstrap', { cookie: substitutedOwnerCookie })).body.user, null, 'an owner entry token also cannot be substituted for normal workshop authentication');
    assert.equal((await fixture.request('/bootstrap', { cookie: ownerSession.cookie })).body.user.id, ownerSession.body.user.id, 'the workshop cookie remains unchanged');

    const first = await fixture.request('/inception/entry', { method: 'POST', body: {} });
    assert.equal(first.status, 200);
    assert.match(first.cookie, /^inception_entry=/);
    assert.equal(Object.keys(first.body).some(key => /email|password|token/i.test(key)), false, 'entry response contains no credentials or personal information');
    const substitutedCookie = first.cookie.replace(/^inception_entry=/, 'workshop=');
    assert.equal((await fixture.request('/bootstrap', { cookie: substitutedCookie })).body.user, null, 'the scoped entry token cannot authenticate as a normal workshop cookie');
    const reused = await fixture.request('/inception/entry', { method: 'POST', cookie: first.cookie, body: {} });
    assert.equal(reused.body.actorId, first.body.actorId, 'refresh reuses the participant identity');
    const second = await fixture.request('/inception/entry', { method: 'POST', body: {} });
    assert.notEqual(second.body.actorId, first.body.actorId, 'separate browsers receive separate identities');
    const participant = await fixture.store.get('SELECT id,name,email,password,role FROM users WHERE id=?', first.body.actorId);
    assert.equal(participant.role, 'inception_participant');
    assert.equal(participant.password, '', 'no credential is generated');
    assert.match(participant.email, /@participant\.invalid$/);
    assert.equal(Number((await fixture.store.get("SELECT COUNT(*) AS n FROM users WHERE role='inception_participant'")).n), 2, 'entry retries do not create another pseudonym');

    const participantCookie = first.cookie;
    const config = await fixture.request('/inception', { cookie: participantCookie });
    assert.equal(config.status, 200);
    assert.equal(config.body.recordingNoticeRequired, false);
    assert.equal(config.body.recordingAccepted, false, 'organizer authorization does not pretend the participant accepted onsite');
    assert.equal(config.body.recordingAuthorized, true);
    assert.equal(config.body.entryPolicy, 'inception-organizer-informed-v1');
    assert.equal((await fixture.store.get('SELECT user_id FROM user_recording_acknowledgements WHERE user_id=?', first.body.actorId)), undefined, 'organizer policy does not forge an ordinary acknowledgement');
    for (const path of ['/levels', '/attempts', '/team', '/inception/design']) assert.notEqual((await fixture.request(path, { cookie: participantCookie })).status, 200, `${path} remains outside participant scope`);
    assert.equal((await fixture.request('/bootstrap', { cookie: participantCookie })).body.user, null, 'participant identity is not a workshop login');
    const start = await fixture.request('/inception/start', { method: 'POST', cookie: participantCookie, body: { profileId: 'standard', clientStartId: 'participant-start-request-0001' } });
    assert.equal(start.status, 201, JSON.stringify(start.body));
    assert.equal(start.body.round.tester, participant.name);
    const roundId = start.body.round.id;
    assert.equal((await fixture.request(`/rounds/${roundId}`, { headers: { 'x-round-token': start.body.round.accessToken } })).status, 403, 'organizer-policy rounds cannot be read through a bearer token without the scoped participant cookie');
    const roundRow = await fixture.store.get('SELECT author_id,recording_accepted_at,recording_notice_version FROM rounds WHERE id=?', roundId);
    assert.equal(roundRow.author_id, first.body.actorId);
    assert.equal(roundRow.recording_accepted_at, null);
    assert.equal(roundRow.recording_notice_version, 'inception-organizer-informed-v1');
    const savedState = JSON.parse((await fixture.store.get('SELECT state FROM inception_sessions WHERE round_id=?', roundId)).state);
    assert.deepEqual(savedState.recordingPolicy.id, 'inception-organizer-informed-v1');
    assert.ok(Number.isSafeInteger(savedState.recordingPolicy.establishedAt));
    assert.ok(Math.abs(savedState.recordingPolicy.establishedAt - Date.now()) < 5000, 'server records policy establishment time, not claimed offline consent time');
    assert.equal(Number((await fixture.store.get('SELECT COUNT(*) AS n FROM user_recording_acknowledgements WHERE user_id=?', first.body.actorId)).n), 0);

    const reply = await fixture.request(`/rounds/${roundId}/messages`, { method: 'POST', cookie: participantCookie, headers: { 'x-round-token': start.body.round.accessToken }, body: { content: 'Tell me what you remember.', requestId: uuid() } });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    const durable = await fixture.store.get('SELECT actor_id,content,status,transcript_saved FROM durable_submissions WHERE round_id=?', roundId);
    assert.equal(durable.actor_id, first.body.actorId);
    assert.equal(durable.status, 'succeeded');
    assert.equal(durable.transcript_saved, 1);
    assert.equal((await fixture.request(`/rounds/${roundId}/recording`, { cookie: participantCookie })).body.version, 'inception-organizer-informed-v1');

    assert.equal((await fixture.request('/telemetry/session', { method: 'POST', cookie: participantCookie, body: { view: 'workshop' } })).status, 403, 'participant policy cannot open telemetry outside Inception');
    const metricsSession = await fixture.request('/telemetry/session', { method: 'POST', cookie: participantCookie, body: { view: 'inception' } });
    assert.equal(metricsSession.status, 200);
    const combinedCookie = `${participantCookie}; ${metricsSession.cookie}`;
    const event = { eventId: uuid(), tabId: uuid(), pageId: uuid(), roundId, kind: 'heartbeat', view: 'inception', elapsedMs: 1000, activeMs: 500, visibleMs: 1000, idleMs: 500 };
    assert.equal((await fixture.request('/telemetry/events', { method: 'POST', cookie: combinedCookie, body: { sessionId: metricsSession.body.sessionId, events: [event] } })).status, 200);
    assert.equal((await fixture.request('/telemetry/events', { method: 'POST', cookie: combinedCookie, body: { sessionId: metricsSession.body.sessionId, events: [{ ...event, eventId: uuid(), view: 'workshop' }] } })).status, 403, 'participant metrics events cannot use organizer authorization on another view');
    const metricsRecord = await fixture.store.get('SELECT user_id,round_id,view_category FROM metrics_events WHERE event_id=?', event.eventId);
    assert.equal(metricsRecord.user_id, first.body.actorId);
    assert.equal(metricsRecord.round_id, roundId);
    assert.equal(metricsRecord.view_category, 'inception');

    assert.equal((await fixture.request('/telemetry/session', { method: 'POST', cookie: ownerSession.cookie, body: { view: 'workshop' } })).status, 428, 'Inception organizer authorization does not replace the owner’s ordinary recording acknowledgement on workshop telemetry');
    const noRoundConfig = await fixture.request('/orchestration/configs', { method: 'POST', cookie: `${ownerSession.cookie}; ${ownerEntry.cookie}`, body: {} });
    assert.equal(noRoundConfig.status, 201);
    const noRoundRun = await fixture.request(`/orchestration/configs/${noRoundConfig.body.id}/runs`, { method: 'POST', cookie: `${ownerSession.cookie}; ${ownerEntry.cookie}`, body: { testInput: 'recording-scope-check' } });
    assert.equal(noRoundRun.status, 201);
    assert.equal((await fixture.request(`/orchestration/runs/${noRoundRun.body.id}/messages`, { method: 'POST', cookie: `${ownerSession.cookie}; ${ownerEntry.cookie}`, body: { lane: 'A', content: 'This should still require the ordinary acknowledgement.' } })).status, 428, 'an Inception entry cannot bypass no-round recording checks on unrelated models');

    await fixture.request('/recording/acknowledge', { method: 'POST', cookie: ownerSession.cookie, body: { version: 'recording-notice-v1', accepted: true } });
    const regularVersion = await fixture.store.get("SELECT * FROM versions WHERE level_id NOT IN (?, ?) LIMIT 1", 'reference-riddle-diary', 'reference-inception-strongroom');
    const regularRound = await fixture.request(`/levels/${regularVersion.level_id}/rounds`, { method: 'POST', cookie: ownerSession.cookie, body: { versionId: regularVersion.id } });
    assert.equal(regularRound.status, 201);
    assert.equal((await fixture.request(`/rounds/${regularRound.body.id}`, { cookie: participantCookie, headers: { 'x-round-token': regularRound.body.accessToken } })).status, 200, 'restricted Inception identity preserves an existing round-token capability on unrelated rounds');

    assert.equal((await fixture.request(`/inception/rounds/${roundId}/finish`, { method: 'POST', cookie: participantCookie, body: { answer: '' } })).status, 200);
    const review = await fixture.request(`/inception/rounds/${roundId}/review`, { method: 'POST', cookie: participantCookie, body: {} });
    assert.equal(review.status, 200, JSON.stringify(review.body));
    assert.equal(review.body.review.status, 'complete');
    assert.equal((await fixture.store.get('SELECT verdict FROM round_machine_reviews WHERE round_id=?', roundId)).verdict, 'not_recovered', 'judge outcome is saved on the participant-owned round');

    assert.equal((await fixture.request(`/inception/rounds/${roundId}`, { cookie: second.cookie, headers: { 'x-round-token': start.body.round.accessToken } })).status, 403, 'another participant cannot use a known round ID and capability');
    assert.equal((await fixture.request(`/attempts/${roundId}/inception`, { cookie: participantCookie })).status, 401);
    assert.equal((await fixture.request(`/rounds/${roundId}/recording`, { method: 'POST', cookie: participantCookie, body: { version: 'recording-notice-v1', accepted: true } })).status, 403, 'participants cannot replace the organizer policy with a forged checkbox acknowledgement');

    const ownerRoster = await fixture.request('/team', { cookie: ownerSession.cookie });
    assert.equal(ownerRoster.status, 200);
    assert.equal(ownerRoster.body.some(user => user.id === first.body.actorId), false, 'participant identities are excluded from team management');
    const ownerRead = await fixture.request('/levels', { cookie: ownerSession.cookie });
    assert.equal(ownerRead.status, 200, 'owner permissions remain intact');
    assert.equal((await fixture.request('/entry', { method: 'PUT', cookie: ownerSession.cookie, body: { enabled: false } })).status, 200);
    assert.notEqual((await fixture.request('/inception', { cookie: participantCookie })).status, 200, 'revocation invalidates the scoped participant cookie');
    assert.equal((await fixture.request(`/inception/rounds/${roundId}`, { cookie: participantCookie, headers: { 'x-round-token': start.body.round.accessToken } })).status, 403, 'revoked participants cannot keep using an old round token');
    assert.equal((await fixture.request(`/rounds/${roundId}`, { headers: { 'x-round-token': start.body.round.accessToken } })).status, 403, 'revoked organizer rounds remain inaccessible without the scoped cookie');
  } finally { await fixture.close(); }
});

test('root entry does not impose the sign-in IP throttle on a shared attendee network', async () => {
  const fixture = await start('sqlite');
  try {
    await owner(fixture.request);
    const attendees = await Promise.all(Array.from({ length: 100 }, () => fixture.request('/inception/entry', { method: 'POST', body: {} })));
    assert.equal(attendees.filter(result => result.status === 200).length, 100);
    assert.equal(new Set(attendees.map(result => result.body.actorId)).size, 100);
  } finally { await fixture.close(); }
});
