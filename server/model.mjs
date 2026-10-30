export function modelConfig(env = process.env) {
  return { model: env.TARGET_MODEL || 'openai/gpt-oss-20b', baseUrl: env.TARGET_BASE_URL || 'https://api.groq.com/openai/v1', apiKey: env.TARGET_API_KEY || env.GROQ_API_KEY || '', reasoningEffort: 'low' };
}

export const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
export const GEMINI_MODEL = 'gemma-4-26b-a4b-it';

export function buildGeminiCompletionBody({ system, messages, temperature = 0.7, responseSchema = null }) {
  return {
    systemInstruction: { parts: [{ text: system }] },
    contents: messages.filter(message => ['user', 'assistant'].includes(message.role)).map(message => ({
      role: message.role === 'assistant' ? 'model' : 'user', parts: [{ text: message.content }],
    })),
    generationConfig: {
      temperature, maxOutputTokens: 2048, thinkingConfig: { thinkingLevel: 'MINIMAL' },
      ...(responseSchema ? { responseMimeType: 'application/json', responseSchema } : {}),
    },
  };
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

export async function complete({ config, system, messages, temperature, onRateLimitHeaders, responseSchema, timeoutMs = 30000 }) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30000) throw Object.assign(new Error('The provider timeout is invalid.'), { providerCode: 'provider_configuration_changed' });
  if (!config.apiKey) throw Object.assign(new Error('The target is not connected. Add GROQ_API_KEY to the server environment and restart.'), { status: 503 });
  if (config.providerId === 'google-gemini') return completeGemini({ config, system, messages, temperature, responseSchema, timeoutMs });
  const body = buildCompletionBody({ config, system, messages, temperature });
  const start = performance.now();
  let response;
  try {
    response = await fetch(`${config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST', headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
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
      try { providerError = await response.clone().json(); }
      catch (error) {
        if (error?.name === 'TimeoutError' || error?.name === 'AbortError') throw Object.assign(new Error('The target did not respond in time. Retry the request.'), { status: 502, providerCode: 'timeout' });
        providerError = null;
      }
    }
    const rateLimitScope = response.status === 429 ? safeRateLimitScope(providerError) : undefined;
    const retryAfterSeconds = response.status === 429 ? safeRetryAfterSeconds(response.headers) : undefined;
    const quotaMatch = rateLimitScope === 'tokens_daily' ? String(providerError?.error?.message || '').match(/limit\s*[:=]?\s*(\d+)[\s\S]{0,80}?used\s*[:=]?\s*(\d+)/i) : null;
    const quota = quotaMatch ? { limit: Number(quotaMatch[1]), used: Number(quotaMatch[2]) } : undefined;
    const message = response.status === 429 ? rateLimitScope === 'tokens_daily' ? 'Usage limit reached. Wait before trying again.' : 'The model service is temporarily rate limited. Wait before trying again.'
      : [401, 403].includes(response.status) ? 'The model service is unavailable right now.'
      : `The provider could not complete this turn (${response.status}).`;
    throw Object.assign(new Error(message), { status: response.status === 429 ? 429 : 502, providerCode: response.status === 429 ? 'rate_limited' : [401, 403].includes(response.status) ? 'provider_auth' : response.status >= 500 ? 'provider_unavailable' : 'provider_rejected', ...(response.status === 429 ? { rateLimitScope, ...(retryAfterSeconds ? { retryAfterSeconds } : {}) } : {}), ...(quota ? { quota } : {}), ...(Object.keys(providerLimits).length ? { providerLimits } : {}) });
  }
  let result;
  try { result = await response.json(); }
  catch (error) { if (error?.name === 'TimeoutError' || error?.name === 'AbortError') throw Object.assign(new Error('The target did not respond in time. Retry the request.'), { status: 502, providerCode: 'timeout' }); throw Object.assign(new Error('The model service returned an invalid response.'), { status: 502, providerCode: 'provider_rejected' }); }
  const text = result.choices?.[0]?.message?.content?.trim();
  if (!text) throw Object.assign(new Error('The target returned no visible reply. Retry this turn.'), { status: 502, providerCode: 'empty_response' });
  // Only visible content crosses the player boundary; provider reasoning is deliberately discarded.
  const tokenCount = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  return { text, latencyMs: Math.round(performance.now() - start), usage: tokenCount(result.usage?.total_tokens), usageDetails: { inputTokens: tokenCount(result.usage?.prompt_tokens), outputTokens: tokenCount(result.usage?.completion_tokens), totalTokens: tokenCount(result.usage?.total_tokens) }, model: result.model || config.model };
}

async function completeGemini({ config, system, messages, temperature, responseSchema, timeoutMs = 30000 }) {
  if (config.baseUrl !== GEMINI_BASE_URL || config.model !== GEMINI_MODEL) throw Object.assign(new Error('The saved Inception model connection is invalid.'), { status: 503, providerCode: 'provider_configuration_changed' });
  const body = buildGeminiCompletionBody({ system, messages, temperature, responseSchema });
  const started = performance.now();
  let response;
  try {
    response = await fetch(`${GEMINI_BASE_URL}/models/${GEMINI_MODEL}:generateContent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.apiKey },
      body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const timeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    throw Object.assign(new Error(timeout ? 'The target did not respond in time. Retry the request.' : 'The provider is temporarily unavailable. Retry the request.'), { status: 502, providerCode: timeout ? 'timeout' : 'provider_unavailable' });
  }
  let result;
  try { result = await response.json(); }
  catch (error) { if (error?.name === 'TimeoutError' || error?.name === 'AbortError') throw Object.assign(new Error('The target did not respond in time. Retry the request.'), { status: 502, providerCode: 'timeout' }); throw Object.assign(new Error('The model service returned an invalid response.'), { status: 502, providerCode: 'provider_rejected' }); }
  const providerError = result?.error;
  if (!response.ok || providerError) {
    const status = Number(providerError?.code || response.status);
    const details = Array.isArray(providerError?.details) ? providerError.details : [];
    const retryDetail = details.find(item => item['@type']?.endsWith('.RetryInfo'));
    const delay = typeof retryDetail?.retryDelay === 'string' ? Number.parseFloat(retryDetail.retryDelay) : 0;
    const retryAfterSeconds = Number.isFinite(delay) && delay > 0 ? Math.min(86400, Math.max(1, Math.ceil(delay))) : undefined;
    const violations = details.filter(item => item['@type']?.endsWith('.QuotaFailure')).flatMap(item => Array.isArray(item.violations) ? item.violations : []);
    const quotaText = violations.map(item => `${item.quotaId || ''} ${JSON.stringify(item.quotaDimensions || {})}`).join(' ').toLowerCase();
    const rateLimitScope = /token/.test(quotaText) && /day/.test(quotaText) ? 'tokens_daily'
      : /token/.test(quotaText) && /minute|per_minute/.test(quotaText) ? 'tokens_minute'
      : /request|generatecontentrequests/.test(quotaText) && /day/.test(quotaText) ? 'requests_daily'
      : /request|generatecontentrequests/.test(quotaText) && /minute|per_minute/.test(quotaText) ? 'requests_minute'
      : 'unknown';
    const quotaFailure = violations.length > 0;
    const rateLimited = status === 429 || quotaFailure;
    throw Object.assign(new Error(rateLimited ? 'The model service is temporarily rate limited. Wait before trying again.' : status === 401 || status === 403 ? 'The model service is unavailable right now.' : 'The provider could not complete this turn.'), {
      status: rateLimited ? 429 : 502,
      providerCode: rateLimited ? 'rate_limited' : [401, 403].includes(status) ? 'provider_auth' : status >= 500 ? 'provider_unavailable' : 'provider_rejected',
      ...(rateLimited ? { rateLimitScope, ...(retryAfterSeconds ? { retryAfterSeconds } : {}) } : {}),
    });
  }
  const candidate = result.candidates?.[0];
  if (candidate?.finishReason === 'MAX_TOKENS') throw Object.assign(new Error('The target reply was incomplete. Retry this turn.'), { status: 502, providerCode: 'provider_rejected' });
  if (candidate?.finishReason !== 'STOP') throw Object.assign(new Error('The target did not return a complete visible reply. Retry this turn.'), { status: 502, providerCode: 'provider_rejected' });
  const text = Array.isArray(candidate?.content?.parts)
    ? candidate.content.parts.filter(part => typeof part?.text === 'string' && !part.thought).map(part => part.text).join('').trim()
    : '';
  if (!text) throw Object.assign(new Error('The target returned no visible reply. Retry this turn.'), { status: 502, providerCode: 'empty_response' });
  const tokenCount = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  const usage = result.usageMetadata || {};
  const details = { inputTokens: tokenCount(usage.promptTokenCount), outputTokens: tokenCount(usage.candidatesTokenCount), totalTokens: tokenCount(usage.totalTokenCount) };
  return { text, latencyMs: Math.round(performance.now() - started), usage: details.totalTokens, usageDetails: details, model: config.model };
}
