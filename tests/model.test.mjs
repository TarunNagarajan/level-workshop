import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCompletionBody, complete } from '../server/model.mjs';

test('provider request builder matches the actual fetch body for a Groq GPT-OSS call', async () => {
  const priorFetch = globalThis.fetch;
  let captured;
  globalThis.fetch = async (url, init) => {
    captured = { url, init };
    return { ok: true, json: async () => ({ choices: [{ message: { content: '  north  ' } }], model: 'openai/gpt-oss-20b' }) };
  };
  try {
    const config = { model: 'openai/gpt-oss-20b', baseUrl: 'https://api.groq.com/openai/v1/', apiKey: 'fixture-key' };
    const input = { config, system: 'Private codebook.', messages: [
      { role: 'user', content: 'Case 7' }, { role: 'tool', content: 'ignored unsupported role' }, { role: 'assistant', content: 'Awaiting color.' },
    ], temperature: 0.3 };
    const result = await complete(input);
    assert.equal(captured.url, 'https://api.groq.com/openai/v1/chat/completions');
    assert.deepEqual(JSON.parse(captured.init.body), buildCompletionBody(input));
    assert.deepEqual(JSON.parse(captured.init.body), {
      model: 'openai/gpt-oss-20b', messages: [
        { role: 'system', content: 'Private codebook.' },
        { role: 'user', content: 'Case 7' },
        { role: 'assistant', content: 'Awaiting color.' },
      ], temperature: 0.3, max_completion_tokens: 2048, stream: false, reasoning_effort: 'low', include_reasoning: false,
    });
    assert.equal(result.text, 'north');
  } finally { globalThis.fetch = priorFetch; }
});

test('non-Groq provider body omits Groq-specific reasoning switches', () => {
  const body = buildCompletionBody({ config: { model: 'fixture-model', baseUrl: 'https://example.test/v1' }, system: 'System', messages: [], temperature: 0.1 });
  assert.equal('reasoning_effort' in body, false);
  assert.equal('include_reasoning' in body, false);
});

test('Groq GPT-OSS request records the frozen reasoning effort', () => {
  const body = buildCompletionBody({ config: { model: 'openai/gpt-oss-20b', baseUrl: 'https://api.groq.com/openai/v1', reasoningEffort: 'medium' }, system: 'System', messages: [], temperature: 0.1 });
  assert.equal(body.reasoning_effort, 'medium');
});

test('provider adapter classifies timeout, unavailable, rate limit, and credential rejection safely', async () => {
  const priorFetch = globalThis.fetch;
  const config = { model: 'fixture-model', baseUrl: 'https://example.test/v1', apiKey: 'fixture-key' };
  const input = { config, system: 'System', messages: [], temperature: 0.2 };
  try {
    globalThis.fetch = async () => { throw Object.assign(new Error('socket deadline'), { name: 'TimeoutError' }); };
    await assert.rejects(complete(input), error => error.status === 502 && error.providerCode === 'timeout');
    globalThis.fetch = async () => { throw new Error('socket closed'); };
    await assert.rejects(complete(input), error => error.status === 502 && error.providerCode === 'provider_unavailable');
    globalThis.fetch = async () => ({ ok: false, status: 429 });
    await assert.rejects(complete(input), error => error.status === 429 && error.providerCode === 'rate_limited');
    globalThis.fetch = async () => ({ ok: false, status: 401 });
    await assert.rejects(complete(input), error => error.status === 502 && error.providerCode === 'provider_auth');
    globalThis.fetch = async () => ({ ok: false, status: 503 });
    await assert.rejects(complete(input), error => error.status === 502 && error.providerCode === 'provider_unavailable');
  } finally { globalThis.fetch = priorFetch; }
});

test('calibration can observe only the allowlisted rate-limit response headers', async () => {
  const priorFetch = globalThis.fetch;
  const observed = [];
  const config = { model: 'fixture-model', baseUrl: 'https://example.test/v1', apiKey: 'fixture-key' };
  const headers = new Headers({
    'x-ratelimit-limit-requests': '30',
    'x-ratelimit-remaining-requests': '4',
    'x-ratelimit-reset-requests': '2.5s',
    'x-ratelimit-limit-tokens': '8000',
    'x-ratelimit-remaining-tokens': '6400',
    'x-ratelimit-reset-tokens': '7s',
    'x-request-id': 'must-not-be-exposed',
    'set-cookie': 'secret-cookie=never-read',
  });
  try {
    globalThis.fetch = async () => ({ ok: true, headers, json: async () => ({ choices: [{ message: { content: 'visible answer' } }] }) });
    const result = await complete({ config, system: 'System', messages: [], temperature: 0.2, onRateLimitHeaders: value => observed.push(value) });
    assert.equal(result.text, 'visible answer');
    assert.deepEqual(observed, [{
      'x-ratelimit-limit-requests': '30',
      'x-ratelimit-remaining-requests': '4',
      'x-ratelimit-reset-requests': '2.5s',
      'x-ratelimit-limit-tokens': '8000',
      'x-ratelimit-remaining-tokens': '6400',
      'x-ratelimit-reset-tokens': '7s',
    }]);

    globalThis.fetch = async () => ({ ok: false, status: 429, headers });
    await assert.rejects(complete({ config, system: 'System', messages: [], temperature: 0.2, onRateLimitHeaders: value => observed.push(value) }), error => {
      assert.equal(error.providerCode, 'rate_limited');
      assert.deepEqual(error.providerLimits, observed[0]);
      assert.equal(JSON.stringify(error).includes('must-not-be-exposed'), false);
      return true;
    });
    assert.equal(observed.length, 2);
    assert.deepEqual(Object.keys(observed[1]).sort(), Object.keys(observed[0]).sort());
  } finally { globalThis.fetch = priorFetch; }
});
