import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createFixture } from './database-fixture.mjs';

const ownerKey = 'metrics-source-test-owner-key';
const provider = { model: 'configured/private-model', baseUrl: 'https://provider.private.test/v1', apiKey: 'test-only-key' };

async function start(adapter, options = {}) {
  const fixture = await createFixture({ adapter, dbPath: ':memory:', provider, ownerKey, metricsEnabled: true, ...options });
  const server = fixture.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const request = async (path, { method = 'GET', body, cookie, token, headers = {} } = {}) => {
    const response = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(token ? { 'x-round-token': token } : {}), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  return { ...fixture, request, async close() { await new Promise(resolve => server.close(resolve)); await fixture.store.db.close(); } };
}

async function owner(request) {
  const result = await request(`/owner/${ownerKey}`, { method: 'POST', body: { name: 'Metrics source owner' } });
  assert.equal(result.status, 200);
  return result.cookie;
}

async function createOrchestrationRun(request, cookie) {
  const config = await request('/orchestration/configs', { method: 'POST', cookie, body: {} });
  assert.equal(config.status, 201);
  const run = await request(`/orchestration/configs/${config.body.id}/runs`, {
    method: 'POST', cookie, body: { testInput: 'A controlled source attribution scenario.' },
  });
  assert.equal(run.status, 201);
  return run.body;
}

for (const adapter of ['sqlite', 'pglite']) test(`${adapter}: route call sites record trusted passport, collection, and orchestration source context`, async () => {
  const providerInputs = [];
  let failNextPassportCall = true;
  const fixture = await start(adapter, {
    completion: async input => {
      providerInputs.push(input);
      if (input.system.includes('fictional passenger') && failNextPassportCall) {
        failNextPassportCall = false;
        throw Object.assign(new Error('Fixture provider rate limit'), { status: 429, providerCode: 'rate_limited' });
      }
      return {
        text: `Controlled reply ${providerInputs.length}.`,
        model: 'returned/fixture-model',
        latencyMs: 7,
        usage: 13,
        usageDetails: { inputTokens: 8, outputTokens: 5, totalTokens: 13 },
      };
    },
  });

  try {
    const cookie = await owner(fixture.request);
    const ownerId = (await fixture.request('/bootstrap', { cookie })).body.user.id;

    // The passport route derives version/source/actor from its stored round. Extra caller labels are ignored.
    const passport = await fixture.request('/reference/start', { method: 'POST', cookie });
    assert.equal(passport.status, 201);
    const passportPath = `/reference/rounds/${passport.body.round.id}/messages`;
    const passportBody = { content: 'Who owns these papers?', profileId: 'spoofed-profile', source: 'participant', model: 'spoofed-model', versionId: 'spoofed-version' };
    const passportFailure = await fixture.request(passportPath, { method: 'POST', cookie, token: passport.body.round.accessToken, body: passportBody });
    assert.equal(passportFailure.status, 429);
    const passportReply = await fixture.request(passportPath, { method: 'POST', cookie, token: passport.body.round.accessToken, body: passportBody });
    assert.equal(passportReply.status, 200);
    assert.equal(passportReply.body.round.messages.at(-1).content, 'Controlled reply 2.');
    assert.equal('metricsCallId' in passportReply.body.round, false);
    assert.equal('profileId' in passportReply.body, false);

    // A single frozen collection profile makes participant allocation deterministic while preview and participant
    // calls traverse their real, separate routes.
    const collection = await fixture.request('/collections', {
      method: 'POST', cookie,
      body: {
        levelId: 'reference-passport-desk', versionId: 'reference-passport-desk-v1',
        profiles: [{ id: 'trusted-profile', label: 'Trusted profile', notes: '', moduleIds: ['secret-boundary'], additionalInstructions: '' }],
      },
    });
    assert.equal(collection.status, 201, JSON.stringify(collection.body));
    const collectionId = collection.body.id;
    const preview = await fixture.request(`/collections/${collectionId}/previews`, {
      method: 'POST', cookie,
      body: { profileId: 'trusted-profile', source: 'participant', model: 'spoofed-model', collectionId: 'spoofed-collection' },
    });
    assert.equal(preview.status, 201);
    const previewPath = `/reference/rounds/${preview.body.round.id}/messages`;
    const previewReply = await fixture.request(previewPath, {
      method: 'POST', cookie, token: preview.body.round.accessToken,
      body: { content: 'A preview question.', profileId: 'spoofed-profile', source: 'participant', model: 'spoofed-model' },
    });
    assert.equal(previewReply.status, 200);
    assert.equal(previewReply.body.round.messages.at(-1).content, 'Controlled reply 3.');

    const link = await fixture.request(`/collections/${collectionId}/links`, { method: 'POST', cookie, body: {} });
    assert.equal(link.status, 201);
    const rawLink = link.body.path.split('/').at(-1);
    const participant = await fixture.request(`/collect/${rawLink}`, {
      method: 'POST', body: { tester: 'Fixture participant', consent: true, startKey: randomUUID() },
    });
    assert.equal(participant.status, 201);
    const participantPath = `/reference/rounds/${participant.body.round.id}/messages`;
    const participantReply = await fixture.request(participantPath, {
      method: 'POST', token: participant.body.round.accessToken,
      body: { content: 'A participant question.', profileId: 'spoofed-profile', source: 'preview', model: 'spoofed-model', collectionId: 'spoofed-collection' },
    });
    assert.equal(participantReply.status, 200);
    assert.equal(participantReply.body.round.messages.at(-1).content, 'Controlled reply 4.');
    assert.equal(participantReply.body.round.model, undefined);
    assert.equal(participantReply.body.round.versionId, undefined);

    const run = await createOrchestrationRun(fixture.request, cookie);
    const orchestrationReply = await fixture.request(`/orchestration/runs/${run.id}/messages`, {
      method: 'POST', cookie,
      body: { lane: 'A', content: 'An orchestration question.', source: 'participant', profileId: 'spoofed-profile', model: 'spoofed-model' },
    });
    assert.equal(orchestrationReply.status, 200);
    assert.equal(orchestrationReply.body.messages.at(-1).content, 'Controlled reply 5.');

    const calls = await fixture.store.all(`SELECT context_kind, round_id, orchestration_run_id, lane, actor_user_id, actor_role,
      collection_id, profile_id, source, version_id, requested_model, returned_model, provider_host, status, error_category,
      started_at, completed_at, input_tokens, output_tokens, total_tokens, latency_ms, transcript_saved
      FROM metrics_model_calls ORDER BY started_at, id`);
    assert.equal(calls.length, 5);
    const passportCalls = calls.filter(call => call.round_id === passport.body.round.id);
    const passportFailed = passportCalls.find(call => call.status === 'failed');
    const passportSaved = passportCalls.find(call => call.status === 'succeeded');
    const previewSaved = calls.find(call => call.round_id === preview.body.round.id);
    const participantSaved = calls.find(call => call.round_id === participant.body.round.id);
    const orchestrationSaved = calls.find(call => call.orchestration_run_id === run.id);
    assert.ok(passportFailed && passportSaved && previewSaved && participantSaved && orchestrationSaved);
    assert.deepEqual([passportFailed.status, passportFailed.error_category], ['failed', 'rate_limited']);
    assert.ok(passportFailed.started_at > 0);
    assert.ok(passportFailed.completed_at >= passportFailed.started_at);
    assert.equal(passportFailed.requested_model, provider.model);
    assert.equal(passportFailed.returned_model, null);
    assert.equal(passportFailed.provider_host, 'provider.private.test');
    assert.deepEqual([passportFailed.input_tokens, passportFailed.output_tokens, passportFailed.total_tokens], [null, null, null]);
    assert.ok(passportFailed.latency_ms >= 0);
    assert.equal(passportFailed.transcript_saved, 0);
    for (const call of [passportSaved, previewSaved, participantSaved, orchestrationSaved]) {
      assert.equal(call.status, 'succeeded');
      assert.equal(call.requested_model, provider.model);
      assert.equal(call.returned_model, 'returned/fixture-model');
      assert.equal(call.provider_host, 'provider.private.test');
      assert.deepEqual([call.input_tokens, call.output_tokens, call.total_tokens], [8, 5, 13]);
      assert.ok(call.latency_ms >= 0);
      assert.equal(call.transcript_saved, 1);
    }

    assert.deepEqual([passportSaved.context_kind, passportSaved.round_id, passportSaved.source, passportSaved.version_id],
      ['round', passport.body.round.id, 'diagnostic', 'reference-passport-desk-v1']);
    assert.equal(passportSaved.actor_user_id, ownerId);
    assert.equal(passportSaved.actor_role, 'admin');
    assert.equal(passportSaved.collection_id, null);
    assert.equal(passportSaved.profile_id, null);
    assert.deepEqual([previewSaved.round_id, previewSaved.source, previewSaved.collection_id, previewSaved.profile_id],
      [preview.body.round.id, 'preview', collectionId, 'trusted-profile']);
    assert.equal(previewSaved.actor_user_id, ownerId);
    assert.equal(previewSaved.actor_role, 'admin');
    assert.deepEqual([participantSaved.round_id, participantSaved.source, participantSaved.collection_id, participantSaved.profile_id],
      [participant.body.round.id, 'participant', collectionId, 'trusted-profile']);
    assert.equal(participantSaved.actor_user_id, null);
    assert.equal(participantSaved.actor_role, null);
    assert.deepEqual([orchestrationSaved.context_kind, orchestrationSaved.round_id, orchestrationSaved.orchestration_run_id,
      orchestrationSaved.lane, orchestrationSaved.source, orchestrationSaved.actor_user_id, orchestrationSaved.actor_role],
    ['orchestration', null, run.id, 'A', null, ownerId, 'admin']);

    assert.equal(providerInputs.some(input => Object.hasOwn(input, 'metricsContext')), false, 'trusted instrumentation context stays out of provider input');
    const apiCalls = await fixture.request('/metrics/calls', { cookie });
    assert.equal(apiCalls.status, 200);
    assert.equal(apiCalls.body.items.length, 5);
    assert.deepEqual(apiCalls.body.items.find(item => item.context.roundId === participant.body.round.id).context,
      { kind: 'round', roundId: participant.body.round.id, runId: null, lane: null, userId: null, userRole: null, collectionId, profileId: 'trusted-profile', source: 'participant', versionId: 'reference-passport-desk-v1' });
    const summary = await fixture.request(`/metrics/summary?from=${Date.now() - 60000}`, { cookie });
    assert.equal(summary.status, 200);
    assert.equal(summary.body.bySource.find(item => item.source === 'orchestration')?.calls, 1);
    const publicReplyJson = JSON.stringify([passportReply.body, previewReply.body, participantReply.body, orchestrationReply.body]);
    assert.equal(publicReplyJson.includes('metricsCallId'), false);
    assert.equal(publicReplyJson.includes('spoofed-model'), false);
  } finally {
    await fixture.close();
  }
});

for (const adapter of ['sqlite', 'pglite']) test(`${adapter}: metrics persistence failures at a real round route preserve completion and transcript`, async () => {
  let rejectMetrics = true;
  const fixture = await start(adapter, {
    wrapStore(store) {
      return {
        ...store,
        async get(sql, ...args) {
          if (rejectMetrics && sql.includes('metrics_model_calls')) throw new Error('fixture metrics read outage');
          return store.get(sql, ...args);
        },
        async run(sql, ...args) {
          if (rejectMetrics && sql.includes('metrics_model_calls')) throw new Error('fixture metrics write outage');
          return store.run(sql, ...args);
        },
      };
    },
    completion: async input => ({ text: 'The saved answer remains available.', model: input.config.model, usage: 6, latencyMs: 4 }),
  });

  try {
    const cookie = await owner(fixture.request);
    const levels = (await fixture.request('/levels', { cookie })).body;
    const level = levels[0];
    const detail = await fixture.request(`/levels/${level.id}`, { cookie });
    const round = await fixture.request(`/levels/${level.id}/rounds`, {
      method: 'POST', cookie, body: { versionId: detail.body.versions[0].id },
    });
    assert.equal(round.status, 201);
    const reply = await fixture.request(`/rounds/${round.body.id}/messages`, {
      method: 'POST', token: round.body.accessToken, body: { content: 'A normal question.' },
    });
    assert.equal(reply.status, 200);
    assert.equal(reply.body.messages.at(-1).content, 'The saved answer remains available.');
    assert.equal(reply.body.messages.at(-1).usage, 6);
    assert.equal('metricsCallId' in reply.body.messages.at(-1), false);
    const saved = await fixture.store.get('SELECT messages FROM rounds WHERE id = ?', round.body.id);
    assert.match(saved.messages, /The saved answer remains available\./);
    rejectMetrics = false;
    assert.equal(Number((await fixture.store.get('SELECT COUNT(*) AS count FROM metrics_model_calls')).count), 0);
  } finally {
    await fixture.close();
  }
});
