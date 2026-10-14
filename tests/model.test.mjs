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
