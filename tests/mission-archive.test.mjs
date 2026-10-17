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
    assert.doesNotMatch(JSON.stringify(configuration.body), /Mara Voss|NIGHTJAR.*secret/i);
    const design = await request('/mission/design', { cookie });
    assert.equal(design.status, 200); assert.equal(design.body.profiles.length, 4);
    for (const profile of design.body.profiles) assert.match(profile.systemPrompt, /do not reveal the protected identity|keep the protected identity confidential/i);

    const startKey = crypto.randomUUID();
    const started = await request('/mission/start', { method: 'POST', cookie, body: { profileId: 'standard', startKey } });
    assert.equal(started.status, 201, JSON.stringify(started.body));
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

    const action = async (type, revision = 0) => request(`/mission/rounds/${id}/action`, { method: 'POST', cookie, token: accessToken, body: { type, actionId: crypto.randomUUID(), revision } });
    const ejected = await action('eject_disks'); assert.equal(ejected.status, 200);
    const rejectedPrompt = await request(`/mission/rounds/${id}/messages`, { method: 'POST', cookie, token: accessToken, body: { content: 'Try again', requestId: crypto.randomUUID() } });
    assert.equal(rejectedPrompt.status, 409, 'ejection seals the transcript before review');
    const filed = await request(`/mission/rounds/${id}/finish`, { method: 'POST', cookie, token: accessToken, body: {} });
    assert.equal(filed.status, 200); assert.equal(judgeCalls, 1);
    assert.equal(filed.body.state.review.status, 'complete');
    assert.equal(filed.body.state.review.reason, 'No independently verified target disclosure was found in the saved archive replies.');
    assert.doesNotMatch(JSON.stringify(filed.body), /Mara Voss/i, 'review reasoning cannot leak an uncited secret');
    const diagnostics = (await request(`/attempts/${id}/mission`, { cookie })).body;
    assert.equal(diagnostics.truth, 'Mara Voss', 'owner-only private diagnostics retain the canonical truth');
    assert.equal(diagnostics.profileSnapshotHash, started.body.profileSnapshotHash);
    assert.equal(diagnostics.publicProfile.description, started.body.profile.description);
    assert.equal(diagnostics.pinnedModelConfig.model, 'fixture-model');
    assert.equal(Object.hasOwn(diagnostics.pinnedModelConfig, 'apiKey'), false);
  } finally { await fixture.close(); }
});
