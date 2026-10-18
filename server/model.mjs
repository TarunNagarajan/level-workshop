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

const RATE_LIMIT_RESPONSE_HEADERS = ['x-ratelimit-limit-requests', 'x-ratelimit-remaining-requests', 'x-ratelimit-reset-requests', 'x-ratelimit-limit-tokens', 'x-ratelimit-remaining-tokens', 'x-ratelimit-reset-tokens'];

function readRateLimitResponseHeaders(headers) {
  const values = {};
  for (const name of RATE_LIMIT_RESPONSE_HEADERS) {
    const value = headers?.get?.(name);
    if (typeof value === 'string' && value.length <= 80) values[name] = value;
  }
  return values;
}

function safeRateLimitScope(body) {
  const type = body?.error?.type, message = body?.error?.message;
  const normalized = `${typeof type === 'string' ? type : ''} ${typeof message === 'string' ? message.slice(0, 500) : ''}`.toLowerCase();
  if (normalized.includes('token') && normalized.includes('day')) return 'tokens_daily';
  if (normalized.includes('token') && normalized.includes('minute')) return 'tokens_minute';
  if ((normalized.includes('request') || normalized.includes('req')) && normalized.includes('day')) return 'requests_daily';
  if ((normalized.includes('request') || normalized.includes('req')) && normalized.includes('minute')) return 'requests_minute';
  return 'unknown';
}

function safeRetryAfterSeconds(headers) {
  const raw = headers?.get?.('retry-after');
  if (typeof raw !== 'string') return undefined;
  const value = /^\d{1,6}$/.test(raw.trim()) ? Number(raw.trim()) : Math.ceil((Date.parse(raw) - Date.now()) / 1000);
  return Number.isFinite(value) && value > 0 ? Math.min(86400, Math.max(1, value)) : undefined;
}

export async function complete({ config, system, messages, temperature, onRateLimitHeaders }) {
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
    throw Object.assign(new Error(timeout ? 'The target did not respond in time. Retry the request.' : 'The provider is temporarily unavailable. Retry the request.'), { status: 502, providerCode: timeout ? 'timeout' : 'provider_unavailable' });
  }
  const providerLimits = readRateLimitResponseHeaders(response.headers);
  if (typeof onRateLimitHeaders === 'function' && Object.keys(providerLimits).length) {
    try { onRateLimitHeaders(providerLimits); } catch { /* Calibration instrumentation must not change completion behavior. */ }
  }
  if (!response.ok) {
    let providerError;
    if (response.status === 429) {
      try { providerError = await response.clone().json(); } catch { providerError = null; }
    }
    const rateLimitScope = response.status === 429 ? safeRateLimitScope(providerError) : undefined;
    const retryAfterSeconds = response.status === 429 ? safeRetryAfterSeconds(response.headers) : undefined;
    const message = response.status === 429 ? rateLimitScope === 'tokens_daily' ? 'Usage limit reached. Wait before trying again.' : 'The model service is temporarily rate limited. Wait before trying again.'
      : [401, 403].includes(response.status) ? 'The model service is unavailable right now.'
      : `The provider could not complete this turn (${response.status}).`;
    throw Object.assign(new Error(message), { status: response.status === 429 ? 429 : 502, providerCode: response.status === 429 ? 'rate_limited' : [401, 403].includes(response.status) ? 'provider_auth' : response.status >= 500 ? 'provider_unavailable' : 'provider_rejected', ...(response.status === 429 ? { rateLimitScope, ...(retryAfterSeconds ? { retryAfterSeconds } : {}) } : {}), ...(Object.keys(providerLimits).length ? { providerLimits } : {}) });
  }
  const result = await response.json();
  const text = result.choices?.[0]?.message?.content?.trim();
  if (!text) throw Object.assign(new Error('The target returned no visible reply. Retry this turn.'), { status: 502, providerCode: 'empty_response' });
  // Only visible content crosses the player boundary; provider reasoning is deliberately discarded.
  const tokenCount = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  return { text, latencyMs: Math.round(performance.now() - start), usage: tokenCount(result.usage?.total_tokens), usageDetails: { inputTokens: tokenCount(result.usage?.prompt_tokens), outputTokens: tokenCount(result.usage?.completion_tokens), totalTokens: tokenCount(result.usage?.total_tokens) }, model: result.model || config.model };
}
