import { randomUUID } from 'node:crypto';
import { GEMINI_BASE_URL, GEMINI_MODEL } from './model.mjs';

const DAY = 24 * 60 * 60 * 1000;
const QUOTA_FRESH_MS = 60_000;
const RESERVE = 10_000;
const RESERVATION_TTL = 15 * 60_000;
const APP_TARGET = 1_200_000;
const GOOGLE_ID = 'google-gemini';
const GROQ_ID = 'groq';

const int = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const retry = value => Number.isInteger(value) && value > 0 ? Math.min(value, 86_400) : 60;
const dateKey = at => new Date(at).toISOString().slice(0, 10);

export function inceptionProviderCapacity({ store, primary, env = process.env, now = () => Date.now() }) {
  const { get, all, run } = store;
  const flagEnabled = env.INCEPTION_AUTO_PROVIDER === 'true' && Boolean(env.GEMINI_API_KEY);

  async function observe(providerId, { usage = null, error = null, at = now() } = {}) {
    const code = error?.providerCode || null;
    const quota = error?.quota || {};
    const tokens = int(usage?.totalTokens ?? usage?.total_tokens ?? usage?.total) || 0;
    const tpdLimit = int(quota.limit);
    const tpdUsed = int(quota.used);
    const quotaAt = tpdLimit !== null && tpdUsed !== null && (error?.rateLimitScope === 'tokens_daily') ? at : null;
    const blockedUntil = providerId === GOOGLE_ID && code === 'rate_limited' ? at + retry(error.retryAfterSeconds) * 1000 : null;
    const day = dateKey(at);
    await run(`INSERT INTO inception_provider_health
      (provider_id, observed_at, last_success_at, blocked_until, last_error_code, daily_limit, daily_used, daily_observed_at, app_tokens_today, app_usage_day, failed_calls_today, failed_calls_day, app_tokens_after_observation)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider_id) DO UPDATE SET
      observed_at=CASE WHEN excluded.observed_at>inception_provider_health.observed_at THEN excluded.observed_at ELSE inception_provider_health.observed_at END,
      last_success_at=CASE WHEN excluded.last_success_at IS NOT NULL AND (inception_provider_health.last_success_at IS NULL OR excluded.last_success_at>inception_provider_health.last_success_at) THEN excluded.last_success_at ELSE inception_provider_health.last_success_at END,
      blocked_until=CASE WHEN excluded.observed_at>=inception_provider_health.observed_at AND excluded.blocked_until IS NOT NULL THEN CASE WHEN COALESCE(inception_provider_health.blocked_until,0)>excluded.blocked_until THEN inception_provider_health.blocked_until ELSE excluded.blocked_until END WHEN excluded.observed_at>=inception_provider_health.observed_at AND inception_provider_health.blocked_until<=excluded.observed_at THEN NULL ELSE inception_provider_health.blocked_until END,
      last_error_code=CASE WHEN excluded.last_error_code IS NOT NULL AND excluded.observed_at>=inception_provider_health.observed_at THEN excluded.last_error_code ELSE inception_provider_health.last_error_code END,
      daily_limit=CASE WHEN excluded.daily_observed_at IS NOT NULL AND (inception_provider_health.daily_observed_at IS NULL OR excluded.daily_observed_at>=inception_provider_health.daily_observed_at) THEN excluded.daily_limit ELSE inception_provider_health.daily_limit END,
      daily_used=CASE WHEN excluded.daily_observed_at IS NOT NULL AND (inception_provider_health.daily_observed_at IS NULL OR excluded.daily_observed_at>=inception_provider_health.daily_observed_at) THEN excluded.daily_used ELSE inception_provider_health.daily_used END,
      app_tokens_after_observation=CASE WHEN excluded.daily_observed_at IS NOT NULL AND (inception_provider_health.daily_observed_at IS NULL OR excluded.daily_observed_at>=inception_provider_health.daily_observed_at) THEN 0 ELSE inception_provider_health.app_tokens_after_observation+excluded.app_tokens_today END,
      daily_observed_at=CASE WHEN excluded.daily_observed_at IS NOT NULL AND (inception_provider_health.daily_observed_at IS NULL OR excluded.daily_observed_at>=inception_provider_health.daily_observed_at) THEN excluded.daily_observed_at ELSE inception_provider_health.daily_observed_at END,
      app_tokens_today=CASE WHEN inception_provider_health.app_usage_day=excluded.app_usage_day THEN inception_provider_health.app_tokens_today+excluded.app_tokens_today WHEN inception_provider_health.app_usage_day IS NULL OR excluded.app_usage_day>inception_provider_health.app_usage_day THEN excluded.app_tokens_today ELSE inception_provider_health.app_tokens_today END,
      app_usage_day=CASE WHEN inception_provider_health.app_usage_day IS NULL OR excluded.app_usage_day>inception_provider_health.app_usage_day THEN excluded.app_usage_day ELSE inception_provider_health.app_usage_day END,
      failed_calls_today=CASE WHEN inception_provider_health.failed_calls_day=excluded.failed_calls_day THEN inception_provider_health.failed_calls_today+excluded.failed_calls_today WHEN inception_provider_health.failed_calls_day IS NULL OR excluded.failed_calls_day>inception_provider_health.failed_calls_day THEN excluded.failed_calls_today ELSE inception_provider_health.failed_calls_today END,
      failed_calls_day=CASE WHEN inception_provider_health.failed_calls_day IS NULL OR excluded.failed_calls_day>inception_provider_health.failed_calls_day THEN excluded.failed_calls_day ELSE inception_provider_health.failed_calls_day END`,
      providerId, at, error ? null : at, blockedUntil, code, tpdLimit, tpdUsed, quotaAt, tokens, day, error ? 1 : 0, day, tokens);
  }

  async function releaseReservation(reservationId) {
    if (!reservationId) return;
    if (store.dialect === 'sqlite') {
      store.transaction(() => {
        const reservation = get('SELECT provider_id,tokens FROM inception_provider_reservations WHERE reservation_id=?', reservationId);
        if (!reservation) return;
        run('UPDATE inception_provider_health SET reserved_tokens=CASE WHEN reserved_tokens>=? THEN reserved_tokens-? ELSE 0 END WHERE provider_id=?', reservation.tokens, reservation.tokens, reservation.provider_id);
        run('DELETE FROM inception_provider_reservations WHERE reservation_id=?', reservationId);
      });
      return;
    }
    await all(`WITH released AS (DELETE FROM inception_provider_reservations WHERE reservation_id=? RETURNING provider_id,tokens)
      UPDATE inception_provider_health SET reserved_tokens=CASE WHEN inception_provider_health.reserved_tokens>=released.tokens THEN inception_provider_health.reserved_tokens-released.tokens ELSE 0 END
      FROM released WHERE inception_provider_health.provider_id=released.provider_id RETURNING inception_provider_health.provider_id`, reservationId);
  }

  async function releaseExpiredReservations(at = now()) {
    const expired = await all('SELECT reservation_id FROM inception_provider_reservations WHERE expires_at<=?', at);
    for (const item of expired) await releaseReservation(item.reservation_id);
  }

  async function reservePrimary(at) {
    const reservationId = randomUUID();
    const expiresAt = at + RESERVATION_TTL;
    if (store.dialect === 'sqlite') {
      return store.transaction(() => {
        run('INSERT INTO inception_provider_reservations (reservation_id,provider_id,tokens,created_at,expires_at) VALUES (?,?,?,?,?)', reservationId, GROQ_ID, RESERVE, at, expiresAt);
        const claimed = run(`UPDATE inception_provider_health SET reserved_tokens=reserved_tokens+?
          WHERE provider_id=? AND daily_observed_at>=? AND daily_observed_at<=?
          AND daily_limit-daily_used-app_tokens_after_observation-reserved_tokens>=?`, RESERVE, GROQ_ID, at - QUOTA_FRESH_MS, at, RESERVE);
        if (!claimed.changes) {
          run('DELETE FROM inception_provider_reservations WHERE reservation_id=?', reservationId);
          return null;
        }
        return reservationId;
      });
    }
    const claimed = await all(`WITH reserved AS (
        UPDATE inception_provider_health SET reserved_tokens=reserved_tokens+?
        WHERE provider_id=? AND daily_observed_at>=? AND daily_observed_at<=?
          AND daily_limit-daily_used-app_tokens_after_observation-reserved_tokens>=?
        RETURNING provider_id
      ) INSERT INTO inception_provider_reservations (reservation_id,provider_id,tokens,created_at,expires_at)
        SELECT ?,?,?,?,? FROM reserved RETURNING reservation_id`, RESERVE, GROQ_ID, at - QUOTA_FRESH_MS, at, RESERVE, reservationId, GROQ_ID, RESERVE, at, expiresAt);
    return claimed[0]?.reservation_id || null;
  }

  async function selectForStart() {
    if (!flagEnabled) return { config: { model: primary.model, baseUrl: primary.baseUrl, reasoningEffort: primary.reasoningEffort || 'low', providerId: GROQ_ID }, reason: 'feature_disabled', checkedAt: now(), reservationId: null };
    const at = now();
    await releaseExpiredReservations(at);
    const row = await get('SELECT * FROM inception_provider_health WHERE provider_id=?', GROQ_ID);
    const fresh = Boolean(primary.apiKey && row?.daily_observed_at && at - Number(row.daily_observed_at) <= QUOTA_FRESH_MS && at >= Number(row.daily_observed_at) && row.daily_limit != null && row.daily_used != null);
    const providerRemaining = fresh ? Math.max(0, Number(row.daily_limit) - Number(row.daily_used)) : null;
    let reservationId = null;
    if (fresh && providerRemaining - Number(row.app_tokens_after_observation || 0) - Number(row.reserved_tokens || 0) >= RESERVE) reservationId = await reservePrimary(at);
    const useGoogle = !reservationId;
    const reason = !primary.apiKey ? 'primary_credentials_unavailable'
      : !fresh ? 'primary_daily_unknown'
      : providerRemaining - Number(row.app_tokens_after_observation || 0) - Number(row.reserved_tokens || 0) < RESERVE ? 'primary_daily_low'
      : 'primary_daily_low'; // A failed atomic reservation means another start consumed the remaining reserve.
    if (useGoogle) {
      const fallbackHealth = await get('SELECT blocked_until FROM inception_provider_health WHERE provider_id=?', GOOGLE_ID);
      if (Number(fallbackHealth?.blocked_until || 0) > at) {
        const error = Object.assign(new Error('The available model is temporarily rate limited. Please try again shortly.'), {
          status: 429, providerCode: 'rate_limited', rateLimitScope: 'unknown', retryAfterSeconds: retry(Math.ceil((Number(fallbackHealth.blocked_until) - at) / 1000)),
        });
        throw error;
      }
      return { config: { model: GEMINI_MODEL, baseUrl: GEMINI_BASE_URL, providerId: GOOGLE_ID, reasoningEffort: 'low' }, reason, checkedAt: at, reservationId: null };
    }
    return { config: { model: primary.model, baseUrl: primary.baseUrl, providerId: GROQ_ID, reasoningEffort: primary.reasoningEffort || 'low', capacityReservationId: reservationId }, reason: 'primary_daily_available', checkedAt: at, reservationId };
  }

  async function attachReservation(reservationId, roundId) {
    if (!reservationId) return;
    const result = await run('UPDATE inception_provider_reservations SET round_id=? WHERE reservation_id=?', roundId, reservationId);
    if (result.changes !== 1) throw Object.assign(new Error('The provider capacity reservation could not be attached.'), { status: 503, providerCode: 'capacity_reservation_unavailable' });
  }

  async function releaseRoundReservation(roundId) {
    const reservation = await get('SELECT reservation_id FROM inception_provider_reservations WHERE round_id=?', roundId);
    if (reservation) return releaseReservation(reservation.reservation_id);
    // The frozen round config is written with the round before the reservation is attached.
    // This fallback makes cleanup/review robust if the attach write itself failed.
    const round = await get('SELECT config FROM rounds WHERE id=?', roundId);
    let reservationId;
    try { reservationId = JSON.parse(round?.config || '{}').capacityReservationId; } catch { return; }
    await releaseReservation(reservationId);
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
    await releaseExpiredReservations();
    const list = await all('SELECT provider_id, observed_at, last_success_at, blocked_until, last_error_code, daily_limit, daily_used, daily_observed_at, app_tokens_today, app_usage_day, failed_calls_today, failed_calls_day, app_tokens_after_observation, reserved_tokens FROM inception_provider_health WHERE provider_id IN (?,?)', GROQ_ID, GOOGLE_ID);
    const at = now(), today = dateKey(at);
    return {
      featureEnabled: flagEnabled,
      selectionPolicy: { reserveTokens: RESERVE, quotaObservationFreshMs: QUOTA_FRESH_MS, unknownPrimaryHeadroomSelects: GOOGLE_ID },
      applicationOperatingTargetTokensPerDay: APP_TARGET,
      providers: Object.fromEntries([GROQ_ID, GOOGLE_ID].map(id => {
        const item = list.find(row => row.provider_id === id);
        const quotaAge = item?.daily_observed_at == null ? null : Math.max(0, at - Number(item.daily_observed_at));
        const dailyFresh = quotaAge !== null && quotaAge <= QUOTA_FRESH_MS && at >= Number(item.daily_observed_at) && item.daily_limit != null && item.daily_used != null;
        const observedRemaining = dailyFresh ? Math.max(0, Number(item.daily_limit) - Number(item.daily_used)) : null;
        const appAfter = dailyFresh ? Number(item.app_tokens_after_observation || 0) : null;
        const reserved = dailyFresh ? Number(item.reserved_tokens || 0) : null;
        return [id, {
          configured: id === GROQ_ID ? Boolean(primary.apiKey) : Boolean(env.GEMINI_API_KEY),
          model: id === GROQ_ID ? primary.model : GEMINI_MODEL,
          host: id === GROQ_ID ? new URL(primary.baseUrl).hostname : 'generativelanguage.googleapis.com',
          observedAt: item?.observed_at ?? null,
          observationAgeMs: item?.observed_at == null ? null : Math.max(0, at - Number(item.observed_at)),
          lastSuccessAt: item?.last_success_at ?? null,
          lastErrorCode: item?.last_error_code ?? null,
          blockedUntil: item?.blocked_until ?? null,
          providerObservedDailyRemainingTokens: observedRemaining,
          dailyHeadroomStatus: dailyFresh ? 'fresh_observation' : item?.daily_observed_at ? 'stale' : 'unknown',
          dailyObservedAt: dailyFresh ? item.daily_observed_at : null,
          applicationTokensSinceObservation: appAfter,
          activeReservedTokens: reserved,
          conservativeAvailableTokens: dailyFresh ? Math.max(0, observedRemaining - appAfter - reserved) : null,
          applicationTokensToday: item?.app_usage_day === today ? Number(item.app_tokens_today || 0) : 0,
          applicationFailedCallsToday: item?.failed_calls_day === today ? Number(item.failed_calls_today || 0) : 0,
          failedCallTokenUsage: 'unknown',
          applicationUsageDay: today,
          outsideApplicationUsage: 'unknown',
        }];
      })),
    };
  }

  return { enabled: flagEnabled, observe, selectForStart, credentialsForFrozen, attachReservation, releaseReservation, releaseRoundReservation, status };
}

export const INCEPTION_GOOGLE_ID = GOOGLE_ID;
