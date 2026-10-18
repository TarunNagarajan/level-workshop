import { test } from 'node:test';
import assert from 'node:assert/strict';
import { complete, buildGeminiCompletionBody, GEMINI_BASE_URL, GEMINI_MODEL } from '../server/model.mjs';
import { inceptionProviderCapacity } from '../server/inception-capacity.mjs';
import { openStore } from '../server/store.mjs';
import { createFixture } from './database-fixture.mjs';
import { randomUUID } from 'node:crypto';

const primary = { model: 'groq-model', baseUrl: 'https://api.groq.com/openai/v1', apiKey: 'groq-secret', reasoningEffort: 'low' };

test('native Gemini adapter maps messages, excludes thought text, and keeps credentials out of URL and body', async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url: String(url), ...options };
    return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'Visible reply' }, { text: 'hidden thought', thought: true }] } }], usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 3, totalTokenCount: 15 } });
  };
  try {
    const messages = [{ role: 'user', content: 'first' }, { role: 'assistant', content: 'answer' }, { role: 'hint', content: 'discard' }, { role: 'system', content: 'discard' }];
    const result = await complete({ config: { providerId: 'google-gemini', model: GEMINI_MODEL, baseUrl: GEMINI_BASE_URL, apiKey: 'gemini-secret' }, system: 'system prompt', messages, temperature: 0.2 });
    assert.equal(result.text, 'Visible reply');
    assert.deepEqual(result.usageDetails, { inputTokens: 12, outputTokens: 3, totalTokens: 15 });
    assert.equal(request.url, `${GEMINI_BASE_URL}/models/${GEMINI_MODEL}:generateContent`);
    assert.equal(request.headers['x-goog-api-key'], 'gemini-secret');
    assert.doesNotMatch(request.url + request.body, /gemini-secret/);
    const body = JSON.parse(request.body);
    assert.deepEqual(body.contents, [{ role: 'user', parts: [{ text: 'first' }] }, { role: 'model', parts: [{ text: 'answer' }] }]);
    assert.deepEqual(body.systemInstruction, { parts: [{ text: 'system prompt' }] });
    assert.deepEqual(body.generationConfig.thinkingConfig, { thinkingLevel: 'MINIMAL' });
    assert.equal(body.generationConfig.maxOutputTokens, 2048);
    const judgeSchema = { type: 'OBJECT', properties: { verdict: { type: 'STRING', enum: ['recovered', 'partial', 'not_recovered', 'uncertain'] }, reason: { type: 'STRING' }, evidence: { type: 'ARRAY', items: { type: 'STRING' }, maxItems: 6 } }, required: ['verdict', 'reason', 'evidence'] };
    const judgeBody = buildGeminiCompletionBody({ system: 'judge', messages, temperature: 0, responseSchema: judgeSchema });
    assert.equal(judgeBody.generationConfig.responseMimeType, 'application/json');
    assert.deepEqual(judgeBody.generationConfig.responseSchema, judgeSchema);
    assert.equal(judgeBody.generationConfig.temperature, 0);
    assert.deepEqual(buildGeminiCompletionBody({ system: 's', messages }), { ...body, systemInstruction: { parts: [{ text: 's' }] }, generationConfig: { temperature: 0.7, maxOutputTokens: 2048, thinkingConfig: { thinkingLevel: 'MINIMAL' } } });
  } finally { globalThis.fetch = originalFetch; }
});

test('native Gemini adapter rejects HTTP 200 error payloads, truncation, and quota errors with bounded retry', async () => {
  const originalFetch = globalThis.fetch;
  const config = { providerId: 'google-gemini', model: GEMINI_MODEL, baseUrl: GEMINI_BASE_URL, apiKey: 'secret' };
  try {
    globalThis.fetch = async () => Response.json({ error: { code: 503, message: 'unavailable' } });
    await assert.rejects(complete({ config, system: 's', messages: [] }), error => error.providerCode === 'provider_unavailable');
    globalThis.fetch = async () => Response.json({ candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: 'partial' }] } }] });
    await assert.rejects(complete({ config, system: 's', messages: [] }), error => error.providerCode === 'provider_rejected');
    globalThis.fetch = async () => new Response(JSON.stringify({ error: { code: 429, details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '2.5s' }, { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [] }] } }), { status: 429 });
    await assert.rejects(complete({ config, system: 's', messages: [] }), error => error.providerCode === 'rate_limited' && error.retryAfterSeconds === 3 && error.rateLimitScope === 'unknown');
  } finally { globalThis.fetch = originalFetch; }
});

test('prestart policy treats unknown or low Groq daily quota conservatively and shares observations through SQLite', async () => {
  const store = openStore(':memory:');
  const env = { INCEPTION_AUTO_PROVIDER: 'true', GEMINI_API_KEY: 'gemini-secret' };
  const capacity = inceptionProviderCapacity({ store, primary, env });
  try {
    const first = await capacity.selectForStart();
    assert.equal(first.config.providerId, 'google-gemini');
    assert.equal(first.reason, 'primary_daily_unknown');
    await capacity.observe('groq', { error: Object.assign(new Error('limit'), { providerCode: 'rate_limited', rateLimitScope: 'tokens_daily', quota: { limit: 200000, used: 199621 } }) });
    const second = await inceptionProviderCapacity({ store, primary, env }).selectForStart();
    assert.equal(second.reason, 'primary_daily_low');
    assert.equal(second.config.providerId, 'google-gemini');
    const status = await capacity.status();
    assert.equal(status.applicationOperatingTargetTokensPerDay, 1_200_000);
    assert.equal(status.providers.groq.dailyHeadroom, 379);
    assert.equal(status.providers['google-gemini'].dailyHeadroomStatus, 'unknown');
    assert.equal(JSON.stringify(status).includes('gemini-secret'), false);
    assert.equal(JSON.stringify(status).includes('groq-secret'), false);
    await store.run('INSERT INTO inception_provider_health (provider_id,observed_at,daily_limit,daily_used,daily_observed_at,app_tokens_today,app_usage_day) VALUES (?,?,?,?,?,?,?) ON CONFLICT(provider_id) DO UPDATE SET daily_limit=excluded.daily_limit,daily_used=excluded.daily_used,daily_observed_at=excluded.daily_observed_at', 'groq', Date.now(), 2_000_000, 100, Date.now(), 0, new Date().toISOString().slice(0, 10));
    assert.equal((await capacity.selectForStart()).config.providerId, 'groq');
  } finally { store.db.close(); }
});

test('frozen provider resolution never sends a key to a changed host or model', async () => {
  const store = openStore(':memory:');
  const capacity = inceptionProviderCapacity({ store, primary, env: { GEMINI_API_KEY: 'gemini-secret' } });
  try {
    assert.equal(capacity.credentialsForFrozen({ providerId: 'google-gemini', model: GEMINI_MODEL, baseUrl: GEMINI_BASE_URL }).apiKey, 'gemini-secret');
    assert.equal(capacity.credentialsForFrozen({ model: primary.model, baseUrl: primary.baseUrl }).apiKey, 'groq-secret');
    assert.throws(() => capacity.credentialsForFrozen({ providerId: 'google-gemini', model: GEMINI_MODEL, baseUrl: 'https://attacker.invalid/v1' }), /connection/);
    assert.throws(() => capacity.credentialsForFrozen({ providerId: 'groq', model: 'other', baseUrl: primary.baseUrl }), /connection/);
  } finally { store.db.close(); }
});

async function routeHarness({ blocked = false } = {}) {
  const calls = [];
  const fixture = await createFixture({
    recordingNoticeRequired: true, passportReviewEnabled: true,
    provider: primary, env: { INCEPTION_AUTO_PROVIDER: 'true', GEMINI_API_KEY: 'gemini-secret' },
    completion: async input => {
      calls.push(input);
      return { text: input.responseSchema ? '{"verdict":"not_recovered","reason":"No disclosure.","evidence":[]}' : 'A saved reply.', model: input.config.model, latencyMs: 1, usage: 10, usageDetails: { inputTokens: 8, outputTokens: 2, totalTokens: 10 } };
    },
  });
  if (blocked) await fixture.store.run('INSERT INTO inception_provider_health (provider_id,observed_at,blocked_until) VALUES (?,?,?)', 'google-gemini', Date.now(), Date.now() + 15_000);
  const server = fixture.app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}/api`;
  const request = async (path, { method = 'GET', body, cookie } = {}) => {
    const response = await fetch(origin + path, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  return { ...fixture, request, calls, close: async () => { await new Promise(resolve => server.close(resolve)); await fixture.store.db?.close?.(); } };
}

test('selected Inception rounds route target and judge through the frozen provider and keep secrets out of round data', async () => {
  const fixture = await routeHarness();
  try {
    const owner = (await fixture.request('/setup', { method: 'POST', body: { name: 'Owner', email: `cap-${randomUUID()}@example.test`, password: 'long-test-password' } })).cookie;
    await fixture.request('/recording/acknowledge', { method: 'POST', cookie: owner, body: { version: 'recording-notice-v1', accepted: true } });
    const started = await fixture.request('/inception/start', { method: 'POST', cookie: owner, body: { profileId: 'standard', clientStartId: randomUUID().replaceAll('-', ''), consent: true } });
    assert.equal(started.status, 201, JSON.stringify(started.body));
    const roundId = started.body.round.id;
    const frozen = JSON.parse((await fixture.store.get('SELECT config FROM rounds WHERE id=?', roundId)).config);
    assert.equal(frozen.providerId, 'google-gemini');
    assert.equal(frozen.selectionReason, 'primary_daily_unknown');
    assert.doesNotMatch(JSON.stringify(frozen), /secret/);
    await fixture.request(`/rounds/${roundId}/messages`, { method: 'POST', cookie: owner, body: { content: 'What do you remember?', requestId: randomUUID() } });
    await fixture.request(`/inception/rounds/${roundId}/finish`, { method: 'POST', cookie: owner, body: { answer: 'done' } });
    await fixture.request(`/inception/rounds/${roundId}/review`, { method: 'POST', cookie: owner, body: {} });
    assert.equal(fixture.calls.length, 2);
    assert.deepEqual(fixture.calls.map(call => call.config.providerId), ['google-gemini', 'google-gemini']);
    assert.deepEqual(fixture.calls.map(call => call.config.apiKey), ['gemini-secret', 'gemini-secret']);
    assert.equal(fixture.calls[0].config.model, GEMINI_MODEL);
    assert.equal(fixture.calls[1].temperature, 0);
    assert.equal(fixture.calls[1].responseSchema.properties.evidence.maxItems, 6);
    assert.equal(JSON.stringify(await fixture.store.get('SELECT config FROM rounds WHERE id=?', roundId)).includes('gemini-secret'), false);
    const status = await fixture.request('/inception/provider-status', { cookie: owner });
    assert.equal(status.status, 200);
    assert.equal(status.body.providers['google-gemini'].dailyHeadroomStatus, 'unknown');
  } finally { await fixture.close(); }
});

test('known blocked fallback rejects prestart with retry metadata and allocates no round', async () => {
  const fixture = await routeHarness({ blocked: true });
  try {
    const owner = (await fixture.request('/setup', { method: 'POST', body: { name: 'Owner', email: `cap-${randomUUID()}@example.test`, password: 'long-test-password' } })).cookie;
    await fixture.request('/recording/acknowledge', { method: 'POST', cookie: owner, body: { version: 'recording-notice-v1', accepted: true } });
    const response = await fixture.request('/inception/start', { method: 'POST', cookie: owner, body: { profileId: 'standard', clientStartId: randomUUID().replaceAll('-', ''), consent: true } });
    assert.equal(response.status, 429, JSON.stringify(response.body));
    assert.equal(response.body.failureCode, 'rate_limited');
    assert.ok(response.body.retryAfterSeconds > 0 && response.body.retryAfterSeconds <= 15);
    assert.equal((await fixture.store.get("SELECT COUNT(*) AS n FROM rounds WHERE source='inception-play'")).n, 0);
  } finally { await fixture.close(); }
});

test('PGlite stores fallback backoff for a second server instance', async () => {
  const fixture = await createFixture({ adapter: 'pglite' });
  const env = { INCEPTION_AUTO_PROVIDER: 'true', GEMINI_API_KEY: 'gemini-secret' };
  try {
    const first = inceptionProviderCapacity({ store: fixture.store, primary, env });
    await first.observe('google-gemini', { error: Object.assign(new Error('quota'), { providerCode: 'rate_limited', retryAfterSeconds: 90 }) });
    const restarted = inceptionProviderCapacity({ store: fixture.store, primary, env });
    await assert.rejects(restarted.selectForStart(), error => error.status === 429 && error.retryAfterSeconds > 0);
  } finally { await fixture.store.db.close(); }
});
