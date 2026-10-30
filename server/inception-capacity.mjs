import { randomUUID } from 'node:crypto';
import { GEMINI_BASE_URL, GEMINI_MODEL } from './model.mjs';

const QUOTA_FRESH_MS = 60_000;
const RESERVE = 10_000;
const RESERVATION_TTL = 15 * 60_000;
const APPLICATION_OPERATING_TARGET = 1_200_000;
const DEFAULT_APP_DAILY_BUDGET = 200_000;
const GOOGLE_ID = 'google-gemini';
const GROQ_ID = 'groq';
const SECONDARY_GROQ_ID = 'groq-secondary';

const int = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const retry = (value, fallback = 60) => Number.isInteger(value) && value > 0 ? Math.min(value, 86_400) : fallback;
const dateKey = at => new Date(at).toISOString().slice(0, 10);

function applicationDailyBudget(env, secondary = false) {
  const raw = secondary ? env.INCEPTION_GROQ_SECONDARY_DAILY_TOKEN_BUDGET : env.INCEPTION_GROQ_DAILY_TOKEN_BUDGET;
  if (raw === undefined || raw === '') return { value: DEFAULT_APP_DAILY_BUDGET, valid: true, source: 'default' };
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return { value: null, valid: false, source: 'environment' };
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0
    ? { value, valid: true, source: 'environment' }
    : { value: null, valid: false, source: 'environment' };
}

function cooldownSeconds(providerId, error) {
  if (!error) return null;
  if (error.providerCode === 'rate_limited') {
    const daily = String(error.rateLimitScope || '').endsWith('_daily');
    return retry(error.retryAfterSeconds, daily ? 86_400 : 60);
  }
  if (error.providerCode === 'timeout' || error.providerCode === 'provider_unavailable') return retry(error.retryAfterSeconds, 30);
  if (['provider_auth', 'provider_configuration_changed', 'provider_rejected'].includes(error.providerCode)) return retry(error.retryAfterSeconds, 300);
  return providerId === GOOGLE_ID && error.providerCode === 'rate_limited' ? retry(error.retryAfterSeconds) : null;
}

export function inceptionProviderCapacity({ store, primary, env = process.env, now = () => Date.now() }) {
  const { get, all, run } = store;
  const routingEnabled = env.INCEPTION_AUTO_PROVIDER === 'true';
  const secondary = env.GROQ_SECONDARY_API_KEY && env.GROQ_SECONDARY_API_KEY !== primary.apiKey
    ? { apiKey: env.GROQ_SECONDARY_API_KEY, model: primary.model, baseUrl: 'https://api.groq.com/openai/v1', reasoningEffort: primary.reasoningEffort || 'low', providerId: SECONDARY_GROQ_ID }
    : null;
  const flagEnabled = routingEnabled && Boolean(primary.apiKey || secondary || env.GEMINI_API_KEY);
  const appBudget = applicationDailyBudget(env);
  const secondaryBudget = applicationDailyBudget(env, true);

  async function observe(providerId, { usage = null, error = null, at = now() } = {}) {
    const code = error?.providerCode || null;
    const quota = error?.quota || {};
    const tokens = int(usage?.totalTokens ?? usage?.total_tokens ?? usage?.total) || 0;
    const tpdLimit = int(quota.limit);
    const tpdUsed = int(quota.used);
    const quotaAt = tpdLimit !== null && tpdUsed !== null && (error?.rateLimitScope === 'tokens_daily') ? at : null;
    const cooldown = cooldownSeconds(providerId, error);
    const blockedUntil = cooldown === null ? null : at + cooldown * 1000;
    const day = dateKey(at);
    await run(`INSERT INTO inception_provider_health
      (provider_id, observed_at, last_success_at, blocked_until, last_error_code, daily_limit, daily_used, daily_observed_at, app_tokens_today, app_usage_day, failed_calls_today, failed_calls_day, app_tokens_after_observation)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider_id) DO UPDATE SET
      observed_at=CASE WHEN excluded.observed_at>inception_provider_health.observed_at THEN excluded.observed_at ELSE inception_provider_health.observed_at END,
      last_success_at=CASE WHEN excluded.last_success_at IS NOT NULL AND (inception_provider_health.last_success_at IS NULL OR excluded.last_success_at>inception_provider_health.last_success_at) THEN excluded.last_success_at ELSE inception_provider_health.last_success_at END,
      blocked_until=CASE WHEN excluded.observed_at>=inception_provider_health.observed_at AND excluded.blocked_until IS NOT NULL THEN CASE WHEN COALESCE(inception_provider_health.blocked_until,0)>excluded.blocked_until THEN inception_provider_health.blocked_until ELSE excluded.blocked_until END WHEN excluded.observed_at>=inception_provider_health.observed_at AND inception_provider_health.blocked_until<=excluded.observed_at THEN NULL ELSE inception_provider_health.blocked_until END,
      last_error_code=CASE WHEN excluded.observed_at>=inception_provider_health.observed_at THEN excluded.last_error_code ELSE inception_provider_health.last_error_code END,
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

  async function reserveSlot(providerId, budget, at, roundId = null) {
    const day = dateKey(at);
    const reservationId = randomUUID();
    const expiresAt = at + RESERVATION_TTL;
    if (store.dialect === 'sqlite') {
      return store.transaction(() => {
        run(`INSERT INTO inception_provider_health (provider_id,observed_at) VALUES (?,?) ON CONFLICT(provider_id) DO NOTHING`, providerId, at);
        run('INSERT INTO inception_provider_reservations (reservation_id,provider_id,tokens,created_at,expires_at,round_id) VALUES (?,?,?,?,?,?)', reservationId, providerId, RESERVE, at, expiresAt, roundId);
        const claimed = run(`UPDATE inception_provider_health SET reserved_tokens=reserved_tokens+?
          WHERE provider_id=? AND (blocked_until IS NULL OR blocked_until<=?)
          AND (CASE WHEN app_usage_day=? THEN app_tokens_today ELSE 0 END)+reserved_tokens+?<=?
          AND (daily_observed_at IS NULL OR daily_observed_at<? OR daily_observed_at>?
            OR daily_limit-daily_used-app_tokens_after_observation-reserved_tokens>=?)`,
          RESERVE, providerId, at, day, RESERVE, budget.value,
          at - QUOTA_FRESH_MS, at, RESERVE);
        if (!claimed.changes) {
          run('DELETE FROM inception_provider_reservations WHERE reservation_id=?', reservationId);
          return null;
        }
        return reservationId;
      });
    }
    await run('INSERT INTO inception_provider_health (provider_id,observed_at) VALUES (?,?) ON CONFLICT(provider_id) DO NOTHING', providerId, at);
    const claimed = await all(`WITH reserved AS (
        UPDATE inception_provider_health SET reserved_tokens=reserved_tokens+?
        WHERE provider_id=? AND (blocked_until IS NULL OR blocked_until<=?)
          AND (CASE WHEN app_usage_day=? THEN app_tokens_today ELSE 0 END)+reserved_tokens+?<=?
          AND (daily_observed_at IS NULL OR daily_observed_at<? OR daily_observed_at>?
            OR daily_limit-daily_used-app_tokens_after_observation-reserved_tokens>=?)
      RETURNING provider_id
      ) INSERT INTO inception_provider_reservations (reservation_id,provider_id,tokens,created_at,expires_at,round_id)
      SELECT ?,?,?,?,?,? FROM reserved RETURNING reservation_id`, RESERVE, providerId, at, day, RESERVE, budget.value,
      at - QUOTA_FRESH_MS, at, RESERVE, reservationId, providerId, RESERVE, at, expiresAt, roundId);
    return claimed[0]?.reservation_id || null;
  }

  async function selectForStart() {
    if (!routingEnabled) return { config: { model: primary.model, baseUrl: primary.baseUrl, reasoningEffort: primary.reasoningEffort || 'low', providerId: GROQ_ID }, reason: 'feature_disabled', checkedAt: now(), reservationId: null };
    const at = now();
    if (!appBudget.valid || (secondary && !secondaryBudget.valid)) throw Object.assign(new Error('The Inception provider budget configuration is invalid.'), { status: 503, providerCode: 'provider_configuration_changed' });
    await releaseExpiredReservations(at);
    let reason = 'primary_credentials_unavailable';
    for (const slot of [{ id: GROQ_ID, config: { model: primary.model, baseUrl: primary.baseUrl, apiKey: primary.apiKey, reasoningEffort: primary.reasoningEffort || 'low', providerId: GROQ_ID }, budget: appBudget }, ...(secondary ? [{ id: SECONDARY_GROQ_ID, config: secondary, budget: secondaryBudget }] : [])]) {
      const row = await get('SELECT * FROM inception_provider_health WHERE provider_id=?', slot.id);
      const fresh = Boolean(row?.daily_observed_at && at - Number(row.daily_observed_at) <= QUOTA_FRESH_MS && at >= Number(row.daily_observed_at) && row.daily_limit != null && row.daily_used != null);
      const remaining = fresh ? Math.max(0, Number(row.daily_limit) - Number(row.daily_used)) : null;
      const blocked = Number(row?.blocked_until || 0) > at;
      const used = row?.app_usage_day === dateKey(at) ? Number(row.app_tokens_today || 0) : 0;
      const reserved = Number(row?.reserved_tokens || 0);
      const available = Math.max(0, slot.budget.value - used - reserved);
      if (!slot.config.apiKey) { reason = slot.id === GROQ_ID ? 'primary_credentials_unavailable' : 'secondary_credentials_unavailable'; continue; }
      if (blocked) { reason = slot.id === GROQ_ID ? 'primary_cooldown' : 'secondary_cooldown'; continue; }
      if (available < RESERVE) { reason = `${slot.id === GROQ_ID ? 'primary' : 'secondary'}_application_budget_low`; continue; }
      if (fresh && remaining - Number(row.app_tokens_after_observation || 0) - reserved < RESERVE) { reason = `${slot.id === GROQ_ID ? 'primary' : 'secondary'}_daily_low`; continue; }
      const reservationId = await reserveSlot(slot.id, slot.budget, at);
      if (reservationId) {
        const { apiKey, ...safeConfig } = slot.config;
        return { config: { ...safeConfig, capacityReservationId: reservationId }, reason: slot.id === GROQ_ID ? (fresh ? 'primary_daily_available' : 'primary_daily_unknown') : (fresh ? 'secondary_daily_available' : 'secondary_daily_unknown'), checkedAt: at, reservationId };
      }
      reason = `${slot.id === GROQ_ID ? 'primary' : 'secondary'}_reservation_unavailable`;
    }
    {
      const fallbackHealth = await get('SELECT blocked_until FROM inception_provider_health WHERE provider_id=?', GOOGLE_ID);
      if (!env.GEMINI_API_KEY) {
        const health = await all('SELECT blocked_until FROM inception_provider_health WHERE provider_id IN (?,?)', GROQ_ID, SECONDARY_GROQ_ID);
        const blockedUntil = Math.max(Number(fallbackHealth?.blocked_until || 0), ...health.map(item => Number(item.blocked_until || 0)));
        throw Object.assign(new Error('No Inception model is currently available. Please try again later.'), {
          status: blockedUntil > at ? 429 : 503,
          providerCode: blockedUntil > at ? 'rate_limited' : 'provider_unavailable',
          rateLimitScope: 'unknown',
          ...(blockedUntil > at ? { retryAfterSeconds: retry(Math.ceil((blockedUntil - at) / 1000)) } : {}),
        });
      }
      if (Number(fallbackHealth?.blocked_until || 0) > at) {
        const error = Object.assign(new Error('The available model is temporarily rate limited. Please try again shortly.'), {
          status: 429, providerCode: 'rate_limited', rateLimitScope: 'unknown', retryAfterSeconds: retry(Math.ceil((Number(fallbackHealth.blocked_until) - at) / 1000)),
        });
        throw error;
      }
      return { config: { model: GEMINI_MODEL, baseUrl: GEMINI_BASE_URL, providerId: GOOGLE_ID, reasoningEffort: 'low' }, reason, checkedAt: at, reservationId: null };
    }
  }

  async function attachReservation(reservationId, roundId) {
    if (!reservationId) return;
    const result = await run('UPDATE inception_provider_reservations SET round_id=? WHERE reservation_id=?', roundId, reservationId);
    if (result.changes !== 1) throw Object.assign(new Error('The provider capacity reservation could not be attached.'), { status: 503, providerCode: 'capacity_reservation_unavailable' });
  }

  async function releaseRoundReservation(roundId) {
    const reservations = await all('SELECT reservation_id FROM inception_provider_reservations WHERE round_id=?', roundId);
    for (const reservation of reservations) await releaseReservation(reservation.reservation_id);
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
    if (config.providerId === SECONDARY_GROQ_ID) {
      if (!secondary || config.baseUrl !== 'https://api.groq.com/openai/v1' || config.model !== secondary.model) throw Object.assign(new Error('The saved Inception model connection is unavailable.'), { status: 503, providerCode: 'provider_configuration_changed' });
      return { ...secondary };
    }
    // Legacy Inception rounds only remain routable to the configured primary Groq host.
    if (!config.providerId && config.baseUrl === primary.baseUrl && config.model === primary.model && primary.apiKey) return { ...config, apiKey: primary.apiKey, providerId: GROQ_ID };
    throw Object.assign(new Error('The saved Inception model connection no longer matches its trusted server configuration.'), { status: 503, providerCode: 'provider_configuration_changed' });
  }

  async function activeCooldown(providerId) {
    const row = await get('SELECT blocked_until FROM inception_provider_health WHERE provider_id=?', providerId);
    return Number(row?.blocked_until || 0) > now();
  }
  async function cooldownRemaining(providerId) {
    const row = await get('SELECT blocked_until FROM inception_provider_health WHERE provider_id=?', providerId);
    return Math.max(0, Math.ceil((Number(row?.blocked_until || 0) - now()) / 1000));
  }
  async function fallbackForOngoing(currentId, roundId) {
    if (!flagEnabled) return null;
    const order = [GROQ_ID, SECONDARY_GROQ_ID, GOOGLE_ID];
    const start = order.indexOf(currentId);
    if (start < 0) return null;
    for (const id of order.slice(start + 1)) {
      if (await activeCooldown(id)) continue;
      if (id === SECONDARY_GROQ_ID && secondary) {
        if (!secondaryBudget.valid) return null;
        const reservationId = await reserveSlot(id, secondaryBudget, now(), roundId);
        if (!reservationId) continue;
        return { ...secondary, capacityReservationId: reservationId };
      }
      if (id === GOOGLE_ID && env.GEMINI_API_KEY) return { providerId: GOOGLE_ID, model: GEMINI_MODEL, baseUrl: GEMINI_BASE_URL, apiKey: env.GEMINI_API_KEY, reasoningEffort: 'low' };
    }
    return null;
  }

  async function releaseStaleSlotReservation(roundId, providerId) {
    const reservation = await get('SELECT reservation_id FROM inception_provider_reservations WHERE round_id=? AND provider_id=?', roundId, providerId);
    if (reservation) await releaseReservation(reservation.reservation_id);
  }

  async function reconcileRoundReservations(roundId, providerId, activeReservationId = null) {
    const reservations = await all('SELECT reservation_id,provider_id FROM inception_provider_reservations WHERE round_id=?', roundId);
    for (const reservation of reservations) if (reservation.provider_id !== providerId || reservation.reservation_id !== activeReservationId) await releaseReservation(reservation.reservation_id);
  }

  async function status({ readOnly = false } = {}) {
    if (!readOnly) await releaseExpiredReservations();
    const list = await all('SELECT provider_id, observed_at, last_success_at, blocked_until, last_error_code, daily_limit, daily_used, daily_observed_at, app_tokens_today, app_usage_day, failed_calls_today, failed_calls_day, app_tokens_after_observation, reserved_tokens FROM inception_provider_health WHERE provider_id IN (?,?,?)', GROQ_ID, SECONDARY_GROQ_ID, GOOGLE_ID);
    const at = now(), today = dateKey(at);
    const liveReservations = readOnly ? await all('SELECT provider_id,SUM(tokens) AS tokens FROM inception_provider_reservations WHERE expires_at>? GROUP BY provider_id', at) : [];
    const liveReserved = new Map(liveReservations.map(row => [row.provider_id, Number(row.tokens || 0)]));
    const groq = list.find(row => row.provider_id === GROQ_ID);
    const applicationTokensToday = groq?.app_usage_day === today ? Number(groq.app_tokens_today || 0) : 0;
    const activeReservedTokens = readOnly ? (liveReserved.get(GROQ_ID) || 0) : Number(groq?.reserved_tokens || 0);
    const configuredBudgets = [primary.apiKey ? appBudget : null, secondary ? secondaryBudget : null].filter(item => item?.valid).map(item => item.value);
    const expectedBudgetCount = Number(Boolean(primary.apiKey)) + Number(Boolean(secondary));
    const planningBudget = configuredBudgets.reduce((sum, value) => sum + value, 0);
    const plannedUsage = [GROQ_ID, SECONDARY_GROQ_ID].reduce((sum, id) => {
      const item = list.find(row => row.provider_id === id);
      return sum + (item?.app_usage_day === today ? Number(item.app_tokens_today || 0) : 0);
    }, 0);
    const plannedReservations = [GROQ_ID, SECONDARY_GROQ_ID].reduce((sum, id) => sum + (readOnly ? (liveReserved.get(id) || 0) : Number(list.find(row => row.provider_id === id)?.reserved_tokens || 0)), 0);
    return {
      featureEnabled: flagEnabled,
      selectionPolicy: { primary: GROQ_ID, fallback: GOOGLE_ID, providerOrder: routingEnabled ? [GROQ_ID, SECONDARY_GROQ_ID, GOOGLE_ID].filter(id => id !== SECONDARY_GROQ_ID || Boolean(secondary)) : [GROQ_ID], reserveTokens: RESERVE, quotaObservationFreshMs: QUOTA_FRESH_MS, unknownPrimaryHeadroomSelects: GROQ_ID },
      applicationDailyBudget: {
        tokens: appBudget.value,
        source: appBudget.source,
        valid: appBudget.valid,
        usageToday: applicationTokensToday,
        activeReservedTokens,
        availableTokens: appBudget.valid ? Math.max(0, appBudget.value - applicationTokensToday - activeReservedTokens) : null,
        day: today,
        capacityMeaning: 'application_planning_cap_not_provider_entitlement',
      },
      applicationOperatingTargetTokensPerDay: APPLICATION_OPERATING_TARGET,
      applicationPlanningCapacity: { tokens: configuredBudgets.length === expectedBudgetCount ? planningBudget : null, usageToday: plannedUsage, activeReservedTokens: plannedReservations, availableTokens: configuredBudgets.length === expectedBudgetCount ? Math.max(0, planningBudget - plannedUsage - plannedReservations) : null, meaning: 'sum_of_independent_application_planning_caps_not_provider_entitlement' },
      providers: Object.fromEntries([GROQ_ID, SECONDARY_GROQ_ID, GOOGLE_ID].map(id => {
        const item = list.find(row => row.provider_id === id);
        const quotaAge = item?.daily_observed_at == null ? null : Math.max(0, at - Number(item.daily_observed_at));
        const dailyFresh = quotaAge !== null && quotaAge <= QUOTA_FRESH_MS && at >= Number(item.daily_observed_at) && item.daily_limit != null && item.daily_used != null;
        const observedRemaining = dailyFresh ? Math.max(0, Number(item.daily_limit) - Number(item.daily_used)) : null;
        const appAfter = dailyFresh ? Number(item.app_tokens_after_observation || 0) : null;
        const reserved = readOnly ? (liveReserved.get(id) || 0) : Number(item?.reserved_tokens || 0);
        return [id, {
          configured: id === GROQ_ID ? Boolean(primary.apiKey) : id === SECONDARY_GROQ_ID ? Boolean(secondary) : Boolean(env.GEMINI_API_KEY),
          model: id === GROQ_ID ? primary.model : id === SECONDARY_GROQ_ID ? secondary?.model || primary.model : GEMINI_MODEL,
          host: id === GROQ_ID ? new URL(primary.baseUrl).hostname : id === SECONDARY_GROQ_ID ? 'api.groq.com' : 'generativelanguage.googleapis.com',
          applicationDailyBudget: id === GROQ_ID ? appBudget.value : id === SECONDARY_GROQ_ID ? (secondary ? secondaryBudget.value : null) : null,
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

  return { enabled: flagEnabled, observe, selectForStart, credentialsForFrozen, attachReservation, releaseReservation, releaseRoundReservation, releaseStaleSlotReservation, reconcileRoundReservations, activeCooldown, cooldownRemaining, fallbackForOngoing, status };
}

export const INCEPTION_GOOGLE_ID = GOOGLE_ID;
export const INCEPTION_SECONDARY_GROQ_ID = SECONDARY_GROQ_ID;
