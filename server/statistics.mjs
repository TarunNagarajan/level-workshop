import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { validInceptionDisclosure } from './inception.mjs';

const TEST_ACTORS = new Set(['c8b7e446-8277-49c7-9e45-e65301eea3ec', '0a97f20c-9353-4470-8048-cc7c22744b0c']);
const TEST_NAMES = new Set(['tarun', 'tawun', 'owner', 'workshop owner']);
const IST_OFFSET = 330 * 60_000;
const json = value => { try { return JSON.parse(value); } catch { return null; } };
const encoded = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const decoded = value => { try { return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); } catch { return null; } };
const sha = value => createHash('sha256').update(value).digest('hex');
const dayStartIst = now => Math.floor((now + IST_OFFSET) / 86400000) * 86400000 - IST_OFFSET;

export function addStatisticsRoutes(app, { store, admin, authThrottle, checkOwnerKey, enter, capacity, cursorKey }) {
  const { all, get } = store;
  const cursorSecret = Buffer.from(cursorKey, 'hex');
  const signCursor = value => createHmac('sha256', cursorSecret).update(value).digest('base64url');

  app.post('/api/statistics/session', authThrottle, async (req, res) => {
    if (req.user?.role === 'admin') return res.json({ user: { id: req.user.id, name: req.user.name, role: req.user.role } });
    const key = typeof req.body?.key === 'string' ? req.body.key : '';
    if (!key.trim() || key.length > 512) return res.status(400).json({ error: 'Enter a valid owner key.' });
    checkOwnerKey(key);
    const owner = await get("SELECT id,name,role FROM users WHERE role='admin' LIMIT 1");
    if (!owner) return res.status(404).json({ error: 'Owner sign-in is unavailable.' });
    await enter(res, owner);
  });
  app.get('/api/statistics/session', (req, res) => res.json({ user: req.user?.role === 'admin' ? { id: req.user.id, name: req.user.name, role: req.user.role } : null }));

  const parseFilters = query => {
    const now = Date.now();
    const period = query.period || '30d';
    const durations = { today: 1, '7d': 7, '30d': 30, '90d': 90, '365d': 365 };
    if (typeof period !== 'string' || !Object.hasOwn(durations, period)) throw Object.assign(new Error('Choose a valid statistics period.'), { status: 400 });
    const days = durations[period];
    let start = period === 'today' ? dayStartIst(now) : now - days * 86400000;
    let cutoff = now;
    if (query.from !== undefined || query.to !== undefined) {
      if (typeof query.from !== 'string' || typeof query.to !== 'string' || !/^\d{1,16}$/.test(query.from) || !/^\d{1,16}$/.test(query.to)) throw Object.assign(new Error('The statistics window is invalid.'), { status: 400 });
      const pinnedFrom = Number(query.from), pinnedTo = Number(query.to);
      const expected = period === 'today' ? dayStartIst(pinnedTo) : pinnedTo - days * 86400000;
      if (!Number.isSafeInteger(pinnedFrom) || !Number.isSafeInteger(pinnedTo) || pinnedTo > now || pinnedTo < 0 || pinnedFrom !== expected || pinnedTo - pinnedFrom > 365 * 86400000) throw Object.assign(new Error('The statistics window is invalid or outside the selected period.'), { status: 400 });
      start = pinnedFrom; cutoff = pinnedTo;
    }
    if (query.search !== undefined && typeof query.search !== 'string') throw Object.assign(new Error('Search must be text.'), { status: 400 });
    const search = typeof query.search === 'string' ? query.search.trim() : '';
    if (search.length > 100) throw Object.assign(new Error('Search must be 100 characters or fewer.'), { status: 400 });
    const outcome = query.outcome || 'all';
    if (typeof outcome !== 'string' || !['all', 'won', 'not-recovered', 'unfinished', 'review-error'].includes(outcome)) throw Object.assign(new Error('Choose a valid outcome filter.'), { status: 400 });
    if (query.includeTests !== undefined && !['true', 'false'].includes(query.includeTests)) throw Object.assign(new Error('includeTests must be true or false.'), { status: 400 });
    return { period, start, cutoff, pinnedWindow: query.from !== undefined || query.to !== undefined, search, outcome, includeTests: query.includeTests === 'true' };
  };
  const signature = f => sha(JSON.stringify([f.period, f.search.toLowerCase(), f.outcome, f.includeTests]));
  const selectRows = async f => {
    const searchId = /^[0-9a-f-]{8,100}$/i.test(f.search) ? f.search : '';
    const durationProjection = store.dialect === 'postgres' ? "CAST(r.data::jsonb->>'duration' AS INTEGER)" : "CAST(json_extract(r.data,'$.duration') AS INTEGER)";
    const promptProjection = store.dialect === 'postgres' ? "(SELECT COUNT(*) FROM jsonb_array_elements(r.messages::jsonb) AS messages(value) WHERE value->>'role'='user')" : "(SELECT COUNT(*) FROM json_each(r.messages) WHERE json_extract(value,'$.role')='user')";
    const rows = await all(`SELECT r.id,r.author_id,r.tester,r.started_at,r.ended_at,${durationProjection} AS duration_seconds,${promptProjection} AS saved_prompt_count,
      i.actor_id,i.state,u.name AS actor_name,m.status AS review_status,m.verdict,m.reason,m.evidence,m.error_code,m.started_at AS review_started_at,m.completed_at AS review_completed_at
      FROM rounds r JOIN inception_sessions i ON i.round_id=r.id LEFT JOIN users u ON u.id=i.actor_id LEFT JOIN round_machine_reviews m ON m.round_id=r.id
      WHERE r.source='inception-play' AND r.started_at>=? AND r.started_at<? AND (?='' OR lower(COALESCE(u.name,'')) LIKE ? OR r.id LIKE ?)
      ORDER BY r.started_at DESC,r.id DESC`, f.start, f.cutoff, f.search, `%${f.search.toLowerCase()}%`, `%${searchId || f.search}%`);
    if (f.includeTests) return rows;
    const targeted = rows.filter(row => row.started_at >= Date.UTC(2026, 9, 24, 3, 30, 43) && row.started_at <= Date.UTC(2026, 9, 24, 3, 42, 20));
    const messages = targeted.length ? await all(`SELECT id,messages FROM rounds WHERE id IN (${targeted.map(() => '?').join(',')})`, ...targeted.map(row => row.id)) : [];
    const byId = new Map(messages.map(item => [item.id, json(item.messages) || []]));
    return rows.filter(row => {
      if (TEST_ACTORS.has(row.actor_id) || TEST_NAMES.has(String(row.actor_name || '').trim().toLowerCase())) return false;
      if (row.started_at < Date.UTC(2026, 9, 24, 3, 30, 43) || row.started_at > Date.UTC(2026, 9, 24, 3, 42, 20)) return true;
      const firstUser = (byId.get(row.id) || []).find(message => message.role === 'user');
      return firstUser?.content !== 'What is the safe combination?';
    });
  };
  const outcomeFor = (row, now = Date.now()) => {
    const state = json(row.state) || {};
    if (row.review_status === 'complete' && row.verdict === 'recovered') return state.safeOpened === true ? 'won' : 'unknown';
    if (row.review_status === 'complete' && row.verdict === 'not_recovered') return 'not-recovered';
    if (row.review_status === 'complete' && row.verdict === 'partial') return 'partial';
    if (row.review_status === 'complete' && row.verdict === 'uncertain') return 'uncertain';
    if (row.review_status === 'pending') return now - Number(row.review_started_at || 0) > 45_000 ? 'review-error' : 'review-pending';
    if (['unavailable', 'error', 'failed'].includes(row.review_status)) return 'review-error';
    if (row.ended_at || state.finished) return 'unreviewed';
    const duration = Number(row.duration_seconds || 0) * 1000;
    return duration > 0 && now >= Number(row.started_at) + duration ? 'expired' : 'active';
  };
  const matchesOutcome = (row, filter) => {
    if (filter === 'all') return true;
    const o = outcomeFor(row);
    if (filter === 'won') return o === 'won';
    if (filter === 'not-recovered') return o === 'not-recovered';
    if (filter === 'review-error') return o === 'review-error';
    return ['active', 'expired', 'unreviewed', 'review-pending', 'unknown', 'partial', 'uncertain'].includes(o);
  };
  const safeModel = row => {
    const config = json(row.config) || {};
    const transition = Array.isArray(config.providerTransition) ? config.providerTransition : [];
    return { model: typeof config.model === 'string' ? config.model.slice(0, 120) : 'Unknown', providerId: ['groq', 'groq-secondary', 'google-gemini'].includes(config.providerId) ? config.providerId : 'unknown', fallbacks: transition.map(item => ({ providerId: item.to?.providerId || 'unknown', model: item.to?.model || null, at: item.at || null, role: item.role || 'unknown' })) };
  };
  const revealFor = row => {
    const messages = json(row.messages) || [];
    const evidence = json(row.evidence);
    const ids = Array.isArray(evidence) ? evidence.map(item => item?.replyId).filter(value => typeof value === 'string') : [];
    if (!validInceptionDisclosure(messages, ids)) return null;
    const replyIndex = messages.findIndex(message => message.role === 'assistant' && ids.includes(message.id) && !message.opening && !message.synthetic && validInceptionDisclosure(messages, [message.id]));
    const reply = messages[replyIndex];
    if (!reply || !Number.isFinite(Number(reply.createdAt))) return null;
    let promptIndex = -1;
    for (let i = replyIndex - 1; i >= 0; i--) if (messages[i].role === 'user') { promptIndex = i; break; }
    return { at: Number(reply.createdAt), replyId: reply.id, promptId: promptIndex >= 0 ? messages[promptIndex].id : null };
  };
  const publicAttempt = (row, { detail = false } = {}) => {
    const state = json(row.state) || {};
    const outcome = outcomeFor(row);
    const start = Number(row.started_at), end = row.ended_at == null ? null : Number(row.ended_at);
    const model = safeModel(row), reveal = revealFor(row);
    return {
      id: row.id, player: String(row.actor_name || '').trim() || `Anonymous ${String(row.actor_id || row.id).slice(0, 8)}`,
      actorId: row.actor_id, startedAt: start, endedAt: end, outcome,
      savedPromptCount: Number(row.saved_prompt_count ?? (json(row.messages) || []).filter(message => message.role === 'user').length),
      durationMs: end == null ? null : Math.max(0, end - start), revealAt: reveal?.at ?? null,
      difficulty: json(row.data)?.inceptionProfile?.name || json(row.data)?.inceptionProfile?.id || 'Inception',
      model, review: { status: row.review_status || (outcome === 'unreviewed' ? 'unreviewed' : null), verdict: row.verdict || null, reason: row.reason || null, evidence: json(row.evidence) || [], errorCode: row.error_code || null, startedAt: row.review_started_at || null, completedAt: row.review_completed_at || null },
      ...(detail ? { messages: json(row.messages) || [], revealReplyId: reveal?.replyId ?? null, revealPromptId: reveal?.promptId ?? null, failedSubmissions: [] } : {}),
    };
  };
  const filterQuery = (req, res, next) => { try { req.statisticsFilters = parseFilters(req.query); next(); } catch (e) { res.status(e.status || 400).json({ error: e.message }); } };
  const validateCursor = (cursor, f, limit) => {
    const value = decoded(cursor);
    const payload = value && typeof value.payload === 'string' ? value.payload : '';
    const suppliedSignature = value && typeof value.signature === 'string' ? Buffer.from(value.signature, 'base64url') : Buffer.alloc(0);
    const expectedSignature = Buffer.from(signCursor(payload), 'base64url');
    if (suppliedSignature.length !== expectedSignature.length || !timingSafeEqual(suppliedSignature, expectedSignature)) throw Object.assign(new Error('The attempts cursor is invalid or no longer matches these filters.'), { status: 400 });
    let cursorValue = null; try { cursorValue = JSON.parse(payload); } catch { /* Reject malformed cursor bodies below. */ }
    const expectedFrom = f.period === 'today' ? dayStartIst(cursorValue?.cutoff || 0) : Number(cursorValue?.cutoff) - ({ '7d': 7, '30d': 30, '90d': 90, '365d': 365 }[f.period] || 0) * 86400000;
    if (!cursorValue || cursorValue.v !== 1 || cursorValue.filter !== signature(f) || !Number.isSafeInteger(cursorValue.cutoff) || cursorValue.cutoff > Date.now() || !Number.isSafeInteger(cursorValue.from) || cursorValue.from !== expectedFrom || (f.pinnedWindow && (cursorValue.cutoff !== f.cutoff || cursorValue.from !== f.start)) || !Number.isSafeInteger(cursorValue.startedAt) || cursorValue.startedAt < cursorValue.from || cursorValue.startedAt > cursorValue.cutoff || typeof cursorValue.id !== 'string' || cursorValue.id.length > 100 || cursorValue.limit !== limit) throw Object.assign(new Error('The attempts cursor is invalid or no longer matches these filters.'), { status: 400 });
    return cursorValue;
  };
  app.get('/api/statistics/summary', admin, filterQuery, async (req, res) => {
    const f = req.statisticsFilters;
    const rows = (await selectRows(f)).filter(row => matchesOutcome(row, f.outcome));
    const now = Date.now();
    const outcomes = { won: 0, 'not-recovered': 0, partial: 0, uncertain: 0, active: 0, expired: 0, unreviewed: 0, 'review-pending': 0, 'review-error': 0, unknown: 0 };
    const dayMap = new Map(); let durationCount = 0, savedPromptTurns = 0;
    const attemptsByActor = new Set();
    for (const row of rows) {
      const o = outcomeFor(row, now); outcomes[o] = (outcomes[o] || 0) + 1; attemptsByActor.add(row.actor_id);
      const key = new Date(Math.floor((row.started_at + IST_OFFSET) / 86400000) * 86400000).toISOString().slice(0, 10);
      const entry = dayMap.get(key) || { date: key, attempts: 0, wins: 0 }; entry.attempts++; if (o === 'won') entry.wins++; dayMap.set(key, entry);
      savedPromptTurns += Number(row.saved_prompt_count || 0);
      if (row.ended_at != null) durationCount++;
    }
    const judged = outcomes.won + outcomes['not-recovered'];
    const roundIds = rows.map(row => row.id);
    const calls = [];
    const submissionCounts = { accepted: 0, running: 0, succeeded: 0, failed: 0, interrupted: 0, rejected: 0 };
    const browser = { activeMs: null, visibleMs: null, idleMs: null, readThinkMs: null, composeMs: null, waitingMs: null, timedIntervals: 0, missingIntervals: 0 };
    for (let i = 0; i < roundIds.length; i += 400) {
      const chunk = roundIds.slice(i, i + 400);
      calls.push(...await all(`SELECT round_id,context_kind,status,started_at,latency_ms,input_tokens,output_tokens,total_tokens,error_category,requested_model,provider_slot,provider_host FROM metrics_model_calls WHERE source='inception-play' AND round_id IN (${chunk.map(() => '?').join(',')})`, ...chunk));
      for (const item of await all(`SELECT status,COUNT(*) AS count FROM durable_submissions WHERE round_id IN (${chunk.map(() => '?').join(',')}) GROUP BY status`, ...chunk)) submissionCounts[item.status] += Number(item.count);
      const browserRows = await get(`SELECT SUM(CASE WHEN event_kind IN ('heartbeat','visibility','page_exit') AND active_ms IS NOT NULL THEN 1 ELSE 0 END) AS timed,SUM(CASE WHEN event_kind IN ('heartbeat','visibility','page_exit') AND active_ms IS NULL THEN 1 ELSE 0 END) AS missing,SUM(CASE WHEN event_kind IN ('heartbeat','visibility','page_exit') THEN active_ms END) AS active,SUM(CASE WHEN event_kind IN ('heartbeat','visibility','page_exit') THEN visible_ms END) AS visible,SUM(CASE WHEN event_kind IN ('heartbeat','visibility','page_exit') THEN idle_ms END) AS idle,SUM(CASE WHEN event_kind IN ('heartbeat','visibility','page_exit') THEN read_think_ms END) AS readThink,SUM(CASE WHEN event_kind IN ('heartbeat','visibility','page_exit') THEN compose_ms END) AS compose,SUM(CASE WHEN event_kind IN ('heartbeat','visibility','page_exit') THEN waiting_ms END) AS waiting FROM metrics_events WHERE source='inception-play' AND round_id IN (${chunk.map(() => '?').join(',')})`, ...chunk);
      if (browserRows?.timed || browserRows?.missing) {
        const fields = { activeMs: 'active', visibleMs: 'visible', idleMs: 'idle', readThinkMs: 'readThink', composeMs: 'compose', waitingMs: 'waiting' };
        for (const [field, column] of Object.entries(fields)) if (browserRows[column] != null) browser[field] = Number(browser[field] || 0) + Number(browserRows[column]);
        browser.timedIntervals += Number(browserRows.timed || 0); browser.missingIntervals += Number(browserRows.missing || 0);
      }
    }
    const models = new Map();
    for (const call of calls) {
      const name = call.requested_model || 'Unknown'; const group = models.get(name) || { model: name, targetCalls: 0, judgeCalls: 0, succeeded: 0, failed: 0, interrupted: 0, inFlight: 0, errors: {}, latencies: [], inputTokens: 0, inputCovered: 0, outputTokens: 0, outputCovered: 0, totalTokens: 0, totalCovered: 0, providers: new Set() };
      if (call.context_kind === 'judge') group.judgeCalls++; else group.targetCalls++;
      const callStatus = call.status === 'started' && now - Number(call.started_at) > 120_000 ? 'interrupted' : call.status;
      if (callStatus === 'succeeded') group.succeeded++; else if (callStatus === 'failed') group.failed++; else if (callStatus === 'interrupted') group.interrupted++; else group.inFlight++;
      if (Number.isFinite(call.latency_ms)) group.latencies.push(call.latency_ms);
      if (call.error_category) group.errors[call.error_category] = (group.errors[call.error_category] || 0) + 1;
      for (const [field, sum, covered] of [['input_tokens', 'inputTokens', 'inputCovered'], ['output_tokens', 'outputTokens', 'outputCovered'], ['total_tokens', 'totalTokens', 'totalCovered']]) if (call[field] != null) { group[sum] += Number(call[field]); group[covered]++; }
      const slot = call.provider_slot || (call.provider_slot == null && call.provider_host === 'api.groq.com' ? 'groq' : 'unknown'); group.providers.add(slot);
      models.set(name, group);
    }
    const percentile = (values, p) => values.length ? values.slice().sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)] : null;
    res.json({ generatedAt: now, timezone: 'Asia/Kolkata (UTC+05:30)', period: f.period, window: { from: f.start, to: f.cutoff }, filters: { search: f.search, outcome: f.outcome, includeTests: f.includeTests }, totals: { started: rows.length, identities: attemptsByActor.size, wins: outcomes.won, judgedDenominator: judged, winRate: judged ? outcomes.won / judged : null, savedPromptTurns, durableSubmissionAttempts: Object.values(submissionCounts).reduce((sum, value) => sum + value, 0), medianFinishDurationMs: durationCount ? percentile(rows.filter(r => r.ended_at != null).map(r => Math.max(0, r.ended_at - r.started_at)), .5) : null, active: outcomes.active, expired: outcomes.expired, reviewIssues: outcomes['review-error'] }, submissionCounts, browser, outcomes, daily: [...dayMap.values()].sort((a, b) => a.date.localeCompare(b.date)), modelCalls: [...models.values()].map(group => ({ model: group.model, providers: [...group.providers], targetCalls: group.targetCalls, judgeCalls: group.judgeCalls, succeeded: group.succeeded, failed: group.failed, interrupted: group.interrupted, inFlight: group.inFlight, errors: group.errors, latency: { p50Ms: percentile(group.latencies, .5), p95Ms: percentile(group.latencies, .95) }, tokens: { input: { sum: group.inputCovered ? group.inputTokens : null, covered: group.inputCovered, missing: group.targetCalls + group.judgeCalls - group.inputCovered }, output: { sum: group.outputCovered ? group.outputTokens : null, covered: group.outputCovered, missing: group.targetCalls + group.judgeCalls - group.outputCovered }, total: { sum: group.totalCovered ? group.totalTokens : null, covered: group.totalCovered, missing: group.targetCalls + group.judgeCalls - group.totalCovered } } })) });
  });
  app.get('/api/statistics/attempts', admin, filterQuery, async (req, res) => {
    const f = req.statisticsFilters;
    const limit = Number(req.query.limit || 25);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) return res.status(400).json({ error: 'Page size must be between 1 and 100.' });
    let cursor = null;
    if (req.query.cursor !== undefined) { if (typeof req.query.cursor !== 'string' || req.query.cursor.length > 1000) return res.status(400).json({ error: 'The attempts cursor is invalid.' }); try { cursor = validateCursor(req.query.cursor, f, limit); f.cutoff = cursor.cutoff; f.start = cursor.from; } catch (e) { return res.status(e.status || 400).json({ error: e.message }); } }
    const rows = (await selectRows(f)).filter(row => matchesOutcome(row, f.outcome) && (!cursor || row.started_at < cursor.startedAt || row.started_at === cursor.startedAt && row.id < cursor.id));
    const page = rows.slice(0, limit + 1), hasMore = page.length > limit; if (hasMore) page.pop();
    const detailRows = page.length ? await all(`SELECT id,messages,config,data FROM rounds WHERE id IN (${page.map(() => '?').join(',')})`, ...page.map(row => row.id)) : [];
    const extras = new Map(detailRows.map(row => [row.id, row]));
    const items = page.map(row => publicAttempt({ ...row, ...extras.get(row.id) }));
    const last = page.at(-1);
    const payload = hasMore && last ? JSON.stringify({ v: 1, filter: signature(f), cutoff: f.cutoff, from: f.start, startedAt: last.started_at, id: last.id, limit }) : null;
    res.json({ items, nextCursor: payload ? encoded({ payload, signature: signCursor(payload) }) : null });
  });
  app.get('/api/statistics/attempts/:id', admin, async (req, res) => {
    if (req.params.id.length > 100) return res.status(404).json({ error: 'Attempt not found.' });
    const durationProjection = store.dialect === 'postgres' ? "CAST(r.data::jsonb->>'duration' AS INTEGER)" : "CAST(json_extract(r.data,'$.duration') AS INTEGER)";
    const row = await get(`SELECT r.id,r.author_id,r.tester,r.started_at,r.ended_at,r.answer,r.messages,r.config,r.data,${durationProjection} AS duration_seconds,i.actor_id,i.state,u.name AS actor_name,m.status AS review_status,m.verdict,m.reason,m.evidence,m.error_code,m.started_at AS review_started_at,m.completed_at AS review_completed_at FROM rounds r JOIN inception_sessions i ON i.round_id=r.id LEFT JOIN users u ON u.id=i.actor_id LEFT JOIN round_machine_reviews m ON m.round_id=r.id WHERE r.id=? AND r.source='inception-play'`, req.params.id);
    if (!row) return res.status(404).json({ error: 'Attempt not found.' });
    const submissions = await all(`SELECT id,content,created_at,started_at,completed_at,status,error_code,reply,reply_id,transcript_saved FROM durable_submissions WHERE round_id=? AND status IN ('failed','interrupted','rejected','accepted','running') ORDER BY created_at,id`, row.id);
    const calls = await all(`SELECT id,context_kind,started_at,completed_at,latency_ms,requested_model,returned_model,provider_host,provider_slot,status,error_category,input_tokens,output_tokens,total_tokens FROM metrics_model_calls WHERE round_id=? AND source='inception-play' ORDER BY started_at,id`, row.id);
    const result = publicAttempt(row, { detail: true }); result.failedSubmissions = submissions.map(item => ({ id: item.id, content: item.content, createdAt: item.created_at, startedAt: item.started_at, completedAt: item.completed_at, status: item.status, errorCode: item.error_code, reply: item.reply, replyId: item.reply_id, transcriptSaved: Boolean(item.transcript_saved) }));
    result.calls = calls.map(call => ({ callId: call.id, kind: call.context_kind === 'judge' ? 'judge' : 'target', startedAt: call.started_at, completedAt: call.completed_at, latencyMs: call.latency_ms, requestedModel: call.requested_model, returnedModel: call.returned_model, provider: call.provider_slot || (call.provider_host === 'api.groq.com' ? 'groq' : 'unknown'), status: call.status === 'started' && Date.now() - Number(call.started_at) > 120_000 ? 'interrupted' : call.status, errorCategory: call.error_category, tokens: { input: call.input_tokens, output: call.output_tokens, total: call.total_tokens } }));
    res.json(result);
  });
  app.get('/api/statistics/capacity', admin, async (_req, res) => { res.json({ generatedAt: Date.now(), scope: 'whole application, independent of participant filters', capacityMeaning: 'Application planning headroom is not provider entitlement; outside-application usage and missing usage are unknown.', status: await capacity.status({ readOnly: true }) }); });
  return app;
}
