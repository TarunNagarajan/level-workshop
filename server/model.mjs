export function modelConfig(env = process.env) {
  return { model: env.TARGET_MODEL || 'openai/gpt-oss-20b', baseUrl: env.TARGET_BASE_URL || 'https://api.groq.com/openai/v1', apiKey: env.TARGET_API_KEY || env.GROQ_API_KEY || '', reasoningEffort: 'low' };
}

export function buildCompletionBody({ config, system, messages, temperature }) {
  return {
    model: config.model, messages: [{ role: 'system', content: system }, ...messages.filter(m => ['user', 'assistant'].includes(m.role)).map(({ role, content }) => ({ role, content }))],
    temperature, max_completion_tokens: 2048, stream: false,
    ...(config.baseUrl.includes('api.groq.com') && config.model.includes('gpt-oss') ? { reasoning_effort: config.reasoningEffort || 'low', include_reasoning: false } : {}),
  };
}

export async function complete({ config, system, messages, temperature }) {
  if (!config.apiKey) throw Object.assign(new Error('The target is not connected. Add GROQ_API_KEY to the server environment and restart.'), { status: 503 });
  const body = buildCompletionBody({ config, system, messages, temperature });
  const start = performance.now();
  let response;
  try {
    response = await fetch(`${config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST', headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
    });
  } catch (error) {
    const timeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    throw Object.assign(new Error(timeout ? 'The target did not respond in time. Your message was not saved; retry it.' : 'The provider is temporarily unavailable. Your message was not saved; retry it.'), { status: 502, providerCode: timeout ? 'timeout' : 'provider_unavailable' });
  }
  if (!response.ok) {
    const message = response.status === 429 ? 'The provider limit was reached. Wait briefly and retry.'
      : [401, 403].includes(response.status) ? 'The provider rejected the server API key. Check its access and restart.'
      : `The provider could not complete this turn (${response.status}). Your message was not saved.`;
    throw Object.assign(new Error(message), { status: response.status === 429 ? 429 : 502, providerCode: response.status === 429 ? 'rate_limited' : [401, 403].includes(response.status) ? 'provider_auth' : response.status >= 500 ? 'provider_unavailable' : 'provider_rejected' });
  }
  const result = await response.json();
  const text = result.choices?.[0]?.message?.content?.trim();
  if (!text) throw Object.assign(new Error('The target returned no visible reply. Retry this turn.'), { status: 502, providerCode: 'empty_response' });
  // Only visible content crosses the player boundary; provider reasoning is deliberately discarded.
  return { text, latencyMs: Math.round(performance.now() - start), usage: result.usage?.total_tokens ?? null, model: result.model || config.model };
}
