import { GEMINI_BASE_URL, GEMINI_MODEL } from './model.mjs';

const DAY = 24 * 60 * 60 * 1000;
const RESERVE = 10_000;
const APP_TARGET = 1_200_000;
const GOOGLE_ID = 'google-gemini';
const GROQ_ID = 'groq';

const int = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const retry = value => Number.isInteger(value) && value > 0 ? Math.min(value, 86_400) : 60;

export function inceptionProviderCapacity({ store, primary, env = process.env, now = () => Date.now() }) {
  const { get, run } = store;
  const flagEnabled = env.INCEPTION_AUTO_PROVIDER === 'true' && Boolean(env.GEMINI_API_KEY);

  async function observe(providerId, { usage = null, error = null, at = now() } = {}) {
    const code = error?.providerCode || null;
    const scope = error?.rateLimitScope || null;
    const limits = error?.providerLimits || {};
    const quota = error?.quota || {};
    const tokens = int(usage?.totalTokens ?? usage?.total_tokens ?? usage?.total);
    const tpdLimit = int(quota.limit ?? limits['x-ratelimit-limit-tokens-day']);
    const tpdUsed = int(quota.used ?? limits['x-ratelimit-used-tokens-day']);
    const blockedUntil = providerId === GOOGLE_ID && code === 'rate_limited' ? at + retry(error.retryAfterSeconds) * 1000 : null;
    await run(`INSERT INTO inception_provider_health
      (provider_id, observed_at, last_success_at, blocked_until, last_error_code, daily_limit, daily_used, daily_observed_at, app_tokens_today, app_usage_day, failed_calls_today, failed_calls_day)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider_id) DO UPDATE SET
      observed_at=excluded.observed_at,
      last_success_at=CASE WHEN excluded.last_success_at IS NOT NULL THEN excluded.last_success_at ELSE inception_provider_health.last_success_at END,
      blocked_until=CASE WHEN excluded.blocked_until IS NOT NULL THEN CASE WHEN COALESCE(inception_provider_health.blocked_until,0)>excluded.blocked_until THEN inception_provider_health.blocked_until ELSE excluded.blocked_until END ELSE CASE WHEN inception_provider_health.blocked_until <= excluded.observed_at THEN NULL ELSE inception_provider_health.blocked_until END END,
      last_error_code=CASE WHEN excluded.last_error_code IS NOT NULL THEN excluded.last_error_code ELSE inception_provider_health.last_error_code END,
      daily_limit=CASE WHEN excluded.daily_limit IS NOT NULL THEN excluded.daily_limit ELSE inception_provider_health.daily_limit END,
      daily_used=CASE WHEN excluded.daily_used IS NOT NULL THEN excluded.daily_used ELSE inception_provider_health.daily_used END,
      daily_observed_at=CASE WHEN excluded.daily_observed_at IS NOT NULL THEN excluded.daily_observed_at ELSE inception_provider_health.daily_observed_at END,
      app_tokens_today=CASE WHEN inception_provider_health.app_usage_day=excluded.app_usage_day THEN inception_provider_health.app_tokens_today+excluded.app_tokens_today ELSE excluded.app_tokens_today END,
      app_usage_day=excluded.app_usage_day,
      failed_calls_today=CASE WHEN inception_provider_health.failed_calls_day=excluded.failed_calls_day THEN inception_provider_health.failed_calls_today+excluded.failed_calls_today ELSE excluded.failed_calls_today END,
      failed_calls_day=excluded.failed_calls_day`,
      providerId, at, error ? null : at, blockedUntil, code, tpdLimit, tpdUsed, (tpdLimit !== null && tpdUsed !== null) ? at : null, tokens || 0, new Date(at).toISOString().slice(0, 10), error ? 1 : 0, new Date(at).toISOString().slice(0, 10));
  }

  async function selectForStart() {
    if (!flagEnabled) return { config: { model: primary.model, baseUrl: primary.baseUrl, reasoningEffort: primary.reasoningEffort || 'low', providerId: GROQ_ID }, reason: 'feature_disabled', checkedAt: now() };
    const at = now();
    const row = await get('SELECT * FROM inception_provider_health WHERE provider_id=?', GROQ_ID);
    const fresh = row?.daily_observed_at && at - Number(row.daily_observed_at) <= DAY && row.daily_limit != null && row.daily_used != null;
    const remaining = fresh ? Math.max(0, Number(row.daily_limit) - Number(row.daily_used)) : null;
    const reason = !fresh ? 'primary_daily_unknown' : remaining < RESERVE ? 'primary_daily_low' : 'primary_daily_available';
    const fallbackHealth = await get('SELECT blocked_until FROM inception_provider_health WHERE provider_id=?', GOOGLE_ID);
    if (Number(fallbackHealth?.blocked_until || 0) > at) {
      const error = Object.assign(new Error('The available model is temporarily rate limited. Please try again shortly.'), {
        status: 429, providerCode: 'rate_limited', rateLimitScope: 'unknown', retryAfterSeconds: retry(Math.ceil((Number(fallbackHealth.blocked_until) - at) / 1000)),
      });
      throw error;
    }
    const useGoogle = reason !== 'primary_daily_available';
    const selected = useGoogle
      ? { model: GEMINI_MODEL, baseUrl: GEMINI_BASE_URL, providerId: GOOGLE_ID, reasoningEffort: 'low' }
      : { model: primary.model, baseUrl: primary.baseUrl, providerId: GROQ_ID, reasoningEffort: primary.reasoningEffort || 'low' };
    return { config: selected, reason, checkedAt: at };
  }

  function credentialsForFrozen(config) {
    if (!config || typeof config !== 'object') throw Object.assign(new Error('The saved Inception model selection is invalid.'), { status: 503, providerCode: 'provider_configuration_changed' });
    if (config.providerId === GOOGLE_ID) {
      if (config.baseUrl !== GEMINI_BASE_URL || config.model !== GEMINI_MODEL || !env.GEMINI_API_KEY) throw Object.assign(new Error('The saved Inception model connection is unavailable.'), { status: 503, providerCode: 'provider_configuration_changed' });
      return { model: GEMINI_MODEL, baseUrl: GEMINI_BASE_URL, apiKey: env.GEMINI_API_KEY, providerId: GOOGLE_ID };
    }
    if (config.providerId === GROQ_ID) {
      if (config.baseUrl !== primary.baseUrl || config.model !== primary.model || !primary.apiKey) throw Object.assign(new Error('The saved Inception model connection is unavailable.'), { status: 503, providerCode: 'provider_configuration_changed' });
      return { model: primary.model, baseUrl: primary.baseUrl, apiKey: primary.apiKey, reasoningEffort: primary.reasoningEffort || 'low', providerId: GROQ_ID };
    }
    // Legacy Inception rounds only remain routable to the configured primary Groq host.
    if (!config.providerId && config.baseUrl === primary.baseUrl && config.model === primary.model && primary.apiKey) return { ...config, apiKey: primary.apiKey, providerId: GROQ_ID };
    throw Object.assign(new Error('The saved Inception model connection no longer matches its trusted server configuration.'), { status: 503, providerCode: 'provider_configuration_changed' });
  }

  async function status() {
    const list = await store.all('SELECT provider_id, observed_at, last_success_at, blocked_until, last_error_code, daily_limit, daily_used, daily_observed_at, app_tokens_today, app_usage_day, failed_calls_today, failed_calls_day FROM inception_provider_health WHERE provider_id IN (?,?)', GROQ_ID, GOOGLE_ID);
    const at = now();
    return {
      featureEnabled: flagEnabled,
      selectionPolicy: { reserveTokens: RESERVE, unknownPrimaryHeadroomSelects: GOOGLE_ID },
      applicationOperatingTargetTokensPerDay: APP_TARGET,
      providers: Object.fromEntries([GROQ_ID, GOOGLE_ID].map(id => {
        const item = list.find(row => row.provider_id === id);
        const dailyFresh = Boolean(item?.daily_observed_at && at - Number(item.daily_observed_at) <= DAY && item.daily_limit != null && item.daily_used != null);
        return [id, {
          configured: id === GROQ_ID ? Boolean(primary.apiKey) : Boolean(env.GEMINI_API_KEY),
          model: id === GROQ_ID ? primary.model : GEMINI_MODEL,
          host: id === GROQ_ID ? new URL(primary.baseUrl).hostname : 'generativelanguage.googleapis.com',
          observedAt: item?.observed_at ?? null,
          observationAgeMs: item?.observed_at == null ? null : Math.max(0, at - Number(item.observed_at)),
          lastSuccessAt: item?.last_success_at ?? null,
          lastErrorCode: item?.last_error_code ?? null,
          blockedUntil: item?.blocked_until ?? null,
          dailyHeadroom: dailyFresh ? Math.max(0, Number(item.daily_limit) - Number(item.daily_used)) : null,
          dailyHeadroomStatus: dailyFresh ? 'known' : 'unknown',
          dailyObservedAt: dailyFresh ? item.daily_observed_at : null,
          applicationTokensToday: item?.app_usage_day === new Date(at).toISOString().slice(0, 10) ? Number(item.app_tokens_today || 0) : 0,
          applicationFailedCallsToday: item?.failed_calls_day === new Date(at).toISOString().slice(0, 10) ? Number(item.failed_calls_today || 0) : 0,
          failedCallTokenUsage: 'unknown',
          applicationUsageDay: new Date(at).toISOString().slice(0, 10),
          outsideApplicationUsage: 'unknown',
        }];
      })),
    };
  }

  return { enabled: flagEnabled, observe, selectForStart, credentialsForFrozen, status };
}

export const INCEPTION_GOOGLE_ID = GOOGLE_ID;
