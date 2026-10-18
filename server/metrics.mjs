import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { buildCompletionBody } from './model.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const now = () => Date.now();
const roundMs = value => Number.isFinite(value) ? Math.max(0, Math.round(value)) : null;
const wordCount = text => (String(text || '').match(/[\p{L}\p{N}]+/gu) || []).length;
const safeSource = source => ({ blind: 'participant', 'reference-blind': 'participant', 'reference-research': 'diagnostic', 'reference-research-preview': 'preview', 'collection-participant': 'participant', 'diary-play': 'participant', 'diary-blind': 'participant', 'diary-diagnostic': 'diagnostic', 'mission-play': 'participant', 'mission-play-judge': 'diagnostic', 'collection-preview': 'preview', reference: 'diagnostic' })[source] || source || null;
const ERROR_MAP = {
  rate_limited: 'rate_limited', timeout: 'timeout', provider_unavailable: 'unavailable',
  provider_auth: 'auth_or_config', provider_rejected: 'auth_or_config', empty_response: 'empty_response',
};

function safeHost(baseUrl) {
  try { return new URL(baseUrl).hostname.slice(0, 255); } catch { return null; }
}

export function createMetricsService({ store, enabled = false }) {
  const { get, all, run, batch } = store;

  async function recordCompletion(completion, input) {
    const { metricsContext = {}, ...providerInput } = input;
    if (!enabled) return completion(providerInput);
    const config = providerInput.config || {};
    let body;
    try { body = buildCompletionBody(providerInput); } catch { body = null; }
    const fingerprint = hash(JSON.stringify({ context: metricsContext, body }));
    const startedAt = now(), callId = randomUUID();
    const context = {
      context_kind: metricsContext.kind || 'round', round_id: metricsContext.roundId || null,
      orchestration_run_id: metricsContext.runId || null, lane: metricsContext.lane || null,
      actor_user_id: metricsContext.userId || null, actor_role: metricsContext.userRole || null,
      collection_id: metricsContext.collectionId || null, profile_id: metricsContext.profileId || null,
      source: safeSource(metricsContext.source), version_id: metricsContext.versionId || null,
    };
    try {
      const previous = await get("SELECT id FROM metrics_model_calls WHERE request_fingerprint = ? AND status IN ('failed','interrupted') AND started_at >= ? ORDER BY started_at DESC LIMIT 1", fingerprint, startedAt - 30 * 60 * 1000);
      await run(`INSERT INTO metrics_model_calls (id, context_kind, round_id, orchestration_run_id, lane, actor_user_id, actor_role, collection_id, profile_id, source, version_id, started_at, requested_model, provider_host, status, request_fingerprint, retry_of_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'started', ?, ?)`, callId, context.context_kind, context.round_id, context.orchestration_run_id, context.lane, context.actor_user_id, context.actor_role, context.collection_id, context.profile_id, context.source, context.version_id, startedAt, config.model || 'unknown', safeHost(config.baseUrl), fingerprint, previous?.id || null);
    } catch { /* Metrics must never prevent a provider call. */ }
    const perfStart = performance.now();
    try {
      const result = await completion(providerInput);
      const completedAt = now(), latencyMs = roundMs(performance.now() - perfStart), text = typeof result?.text === 'string' ? result.text : '';
      const usage = result?.usageDetails || {};
      try {
        await run(`UPDATE metrics_model_calls SET completed_at=?, latency_ms=?, returned_model=?, status='succeeded', error_category=NULL, input_tokens=?, output_tokens=?, total_tokens=?, response_chars=?, response_words=? WHERE id=? AND status='started'`,
          completedAt, latencyMs, result?.model || config.model || null, safeInt(usage.inputTokens), safeInt(usage.outputTokens), safeInt(usage.totalTokens ?? result?.usage), text.length, wordCount(text), callId);
      } catch { /* Best effort. */ }
      return { ...result, metricsCallId: callId };
    } catch (error) {
      try { await run("UPDATE metrics_model_calls SET completed_at=?, latency_ms=?, status='failed', error_category=? WHERE id=? AND status='started'", now(), roundMs(performance.now() - perfStart), ERROR_MAP[error?.providerCode] || 'transport_or_provider', callId); } catch { /* Best effort. */ }
      throw error;
    }
  }

  async function markSaved(callId) {
    if (!enabled || !callId) return;
    try { await run("UPDATE metrics_model_calls SET transcript_saved=1 WHERE id=? AND status='succeeded'", callId); } catch { /* Best effort. */ }
  }

  async function reconcile() {
    if (!enabled) return;
    try {
      await run("UPDATE metrics_model_calls SET status='interrupted', error_category='interrupted' WHERE status='started' AND started_at < ?", now() - 2 * 60 * 1000);
    } catch { /* Best effort. */ }
  }

  return { enabled, recordCompletion, markSaved, reconcile };
}

function safeInt(value) { return Number.isSafeInteger(value) && value >= 0 ? value : null; }

const views = new Set(['workshop','collect','passport','orchestration','editor','tests','settings','diary','mission','inception','other']);
const kinds = new Set(['page_enter','page_exit','heartbeat','visibility','phase','request','interaction']);
const phases = new Set(['read_think','compose','waiting','idle','hidden']);
const requestCategories = new Set(['navigation','round_action','authoring','review','other']);
const requestOutcomes = new Set(['success','error','retry']);
const interactions = new Set(['hint','submit','finish','inspect','reply','review']);
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const durationFields = ['elapsedMs','activeMs','visibleMs','idleMs','readThinkMs','composeMs','waitingMs','sinceReplyMs'];
const eventFields = new Set(['eventId','tabId','pageId','kind','view','roundId','phase',...durationFields,'requestCategory','requestOutcome','requestWallMs','retryCount','interaction']);

function validateEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event) || Object.keys(event).some(key => !eventFields.has(key))) throw Object.assign(new Error('Event contains an unsupported field.'), { status: 400 });
  if (!uuid(event.eventId) || !uuid(event.tabId) || !uuid(event.pageId) || !kinds.has(event.kind) || !views.has(event.view)) throw Object.assign(new Error('Event identity or category is invalid.'), { status: 400 });
  if (event.roundId !== undefined && !uuid(event.roundId)) throw Object.assign(new Error('Round ID is invalid.'), { status: 400 });
  event.eventId = event.eventId.toLowerCase();
  event.tabId = event.tabId.toLowerCase();
  event.pageId = event.pageId.toLowerCase();
  if (event.roundId !== undefined) event.roundId = event.roundId.toLowerCase();
  for (const key of durationFields) if (event[key] !== undefined && (!Number.isSafeInteger(event[key]) || event[key] < 0 || event[key] > 86400000)) throw Object.assign(new Error(`${key} must be a bounded integer.`), { status: 400 });
  if (event.requestWallMs !== undefined && (!Number.isSafeInteger(event.requestWallMs) || event.requestWallMs < 0 || event.requestWallMs > 600000)) throw Object.assign(new Error('requestWallMs must be a bounded integer.'), { status: 400 });
  if (event.retryCount !== undefined && (!Number.isSafeInteger(event.retryCount) || event.retryCount < 0 || event.retryCount > 20)) throw Object.assign(new Error('retryCount must be a bounded integer.'), { status: 400 });
  if (event.phase !== undefined && !phases.has(event.phase)) throw Object.assign(new Error('Phase is invalid.'), { status: 400 });
  if (event.requestCategory !== undefined && !requestCategories.has(event.requestCategory)) throw Object.assign(new Error('Request category is invalid.'), { status: 400 });
  if (event.requestOutcome !== undefined && !requestOutcomes.has(event.requestOutcome)) throw Object.assign(new Error('Request outcome is invalid.'), { status: 400 });
  if (event.interaction !== undefined && !interactions.has(event.interaction)) throw Object.assign(new Error('Interaction is invalid.'), { status: 400 });
  if (event.kind === 'phase' && !event.phase) throw Object.assign(new Error('Phase events require phase.'), { status: 400 });
  if (event.kind === 'request' && (!event.requestCategory || !event.requestOutcome || event.requestWallMs === undefined)) throw Object.assign(new Error('Request events require category, outcome, and wall time.'), { status: 400 });
  if (event.kind === 'interaction' && !event.interaction) throw Object.assign(new Error('Interaction events require interaction.'), { status: 400 });
  const { elapsedMs = 0, activeMs = 0, visibleMs = 0, idleMs = 0, readThinkMs = 0, composeMs = 0, waitingMs = 0 } = event;
  if (activeMs + idleMs > visibleMs || visibleMs > elapsedMs || readThinkMs + composeMs + waitingMs > activeMs || (event.phase === 'hidden' && (activeMs !== 0 || visibleMs !== 0))) throw Object.assign(new Error('Event duration totals are inconsistent.'), { status: 400 });
}

function windowFromQuery(query) {
  const end = now(), start = end - 30 * 86400000;
  const from = query.from === undefined ? start : Number(query.from), to = query.to === undefined ? end : Number(query.to);
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from >= to || to - from > 365 * 86400000) throw Object.assign(new Error('Date window must be a valid range of at most 365 days.'), { status: 400 });
  return { from, to };
}
function pageArgs(query, { allowType = false, requireType = false } = {}) {
  const limit = query.limit === undefined ? 50 : Number(query.limit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw Object.assign(new Error('limit must be an integer from 1 to 200.'), { status: 400 });
  let cursor = null;
  if (query.cursor !== undefined) {
    try { cursor = JSON.parse(Buffer.from(String(query.cursor), 'base64url').toString()); } catch { throw Object.assign(new Error('Cursor is invalid.'), { status: 400 }); }
    if (!cursor || Object.keys(cursor).some(key => !['at','id','type','from','to'].includes(key)) || !Number.isSafeInteger(cursor.at) || typeof cursor.id !== 'string' || cursor.id.length > 100 || (cursor.from !== undefined && !Number.isSafeInteger(cursor.from)) || (cursor.to !== undefined && !Number.isSafeInteger(cursor.to)) || ((cursor.from === undefined) !== (cursor.to === undefined)) || (cursor.from !== undefined && (cursor.from >= cursor.to || cursor.to - cursor.from > 365 * 86400000)) || (cursor.type !== undefined && (!allowType || !['event','model_call','session'].includes(cursor.type))) || (requireType && !cursor.type)) throw Object.assign(new Error('Cursor is invalid.'), { status: 400 });
  }
  return { limit, cursor };
}
const nextCursor = (row, window) => row ? Buffer.from(JSON.stringify({ at: row._at, id: row._id, from: window.from, to: window.to })).toString('base64url') : null;
function applyCursorWindow(query, window, cursor) {
  if (!cursor) return window;
  const checked = cursor.from !== undefined && cursor.to !== undefined ? { from: cursor.from, to: cursor.to } : window;
  if (cursor.at < checked.from || cursor.at >= checked.to) throw Object.assign(new Error('Cursor is outside its requested window.'), { status: 400 });
  if (cursor.from !== undefined && cursor.to !== undefined) {
    if ((query.from !== undefined && Number(query.from) !== cursor.from) || (query.to !== undefined && Number(query.to) !== cursor.to)) throw Object.assign(new Error('Cursor window does not match the requested window.'), { status: 400 });
    return checked;
  }
  return window;
}

export function addMetricsRoutes(app, { store, enabled = false, secureCookies = false, authorizeRound = async () => null, admin, sessionCreationLimit = 120, recordingNoticeRequired = false, recordingAccepted = async () => true, inceptionEntryPolicy = null }) {
  const { get, all, run, batch } = store;
  const identityFor = req => req.inceptionEntry?.actor?.id || req.user?.id || null;
  const cookieName = 'workshop_metrics';
  const cookieOptions = { httpOnly: true, sameSite: 'strict', path: '/api/telemetry', secure: secureCookies };
  const sessionCreationLimits = new Map();
  app.post('/api/telemetry/session', async (req, res) => {
    const organizerView = req.inceptionEntry?.policyId === inceptionEntryPolicy && req.body?.view === 'inception';
    const restrictedEntry = req.inceptionEntry?.actor?.role === 'inception_participant';
    if (restrictedEntry && !organizerView) return res.status(403).json({ error: 'This participant entry is limited to Inception telemetry.' });
    if (recordingNoticeRequired && req.user && !organizerView && !await recordingAccepted(req.user.id)) return res.status(428).json({ error: 'Acknowledge the recording notice before telemetry starts.' });
    if (!enabled) return res.json({ enabled: false, heartbeatSeconds: 0, idleAfterMs: 0 });
    const raw = req.cookies?.[cookieName];
    const userId = identityFor(req), time = now();
    let session = raw ? await get('SELECT * FROM metrics_sessions WHERE token_hash=?', hash(raw)) : null;
    if (session && (session.expires_at <= time || session.created_at + 24 * 60 * 60 * 1000 <= time || session.closed_at || session.user_id !== userId)) {
      await run('UPDATE metrics_sessions SET closed_at=? WHERE id=? AND closed_at IS NULL', time, session.id);
      session = null;
    }
    let currentSessionId;
    if (!session) {
      const key = req.ip || 'unknown';
      const previous = sessionCreationLimits.get(key);
      const bucket = previous && previous.until > time ? previous : { until: time + 60000, count: 0 };
      bucket.count++;
      sessionCreationLimits.set(key, bucket);
      if (sessionCreationLimits.size > 1000) for (const [entry,value] of sessionCreationLimits) if (value.until <= time) sessionCreationLimits.delete(entry);
      if (bucket.count > sessionCreationLimit) return res.status(429).json({ error: 'Too many new metrics sessions. Retry shortly.' });
      const token = randomBytes(32).toString('base64url'), id = randomUUID();
      await run('INSERT INTO metrics_sessions (id,token_hash,user_id,created_at,last_seen_at,expires_at,event_window_started_at,event_window_count) VALUES (?,?,?,?,?,?,?,0)', id, hash(token), userId, time, time, time + 30 * 60 * 1000, time);
      res.cookie(cookieName, token, { ...cookieOptions, maxAge: 30 * 60 * 1000 });
      currentSessionId = id;
    } else {
      const expires = Math.min(time + 30 * 60 * 1000, session.created_at + 24 * 60 * 60 * 1000);
      await run('UPDATE metrics_sessions SET last_seen_at=?, expires_at=? WHERE id=?', time, expires, session.id);
      res.cookie(cookieName, raw, { ...cookieOptions, maxAge: expires - time });
      currentSessionId = session.id;
    }
    res.json({ enabled: true, heartbeatSeconds: 18, idleAfterMs: 30000, sessionId: currentSessionId });
  });
  app.post('/api/telemetry/events', async (req, res) => {
    if (!enabled) return res.json({ accepted: 0, duplicates: 0 });
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).some(key => !['events','roundId','sessionId'].includes(key))) return res.status(400).json({ error: 'Event batch contains an unsupported field.' });
    if (!uuid(req.body.sessionId)) return res.status(400).json({ error: 'Metrics session ID is required.' });
    const events = req.body?.events;
    if (!Array.isArray(events) || events.length < 1 || events.length > 50) return res.status(400).json({ error: 'Submit 1 through 50 events.' });
    const organizerBatch = req.inceptionEntry?.policyId === inceptionEntryPolicy && events.every(event => event?.view === 'inception');
    const restrictedEntry = req.inceptionEntry?.actor?.role === 'inception_participant';
    if (restrictedEntry && !organizerBatch) return res.status(403).json({ error: 'This participant entry is limited to Inception telemetry.' });
    const ordinaryAcknowledgement = Boolean(req.user && await recordingAccepted(req.user.id));
    const reliesOnOrganizerPolicy = Boolean(organizerBatch && !ordinaryAcknowledgement);
    if (recordingNoticeRequired && req.user && !organizerBatch && !ordinaryAcknowledgement) return res.status(428).json({ error: 'Acknowledge the recording notice before telemetry starts.' });
    const raw = req.cookies?.[cookieName];
    const session = raw ? await get('SELECT * FROM metrics_sessions WHERE token_hash=?', hash(raw)) : null;
    if (!session || req.body.sessionId !== session.id || session.expires_at <= now() || session.created_at + 24 * 60 * 60 * 1000 <= now() || session.closed_at || session.user_id !== identityFor(req)) return res.status(401).json({ error: 'Metrics session expired.' });
    events.forEach(validateEvent);
    if (req.body.roundId !== undefined && !uuid(req.body.roundId)) return res.status(400).json({ error: 'Round ID is invalid.' });
    if (req.body.roundId !== undefined && events.some(e => e.roundId !== undefined && e.roundId !== req.body.roundId)) return res.status(400).json({ error: 'Batch round ID does not match its events.' });
    const batchRoundId = req.body.roundId;
    const roundIds = new Set([...events.map(e => e.roundId).filter(Boolean), ...(batchRoundId ? [batchRoundId] : [])]);
    if (roundIds.size > 1 || (roundIds.size === 1 && !batchRoundId && events.some(e => !e.roundId))) return res.status(400).json({ error: 'A batch can be scoped to one round only.' });
    let inferred = {};
    if (roundIds.size) {
      const roundId = [...roundIds][0];
      if (!req.user && !req.inceptionEntry && !req.get('x-round-token')) return res.status(403).json({ error: 'Round capability is required.' });
      const round = await authorizeRound(req, roundId);
      if (!round) return res.status(403).json({ error: req.user || req.inceptionEntry ? 'Round access is not authorized.' : 'Round capability is invalid.' });
      if (reliesOnOrganizerPolicy && !(round.source === 'inception-play' && round.author_id === req.inceptionEntry.actor.id && round.recording_notice_version === inceptionEntryPolicy)) return res.status(403).json({ error: 'Organizer-policy telemetry is limited to this participant’s Inception round.' });
      inferred = await get('SELECT a.collection_id AS "collectionId",a.profile_id AS "profileId",COALESCE(a.source,r.source) AS source,r.version_id AS "versionId" FROM rounds r LEFT JOIN difficulty_collection_assignments a ON a.round_id=r.id WHERE r.id=?', roundId) || {};
      inferred.profileId ||= round.profileId || null;
      inferred.source = safeSource(inferred.source);
    }
    const time = now(), batchToken=randomUUID(), expires=Math.min(time+30*60*1000,session.created_at+24*60*60*1000), actorId = identityFor(req);
    const stmts=[['UPDATE metrics_sessions SET event_window_started_at=CASE WHEN event_window_started_at+60000<=? THEN ? ELSE event_window_started_at END,event_window_count=CASE WHEN event_window_started_at+60000<=? THEN ? ELSE event_window_count+? END,event_batch_token=?,last_seen_at=?,expires_at=? WHERE id=? AND expires_at>? AND created_at+86400000>? AND closed_at IS NULL AND (user_id=? OR (user_id IS NULL AND CAST(? AS TEXT) IS NULL)) AND (CASE WHEN event_window_started_at+60000<=? THEN 0 ELSE event_window_count END)+?<=200',time,time,time,events.length,events.length,batchToken,time,expires,session.id,time,time,actorId,actorId,time,events.length]];
    for (const e of events) stmts.push(['INSERT INTO metrics_events (event_id,session_id,user_id,tab_id,page_id,round_id,collection_id,profile_id,source,version_id,event_kind,view_category,phase,elapsed_ms,active_ms,visible_ms,idle_ms,read_think_ms,compose_ms,waiting_ms,since_reply_ms,request_category,request_outcome,request_wall_ms,retry_count,interaction,created_at) SELECT ?,s.id,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? FROM metrics_sessions s WHERE s.id=? AND s.event_batch_token=? ON CONFLICT(event_id) DO NOTHING',
      e.eventId, session.user_id, e.tabId, e.pageId, e.roundId || batchRoundId || null, inferred.collectionId || null, inferred.profileId || null, inferred.source || null, inferred.versionId || null, e.kind, e.view, e.phase || null, e.elapsedMs ?? null, e.activeMs ?? null, e.visibleMs ?? null, e.idleMs ?? null, e.readThinkMs ?? null, e.composeMs ?? null, e.waitingMs ?? null, e.sinceReplyMs ?? null, e.requestCategory || null, e.requestOutcome || null, e.requestWallMs ?? null, e.retryCount ?? null, e.interaction || null, time, session.id, batchToken]);
    const results = await batch(stmts);
    if (!results[0]?.changes) {
      const current=await get('SELECT user_id,expires_at,created_at,closed_at FROM metrics_sessions WHERE id=?',session.id);
      if(!current||current.closed_at||current.expires_at<=time||current.created_at+24*60*60*1000<=time||current.user_id!==actorId)return res.status(401).json({error:'Metrics session expired.'});
      return res.status(429).json({ error: 'Event rate limit reached.' });
    }
    const accepted=results.slice(1).reduce((n,result)=>n+Number(result.changes||0),0);
    res.cookie(cookieName,raw,{...cookieOptions,maxAge:Math.max(0,expires-time)});
    res.json({ accepted, duplicates: events.length - accepted });
  });

  const owner = admin || ((_req, res) => res.status(403).json({ error: 'Owner metrics authorization is unavailable.' }));
  app.get('/api/metrics/summary', owner, async (req, res) => {
    if (!enabled) return res.json({ enabled: false });
    const window = windowFromQuery(req.query);
    await run("UPDATE metrics_model_calls SET status='interrupted',error_category='interrupted' WHERE status='started' AND started_at<?", now()-120000);
    const [first,instrumentation,calls,browser,sessions,routes,sources,models,profiles,profileLatency,roundCoverage,reviews,rounds,overallLatency,modelLatency] = await Promise.all([
      get('SELECT MIN(t) AS t FROM (SELECT started_at AS t FROM metrics_model_calls WHERE started_at>=? AND started_at<? UNION ALL SELECT created_at AS t FROM metrics_events WHERE created_at>=? AND created_at<? UNION ALL SELECT created_at AS t FROM metrics_sessions WHERE created_at>=? AND created_at<?)',window.from,window.to,window.from,window.to,window.from,window.to),
      get('SELECT MIN(t) AS t FROM (SELECT started_at AS t FROM metrics_model_calls UNION ALL SELECT created_at AS t FROM metrics_events UNION ALL SELECT created_at AS t FROM metrics_sessions)'),
      get('SELECT COUNT(*) AS total,SUM(CASE WHEN status=\'succeeded\' THEN 1 ELSE 0 END) AS succeeded,SUM(CASE WHEN status=\'failed\' THEN 1 ELSE 0 END) AS failed,SUM(CASE WHEN status=\'interrupted\' THEN 1 ELSE 0 END) AS interrupted,SUM(CASE WHEN status=\'started\' THEN 1 ELSE 0 END) AS started,SUM(CASE WHEN retry_of_id IS NOT NULL THEN 1 ELSE 0 END) AS retries,COUNT(latency_ms) AS "latencyCount",AVG(latency_ms) AS "latencyMean",MIN(latency_ms) AS "latencyMin",MAX(latency_ms) AS "latencyMax",SUM(input_tokens) AS "inputSum",COUNT(input_tokens) AS "inputCovered",SUM(output_tokens) AS "outputSum",COUNT(output_tokens) AS "outputCovered",SUM(total_tokens) AS "totalSum",COUNT(total_tokens) AS "totalCovered",SUM(response_chars) AS chars,SUM(response_words) AS words FROM metrics_model_calls WHERE started_at>=? AND started_at<?',window.from,window.to),
      get("SELECT COUNT(*) AS events,COUNT(DISTINCT session_id) AS sessions,SUM(CASE WHEN event_kind IN ('heartbeat','visibility','page_exit') AND active_ms IS NOT NULL THEN 1 ELSE 0 END) AS timed,SUM(CASE WHEN event_kind IN ('heartbeat','visibility','page_exit') AND active_ms IS NULL THEN 1 ELSE 0 END) AS missing,SUM(CASE WHEN event_kind IN ('heartbeat','visibility','page_exit') THEN active_ms END) AS active,SUM(CASE WHEN event_kind IN ('heartbeat','visibility','page_exit') THEN visible_ms END) AS visible,SUM(CASE WHEN event_kind IN ('heartbeat','visibility','page_exit') THEN idle_ms END) AS idle,SUM(CASE WHEN event_kind IN ('heartbeat','visibility','page_exit') THEN read_think_ms END) AS \"readThink\",SUM(CASE WHEN event_kind IN ('heartbeat','visibility','page_exit') THEN compose_ms END) AS compose,SUM(CASE WHEN event_kind IN ('heartbeat','visibility','page_exit') THEN waiting_ms END) AS waiting FROM metrics_events WHERE created_at>=? AND created_at<?",window.from,window.to),
      get('SELECT COUNT(*) AS count FROM metrics_sessions WHERE created_at>=? AND created_at<?',window.from,window.to),
      all('SELECT view_category AS view,COUNT(DISTINCT session_id) AS sessions,COUNT(*) AS events,SUM(active_ms) AS "activeMs",SUM(visible_ms) AS "visibleMs" FROM metrics_events WHERE created_at>=? AND created_at<? GROUP BY view_category',window.from,window.to),
      all("SELECT COALESCE(source,context_kind) AS source,COUNT(*) AS calls,SUM(CASE WHEN status='succeeded' THEN 1 ELSE 0 END) AS succeeded,SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,SUM(CASE WHEN status='interrupted' THEN 1 ELSE 0 END) AS interrupted,SUM(CASE WHEN status='started' THEN 1 ELSE 0 END) AS started,SUM(CASE WHEN retry_of_id IS NOT NULL THEN 1 ELSE 0 END) AS retries,COUNT(DISTINCT round_id) AS rounds FROM metrics_model_calls WHERE started_at>=? AND started_at<? GROUP BY COALESCE(source,context_kind)",window.from,window.to),
      all("SELECT requested_model AS model,COUNT(*) AS calls,SUM(CASE WHEN status='succeeded' THEN 1 ELSE 0 END) AS succeeded,SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,SUM(CASE WHEN status='interrupted' THEN 1 ELSE 0 END) AS interrupted,SUM(CASE WHEN status='started' THEN 1 ELSE 0 END) AS started FROM metrics_model_calls WHERE started_at>=? AND started_at<? GROUP BY requested_model",window.from,window.to),
      all("SELECT collection_id AS \"collectionId\",source,profile_id AS \"profileId\",COUNT(*) AS calls,SUM(CASE WHEN status='succeeded' THEN 1 ELSE 0 END) AS succeeded,SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,SUM(CASE WHEN status='interrupted' THEN 1 ELSE 0 END) AS interrupted,SUM(CASE WHEN status='started' THEN 1 ELSE 0 END) AS started,SUM(CASE WHEN retry_of_id IS NOT NULL THEN 1 ELSE 0 END) AS retries,COUNT(DISTINCT round_id) AS rounds FROM metrics_model_calls WHERE started_at>=? AND started_at<? AND profile_id IS NOT NULL GROUP BY collection_id,source,profile_id",window.from,window.to),
      profilePercentiles(all,window),
      get('SELECT COUNT(*) AS rounds,COUNT(c.round_id) AS "withCalls",COUNT(*)-COUNT(c.round_id) AS "withoutCalls" FROM rounds r LEFT JOIN (SELECT DISTINCT round_id FROM metrics_model_calls WHERE round_id IS NOT NULL) c ON c.round_id=r.id WHERE r.started_at>=? AND r.started_at<?',window.from,window.to),
      all('SELECT outcome,COUNT(*) AS count FROM reviews JOIN rounds ON rounds.id=reviews.round_id WHERE rounds.started_at>=? AND rounds.started_at<? GROUP BY outcome',window.from,window.to),
      roundSummaryPages(store,window),
      percentileQuery(get,all,'',window),
      percentileQuery(get,all,'requested_model',window),
    ]);
    const asNum=value=>value==null?0:Number(value), tokenStat=(sum,covered)=>({sum:asNum(covered)?asNum(sum):null,covered:asNum(covered),missing:asNum(calls.total)-asNum(covered)});
    const totalLatency={count:asNum(calls.latencyCount),meanMs:calls.latencyMean==null?null:Number(calls.latencyMean),minMs:calls.latencyMin==null?null:Number(calls.latencyMin),maxMs:calls.latencyMax==null?null:Number(calls.latencyMax),p50Ms:overallLatency?.p50Ms==null?null:Number(overallLatency.p50Ms),p90Ms:overallLatency?.p90Ms==null?null:Number(overallLatency.p90Ms),p95Ms:overallLatency?.p95Ms==null?null:Number(overallLatency.p95Ms)};
    const modelsById=new Map(modelLatency.map(row=>[row.model,row]));
    const profileLatencyByKey=new Map(profileLatency.map(row=>[`${row.collectionId||''}\0${row.source||''}\0${row.profileId}`,row]));
    res.json({window,instrumentationStartedAt:instrumentation?.t??null,firstRecordedAt:first?.t??null,
      coverage:{modelCalls:{recorded:asNum(calls.total),roundsWithoutCalls:asNum(roundCoverage.withoutCalls)},rounds:{withCalls:asNum(roundCoverage.withCalls),withoutCalls:asNum(roundCoverage.withoutCalls)},browserIntervals:{timed:asNum(browser.timed),missing:asNum(browser.missing)}},
      visits:{sessions:asNum(sessions.count)},browser:{sessions:asNum(browser.sessions),events:asNum(browser.events),activeMs:browser.active==null?null:Number(browser.active),visibleMs:browser.visible==null?null:Number(browser.visible),idleMs:browser.idle==null?null:Number(browser.idle),readThinkMs:browser.readThink==null?null:Number(browser.readThink),composeMs:browser.compose==null?null:Number(browser.compose),waitingMs:browser.waiting==null?null:Number(browser.waiting),timedIntervals:asNum(browser.timed),missingIntervals:asNum(browser.missing)},
      modelCalls:{total:asNum(calls.total),succeeded:asNum(calls.succeeded),failed:asNum(calls.failed),interrupted:asNum(calls.interrupted),inFlight:asNum(calls.started),inferredRetries:asNum(calls.retries),latency:totalLatency,tokens:{input:tokenStat(calls.inputSum,calls.inputCovered),output:tokenStat(calls.outputSum,calls.outputCovered),total:tokenStat(calls.totalSum,calls.totalCovered)},response:{chars:asNum(calls.chars),words:asNum(calls.words)}},
      rounds:{...rounds,reviewOutcomes:Object.fromEntries(reviews.map(r=>[r.outcome,Number(r.count)]))},routes:routes.map(r=>({view:r.view,sessions:asNum(r.sessions),events:asNum(r.events),activeMs:r.activeMs==null?null:Number(r.activeMs),visibleMs:r.visibleMs==null?null:Number(r.visibleMs)})),
      bySource:sources.map(r=>({source:r.source,calls:asNum(r.calls),succeeded:asNum(r.succeeded),failed:asNum(r.failed),interrupted:asNum(r.interrupted),inFlight:asNum(r.started),inferredRetries:asNum(r.retries),rounds:asNum(r.rounds)})),
      byModel:models.map(r=>{const lat=modelsById.get(r.model);return {model:r.model,calls:asNum(r.calls),succeeded:asNum(r.succeeded),failed:asNum(r.failed),interrupted:asNum(r.interrupted),inFlight:asNum(r.started),latency:{count:asNum(lat?.count),meanMs:lat?.meanMs==null?null:Number(lat.meanMs),p50Ms:lat?.p50Ms==null?null:Number(lat.p50Ms),p90Ms:lat?.p90Ms==null?null:Number(lat.p90Ms),p95Ms:lat?.p95Ms==null?null:Number(lat.p95Ms)}}}),
      byProfile:profiles.map(r=>{const latency=profileLatencyByKey.get(`${r.collectionId||''}\0${r.source||''}\0${r.profileId}`);return {collectionId:r.collectionId,source:r.source,profileId:r.profileId,calls:asNum(r.calls),succeeded:asNum(r.succeeded),failed:asNum(r.failed),interrupted:asNum(r.interrupted),inFlight:asNum(r.started),inferredRetries:asNum(r.retries),rounds:asNum(r.rounds),latency:{count:asNum(latency?.count),meanMs:latency?.meanMs==null?null:Number(latency.meanMs),p50Ms:latency?.p50Ms==null?null:Number(latency.p50Ms),p95Ms:latency?.p95Ms==null?null:Number(latency.p95Ms)}};})});
  });
  for (const [path,table,timeColumn] of [['/api/metrics/sessions','metrics_sessions','created_at'],['/api/metrics/calls','metrics_model_calls','started_at']]) app.get(path,owner,async(req,res)=>{
    let window=windowFromQuery(req.query);const {limit,cursor}=pageArgs(req.query);window=applyCursorWindow(req.query,window,cursor);
    if(!enabled)return res.json({items:[],limit,nextCursor:null,window});
    const at=cursor?.at??window.to-1,id=cursor?.id??'\uffff';
    const idCollation = store.dialect === 'postgres' ? ' COLLATE "C"' : ' COLLATE BINARY';
    const rows=await all(`SELECT *,${timeColumn} AS _at,id AS _id FROM ${table} WHERE ${timeColumn}>=? AND ${timeColumn}<? AND (${timeColumn}<? OR (${timeColumn}=? AND id${idCollation}<?)) ORDER BY ${timeColumn} DESC,id${idCollation} DESC LIMIT ?`,window.from,window.to,at,at,id,limit+1);
    const page=rows.slice(0,limit),items=await Promise.all(page.map(row=>table==='metrics_sessions'?sessionDto(row,store):callDto(row)));
    res.json({items,limit,nextCursor:rows.length>limit?nextCursor(page.at(-1),window):null,window});
  });
  app.get('/api/metrics/export',owner,async(req,res)=>{
    let window=windowFromQuery(req.query);const {limit,cursor}=pageArgs({...req.query,limit:req.query.limit??100},{allowType:true,requireType:true});window=applyCursorWindow(req.query,window,cursor);
    if(!enabled)return res.json({schema:'owner-metrics',schemaVersion:1,window,items:[],nextCursor:null,pageLimit:limit});
    const at=cursor?.at??window.to-1,id=cursor?.id??'\uffff',cap=limit+1;
    const idCollation = store.dialect === 'postgres' ? ' COLLATE "C"' : ' COLLATE BINARY';
    const [eventRows,callRows,sessionRows]=await Promise.all([
      all(`SELECT * FROM metrics_events WHERE created_at>=? AND created_at<? AND (created_at<? OR (created_at=? AND (event_id${idCollation}<? OR (event_id${idCollation}=? AND 'event'>?)))) ORDER BY created_at DESC,event_id${idCollation} DESC LIMIT ?`,window.from,window.to,at,at,id,id,cursor?.type||'',cap),
      all(`SELECT * FROM metrics_model_calls WHERE started_at>=? AND started_at<? AND (started_at<? OR (started_at=? AND (id${idCollation}<? OR (id${idCollation}=? AND 'model_call'>?)))) ORDER BY started_at DESC,id${idCollation} DESC LIMIT ?`,window.from,window.to,at,at,id,id,cursor?.type||'',cap),
      all(`SELECT * FROM metrics_sessions WHERE created_at>=? AND created_at<? AND (created_at<? OR (created_at=? AND (id${idCollation}<? OR (id${idCollation}=? AND 'session'>?)))) ORDER BY created_at DESC,id${idCollation} DESC LIMIT ?`,window.from,window.to,at,at,id,id,cursor?.type||'',cap),
    ]);
    const records=[
      ...eventRows.map(r=>({type:'event',id:r.event_id,recordedAt:r.created_at,sessionId:r.session_id,userId:r.user_id,kind:r.event_kind,view:r.view_category,tabId:r.tab_id,pageId:r.page_id,roundId:r.round_id,collectionId:r.collection_id,source:r.source,profileId:r.profile_id,versionId:r.version_id,phase:r.phase,elapsedMs:r.elapsed_ms,activeMs:r.active_ms,visibleMs:r.visible_ms,idleMs:r.idle_ms,readThinkMs:r.read_think_ms,composeMs:r.compose_ms,waitingMs:r.waiting_ms,sinceReplyMs:r.since_reply_ms,requestCategory:r.request_category,requestOutcome:r.request_outcome,requestWallMs:r.request_wall_ms,retryCount:r.retry_count,interaction:r.interaction})),
      ...callRows.map(r=>({type:'model_call',id:r.id,recordedAt:r.started_at,...callDto(r)})),
      ...await Promise.all(sessionRows.map(async r=>({type:'session',id:r.id,recordedAt:r.created_at,...await sessionDto(r,store)}))),
    ].sort((a,b)=>b.recordedAt-a.recordedAt||(a.id===b.id?0:a.id<b.id?1:-1)||(a.type===b.type?0:a.type<b.type?-1:1));
    const items=records.slice(0,limit),last=items.at(-1);
    res.json({schema:'owner-metrics',schemaVersion:1,window,items,nextCursor:records.length>limit?Buffer.from(JSON.stringify({at:last.recordedAt,id:last.id,type:last.type,from:window.from,to:window.to})).toString('base64url'):null,pageLimit:limit});
  });
}

async function percentileQuery(get, all, groupColumn, window) {
  const group = groupColumn ? `${groupColumn} AS model,` : '';
  const partition = groupColumn ? `PARTITION BY ${groupColumn}` : '';
  const grouping = groupColumn ? 'GROUP BY model' : '';
  const sql=`WITH ordered AS (SELECT ${group}latency_ms,ROW_NUMBER() OVER (${partition} ORDER BY latency_ms) AS rn,COUNT(*) OVER (${partition}) AS n FROM metrics_model_calls WHERE started_at>=? AND started_at<? AND latency_ms IS NOT NULL) SELECT ${groupColumn ? 'model,' : ''}COUNT(*) AS count,AVG(latency_ms) AS "meanMs",MAX(CASE WHEN rn=CAST((n+1)/2 AS INTEGER) THEN latency_ms END) AS "p50Ms",MAX(CASE WHEN rn=CAST((n*9+9)/10 AS INTEGER) THEN latency_ms END) AS "p90Ms",MAX(CASE WHEN rn=CAST((n*95+99)/100 AS INTEGER) THEN latency_ms END) AS "p95Ms" FROM ordered ${grouping}`;
  return groupColumn ? all(sql,window.from,window.to) : get(sql,window.from,window.to);
}

async function profilePercentiles(all,window){
  return all('WITH ordered AS (SELECT collection_id,source,profile_id,latency_ms,ROW_NUMBER() OVER (PARTITION BY collection_id,source,profile_id ORDER BY latency_ms) AS rn,COUNT(*) OVER (PARTITION BY collection_id,source,profile_id) AS n FROM metrics_model_calls WHERE started_at>=? AND started_at<? AND profile_id IS NOT NULL AND latency_ms IS NOT NULL) SELECT collection_id AS "collectionId",source,profile_id AS "profileId",COUNT(*) AS count,AVG(latency_ms) AS "meanMs",MAX(CASE WHEN rn=CAST((n+1)/2 AS INTEGER) THEN latency_ms END) AS "p50Ms",MAX(CASE WHEN rn=CAST((n*95+99)/100 AS INTEGER) THEN latency_ms END) AS "p95Ms" FROM ordered GROUP BY collection_id,source,profile_id',window.from,window.to);
}

async function roundSummaryPages(store, window) {
  const { all } = store;
  const summary={started:0,submitted:0,active:0,abandoned:0,hints:0,questions:0,diagnostics:{started:0,submitted:0,active:0,abandoned:0,hints:0,questions:0},bySource:{}};
  const durationExpression = store.dialect === 'postgres'
    ? "CASE WHEN r.data::jsonb->>'duration' ~ '^[0-9]+$' THEN (r.data::jsonb->>'duration')::numeric ELSE 0 END"
    : "CAST(json_extract(r.data, '$.duration') AS INTEGER)";
  const questionExpression = store.dialect === 'postgres'
    ? "(SELECT COUNT(*) FROM jsonb_array_elements(r.messages::jsonb) AS message(value) WHERE value->>'role'='user')"
    : "(SELECT COUNT(*) FROM json_each(r.messages) AS message WHERE json_extract(message.value, '$.role')='user')";
  let lastAt=window.from-1,lastId='';
  while(true){
    const rows=await all(`SELECT r.id,r.source,COALESCE(a.source,r.source) AS metric_source,r.started_at,r.ended_at,${durationExpression} AS duration_seconds,${questionExpression} AS question_count,r.hints_used FROM rounds r LEFT JOIN difficulty_collection_assignments a ON a.round_id=r.id WHERE r.started_at>=? AND r.started_at<? AND (r.started_at>? OR (r.started_at=? AND r.id>?)) ORDER BY r.started_at,r.id LIMIT 500`,window.from,window.to,lastAt,lastAt,lastId);
    if(!rows.length)break;
    for(const row of rows){
      const source=row.metric_source||row.source||'unknown';
      const participant=['participant','blind','reference-blind','collection-participant','diary-play','diary-blind','mission-play'].includes(source);
      const bucket=participant?summary:summary.diagnostics;
      bucket.started++;
      bucket.questions+=Number(row.question_count)||0;
      if(row.ended_at!=null)bucket.submitted++;
      else {
        const duration=Number(row.duration_seconds)||0;
        if(row.started_at+duration*1000<=now())bucket.abandoned++;else bucket.active++;
      }
      bucket.hints+=Number(row.hints_used||0);
      const perSource=summary.bySource[source]||= {source,started:0,submitted:0,active:0,abandoned:0,hints:0,questions:0};
      perSource.started++;
      perSource.questions+=Number(row.question_count)||0;
      if(row.ended_at!=null)perSource.submitted++;
      else if(row.started_at+(Number(row.duration_seconds)||0)*1000<=now())perSource.abandoned++;
      else perSource.active++;
      perSource.hints+=Number(row.hints_used||0);
    }
    lastAt=rows.at(-1).started_at;lastId=rows.at(-1).id;
    if(rows.length<500)break;
  }
  return {...summary,bySource:Object.values(summary.bySource)};
}

async function sessionDto(row,store){
  const {all}=store;
  const questionExpression = store.dialect === 'postgres'
    ? "(SELECT COUNT(*) FROM jsonb_array_elements(r.messages::jsonb) AS message(value) WHERE value->>'role'='user')"
    : "(SELECT COUNT(*) FROM json_each(r.messages) AS message WHERE json_extract(message.value, '$.role')='user')";
  const [stats,routes,rounds]=await Promise.all([
    store.get("SELECT COUNT(*) AS events,COUNT(DISTINCT tab_id) AS tabs,COUNT(DISTINCT page_id) AS pages,SUM(CASE WHEN event_kind IN ('heartbeat','visibility','page_exit') AND active_ms IS NOT NULL THEN 1 ELSE 0 END) AS timed,SUM(CASE WHEN event_kind IN ('heartbeat','visibility','page_exit') AND active_ms IS NULL THEN 1 ELSE 0 END) AS missing,SUM(CASE WHEN event_kind IN ('heartbeat','visibility','page_exit') THEN active_ms END) AS active,SUM(CASE WHEN event_kind IN ('heartbeat','visibility','page_exit') THEN visible_ms END) AS visible,SUM(CASE WHEN event_kind IN ('heartbeat','visibility','page_exit') THEN idle_ms END) AS idle,SUM(CASE WHEN event_kind IN ('heartbeat','visibility','page_exit') THEN read_think_ms END) AS \"readThink\",SUM(CASE WHEN event_kind IN ('heartbeat','visibility','page_exit') THEN compose_ms END) AS compose,SUM(CASE WHEN event_kind IN ('heartbeat','visibility','page_exit') THEN waiting_ms END) AS waiting FROM metrics_events WHERE session_id=?",row.id),
    all("SELECT view_category AS view,COUNT(*) AS events,SUM(CASE WHEN event_kind IN ('heartbeat','visibility','page_exit') THEN active_ms END) AS \"activeMs\",SUM(CASE WHEN event_kind IN ('heartbeat','visibility','page_exit') THEN visible_ms END) AS \"visibleMs\" FROM metrics_events WHERE session_id=? GROUP BY view_category",row.id),
    all(`SELECT r.id AS "roundId",COALESCE(a.source,r.source) AS source,r.version_id AS "versionId",r.started_at AS "startedAt",r.ended_at AS "submittedAt",r.hints_used AS hints,${questionExpression} AS questions FROM rounds r JOIN (SELECT DISTINCT round_id FROM metrics_events WHERE session_id=? AND round_id IS NOT NULL) e ON e.round_id=r.id LEFT JOIN difficulty_collection_assignments a ON a.round_id=r.id ORDER BY r.started_at`,row.id),
  ]);
  return {sessionId:row.id,createdAt:row.created_at,lastSeenAt:row.last_seen_at,closedAt:row.closed_at,userId:row.user_id,tabCount:Number(stats.tabs),pageCount:Number(stats.pages),events:Number(stats.events),activeMs:stats.active==null?null:Number(stats.active),visibleMs:stats.visible==null?null:Number(stats.visible),idleMs:stats.idle==null?null:Number(stats.idle),readThinkMs:stats.readThink==null?null:Number(stats.readThink),composeMs:stats.compose==null?null:Number(stats.compose),waitingMs:stats.waiting==null?null:Number(stats.waiting),routeUsage:routes.map(r=>({view:r.view,events:Number(r.events),activeMs:r.activeMs==null?null:Number(r.activeMs),visibleMs:r.visibleMs==null?null:Number(r.visibleMs)})),rounds:rounds.map(r=>({...r,hints:Number(r.hints),questions:Number(r.questions)})),coverage:{timedIntervals:Number(stats.timed),missingIntervals:Number(stats.missing)}};
}

function callDto(r){return {callId:r.id,context:{kind:r.context_kind,roundId:r.round_id,runId:r.orchestration_run_id,lane:r.lane,userId:r.actor_user_id,userRole:r.actor_role,collectionId:r.collection_id,profileId:r.profile_id,source:r.source,versionId:r.version_id},startedAt:r.started_at,completedAt:r.completed_at,latencyMs:r.latency_ms,requestedModel:r.requested_model,returnedModel:r.returned_model,providerHost:r.provider_host,status:r.status,errorCategory:r.error_category,tokens:{input:r.input_tokens,output:r.output_tokens,total:r.total_tokens},response:{chars:r.response_chars,words:r.response_words},retry:{inferred:Boolean(r.retry_of_id),retryOfId:r.retry_of_id},transcriptSaved:Boolean(r.transcript_saved)};}
