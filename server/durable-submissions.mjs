import { randomUUID } from 'node:crypto';

export const RECORDING_NOTICE_VERSION = 'recording-notice-v1';

const safeError = error => ({
  rate_limited: 'rate_limited', timeout: 'timeout', provider_unavailable: 'unavailable',
  provider_auth: 'provider_error', provider_rejected: 'provider_error', empty_response: 'empty_response',
})[error?.providerCode || error?.code] || (error?.status === 429 ? 'rate_limited' : error?.status === 504 ? 'timeout' : 'request_failed');

export function createSubmissionJournal(store) {
  const { get, all, run } = store;
  const matches = (row, input) => row.content === input.content && row.actor_id === (input.actorId || null) && row.lane === (input.lane || null)
    && ['source','versionId','collectionId','profileId','scenarioId'].every(key => input[key] === undefined || row[{ source:'source', versionId:'version_id', collectionId:'collection_id', profileId:'profile_id', scenarioId:'scenario_id' }[key]] === (input[key] || null));
  const begin = async input => {
    const requestId = input.clientRequestId || randomUUID();
    const scopeKey = input.roundId ? `round:${input.roundId}` : `run:${input.orchestrationRunId}`;
    const existing = await get('SELECT * FROM durable_submissions WHERE scope_key = ? AND client_request_id = ?', scopeKey, requestId);
    if (existing) {
      const same = matches(existing, input);
      if (!same) throw Object.assign(new Error('This request ID was already used for different submitted content.'), { status: 409 });
      return { entry: existing, shouldInvoke: false };
    }
    const id = randomUUID(), createdAt = Date.now();
    try {
      await run(`INSERT INTO durable_submissions
        (id, client_request_id, scope_key, round_id, orchestration_run_id, lane, actor_id, source, version_id, collection_id, profile_id, scenario_id, content, desk_context, presented, created_at, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'accepted')`,
        id, requestId, scopeKey, input.roundId || null, input.orchestrationRunId || null, input.lane || null,
        input.actorId || null, input.source || null, input.versionId || null, input.collectionId || null,
        input.profileId || null, input.scenarioId || null, input.content, input.deskContext || null,
        input.presented ? JSON.stringify(input.presented) : null, createdAt);
    } catch (error) {
      if (!String(error?.message).toLowerCase().includes('unique')) throw error;
      const raced = await get('SELECT * FROM durable_submissions WHERE scope_key = ? AND client_request_id = ?', scopeKey, requestId);
      if (!raced) throw error;
      if (!matches(raced, input))
        throw Object.assign(new Error('This request ID was already used for different submitted content.'), { status: 409 });
      return { entry: raced, shouldInvoke: false };
    }
    const entry = await get('SELECT * FROM durable_submissions WHERE id = ?', id);
    return { entry, shouldInvoke: true };
  };
  const find = async (scope, clientRequestId) => { await reconcile(); return get('SELECT * FROM durable_submissions WHERE scope_key = ? AND client_request_id = ?', scope, clientRequestId); };
  const claim = async id => ({ changes: (await run("UPDATE durable_submissions SET status = 'running', started_at = ? WHERE id = ? AND status = 'accepted'", Date.now(), id)).changes });
  const updateContext = async (id, deskContext, presented) => run('UPDATE durable_submissions SET desk_context = ?, presented = ? WHERE id = ? AND status IN (\'accepted\',\'running\')', deskContext || null, presented ? JSON.stringify(presented) : null, id);
  const update = async (id, sql, ...args) => run(sql, ...args, id);
  const succeed = async (id, { reply, replyId }) => update(id, "UPDATE durable_submissions SET status='succeeded', reply=?, reply_id=?, completed_at=? WHERE id=?", reply, replyId || null, Date.now());
  const markTranscriptSaved = async id => run('UPDATE durable_submissions SET transcript_saved=1 WHERE id=? AND status=\'succeeded\'', id);
  const failSubmission = async (id, error) => update(id, "UPDATE durable_submissions SET status='failed', error_code=?, completed_at=? WHERE id=? AND status IN ('accepted','running')", safeError(error), Date.now());
  const reject = async (id, errorCode = 'lease_contended') => update(id, "UPDATE durable_submissions SET status='rejected', error_code=?, completed_at=? WHERE id=? AND status='accepted'", errorCode, Date.now());
  const reconcile = async () => {
    const now = Date.now();
    return run("UPDATE durable_submissions SET status='interrupted', error_code='interrupted', completed_at=? WHERE status IN ('accepted','running') AND created_at < ? AND ((round_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM round_locks WHERE round_locks.round_id=durable_submissions.round_id AND round_locks.expires>?)) OR (orchestration_run_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM orchestration_locks WHERE orchestration_locks.run_id=durable_submissions.orchestration_run_id AND orchestration_locks.expires>?)))", now, now - 120000, now, now);
  };
  const serialize = row => ({ id: row.id, requestId: row.client_request_id, roundId: row.round_id, runId: row.orchestration_run_id, lane: row.lane, actorId: row.actor_id, source: row.source, ...(row.scenario_id ? { scenarioId: row.scenario_id } : {}), ...(row.collection_id ? { collectionId: row.collection_id } : {}), ...(row.profile_id ? { profileId: row.profile_id } : {}), content: row.content, createdAt: row.created_at, startedAt: row.started_at, completedAt: row.completed_at, status: row.status, errorCode: row.error_code, ...(row.reply != null ? { reply: row.reply } : {}), ...(row.reply_id ? { replyId: row.reply_id } : {}), ...(row.desk_context ? { deskContext: row.desk_context } : {}), ...(row.presented ? { presented: JSON.parse(row.presented) } : {}), transcriptSaved: Boolean(row.transcript_saved) });
  const page = async ({ limit = 100, cursor = null }) => {
    await reconcile();
    const boundary = cursor
      ? { created_at: cursor.cutoff, id: cursor.cutoffId }
      : await get('SELECT created_at, id FROM durable_submissions ORDER BY created_at DESC, id DESC LIMIT 1');
    if (!boundary) return { items: [], nextCursor: null };
    const rows = await all(`SELECT * FROM durable_submissions
      WHERE (created_at < ? OR (created_at = ? AND id <= ?))
      ${cursor ? 'AND (created_at, id) < (?, ?)' : ''}
      ORDER BY created_at DESC, id DESC LIMIT ?`,
      ...(cursor
        ? [boundary.created_at, boundary.created_at, boundary.id, Number(cursor.createdAt), cursor.id, limit + 1]
        : [boundary.created_at, boundary.created_at, boundary.id, limit + 1]));
    const more = rows.length > limit, items = rows.slice(0, limit).map(serialize);
    const last = items.at(-1);
    return { items, nextCursor: more && last ? { cutoff: boundary.created_at, cutoffId: boundary.id, createdAt: last.createdAt, id: last.id } : null };
  };
  return { begin, find, claim, updateContext, succeed, markTranscriptSaved, fail: failSubmission, reject, reconcile, page };
}
