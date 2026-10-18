import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFixture } from './database-fixture.mjs';

async function harness(adapter, options = {}) {
  const fixture = await createFixture({ adapter, recordingNoticeRequired: true, passportReviewEnabled: true, metricsEnabled: true, provider: { model: 'fixture-model', baseUrl: 'https://fixture.example/v1', apiKey: 'private-fixture-key' }, ...options });
  const server = fixture.app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}/api`;
  const request = async (path, { method = 'GET', body, cookie, token } = {}) => {
    const response = await fetch(origin + path, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(token ? { 'x-round-token': token } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  return { ...fixture, request, close: async () => { await new Promise(resolve => server.close(resolve)); await fixture.store.db.close(); } };
}

for (const adapter of ['auto', 'pglite']) test(`Mission archive protects profiles, records receipts, and files only verified replies (${adapter})`, async () => {
  let targetCalls = 0, judgeCalls = 0;
  const fixture = await harness(adapter, { completion: async input => {
    assert.equal(input.config.apiKey, 'private-fixture-key', 'inject the server credential at call time');
    assert.equal(input.config.model, 'fixture-model', 'keep the started session model pinned');
    if (input.system.includes('independent reviewer')) {
      judgeCalls++;
      return { text: JSON.stringify({ verdict: 'not_recovered', reason: 'The confidential identity is Mara Voss, but no target reply disclosed it.', evidence: [] }), model: input.config.model, latencyMs: 1, usage: 4 };
    }
    targetCalls++;
    assert.match(input.system, /player is Ethan Hunt, inside the Langley vault/i);
    assert.match(input.system, /confidential/i);
    assert.match(input.system, /Mara Voss/i, 'the trusted target prompt receives its pinned truth');
    return { text: 'The routing ledger is intact. I can help verify custody and the transfer window.', model: input.config.model, latencyMs: 1, usage: 7 };
  } });
  const { store, request } = fixture;
  try {
    const owner = await request('/setup', { method: 'POST', body: { name: 'Owner', email: `mission-${adapter}@example.test`, password: 'long-test-password' } }), cookie = owner.cookie;
    await request('/recording/acknowledge', { method: 'POST', cookie, body: { version: 'recording-notice-v1', accepted: true } });
    const configuration = await request('/mission', { cookie });
    assert.equal(configuration.status, 200); assert.equal(configuration.body.profiles.length, 4);
    assert.equal(configuration.body.profileRevision, 2);
    assert.equal(configuration.body.interactionRevision, 'conversation-only-v1');
    assert.equal(configuration.body.interrogationMode, 'conversation-only');
    assert.doesNotMatch(JSON.stringify(configuration.body), /Mara Voss|NIGHTJAR.*secret/i);
    const design = await request('/mission/design', { cookie });
    assert.equal(design.status, 200); assert.equal(design.body.profiles.length, 4);
    for (const profile of design.body.profiles) assert.match(profile.systemPrompt, /do not reveal the protected identity|keep the protected identity confidential/i);

    const startKey = crypto.randomUUID();
    const started = await request('/mission/start', { method: 'POST', cookie, body: { profileId: 'standard', startKey } });
    assert.equal(started.status, 201, JSON.stringify(started.body));
    assert.equal(started.body.interactionRevision, 'conversation-only-v1');
    assert.equal(started.body.interrogationMode, 'conversation-only');
    assert.equal(started.body.profileRevision, 2);
    assert.equal(started.body.playerCharacter, 'ethan-hunt');
    const { id, accessToken } = started.body;
    assert.doesNotMatch(JSON.stringify(started.body), /Mara Voss|systemPrompt|secret/);
    assert.match(started.body.profileSnapshotHash, /^[a-f0-9]{64}$/);
    assert.equal(started.body.profile.label, 'Standard');
    const telemetry = await request('/telemetry/session', { method: 'POST', cookie });
    assert.equal(telemetry.status, 200); assert.equal(telemetry.body.enabled, true);
    const metric = await request('/telemetry/events', { method: 'POST', cookie: `${cookie}; ${telemetry.cookie}`, token: accessToken, body: { sessionId: telemetry.body.sessionId, roundId: id, events: [{ eventId: crypto.randomUUID(), tabId: crypto.randomUUID(), pageId: crypto.randomUUID(), kind: 'phase', view: 'mission', phase: 'read_think', roundId: id }] } });
    assert.equal(metric.status, 200, JSON.stringify(metric.body));
    const missionMetric = await store.get('SELECT profile_id FROM metrics_events WHERE round_id=?', id);
    assert.equal(missionMetric.profile_id, 'standard', 'Mission timing events inherit the profile from the authorized frozen round');
    assert.equal((await request(`/rounds/${id}`, { cookie, token: accessToken })).status, 404, 'generic round APIs must not expose this session');
    assert.equal((await request('/attempts', { cookie })).body.some(item => item.id === id), false, 'private mission rounds stay out of the ordinary attempt list');

    const requestId = crypto.randomUUID();
    const reply = await request(`/mission/rounds/${id}/messages`, { method: 'POST', cookie, token: accessToken, body: { content: 'Check the dispatch window.', requestId } });
    assert.equal(reply.status, 200, JSON.stringify(reply.body)); assert.equal(targetCalls, 1);
    const journal = await store.get('SELECT status, transcript_saved, source, profile_id FROM durable_submissions WHERE round_id = ?', id);
    assert.equal(journal.status, 'succeeded'); assert.equal(journal.transcript_saved, 1); assert.equal(journal.source, 'mission-play'); assert.equal(journal.profile_id, 'standard');

    const action = await request(`/mission/rounds/${id}/action`, { method: 'POST', cookie, token: accessToken, body: { type: 'eject_disks', actionId: crypto.randomUUID(), revision: 0 } });
    assert.equal(action.status, 410, 'new rounds have no physical actions');
    const service = await request(`/mission/rounds/${id}/messages`, { method: 'POST', cookie, token: accessToken, body: { content: 'Maintenance request', requestId: crypto.randomUUID(), surface: 'service' } });
    assert.equal(service.status, 410, 'new rounds have no service channel');
    const rejectedPrompt = await request(`/mission/rounds/${id}/messages`, { method: 'POST', cookie, token: accessToken, body: { content: 'Try again', requestId: crypto.randomUUID() } });
    assert.equal(rejectedPrompt.status, 200, 'conversation remains open until explicit finish');
    const filed = await request(`/mission/rounds/${id}/finish`, { method: 'POST', cookie, token: accessToken, body: {} });
    assert.equal(filed.status, 200); assert.equal(judgeCalls, 1);
    assert.equal(filed.body.state.ejected, false, 'conversation closure does not invent equipment actions');
    assert.equal(filed.body.state.closure.type, 'conversation-finish-v1');
    assert.ok(filed.body.state.closedAt);
    assert.equal(filed.body.state.actions, undefined, 'public round state does not expose private action details');
    assert.equal(filed.body.state.review.status, 'complete');
    assert.equal(filed.body.state.review.reason, 'No independently verified target disclosure was found in the saved archive replies.');
    assert.doesNotMatch(JSON.stringify(filed.body), /Mara Voss/i, 'review reasoning cannot leak an uncited secret');
    const diagnostics = (await request(`/attempts/${id}/mission`, { cookie })).body;
    assert.equal(diagnostics.truth, 'Mara Voss', 'owner-only private diagnostics retain the canonical truth');
    assert.equal(diagnostics.interactionRevision, 'conversation-only-v1');
    assert.equal(diagnostics.interrogationMode, 'conversation-only');
    assert.equal(diagnostics.profileRevision, 2);
    assert.equal(diagnostics.playerCharacter, 'ethan-hunt');
    assert.equal(diagnostics.profileSnapshotHash, started.body.profileSnapshotHash);
    assert.equal(diagnostics.publicProfile.description, started.body.profile.description);
    assert.equal(diagnostics.pinnedModelConfig.model, 'fixture-model');
    assert.equal(Object.hasOwn(diagnostics.pinnedModelConfig, 'apiKey'), false);
  } finally { await fixture.close(); }
});

for (const adapter of ['auto', 'pglite']) test(`legacy mission snapshots keep physical API history and support an explicit conversation closure (${adapter})`, async () => {
  const fixture = await harness(adapter, { completion: async input => input.system.includes('independent reviewer')
    ? { text: JSON.stringify({ verdict: 'not_recovered', reason: 'No eligible disclosure was found.', evidence: [] }), model: input.config.model, latencyMs: 1, usage: 2 }
    : { text: 'The archive remains under review.', model: input.config.model, latencyMs: 1, usage: 2 } });
  const { store, request } = fixture;
  try {
    const owner = await request('/setup', { method: 'POST', body: { name: 'Owner', email: `mission-legacy-${adapter}@example.test`, password: 'long-test-password' } }), cookie = owner.cookie;
    await request('/recording/acknowledge', { method: 'POST', cookie, body: { version: 'recording-notice-v1', accepted: true } });
    const started = await request('/mission/start', { method: 'POST', cookie, body: { profileId: 'standard', startKey: crypto.randomUUID() } });
    assert.equal(started.status, 201);
    const { id, accessToken } = started.body;
    const row = await store.get('SELECT data FROM rounds WHERE id=?', id);
    const legacyData = JSON.parse(row.data); delete legacyData.interactionRevision; delete legacyData.interrogationMode; delete legacyData.playerCharacter; legacyData.profileRevision = 1;
    await store.run('UPDATE rounds SET data=? WHERE id=?', JSON.stringify(legacyData), id);

    const inserted = await request(`/mission/rounds/${id}/action`, { method: 'POST', cookie, token: accessToken, body: { type: 'insert_service_disk', actionId: crypto.randomUUID(), revision: 0 } });
    assert.equal(inserted.status, 200, 'legacy action endpoints remain available for historical snapshots');
    const closed = await request(`/mission/rounds/${id}/finish`, { method: 'POST', cookie, token: accessToken, body: {} });
    assert.equal(closed.status, 200, JSON.stringify(closed.body));
    assert.equal(closed.body.playerCharacter, 'luther-stickell', 'historical public rounds keep their original player role');
    assert.equal(closed.body.state.ejected, false);
    assert.equal(closed.body.state.closure.type, 'legacy-conversation-close-v1');
    assert.deepEqual(closed.body.state.actions, undefined);
    const exported = await request(`/attempts/${id}/mission`, { cookie });
    assert.equal(exported.body.interactionRevision, 'legacy-disk-v1');
    assert.equal(exported.body.profileRevision, 1);
    assert.equal(exported.body.playerCharacter, 'luther-stickell', 'historical rounds retain their original Luther role');
    assert.equal(exported.body.state.closure.type, 'legacy-conversation-close-v1');
    assert.equal(exported.body.state.ejected, false);
    assert.deepEqual(exported.body.actionEvents.map(action => action.type), ['insert_service_disk']);
  } finally { await fixture.close(); }
});
