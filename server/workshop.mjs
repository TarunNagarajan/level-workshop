import express from 'express';
import cookieParser from 'cookie-parser';
import { randomBytes, randomUUID, createHash, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { z } from 'zod';
import { buildCompletionBody, complete, modelConfig } from './model.mjs';
import { emptyLevel, levelSchema, seedLevels, compilePrompt, playerLevel, validatePlayable } from './levels.mjs';
import { addPassportRoutes, passportContext, passportScenarioForVersion, publicPassportState } from './passport-reference.mjs';
import { addOrchestrationRoutes } from './orchestration.mjs';
import { addCollectionRoutes, createCollectionModelServices } from './collections.mjs';
import { addMetricsRoutes, createMetricsService } from './metrics.mjs';
import { createSubmissionJournal, RECORDING_NOTICE_VERSION } from './durable-submissions.mjs';
import { MACHINE_REVIEW_SYSTEM, MACHINE_REVIEW_PROTOCOL_VERSION, makeReviewPrompt, publicMachineReview, validateMachineReview } from './machine-review.mjs';
import { RIDDLE_DIARY_LEVEL_ID, RIDDLE_DIARY_SCENARIO_ID, addRiddleDiaryRoutes, diaryPromptContext, isRiddleDiaryData, publicDiaryProfile } from './riddle-diary.mjs';
import { addMissionArchiveRoutes, isMissionRound } from './mission-archive.mjs';
import { INCEPTION_ORGANIZER_RECORDING_POLICY, INCEPTION_SCENARIO_ID, addInceptionRoutes, inceptionPromptContext, isInceptionData, publicInceptionProfile } from './inception.mjs';
import { inceptionProviderCapacity } from './inception-capacity.mjs';
const scrypt = promisify(scryptCallback);
const id = () => randomUUID();
const token = () => randomBytes(32).toString('base64url');
const hash = value => createHash('sha256').update(value).digest('hex');
const isPassportVersion = versionId => versionId === 'reference-passport-desk-v1' || versionId.startsWith('reference-passport-study-v1-') || versionId.startsWith('reference-passport-case-');
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const publicFailureCodes = new Set(['rate_limited', 'provider_auth', 'provider_unavailable', 'timeout', 'empty_response', 'provider_rejected']);
const publicRateLimitScopes = new Set(['tokens_daily', 'tokens_minute', 'requests_daily', 'requests_minute', 'unknown']);
const publicRetryAfter = value => Number.isInteger(value) && value > 0 ? Math.min(value, 86400) : undefined;
const accountSchema = z.object({ name: z.string().trim().min(1).max(70), email: z.email().transform(v => v.toLowerCase()), password: z.string().min(10).max(200) });
const publicUser = user => user ? { id: user.id, name: user.name, email: user.email, role: user.role } : null;
async function passwordHash(password) {
    const salt = randomBytes(16).toString('hex');
    return `${salt}:${Buffer.from(await scrypt(password, salt, 64)).toString('hex')}`;
}
async function verifyPassword(password, stored) {
    const [salt, expected] = stored.split(':');
    const actual = Buffer.from(await scrypt(password, salt, 64));
    return timingSafeEqual(actual, Buffer.from(expected, 'hex'));
}
export function createWorkshop({ store, provider = modelConfig(), completion = complete, ownerKey = '', sharingKey = '', rootEntry = false, secureCookies = false, publicOrigin = '', researchWorlds = false, researchWorldId = '', metricsEnabled = false, metricsSessionCreationLimit = 120, passportReviewEnabled = false, passportScenarioRotation = true, recordingNoticeRequired = false, env = process.env } = {}) {
    if (!store)
        throw new Error('A persistent store is required.');
    const cookieOptions = { httpOnly: true, sameSite: 'strict', path: '/', secure: secureCookies, maxAge: 30 * 86400000 };
    const inceptionCookieOptions = { ...cookieOptions };
    const { get, all, run, batch } = store;
    const app = express();
    const authLimits = new Map();
    app.disable('x-powered-by');
    app.use(express.json({ limit: '128kb' }));
    app.use(cookieParser());
    app.use('/api', async (req, res, next) => {
        res.set('Cache-Control', 'no-store');
        res.set('X-Content-Type-Options', 'nosniff');
        if (!['GET', 'HEAD'].includes(req.method) && req.headers.origin) {
            const allowed = publicOrigin || `${req.protocol}://${req.get('host')}`;
            if (req.headers.origin !== allowed)
                return res.status(403).json({ error: 'This request came from another origin.' });
        }
        const auth = req.cookies.workshop ? await get('SELECT users.* FROM auth JOIN users ON users.id = auth.user_id LEFT JOIN link_sessions ON link_sessions.auth_token = auth.token LEFT JOIN workshop_links ON workshop_links.id = link_sessions.link_id WHERE auth.token = ? AND auth.expires > ? AND (link_sessions.link_id IS NULL OR (workshop_links.revoked = 0 AND workshop_links.expires > ?))', hash(req.cookies.workshop), Date.now(), Date.now()) : null;
        req.user = auth || null;
        req.inceptionEntry = null;
        if (rootEntry && req.cookies.inception_entry) {
          const entry = await get(`SELECT users.id,users.name,users.role FROM auth
            JOIN users ON users.id=auth.user_id
            JOIN link_sessions ON link_sessions.auth_token=auth.token
            JOIN workshop_links ON workshop_links.id=link_sessions.link_id
            WHERE auth.token=? AND auth.expires>? AND workshop_links.id=? AND workshop_links.revoked=0 AND workshop_links.expires>?`,
            hash(`inception-entry:${req.cookies.inception_entry}`), Date.now(), 'root-workshop-entry', Date.now());
          if (entry && (entry.role === 'inception_participant' ? !req.user : req.user?.id === entry.id)) {
            req.inceptionEntry = { actor: { id: entry.id, name: entry.name, role: entry.role }, policyId: INCEPTION_ORGANIZER_RECORDING_POLICY };
          }
        }
        next();
    });
    const member = (req, res, next) => req.user ? next() : res.status(401).json({ error: 'Sign in to use the workshop.' });
    const inceptionMember = (req, res, next) => {
      const actor = req.inceptionEntry?.actor || req.user;
      if (!actor) return res.status(401).json({ error: 'Open the Inception entry link to continue.' });
      req.inceptionActor = actor;
      next();
    };
    const admin = (req, res, next) => req.user?.role === 'admin' ? next() : res.status(403).json({ error: 'Only the workspace owner can do this.' });
    const metrics = createMetricsService({ store, enabled: metricsEnabled });
    const inceptionCapacity = inceptionProviderCapacity({ store, primary: provider, env });
    const journal = createSubmissionJournal(store);
    const recordingAccepted = async userId => Boolean(userId && await get('SELECT user_id FROM user_recording_acknowledgements WHERE user_id = ? AND version = ?', userId, RECORDING_NOTICE_VERSION));
    const requireRecording = async (req, round = null, organizerStart = false) => {
      if (!recordingNoticeRequired) return;
      const scopedActorId = req.inceptionEntry?.actor?.id;
      if (scopedActorId && organizerStart && !round && req.inceptionActor?.id === scopedActorId) return;
      if (scopedActorId && round && isInceptionData(JSON.parse(round.data)) && round.recording_notice_version === INCEPTION_ORGANIZER_RECORDING_POLICY && round.author_id === scopedActorId) return;
      const roundAccepted = round && ((round.recording_accepted_at && round.recording_notice_version === RECORDING_NOTICE_VERSION) || await get('SELECT round_id FROM difficulty_collection_assignments WHERE round_id = ? AND consent_at IS NOT NULL AND consent_version IS NOT NULL', round.id));
      if (roundAccepted) return;
      if (req.user && await recordingAccepted(req.user.id)) return;
      fail(428, round ? 'Accept the recording notice for this test before submitting a question.' : 'Acknowledge the recording notice before submitting model questions.');
    };
    const instrumentedCompletion = input => metrics.recordCompletion(completion, input);
    const inceptionCompletion = async input => {
      const inceptionCall = input.metricsContext?.source === 'inception-play';
      if (!inceptionCall) return instrumentedCompletion(input);
      const { roundLockToken: lease, ...completionInput } = input;
      let selected = completionInput.config;
      const roundId = completionInput.metricsContext?.roundId;
      const switchProvider = async reason => {
        if (!inceptionCapacity.enabled || !roundId || !lease) return null;
        const fallback = await inceptionCapacity.fallbackForOngoing();
        if (!fallback) return null;
        const saved = await get('SELECT config FROM rounds WHERE id=?', roundId);
        if (!saved) return null;
        let frozen;
        try { frozen = JSON.parse(saved.config); } catch { return null; }
        try { inceptionCapacity.credentialsForFrozen(frozen); } catch { return null; }
        if (frozen.providerId !== 'groq' && !( !frozen.providerId && frozen.baseUrl === provider.baseUrl && frozen.model === provider.model)) return null;
        const next = { providerId: fallback.providerId, model: fallback.model, baseUrl: fallback.baseUrl,
          ...(frozen.reasoningEffort ? { reasoningEffort: frozen.reasoningEffort } : {}),
          ...(frozen.selectionReason ? { selectionReason: frozen.selectionReason } : {}),
          ...(Number.isFinite(frozen.selectionCheckedAt) ? { selectionCheckedAt: frozen.selectionCheckedAt } : {}),
          ...(typeof frozen.capacityReservationId === 'string' ? { capacityReservationId: frozen.capacityReservationId } : {}),
          providerTransition: [{ from: { providerId: frozen.providerId || 'groq', model: frozen.model }, to: { providerId: fallback.providerId, model: fallback.model }, at: Date.now(), reason, role: completionInput.metricsContext?.kind === 'judge' ? 'judge' : 'target' }] };
        const changed = await run('UPDATE rounds SET config=? WHERE id=? AND config=? AND EXISTS (SELECT 1 FROM round_locks WHERE round_id=? AND token=? AND expires>?)', JSON.stringify(next), roundId, saved.config, roundId, lease, Date.now());
        if (changed.changes !== 1) return null;
        try { await inceptionCapacity.releaseRoundReservation(roundId); } catch { /* A later Gemma request or review retries idempotent reservation cleanup. */ }
        return { ...fallback };
      };
      if (inceptionCapacity.enabled && (selected?.providerId === 'groq' || (!selected?.providerId && selected?.baseUrl === provider.baseUrl))) {
        if (await inceptionCapacity.activeCooldown('groq')) {
          const next = await switchProvider('primary_cooldown');
          if (next) selected = next;
          else throw Object.assign(new Error('The model service is temporarily rate limited. Your prompt is saved; wait before trying again.'), { status: 429, providerCode: 'rate_limited', rateLimitScope: 'unknown', retryAfterSeconds: await inceptionCapacity.cooldownRemaining('groq') || undefined });
        }
      }
      const providerId = selected?.providerId || 'groq';
      if (providerId === 'google-gemini') try { await inceptionCapacity.releaseRoundReservation(roundId); } catch { /* Retry on the next request. */ }
      try {
        const result = await instrumentedCompletion({ ...completionInput, config: selected, timeoutMs: selected.providerId === 'google-gemini' ? 30000 : inceptionCapacity.enabled ? 15000 : completionInput.timeoutMs });
        try { await inceptionCapacity.observe(providerId, { usage: result.usageDetails || { total: result.usage } }); } catch { /* Provider completion remains usable if telemetry storage is temporarily unavailable. */ }
        return result;
      } catch (error) {
        try { await inceptionCapacity.observe(providerId, { error }); } catch { /* Capacity telemetry must not replace the provider failure. */ }
        if (providerId === 'groq' && inceptionCapacity.enabled && ['rate_limited', 'timeout', 'provider_unavailable', 'provider_auth', 'empty_response'].includes(error.providerCode)) {
          const next = await switchProvider(error.providerCode);
          if (next) {
            try {
              const result = await instrumentedCompletion({ ...completionInput, config: next, timeoutMs: 15000 });
              try { await inceptionCapacity.observe(next.providerId, { usage: result.usageDetails || { total: result.usage } }); } catch { /* Capacity telemetry must not replace a successful reply. */ }
              return result;
            } catch (fallbackError) {
              try { await inceptionCapacity.observe(next.providerId, { error: fallbackError }); } catch { /* Capacity telemetry must not replace the provider failure. */ }
              throw fallbackError;
            }
          }
        }
        throw error;
      }
    };
    const owner = async (req, levelId) => {
        const row = await get('SELECT * FROM levels WHERE id = ?', levelId);
        if (!row)
            fail(404, 'This level does not exist.');
        if (row.owner_id !== req.user.id && req.user.role !== 'admin')
            fail(403, 'Only the level author or workspace owner can edit this draft. Duplicate it to make your own version.');
        if (levelId === 'reference-passport-desk') fail(409, 'This finished reference is fixed. Create your editable copy from its build guide.');
        if (levelId === RIDDLE_DIARY_LEVEL_ID) fail(409, 'This interactive diary is fixed. Use its dedicated play route.');
        if (levelId === 'reference-inception-strongroom') fail(409, 'This interactive strongroom is fixed. Use its dedicated play route.');
        return row;
    };
    const levelRow = async (levelId) => { const row = await get('SELECT * FROM levels WHERE id = ?', levelId); if (!row || row.id === RIDDLE_DIARY_LEVEL_ID || row.id === 'reference-inception-strongroom')
        fail(404, 'Level not found.'); return row; };
    const versionRow = async (versionId) => { const row = await get('SELECT * FROM versions WHERE id = ?', versionId); if (!row)
        fail(404, 'Version not found.'); return row; };
    const safeConfig = () => ({ model: provider.model, baseUrl: provider.baseUrl, reasoningEffort: provider.reasoningEffort || 'low' });
    const enter = async (res, user, accessId = null) => {
        const raw = token();
        await batch([
          ['INSERT INTO auth (token, user_id, expires) VALUES (?, ?, ?)', hash(raw), user.id, Date.now() + cookieOptions.maxAge],
          ...(accessId ? [['INSERT INTO link_sessions VALUES (?, ?)', hash(raw), accessId]] : []),
        ]);
        res.cookie('workshop', raw, cookieOptions).json({ user: publicUser(user) });
    };
    const authThrottle = (req, res, next) => {
        const key = req.ip;
        const now = Date.now();
        const previous = authLimits.get(key);
        const bucket = previous && previous.until > now ? previous : { failures: 0, pending: 0, until: now + 60000 };
        authLimits.set(key, bucket);
        if (authLimits.size > 1000)
            for (const [k, v] of authLimits)
                if (v.until < now)
                    authLimits.delete(k);
        if (bucket.failures + bucket.pending >= 12)
            return res.status(429).json({ error: 'Too many sign-in attempts. Try again in a minute.' });
        bucket.pending++;
        res.once('finish', () => {
            bucket.pending--;
            if (res.statusCode >= 400) bucket.failures++;
        });
        next();
    };
    const addDraft = async (draft, userId) => {
        const levelId = id();
        const now = Date.now();
        await run('INSERT INTO levels (id, owner_id, draft, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', levelId, userId, JSON.stringify(draft), now, now);
        return levelId;
    };
    const saveVersion = async (row, userId, note) => {
        const versionId = id();
        await run('INSERT INTO versions SELECT ?, ?, COALESCE(MAX(number), 0) + 1, ?, ?, ?, ? FROM versions WHERE level_id = ?', versionId, row.id, row.draft, note, userId, Date.now(), row.id);
        return versionId;
    };
    const serializeLevel = async (row) => ({ id: row.id, draft: JSON.parse(row.draft), revision: row.revision, status: row.status, ownerId: row.owner_id, owner: (await get('SELECT name FROM users WHERE id = ?', row.owner_id))?.name, updatedAt: row.updated_at });
    const versions = async (levelId) => (await all('SELECT versions.*, users.name AS author FROM versions JOIN users ON users.id = versions.author_id WHERE level_id = ? ORDER BY number DESC', levelId)).map(v => ({ id: v.id, number: v.number, data: JSON.parse(v.data), note: v.note, author: v.author, createdAt: v.created_at }));
    const publicRound = row => ({ id: row.id, ...(row.source === 'collection-participant' ? {} : { versionId: row.version_id.startsWith('reference-passport-case-') ? 'reference-passport-case' : row.source === 'reference-research-preview' ? 'reference-passport-study' : row.version_id, ...(row.version_id.startsWith('reference-passport-case-') ? { inspectionMode: 'documents' } : {}), model: JSON.parse(row.config).model, source: row.source }), level: playerLevel(JSON.parse(row.data)), tester: row.tester, messages: row.source === 'collection-participant' ? JSON.parse(row.messages).map(({ id: messageId, role, content, createdAt, opening, latencyMs }) => ({ id: messageId, role, content, createdAt, ...(opening ? { opening: true } : {}), ...(Number.isFinite(latencyMs) ? { latencyMs } : {}) })) : JSON.parse(row.messages), startedAt: row.started_at, endedAt: row.ended_at, deadline: row.started_at + JSON.parse(row.data).duration * 1000, answer: row.answer, hintsUsed: row.hints_used, reviewEnabled: Boolean(passportReviewEnabled), ...(isRiddleDiaryData(JSON.parse(row.data)) ? { diary: publicDiaryProfile(JSON.parse(row.data)) } : {}), ...(isInceptionData(JSON.parse(row.data)) ? { inception: publicInceptionProfile(JSON.parse(row.data)) } : {}) });
    const accessRound = async (req, roundId = req.params.id) => {
        const row = await get('SELECT * FROM rounds WHERE id = ?', roundId);
        if (!row)
            fail(404, 'Test session not found.');
        if (isMissionRound(row)) fail(404, 'Continue this session in the interactive archive.');
        const supplied = req.get('x-round-token');
        const inceptionOwner = req.inceptionEntry?.actor?.id === row.author_id && isInceptionData(JSON.parse(row.data))
          ? await get('SELECT round_id FROM inception_sessions WHERE round_id=? AND actor_id=?', row.id, req.inceptionEntry.actor.id)
          : null;
        const inceptionRound = isInceptionData(JSON.parse(row.data));
        const memberOwnsRound = req.user && (row.author_id === req.user.id || req.user.role === 'admin');
        const validRoundToken = Boolean(supplied && hash(supplied) === row.token);
        const organizerPolicyRound = inceptionRound && row.source === 'inception-play' && row.recording_notice_version === INCEPTION_ORGANIZER_RECORDING_POLICY;
        const allowed = inceptionRound ? Boolean(memberOwnsRound || inceptionOwner || (validRoundToken && !organizerPolicyRound))
          : Boolean(memberOwnsRound || validRoundToken);
        if (!allowed)
            fail(403, 'This test session is private.');
        return row;
    };
    const createRound = async ({ version, userId = null, tester, source, messages, parentId = null, deskState, roundId: requestedRoundId, rawToken: requestedToken, collectionAssignment, frozenConfig, allocationLeaseToken, consentAt = null, recordingAckUserId = null, recordingPolicy = null, diaryState = null, inceptionState = null }) => {
        consentAt ||= collectionAssignment?.consentAt || null;
        if (isPassportVersion(version.id) && !deskState) fail(409, 'Start this reference from the interactive passport desk.');
        if (userId && recordingNoticeRequired && !await recordingAccepted(userId) && !consentAt && !recordingPolicy) fail(428, 'Acknowledge the recording notice before starting a test.');
        if (recordingNoticeRequired && !userId && ['blind', 'reference-blind', 'reference-research-preview'].includes(source) && !consentAt) fail(428, 'Accept the recording notice before starting this test.');
        const raw = requestedToken || token();
        const roundId = requestedRoundId || id();
        const data = JSON.parse(version.data);
        if (isRiddleDiaryData(data) !== Boolean(diaryState)) fail(409, 'Continue this diary in its interactive scene.');
        if (isInceptionData(data) !== Boolean(inceptionState)) fail(409, 'Start this strongroom through its interactive scene.');
        validatePlayable(data);
        const initial = messages || [{ id: id(), role: 'assistant', content: data.opening, createdAt: Date.now(), opening: true }];
        const config = frozenConfig || safeConfig();
        const roundStartedAt = Date.now();
        if (recordingPolicy && (!inceptionState || recordingPolicy !== INCEPTION_ORGANIZER_RECORDING_POLICY || source !== 'inception-play')) fail(403, 'The recording policy is not valid for this session.');
        const roundValues = [roundId, hash(raw), version.level_id, version.id, userId, source, version.data, JSON.stringify(config), tester, JSON.stringify(initial), roundStartedAt, parentId, consentAt, recordingPolicy || (consentAt ? RECORDING_NOTICE_VERSION : null)];
        const allocationGuard = allocationLeaseToken && collectionAssignment?.source === 'participant';
        const roundInsert = allocationGuard
          ? ['INSERT INTO rounds (id, token, level_id, version_id, author_id, source, data, config, tester, messages, started_at, parent_id, recording_accepted_at, recording_notice_version) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM difficulty_collection_leases l JOIN difficulty_collections c ON c.id = l.collection_id JOIN difficulty_collection_links k ON k.id = ? AND k.collection_id = c.id WHERE l.collection_id = ? AND l.token = ? AND l.expires > ? AND c.status = ? AND k.revoked = 0 AND k.expires > ?)', ...roundValues, collectionAssignment.linkId, collectionAssignment.collectionId, allocationLeaseToken, Date.now(), 'active', Date.now()]
          : inceptionState
            ? ['INSERT INTO rounds (id, token, level_id, version_id, author_id, source, data, config, tester, messages, started_at, parent_id, recording_accepted_at, recording_notice_version) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM rounds active JOIN inception_sessions scene ON scene.round_id=active.id WHERE scene.actor_id=? AND active.ended_at IS NULL AND active.started_at + ? > ?)', ...roundValues, inceptionState.actorId, data.duration * 1000, roundStartedAt]
          : ['INSERT INTO rounds (id, token, level_id, version_id, author_id, source, data, config, tester, messages, started_at, parent_id, recording_accepted_at, recording_notice_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', ...roundValues];
        const statements = inceptionState ? [['INSERT INTO inception_start_locks (actor_id,serial) VALUES (?,0) ON CONFLICT(actor_id) DO UPDATE SET serial=inception_start_locks.serial+1', inceptionState.actorId], roundInsert] : [roundInsert];
        const roundInsertIndex = inceptionState ? 1 : 0;
        if (recordingAckUserId && consentAt) statements.push(['INSERT INTO user_recording_acknowledgements (user_id, version, accepted_at) VALUES (?, ?, ?) ON CONFLICT(user_id, version) DO NOTHING', recordingAckUserId, RECORDING_NOTICE_VERSION, consentAt]);
        if (diaryState) statements.push(['INSERT INTO diary_sessions (round_id,state) VALUES (?,?)', roundId, JSON.stringify(diaryState)]);
        if (inceptionState) statements.push(['INSERT INTO inception_sessions (round_id,state,start_key_hash,actor_key_hash,actor_id,created_at) SELECT ?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM rounds WHERE id=?)', roundId, inceptionState.state, inceptionState.startKeyHash, inceptionState.actorKeyHash, inceptionState.actorId, inceptionState.createdAt, roundId]);
        if (deskState) statements.push(allocationGuard
          ? ['INSERT INTO passport_sessions (round_id, state) SELECT ?, ? WHERE EXISTS (SELECT 1 FROM rounds WHERE id = ?)', roundId, JSON.stringify(deskState), roundId]
          : ['INSERT INTO passport_sessions VALUES (?, ?)', roundId, JSON.stringify(deskState)]);
        if (collectionAssignment) statements.push(allocationGuard
          ? ['INSERT INTO difficulty_collection_assignments (id, collection_id, round_id, profile_id, profile_snapshot, source, parent_id, link_id, start_key_hash, consent_at, consent_version, assigned_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM rounds WHERE id = ?)', collectionAssignment.id, collectionAssignment.collectionId, roundId, collectionAssignment.profileId, JSON.stringify(collectionAssignment.profileSnapshot), collectionAssignment.source, collectionAssignment.parentId ?? parentId, collectionAssignment.linkId, collectionAssignment.startKeyHash, collectionAssignment.consentAt, collectionAssignment.consentVersion, collectionAssignment.assignedAt, roundId]
          : ['INSERT INTO difficulty_collection_assignments (id, collection_id, round_id, profile_id, profile_snapshot, source, parent_id, link_id, start_key_hash, consent_at, consent_version, assigned_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', collectionAssignment.id, collectionAssignment.collectionId, roundId, collectionAssignment.profileId, JSON.stringify(collectionAssignment.profileSnapshot), collectionAssignment.source, collectionAssignment.parentId ?? parentId, collectionAssignment.linkId, collectionAssignment.startKeyHash, collectionAssignment.consentAt, collectionAssignment.consentVersion, collectionAssignment.assignedAt]);
        const results = await batch(statements);
        if (!results[roundInsertIndex].changes && inceptionState) fail(409, 'Finish or let the current strongroom attempt expire before starting a replay.');
        if (!results[roundInsertIndex].changes) fail(409, 'This collection is no longer accepting attempts. Retry with the same start key if the attempt was already accepted.');
        return { ...publicRound(await get('SELECT * FROM rounds WHERE id = ?', roundId)), accessToken: raw };
    };
    addRiddleDiaryRoutes(app, { store, member, provider, createRound, accessRound, withRoundLock: async (req, action) => { const initial = await accessRound(req); const lease = token(), now = Date.now(); const claim = await run('INSERT INTO round_locks VALUES (?,?,?) ON CONFLICT(round_id) DO UPDATE SET token=excluded.token, expires=excluded.expires WHERE round_locks.expires<=?', initial.id, lease, now + 45000, now); if (!claim.changes) fail(409, 'Wait for the current reply before changing this diary.'); try { return await action(await accessRound(req), lease); } finally { await run('DELETE FROM round_locks WHERE round_id=? AND token=?', initial.id, lease); } }, publicRound, requireRecording, recordingNoticeRequired, reviewEnabled: Boolean(passportReviewEnabled), hashToken: hash, createToken: token });
    app.get('/api/bootstrap', async (req, res) => {
      const hasOwner = Boolean(await get("SELECT id FROM users WHERE role = 'admin' LIMIT 1"));
      const publicRootEntry = Boolean(rootEntry && hasOwner);
      if (publicRootEntry) await ensureRootEntryLink();
      res.json({ needsSetup: !await get('SELECT id FROM users LIMIT 1'), privateEntry: Boolean(ownerKey), rootEntry: publicRootEntry, user: publicUser(req.user), tutorialDone: Boolean(req.user && await get('SELECT user_id FROM onboarding WHERE user_id = ? AND version >= ?', req.user.id, 1)), recordingAccepted: await recordingAccepted(req.user?.id), recordingNoticeVersion: RECORDING_NOTICE_VERSION, recordingNoticeRequired, model: { ...(req.user ? { model: provider.model, provider: new URL(provider.baseUrl).hostname } : {}), connected: Boolean(provider.apiKey) } });
    });
    app.post('/api/recording/acknowledge', member, async (req, res) => {
      const input = z.object({ version: z.literal(RECORDING_NOTICE_VERSION), accepted: z.literal(true) }).parse(req.body);
      await run('INSERT INTO user_recording_acknowledgements (user_id, version, accepted_at) VALUES (?, ?, ?) ON CONFLICT(user_id, version) DO NOTHING', req.user.id, input.version, Date.now());
      res.json({ accepted: true, version: input.version });
    });
    app.get('/api/submissions', member, admin, async (req, res) => {
      const limit = z.coerce.number().int().min(1).max(200).default(100).parse(req.query.limit);
      let cursor = null;
      if (req.query.cursor) {
        try { cursor = JSON.parse(Buffer.from(z.string().max(500).parse(req.query.cursor), 'base64url').toString('utf8')); }
        catch { fail(400, 'The submissions cursor is invalid.'); }
        if (!cursor || !Number.isSafeInteger(cursor.cutoff) || !Number.isSafeInteger(cursor.createdAt) || cursor.createdAt > cursor.cutoff || typeof cursor.cutoffId !== 'string' || !/^[0-9a-f-]{36}$/i.test(cursor.cutoffId) || typeof cursor.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(cursor.id)) fail(400, 'The submissions cursor is invalid.');
      }
      const page = await journal.page({ limit, cursor });
      const nextCursor = page.nextCursor ? Buffer.from(JSON.stringify(page.nextCursor)).toString('base64url') : null;
      res.json({ items: page.items, nextCursor });
    });
    app.put('/api/tutorial', member, async (req, res) => {
        const { result } = z.object({ result: z.enum(['completed', 'skipped']) }).parse(req.body);
        await run('INSERT INTO onboarding VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET version = excluded.version, result = excluded.result, completed_at = excluded.completed_at', req.user.id, 1, result, Date.now());
        res.json({ ok: true });
    });
    const createOwner = async (user) => {
        if (await get('SELECT id FROM users LIMIT 1'))
            fail(409, 'This workspace already has an owner.');
        const now = Date.now();
        const statements = [['INSERT INTO users VALUES (?, ?, ?, ?, ?, ?)', user.id, user.name, user.email, user.password, 'admin', now]];
        if (sharingKey) statements.push(['INSERT INTO workshop_links (id, token, created_at, expires) VALUES (?, ?, ?, ?)', 'initial-workshop-link', hash(sharingKey), now, now + 30 * 86400000]);
        for (const seed of seedLevels) {
            const data = JSON.stringify(levelSchema.parse(seed));
            const levelId = id();
            statements.push(['INSERT INTO levels (id, owner_id, draft, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', levelId, user.id, data, now, now]);
            statements.push(['INSERT INTO versions VALUES (?, ?, ?, ?, ?, ?, ?)', id(), levelId, 1, data, 'Initial scenario from the project brief. Needs blind testing.', user.id, now]);
        }
        try {
            await batch(statements);
        }
        catch (error) {
            if (await get("SELECT id FROM users WHERE role = 'admin'"))
                fail(409, 'This workspace already has an owner.');
            throw error;
        }
    };
    app.post('/api/setup', authThrottle, async (req, res) => {
        if (ownerKey)
            fail(403, 'Open the private owner link to set up this workspace.');
        const input = accountSchema.parse(req.body);
        const user = { id: id(), ...input, password: await passwordHash(input.password), role: 'admin' };
        await createOwner(user);
        await enter(res, user);
    });
    app.post('/api/login', authThrottle, async (req, res) => {
        const input = z.object({ email: z.string().trim().max(200), password: z.string().max(200) }).parse(req.body);
        const user = await get('SELECT * FROM users WHERE email = ?', input.email.toLowerCase());
        if (!user || !user.password.includes(':') || !await verifyPassword(input.password, user.password))
            fail(401, 'The email or password is incorrect.');
        await enter(res, user);
    });
    app.post('/api/logout', async (req, res) => {
        if (req.cookies.workshop)
            await run('DELETE FROM auth WHERE token = ?', hash(req.cookies.workshop));
        res.clearCookie('workshop', cookieOptions).json({ ok: true });
    });
    app.get('/api/invite/:token', async (req, res) => {
        const invite = await get('SELECT * FROM invites WHERE token = ? AND used = 0 AND expires > ?', hash(req.params.token), Date.now());
        if (!invite)
            fail(404, 'This invitation has expired or has already been used.');
        res.json({ role: invite.role });
    });
    app.post('/api/invite/:token', authThrottle, async (req, res) => {
        const input = accountSchema.parse(req.body);
        const password = await passwordHash(input.password);
        const invite = await get('SELECT * FROM invites WHERE token = ? AND used = 0 AND expires > ?', hash(req.params.token), Date.now());
        if (!invite)
            fail(404, 'This invitation is no longer available.');
        if (await get('SELECT id FROM users WHERE email = ?', input.email))
            fail(409, 'This email already has an account.');
        const user = { id: id(), ...input, password, role: invite.role };
        await batch([
            ['INSERT INTO invite_claims (invite_id, user_id) VALUES (?, ?)', invite.id, user.id],
            ['INSERT INTO users VALUES (?, ?, ?, ?, ?, ?)', user.id, user.name, user.email, password, user.role, Date.now()],
            ['UPDATE invites SET used = 1 WHERE id = ?', invite.id],
        ]);
        await enter(res, user);
    });
    app.get('/api/team', member, async (req, res) => res.json(await all("SELECT id, name, email, role FROM users WHERE role <> 'inception_participant' ORDER BY created_at")));
    const checkOwnerKey = value => {
      if (!ownerKey || !timingSafeEqual(Buffer.from(hash(value)), Buffer.from(hash(ownerKey)))) fail(404, 'This owner link is not available.');
    };
    app.get('/api/owner/:token', (req, res) => { checkOwnerKey(req.params.token); res.json({ role: 'admin' }); });
    app.post('/api/owner/:token', authThrottle, async (req, res) => {
      checkOwnerKey(req.params.token);
      const name = z.string().trim().min(1).max(70).parse(req.body.name);
      let user = await get("SELECT * FROM users WHERE role = 'admin'");
      if (!user) {
        user = { id: id(), name, email: `${id()}@workshop.invalid`, password: 'link-only', role: 'admin' };
        await createOwner(user);
      }
      await enter(res, user);
    });
    const sharedLink = async raw => {
      const link = await get('SELECT * FROM workshop_links WHERE token = ? AND revoked = 0 AND expires > ?', hash(raw), Date.now());
      if (!link) fail(404, 'This workshop link has expired or has been revoked. Ask the owner for a new link.');
      return link;
    };
    const ensureRootEntryLink = async () => {
      if (!rootEntry || !await get("SELECT id FROM users WHERE role = 'admin' LIMIT 1")) fail(404, 'Main website entry is not enabled.');
      await run('INSERT INTO workshop_links (id, token, created_at, expires) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING', 'root-workshop-entry', hash(token()), Date.now(), Number.MAX_SAFE_INTEGER);
      const link = await get('SELECT * FROM workshop_links WHERE id = ?', 'root-workshop-entry');
      if (!link) fail(404, 'Main website entry is not available.');
      return link;
    };
    const activeRootEntryLink = async () => {
      const link = await ensureRootEntryLink();
      if (link.revoked || link.expires <= Date.now()) fail(404, 'Main website name-only entry is paused. Ask the workspace owner to reopen it.');
      return link;
    };
    const setRootEntryEnabled = async enabled => {
      const link = await ensureRootEntryLink();
      await batch(enabled
        ? [['UPDATE workshop_links SET revoked = 0 WHERE id = ?', link.id]]
        : [['UPDATE workshop_links SET revoked = 1 WHERE id = ?', link.id], ['DELETE FROM auth WHERE token IN (SELECT auth_token FROM link_sessions WHERE link_id = ?)', link.id]]);
      return { enabled };
    };
    app.post('/api/inception/entry', async (req, res) => {
      res.set('Cache-Control', 'no-store');
      z.object({}).strict().parse(req.body);
      if (req.inceptionEntry) {
        const actor = req.inceptionEntry.actor;
        return res.json({ actorId: actor.id, actorScope: hash(String(actor.id)).slice(0, 24), recordingAuthorized: true, policyId: INCEPTION_ORGANIZER_RECORDING_POLICY });
      }
      if (req.user && !rootEntry) {
        const accepted = await recordingAccepted(req.user.id);
        return res.json({ actorId: req.user.id, actorScope: hash(String(req.user.id)).slice(0, 24), recordingAuthorized: accepted || !recordingNoticeRequired, policyId: null, ordinaryRecordingNotice: recordingNoticeRequired && !accepted });
      }
      const link = await activeRootEntryLink();
      let actor;
      if (req.user) actor = req.user;
      else {
        actor = { id: id(), name: `Participant ${randomBytes(5).toString('hex')}`, email: `${id()}@participant.invalid`, password: '', role: 'inception_participant' };
        await run('INSERT INTO users VALUES (?, ?, ?, ?, ?, ?)', actor.id, actor.name, actor.email, actor.password, actor.role, Date.now());
      }
      const raw = token(), expires = Date.now() + inceptionCookieOptions.maxAge;
      await batch([
        ['INSERT INTO auth (token,user_id,expires) VALUES (?,?,?)', hash(`inception-entry:${raw}`), actor.id, expires],
        ['INSERT INTO link_sessions (auth_token,link_id) VALUES (?,?)', hash(`inception-entry:${raw}`), link.id],
      ]);
      res.cookie('inception_entry', raw, inceptionCookieOptions);
      res.json({ actorId: actor.id, actorScope: hash(String(actor.id)).slice(0, 24), recordingAuthorized: true, policyId: INCEPTION_ORGANIZER_RECORDING_POLICY });
    });
    const createEditorEntry = async (req, res, link, name) => {
      if (req.user) return res.json({ user: publicUser(req.user) });
      const user = { id: id(), name, email: `${id()}@workshop.invalid`, password: 'link-only', role: 'editor' };
      await run('INSERT INTO users VALUES (?, ?, ?, ?, ?, ?)', user.id, user.name, user.email, user.password, user.role, Date.now());
      await enter(res, user, link.id);
    };
    app.get('/api/enter/:token', async (req, res) => { await sharedLink(req.params.token); res.json({ role: 'editor' }); });
    app.post('/api/enter/:token', authThrottle, async (req, res) => {
      const link = await sharedLink(req.params.token);
      const name = z.string().trim().min(1).max(70).parse(req.body.name);
      await createEditorEntry(req, res, link, name);
    });
    app.get('/api/entry', async (req, res) => {
      const link = await activeRootEntryLink();
      res.json({ role: req.user?.role || 'editor', ready: Boolean(link) });
    });
    app.post('/api/entry', authThrottle, async (req, res) => {
      const link = await activeRootEntryLink();
      const { name } = z.object({ name: z.string().trim().min(1).max(70) }).strict().parse(req.body);
      await createEditorEntry(req, res, link, name);
    });
    app.put('/api/entry', member, admin, async (req, res) => {
      const { enabled } = z.object({ enabled: z.boolean() }).strict().parse(req.body);
      res.json(await setRootEntryEnabled(enabled));
    });
    app.get('/api/workshop-links', member, admin, async (req, res) => {
      const rows = await all('SELECT id, created_at AS "createdAt", expires, revoked FROM workshop_links ORDER BY created_at DESC');
      res.json(rows.filter(link => link.id !== 'root-workshop-entry' || rootEntry).map(link => link.id === 'root-workshop-entry'
        ? { id: link.id, createdAt: link.createdAt, revoked: link.revoked, rootEntry: true, enabled: !link.revoked && link.expires > Date.now(), path: '/' }
        : { ...link, ...(link.id === 'initial-workshop-link' && sharingKey && !link.revoked && link.expires > Date.now() ? { path: `/enter/${sharingKey}` } : {}) }));
    });
    app.post('/api/workshop-links', member, admin, async (req, res) => {
      const raw = token(); const linkId = id(); const expires = Date.now() + 30 * 86400000;
      await run('INSERT INTO workshop_links (id, token, created_at, expires) VALUES (?, ?, ?, ?)', linkId, hash(raw), Date.now(), expires);
      res.json({ id: linkId, path: `/enter/${raw}`, expires });
    });
    app.delete('/api/workshop-links/:id', member, admin, async (req, res) => {
      if (req.params.id === 'root-workshop-entry' && rootEntry) await setRootEntryEnabled(false);
      else await run('UPDATE workshop_links SET revoked = 1 WHERE id = ?', req.params.id);
      res.json({ ok: true });
    });
    app.post('/api/invites', member, admin, async (req, res) => {
        const raw = token();
        const inviteId = id();
        await run('INSERT INTO invites (id, token, role, expires) VALUES (?, ?, ?, ?)', inviteId, hash(raw), 'editor', Date.now() + 7 * 86400000);
        res.json({ id: inviteId, path: `/join/${raw}` });
    });
    app.get('/api/levels', member, async (req, res) => {
      const rows = await all('SELECT levels.*, users.name AS owner, (SELECT COUNT(*) FROM versions WHERE level_id = levels.id) AS versions, (SELECT COUNT(*) FROM rounds WHERE level_id = levels.id) AS attempts FROM levels JOIN users ON users.id = levels.owner_id ORDER BY updated_at DESC');
      const ordinaryRows = rows.filter(row => !row.id.startsWith('reference-passport-case-') && !row.id.startsWith('reference-passport-study-') && row.id !== 'reference-riddle-diary');
      res.json(ordinaryRows.map(row => ({ id: row.id, draft: JSON.parse(row.draft), revision: row.revision, status: row.status, ownerId: row.owner_id, owner: row.owner, updatedAt: row.updated_at, versions: row.versions, attempts: row.attempts })));
    });
    app.post('/api/levels', member, async (req, res) => {
        const input = z.object({ templateId: z.string().optional() }).parse(req.body);
        let draft = { ...emptyLevel };
        if (input.templateId)
            draft = { ...JSON.parse((await levelRow(input.templateId)).draft), title: `${JSON.parse((await levelRow(input.templateId)).draft).title} copy` };
        const levelId = await addDraft(draft, req.user.id);
        res.status(201).json(await serializeLevel(await levelRow(levelId)));
    });
    app.get('/api/levels/:id', member, async (req, res) => {
        const row = await levelRow(req.params.id);
        res.json({ ...await serializeLevel(row), versions: await versions(row.id), comments: await all('SELECT comments.*, users.name AS author FROM comments JOIN users ON users.id = comments.user_id WHERE level_id = ? ORDER BY created_at', row.id), links: await all('SELECT links.id, links.version_id AS "versionId", links.created_at AS "createdAt", links.expires, links.revoked FROM links JOIN versions ON versions.id = links.version_id WHERE versions.level_id = ? ORDER BY links.created_at DESC', row.id) });
    });
    app.put('/api/levels/:id', member, async (req, res) => {
        await owner(req, req.params.id);
        const input = z.object({ draft: levelSchema, revision: z.number().int() }).parse(req.body);
        const result = await run("UPDATE levels SET draft = ?, revision = revision + 1, updated_at = ?, status = 'draft' WHERE id = ? AND revision = ?", JSON.stringify(input.draft), Date.now(), req.params.id, input.revision);
        if (!result.changes)
            fail(409, 'Someone updated this draft. Reload it before saving to avoid overwriting their work.');
        res.json(await serializeLevel(await levelRow(req.params.id)));
    });
    app.post('/api/levels/:id/versions', member, async (req, res) => {
        const row = await owner(req, req.params.id);
        const input = z.object({ note: z.string().trim().min(1).max(1000), revision: z.number().int() }).parse(req.body);
        if (input.revision !== row.revision)
            fail(409, 'The draft changed. Reload before saving a version.');
        validatePlayable(JSON.parse(row.draft));
        const versionId = await saveVersion(row, req.user.id, input.note);
        res.json({ versionId, versions: await versions(row.id) });
    });
    app.post('/api/levels/:id/restore', member, async (req, res) => {
        const row = await owner(req, req.params.id);
        const input = z.object({ versionId: z.string(), revision: z.number().int() }).parse(req.body);
        const v = await versionRow(input.versionId);
        if (v.level_id !== row.id)
            fail(400, 'This version belongs to another level.');
        const result = await run("UPDATE levels SET draft = ?, revision = revision + 1, updated_at = ?, status = 'draft' WHERE id = ? AND revision = ?", v.data, Date.now(), row.id, input.revision);
        if (!result.changes)
            fail(409, 'The draft changed. Reload before restoring.');
        res.json(await serializeLevel(await levelRow(row.id)));
    });
    app.post('/api/levels/:id/status', member, async (req, res) => {
        const row = await owner(req, req.params.id);
        const input = z.object({ status: z.enum(['draft', 'testing', 'revision', 'review', 'approved']) }).parse(req.body);
        if (input.status === 'approved' && req.user.role !== 'admin')
            fail(403, 'Only the workspace owner can approve a level.');
        if (['review', 'approved', 'testing'].includes(input.status)) {
            const latest = await get('SELECT data FROM versions WHERE level_id = ? ORDER BY number DESC LIMIT 1', row.id);
            if (!latest || latest.data !== row.draft)
                fail(400, 'Save the current draft as a version first.');
            if (input.status === 'approved' && !await get('SELECT reviews.round_id FROM reviews JOIN rounds ON rounds.id = reviews.round_id JOIN versions ON versions.id = rounds.version_id WHERE rounds.level_id = ? AND versions.data = ? LIMIT 1', row.id, row.draft))
                fail(400, 'Review at least one test of this version before approving it.');
        }
        await run('UPDATE levels SET status = ?, updated_at = ? WHERE id = ?', input.status, Date.now(), row.id);
        res.json({ status: input.status });
    });
    app.post('/api/levels/:id/comments', member, async (req, res) => {
        await levelRow(req.params.id);
        const text = z.string().trim().min(1).max(3000).parse(req.body.text);
        await run('INSERT INTO comments VALUES (?, ?, ?, ?, ?)', id(), req.params.id, req.user.id, text, Date.now());
        res.json({ ok: true });
    });
    app.post('/api/levels/:id/owner', member, admin, async (req, res) => {
        await levelRow(req.params.id);
        const userId = z.string().parse(req.body.userId);
        if (!await get('SELECT id FROM users WHERE id = ?', userId))
            fail(404, 'Team member not found.');
        await run('UPDATE levels SET owner_id = ?, updated_at = ? WHERE id = ?', userId, Date.now(), req.params.id);
        res.json({ ok: true });
    });
    app.post('/api/levels/:id/links', member, async (req, res) => {
        await owner(req, req.params.id);
        const version = await versionRow(z.string().parse(req.body.versionId));
        if (version.level_id !== req.params.id)
            fail(400, 'This version belongs to another level.');
        validatePlayable(JSON.parse(version.data));
        const raw = token();
        const linkId = id();
        await run('INSERT INTO links (id, token, version_id, created_at, expires) VALUES (?, ?, ?, ?, ?)', linkId, hash(raw), version.id, Date.now(), Date.now() + 7 * 86400000);
        res.json({ id: linkId, path: `/play/${raw}` });
    });
    app.delete('/api/links/:id', member, async (req, res) => {
        const row = await get('SELECT links.*, versions.level_id FROM links JOIN versions ON versions.id = links.version_id WHERE links.id = ?', req.params.id);
        if (!row)
            fail(404, 'Link not found.');
        await owner(req, row.level_id);
        await run('UPDATE links SET revoked = 1 WHERE id = ?', row.id);
        res.json({ ok: true });
    });
    const publicLink = async (raw) => {
        const link = await get('SELECT * FROM links WHERE token = ? AND revoked = 0 AND expires > ?', hash(raw), Date.now());
        if (!link)
            fail(404, 'This test link has expired or has been revoked.');
        return await versionRow(link.version_id);
    };
    app.get('/api/play/:token', async (req, res) => {
        const v = await publicLink(req.params.token);
        if (isInceptionData(JSON.parse(v.data))) fail(409, 'Use the dedicated strongroom entry.');
        res.json({ level: playerLevel(JSON.parse(v.data)), version: v.number, connected: Boolean(provider.apiKey) });
    });
    app.post('/api/play/:token', async (req, res) => {
        if (!provider.apiKey)
            fail(503, 'The target model is not connected yet. Ask the level author to connect it.');
        const tester = z.string().trim().min(1).max(70).parse(req.body.tester);
        if (recordingNoticeRequired && req.body.consent !== true) fail(428, 'Accept the recording notice before starting this test.');
        const version = await publicLink(req.params.token);
        if (isInceptionData(JSON.parse(version.data))) fail(409, 'Use the dedicated strongroom entry.');
        res.status(201).json(await createRound({ version, tester, source: 'blind', consentAt: req.body.consent === true ? Date.now() : null, recordingAckUserId: req.body.consent === true ? req.user?.id : null }));
    });
    app.post('/api/levels/:id/rounds', member, async (req, res) => {
        const v = await versionRow(z.string().parse(req.body.versionId));
        if (v.level_id === RIDDLE_DIARY_LEVEL_ID) fail(409, 'Start this scenario through the interactive diary.');
        if (isInceptionData(JSON.parse(v.data))) fail(409, 'Start this scenario through the interactive strongroom.');
        if (v.level_id !== req.params.id)
            fail(400, 'This version belongs to another level.');
        const replayOf = req.body.replayOf ? z.string().parse(req.body.replayOf) : null;
        const parentRound = replayOf ? await get('SELECT * FROM rounds WHERE id = ? AND level_id = ?', replayOf, req.params.id) : null;
        if (replayOf && !parentRound)
            fail(400, 'Choose an earlier test of this level.');
        const parentAssignment = parentRound ? await get('SELECT * FROM difficulty_collection_assignments WHERE round_id = ?', replayOf) : null;
        let version = v, collectionAssignment, frozenConfig;
        if (parentAssignment) {
            version = { id: parentRound.version_id, level_id: parentRound.level_id, data: parentRound.data };
            collectionAssignment = { id: id(), collectionId: parentAssignment.collection_id, profileId: parentAssignment.profile_id, profileSnapshot: JSON.parse(parentAssignment.profile_snapshot), source: 'replay', parentId: replayOf, linkId: null, startKeyHash: null, consentAt: null, consentVersion: null, assignedAt: Date.now() };
            frozenConfig = JSON.parse(parentRound.config);
        }
        res.status(201).json(await createRound({ version, frozenConfig, collectionAssignment, userId: req.user.id, tester: req.user.name, source: replayOf ? 'replay' : 'preview', parentId: replayOf }));
    });
    app.get('/api/levels/:id/active-round', member, async (req, res) => {
        await levelRow(req.params.id);
        const row = await get('SELECT * FROM rounds WHERE level_id = ? AND author_id = ? AND ended_at IS NULL AND NOT EXISTS (SELECT 1 FROM difficulty_collection_assignments WHERE round_id = rounds.id) ORDER BY started_at DESC LIMIT 1', req.params.id, req.user.id);
        res.json(row && row.started_at + JSON.parse(row.data).duration * 1000 > Date.now() ? publicRound(row) : null);
    });
    app.get('/api/rounds/:id', async (req, res) => res.json(publicRound(await accessRound(req))));
    const machineReviewView = row => row ? publicMachineReview({ status: row.status, attempts: Number(row.attempts), startedAt: row.started_at, completedAt: row.completed_at, verdict: row.verdict, reason: row.reason, evidence: row.evidence ? JSON.parse(row.evidence) : [], errorCode: row.error_code, protocolVersion: row.reviewer_protocol || undefined }) : null;
    const readMachineReview = async roundId => {
      let saved = await get('SELECT * FROM round_machine_reviews WHERE round_id = ?', roundId);
      if (saved?.status === 'pending' && Date.now() - saved.started_at > 45000) {
        const now = Date.now(), lease = await get('SELECT expires FROM round_locks WHERE round_id = ?', roundId);
        if (!lease || lease.expires <= now) {
          await run("UPDATE round_machine_reviews SET status='unavailable',error_code='interrupted',completed_at=? WHERE round_id=? AND status='pending' AND run_id=?", now, roundId, saved.run_id);
          saved = await get('SELECT * FROM round_machine_reviews WHERE round_id = ?', roundId);
        }
      }
      return machineReviewView(saved);
    };
    app.get('/api/rounds/:id/review', async (req, res) => {
      const row = await accessRound(req);
      if (isPassportVersion(row.version_id)) fail(409, 'Use the reference desk review for passport sessions.');
      if (isInceptionData(JSON.parse(row.data))) fail(409, 'Use the independent strongroom review for Inception sessions.');
      res.json({ machineReview: row.ended_at ? await readMachineReview(row.id) : null });
    });
    app.post('/api/rounds/:id/review', async (req, res) => {
      const authorized = await accessRound(req);
      if (!authorized.ended_at) fail(409, 'Finish the game before requesting automated review.');
      if (isPassportVersion(authorized.version_id)) fail(409, 'Use the reference desk review for passport sessions.');
      if (isInceptionData(JSON.parse(authorized.data))) fail(409, 'Use the independent strongroom review for Inception sessions.');
      if (!passportReviewEnabled) fail(503, 'Automated review is disabled for this workspace.');
      await requireRecording(req, authorized);
      if (!provider.apiKey) fail(503, 'The review provider is not connected.');
      const old = await get('SELECT * FROM round_machine_reviews WHERE round_id = ?', authorized.id);
      if (old?.status === 'complete') return res.json({ machineReview: machineReviewView(old) });
      if (old?.status === 'pending' && Date.now() - old.started_at <= 45000) return res.json({ machineReview: machineReviewView(old) });
      if (old?.status === 'pending') {
        const now = Date.now(), live = await get('SELECT expires FROM round_locks WHERE round_id = ?', authorized.id);
        if (live && live.expires > now) return res.status(409).json({ error: 'The review is still running.', machineReview: machineReviewView(old) });
        await run("UPDATE round_machine_reviews SET status='unavailable',error_code='interrupted',completed_at=? WHERE round_id=? AND status='pending' AND run_id=?", now, authorized.id, old.run_id);
        return res.json({ machineReview: await readMachineReview(authorized.id) });
      }
      if (old?.attempts >= 3) return res.json({ machineReview: machineReviewView({ ...old, status: 'unavailable', error_code: 'attempt_limit' }) });
      const result = await withRoundLock(req, async (row, lease) => {
        if (!row.ended_at) fail(409, 'Finish the game before requesting automated review.');
        const current = await get('SELECT * FROM round_machine_reviews WHERE round_id = ?', row.id);
        if (current?.status === 'complete') return { machineReview: machineReviewView(current) };
        if (current?.status === 'pending') return { machineReview: machineReviewView(current) };
        if (current?.attempts >= 3) return { machineReview: machineReviewView({ ...current, status: 'unavailable', error_code: 'attempt_limit' }) };
        const now = Date.now(), runId = id(), attempts = Number(current?.attempts || 0) + 1;
        await run(`INSERT INTO round_machine_reviews (round_id,status,attempts,run_id,started_at,completed_at,verdict,reason,evidence,error_code,reviewer_protocol)
          VALUES (?,'pending',?,?,?,NULL,NULL,NULL,NULL,NULL,?)
          ON CONFLICT(round_id) DO UPDATE SET status='pending',attempts=excluded.attempts,run_id=excluded.run_id,started_at=excluded.started_at,completed_at=NULL,verdict=NULL,reason=NULL,evidence=NULL,error_code=NULL,reviewer_protocol=excluded.reviewer_protocol`, row.id, attempts, runId, now, MACHINE_REVIEW_PROTOCOL_VERSION);
        const data = JSON.parse(row.data), messages = JSON.parse(row.messages);
        let assessed;
        try {
          const answer = await instrumentedCompletion({ config: provider, system: MACHINE_REVIEW_SYSTEM, messages: [{ role: 'user', content: makeReviewPrompt({ secret: data.secret, criteria: data.criteria, messages }) }], temperature: 0, metricsContext: { kind: 'judge', source: 'judge', roundId: row.id, versionId: row.version_id, userId: req.user?.id || null, userRole: req.user?.role || null, ...(await get('SELECT collection_id AS "collectionId", profile_id AS "profileId" FROM difficulty_collection_assignments WHERE round_id = ?', row.id) || {}), profileId: (await get('SELECT profile_id FROM difficulty_collection_assignments WHERE round_id = ?', row.id))?.profile_id || JSON.parse(row.data).diaryProfile?.id || null } });
          const valid = validateMachineReview(answer.text, messages);
          assessed = { status: 'complete', attempts, verdict: valid.verdict, reason: valid.reason, evidence: JSON.stringify(valid.evidence), errorCode: null };
        } catch (error) {
          assessed = { status: 'unavailable', attempts, verdict: null, reason: null, evidence: null, errorCode: error.reviewError || (error.providerCode === 'timeout' ? 'provider_error' : 'provider_error') };
        }
        const saved = await run('UPDATE round_machine_reviews SET status=?,attempts=?,completed_at=?,verdict=?,reason=?,evidence=?,error_code=? WHERE round_id=? AND run_id=? AND status=?', assessed.status, attempts, Date.now(), assessed.verdict, assessed.reason, assessed.evidence, assessed.errorCode, row.id, runId, 'pending');
        if (!saved.changes) fail(409, 'The review result could not be saved. Reload before retrying.');
        return { machineReview: machineReviewView(await get('SELECT * FROM round_machine_reviews WHERE round_id = ?', row.id)) };
      });
      res.json(result);
    });
    app.get('/api/rounds/:id/recording', async (req, res) => {
      const row = await accessRound(req), collectionConsent = await get('SELECT round_id FROM difficulty_collection_assignments WHERE round_id = ? AND consent_at IS NOT NULL AND consent_version IS NOT NULL', row.id), organizerPolicy = isInceptionData(JSON.parse(row.data)) && row.recording_notice_version === INCEPTION_ORGANIZER_RECORDING_POLICY && req.inceptionEntry?.actor?.id === row.author_id, accepted = Boolean(organizerPolicy || (row.recording_accepted_at && row.recording_notice_version === RECORDING_NOTICE_VERSION) || collectionConsent || await recordingAccepted(req.user?.id));
      res.json({ accepted, version: accepted ? (organizerPolicy ? INCEPTION_ORGANIZER_RECORDING_POLICY : RECORDING_NOTICE_VERSION) : null });
    });
    app.post('/api/rounds/:id/recording', async (req, res) => {
      const row = await accessRound(req), input = z.object({ version: z.literal(RECORDING_NOTICE_VERSION), accepted: z.literal(true) }).parse(req.body);
      if (req.inceptionEntry?.actor?.role === 'inception_participant' && isInceptionData(JSON.parse(row.data))) fail(403, 'The organizer-provided Inception recording policy cannot be replaced by a participant acknowledgement.');
      const acceptedAt = Date.now();
        if (row.recording_notice_version !== input.version) await run('UPDATE rounds SET recording_accepted_at = ?, recording_notice_version = ? WHERE id = ?', acceptedAt, input.version, row.id);
        if (req.user) await run('INSERT INTO user_recording_acknowledgements (user_id, version, accepted_at) VALUES (?, ?, ?) ON CONFLICT(user_id, version) DO NOTHING', req.user.id, input.version, acceptedAt);
      res.json({ accepted: true, version: input.version });
    });
    const withRoundLock = async (req, action) => {
        const initial = await accessRound(req);
        const lease = token(); const now = Date.now();
        const claimed = await run('INSERT INTO round_locks VALUES (?, ?, ?) ON CONFLICT(round_id) DO UPDATE SET token = excluded.token, expires = excluded.expires WHERE round_locks.expires <= ?', initial.id, lease, now + 45000, now);
        if (!claimed.changes) fail(409, 'Wait for the current reply before changing this conversation.');
        try { return await action(await accessRound(req), lease); }
        finally { await run('DELETE FROM round_locks WHERE round_id = ? AND token = ?', initial.id, lease); }
    };
    addInceptionRoutes(app, { store, member, inceptionMember, provider, capacity: inceptionCapacity, createRound, accessRound, withRoundLock, publicRound, requireRecording, recordingNoticeRequired, reviewEnabled: Boolean(passportReviewEnabled), completion: inceptionCompletion, markCompletionSaved: metrics.markSaved });
    const collectionModels = createCollectionModelServices({ store, provider, completion: inceptionCompletion, metrics });
    app.post('/api/rounds/:id/messages', async (req, res) => {
      const authorized = await accessRound(req), content = z.string().trim().min(1).max(4000).parse(req.body.content);
      if (isPassportVersion(authorized.version_id)) fail(409, 'Continue this interview at the interactive reference desk.');
      if (isRiddleDiaryData(JSON.parse(authorized.data)) && !await get('SELECT round_id FROM diary_sessions WHERE round_id=?', authorized.id)) fail(409, 'Continue this diary in its interactive scene.');
      if (isInceptionData(JSON.parse(authorized.data)) && !await get('SELECT round_id FROM inception_sessions WHERE round_id=?', authorized.id)) fail(409, 'Continue this strongroom in its interactive scene.');
      await requireRecording(req, authorized);
      const requestId = req.body.requestId === undefined ? undefined : z.string().uuid().parse(req.body.requestId);
      const authorizedData = JSON.parse(authorized.data), diaryMode = isRiddleDiaryData(authorizedData), inceptionMode = isInceptionData(authorizedData), diaryProfileId = authorizedData.diaryProfile?.id || null, inceptionProfileId = authorizedData.inceptionProfile?.id || null;
      if (requestId) {
        const existing = await journal.find(`round:${authorized.id}`, requestId);
        if (existing) {
          const existingAssignment = await get('SELECT collection_id, profile_id FROM difficulty_collection_assignments WHERE round_id = ?', authorized.id);
          const checked = await journal.begin({ roundId: authorized.id, clientRequestId: requestId, actorId: req.user?.id || (inceptionMode ? req.inceptionEntry?.actor?.id : null), source: authorized.source, versionId: authorized.version_id, collectionId: existingAssignment?.collection_id, profileId: existingAssignment?.profile_id || diaryProfileId || inceptionProfileId, scenarioId: diaryMode ? RIDDLE_DIARY_SCENARIO_ID : inceptionMode ? INCEPTION_SCENARIO_ID : undefined, content });
          const receipt = checked.entry;
          if (receipt.status === 'succeeded' && receipt.transcript_saved) return res.json({ ...publicRound(await get('SELECT * FROM rounds WHERE id = ?', authorized.id)), submissionId: receipt.id });
          return res.status(409).json({ error: receipt.status === 'succeeded' ? 'The reply was recorded, but the conversation save did not complete.' : 'This request was already received and will not be sent twice.', submissionId: receipt.id, submissionStatus: receipt.status, receiptConfirmed: true, transcriptSaved: Boolean(receipt.transcript_saved) });
        }
      }
      if (authorized.ended_at || Date.now() >= authorized.started_at + JSON.parse(authorized.data).duration * 1000) fail(409, 'The conversation has ended. Submit your answer or start a fresh test.');
      const messagesBefore = JSON.parse(authorized.messages);
      if (messagesBefore.filter(m => m.role === 'user').length >= 40) fail(409, 'This test has reached its 40-turn limit.');
      const assignment = await get('SELECT collection_id, profile_id FROM difficulty_collection_assignments WHERE round_id = ?', authorized.id);
      const { entry, shouldInvoke } = await journal.begin({ roundId: authorized.id, clientRequestId: requestId, actorId: req.user?.id || (inceptionMode ? req.inceptionEntry?.actor?.id : null), source: authorized.source, versionId: authorized.version_id, collectionId: assignment?.collection_id, profileId: assignment?.profile_id || diaryProfileId || inceptionProfileId, scenarioId: diaryMode ? RIDDLE_DIARY_SCENARIO_ID : inceptionMode ? INCEPTION_SCENARIO_ID : undefined, content });
      if (!shouldInvoke) {
        if (entry.status === 'succeeded' && entry.transcript_saved) return res.json({ ...publicRound(await get('SELECT * FROM rounds WHERE id = ?', authorized.id)), submissionId: entry.id });
        return res.status(409).json({ error: entry.status === 'succeeded' ? 'The reply was recorded, but the conversation save did not complete.' : 'This request was already received and will not be sent twice.', submissionId: entry.id, submissionStatus: entry.status, receiptConfirmed: true, transcriptSaved: Boolean(entry.transcript_saved) });
      }
      try { await withRoundLock(req, async (row, lease) => {
        if (isPassportVersion(row.version_id)) fail(409, 'Continue this interview at the interactive reference desk.');
        if (isRiddleDiaryData(JSON.parse(row.data)) && !await get('SELECT round_id FROM diary_sessions WHERE round_id=?', row.id)) fail(409, 'Continue this diary in its interactive scene.');
        if (isInceptionData(JSON.parse(row.data)) && !await get('SELECT round_id FROM inception_sessions WHERE round_id=?', row.id)) fail(409, 'Continue this strongroom in its interactive scene.');
        if (row.ended_at || Date.now() >= row.started_at + JSON.parse(row.data).duration * 1000)
            fail(409, 'The conversation has ended. Submit your answer or start a fresh test.');
        const messages = JSON.parse(row.messages);
        if (messages.filter(m => m.role === 'user').length >= 40)
            fail(409, 'This test has reached its 40-turn limit.');
        if (!(await journal.claim(entry.id)).changes) fail(409, 'This request was already received and will not be sent twice.');
        const config = JSON.parse(row.config);
        const collectionSystem = await collectionModels.systemForRound(row);
        const inceptionConfig = inceptionMode ? inceptionCapacity.credentialsForFrozen(config) : null;
        if (!inceptionMode && !collectionSystem && config.baseUrl !== provider.baseUrl)
            fail(409, 'The provider changed since this test started. Start a fresh test.');
            const playerMessage = { id: id(), role: 'user', content, createdAt: Date.now() };
            const data = JSON.parse(row.data);
            let verifiedContext = '';
            let presentedObjects = null;
            if (isRiddleDiaryData(data)) {
              const diaryStateRow = await get('SELECT state FROM diary_sessions WHERE round_id=?', row.id);
              if (!diaryStateRow) fail(409, 'Continue this diary in its interactive scene.');
              const diaryState = JSON.parse(diaryStateRow.state);
              verifiedContext = diaryPromptContext(diaryState);
              presentedObjects = diaryState.presentedObjects;
              playerMessage.deskContext = verifiedContext;
              playerMessage.presented = [...presentedObjects];
              await journal.updateContext(entry.id, verifiedContext, presentedObjects);
            }
            if (isInceptionData(data)) {
              const scene = await get('SELECT state FROM inception_sessions WHERE round_id=?', row.id);
              if (!scene) fail(409, 'Continue this strongroom in its interactive scene.');
              verifiedContext = inceptionPromptContext(JSON.parse(scene.state));
              playerMessage.verifiedContext = verifiedContext;
              await journal.updateContext(entry.id, verifiedContext, []);
            }
            const system = `${collectionSystem || compilePrompt(data)}${verifiedContext ? `\n\n${verifiedContext}` : ''}`;
            let requested;
            try { requested = await collectionModels.request({ row, system, messages: [...messages, playerMessage], temperature: data.temperature, actor: req.user || (inceptionMode ? req.inceptionEntry?.actor : undefined), profileId: diaryProfileId || inceptionProfileId, configOverride: inceptionConfig, roundLockToken: inceptionMode ? lease : null }); }
            catch (error) { await journal.fail(entry.id, error); error.submissionId = entry.id; throw error; }
            const { result, callId } = requested;
            const replyId = id();
            await journal.succeed(entry.id, { reply: result.text, replyId });
            const next = [...messages, playerMessage, { id: replyId, role: 'assistant', content: result.text, createdAt: Date.now(), latencyMs: result.latencyMs, usage: result.usage, model: result.model }];
            const saved = await collectionModels.finish({ row, lease, messages: next, callId, result });
            if (!saved) { const error = Object.assign(new Error('This reply was received and saved, but the conversation could not be updated.'), { status: 409, submissionId: entry.id }); throw error; }
            await journal.markTranscriptSaved(entry.id);
            res.json({ ...publicRound(await get('SELECT * FROM rounds WHERE id = ?', row.id)), submissionId: entry.id });
      }); } catch (error) {
        const current = await get('SELECT status FROM durable_submissions WHERE id = ?', entry.id);
        if (current?.status === 'accepted') { await journal.reject(entry.id); current.status = 'rejected'; }
        else if (current?.status === 'running') { await journal.fail(entry.id, error); current.status = 'failed'; }
        error.submissionId ||= entry.id;
        error.submissionStatus ||= current?.status;
        error.receiptConfirmed = true;
        if (current?.status === 'failed') {
          const safeFailureMessages = {
            rate_limited: error.rateLimitScope === 'tokens_daily' ? 'Usage limit reached. Your prompt is saved. Wait before trying again.' : 'The model service is temporarily rate limited. Your prompt is saved; wait before trying again.',
            provider_auth: 'The model service is unavailable. Your prompt is saved.',
            provider_unavailable: 'The model service is unavailable. Your prompt is saved.',
            timeout: 'The model service did not respond in time. Your prompt is saved.',
            empty_response: 'The model service returned no reply. Your prompt is saved.',
          };
          error.message = safeFailureMessages[error.providerCode] || 'Your prompt is saved, but the model service could not reply. Try again later.';
        }
        else if (current?.status === 'succeeded') { error.status = 409; error.message = 'The model reply was recorded, but the conversation could not be updated.'; error.transcriptSaved = false; }
        throw error;
      }
    });
    app.post('/api/rounds/:id/hint', async (req, res) => withRoundLock(req, async row => {
        if (isPassportVersion(row.version_id)) fail(409, 'Use the hints at the interactive reference desk.');
        const data = JSON.parse(row.data);
        if (isRiddleDiaryData(data)) fail(409, 'Use the diary objects to uncover further clues.');
        if (isInceptionData(data)) fail(409, 'Use the strongroom objects to inspect the scene.');
        if (row.ended_at || Date.now() >= row.started_at + data.duration * 1000)
            fail(409, 'This conversation has ended.');
        if (isRiddleDiaryData(data)) fail(409, 'Use the diary objects to uncover further clues.');
        await requireRecording(req, row);
        if (row.hints_used >= data.hints.length)
            fail(400, 'There are no more hints.');
        const messages = [...JSON.parse(row.messages), { id: id(), role: 'hint', content: data.hints[row.hints_used], createdAt: Date.now() }];
        await run('UPDATE rounds SET hints_used = hints_used + 1, messages = ? WHERE id = ?', JSON.stringify(messages), row.id);
        res.json(publicRound(await get('SELECT * FROM rounds WHERE id = ?', row.id)));
    }));
    app.post('/api/rounds/:id/submit', async (req, res) => withRoundLock(req, async row => {
        if (isPassportVersion(row.version_id)) fail(409, 'Stamp and file this case at the interactive reference desk.');
        if (isRiddleDiaryData(JSON.parse(row.data))) fail(409, 'File your evidence from the interactive diary.');
        if (isInceptionData(JSON.parse(row.data))) fail(409, 'Finish the strongroom from its dedicated interface.');
        if (row.ended_at)
            fail(409, 'This answer has already been submitted.');
        const answer = z.string().trim().min(1).max(4000).parse(req.body.answer);
        await requireRecording(req, row);
        await run('UPDATE rounds SET answer = ?, ended_at = ? WHERE id = ?', answer, Date.now(), row.id);
        res.json(publicRound(await get('SELECT * FROM rounds WHERE id = ?', row.id)));
    }));
    app.post('/api/rounds/:id/branch', member, async (req, res) => {
        const row = await accessRound(req);
        if (isPassportVersion(row.version_id)) fail(409, 'Replay this reference at the interactive desk.');
        if (isRiddleDiaryData(JSON.parse(row.data))) fail(409, 'Start a fresh diary scene to change prompt profiles.');
        if (isInceptionData(JSON.parse(row.data))) fail(409, 'Start a fresh strongroom scene to make a replay.');
        const messages = JSON.parse(row.messages);
        const messageId = z.string().parse(req.body.messageId);
        const index = messages.findIndex(m => m.id === messageId && m.role === 'assistant');
        if (index < 0)
            fail(400, 'Branch from a target reply.');
        const inherited = messages.slice(0, index + 1).map(m => ({ ...m, id: id() }));
        const parentAssignment = await get('SELECT * FROM difficulty_collection_assignments WHERE round_id = ?', row.id);
        const collectionAssignment = parentAssignment ? { id: id(), collectionId: parentAssignment.collection_id, profileId: parentAssignment.profile_id, profileSnapshot: JSON.parse(parentAssignment.profile_snapshot), source: 'branch', parentId: row.id, linkId: null, startKeyHash: null, consentAt: null, consentVersion: null, assignedAt: Date.now() } : undefined;
        const version = { id: row.version_id, level_id: row.level_id, data: row.data };
        const next = await createRound({ version, frozenConfig: parentAssignment ? JSON.parse(row.config) : undefined, collectionAssignment, userId: req.user.id, tester: req.user.name, source: 'branch', messages: inherited, parentId: row.id });
        await run('UPDATE rounds SET hints_used = ? WHERE id = ?', inherited.filter(m => m.role === 'hint').length, next.id);
        res.status(201).json({ ...next, hintsUsed: inherited.filter(m => m.role === 'hint').length });
    });
    app.get('/api/attempts', member, async (req, res) => {
        const rows = req.query.levelId
          ? await all("SELECT * FROM rounds WHERE level_id = ? AND (source IS NULL OR source NOT IN ('mission-play','inception-play')) AND NOT EXISTS (SELECT 1 FROM difficulty_collection_assignments WHERE round_id = rounds.id) ORDER BY started_at DESC LIMIT 200", String(req.query.levelId))
          : await all("SELECT * FROM rounds WHERE (source IS NULL OR source NOT IN ('mission-play','inception-play')) AND NOT EXISTS (SELECT 1 FROM difficulty_collection_assignments WHERE round_id = rounds.id) ORDER BY started_at DESC LIMIT 200");
        res.json(await Promise.all(rows.map(async row => ({ ...publicRound(row), version: (await versionRow(row.version_id)).number, review: await get('SELECT outcome, note, evidence FROM reviews WHERE round_id = ?', row.id) || null }))));
    });
    app.get('/api/attempts/:id', member, async (req, res) => {
        const row = await get('SELECT * FROM rounds WHERE id = ?', req.params.id);
        if (!row)
            fail(404, 'Test not found.');
        if (isMissionRound(row)) fail(404, 'Continue this session in the interactive archive.');
        if (isRiddleDiaryData(JSON.parse(row.data))) fail(403, 'The diary system prompt is not available in player routes.');
        if (isInceptionData(JSON.parse(row.data))) fail(403, 'The strongroom system prompt is not available in player routes.');
        const assignment = await get('SELECT source FROM difficulty_collection_assignments WHERE round_id = ?', row.id);
        if (assignment?.source === 'participant') fail(403, 'Review participant attempts from their collection to keep collection context attached.');
        const desk = isPassportVersion(row.version_id) ? await get('SELECT state FROM passport_sessions WHERE round_id = ?', row.id) : null;
        res.json({ ...publicRound(row), ...(desk ? { desk: publicPassportState(JSON.parse(desk.state)) } : {}), data: JSON.parse(row.data), config: JSON.parse(row.config), version: (await versionRow(row.version_id)).number, parentId: row.parent_id, review: await get('SELECT reviews.*, users.name AS reviewer FROM reviews JOIN users ON users.id = reviews.reviewer_id WHERE round_id = ?', row.id) || null });
    });
    app.post('/api/attempts/:id/review', member, async (req, res) => {
        const row = await get('SELECT * FROM rounds WHERE id = ?', req.params.id);
        if (!row)
            fail(404, 'Test not found.');
        if (isMissionRound(row)) fail(404, 'Use the archive review for this session.');
        if (isInceptionData(JSON.parse(row.data))) fail(409, 'Use the independent strongroom review for Inception sessions.');
        const input = z.object({ outcome: z.enum(['solved', 'partial', 'unsolved']), note: z.string().trim().min(1).max(4000), evidence: z.array(z.string()).max(40) }).parse(req.body);
        const messages = JSON.parse(row.messages);
        if (input.evidence.some(e => !messages.some(m => m.id === e && m.role === 'assistant' && !m.opening)))
            fail(400, 'Evidence must reference target replies from this conversation.');
        if (['solved', 'partial'].includes(input.outcome) && !input.evidence.length)
            fail(400, 'Select a target reply as evidence for this outcome.');
        await batch([
            ['INSERT INTO reviews VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(round_id) DO UPDATE SET outcome = excluded.outcome, note = excluded.note, evidence = excluded.evidence, reviewer_id = excluded.reviewer_id, updated_at = excluded.updated_at', row.id, input.outcome, input.note, JSON.stringify(input.evidence), req.user.id, Date.now()],
            ['DELETE FROM difficulty_annotations WHERE round_id = ?', row.id],
        ]);
        res.json({ ok: true });
    });
    app.get('/api/attempts/:id/prompt', member, async (req, res) => {
        const row = await get('SELECT * FROM rounds WHERE id = ?', req.params.id);
        if (!row)
            fail(404, 'Test not found.');
        if (isMissionRound(row)) fail(404, 'Continue this session in the interactive archive.');
        if (isRiddleDiaryData(JSON.parse(row.data))) fail(403, 'The diary system prompt is not available in player routes.');
        if (isInceptionData(JSON.parse(row.data))) fail(403, 'The strongroom system prompt is not available in player routes.');
        const assignment = await get('SELECT source FROM difficulty_collection_assignments WHERE round_id = ?', row.id);
        if (assignment?.source === 'participant') fail(403, 'Participant attempts do not expose their protection prompt.');
        const messages = JSON.parse(row.messages).filter(m => ['user', 'assistant'].includes(m.role));
        if (assignment?.source === 'preview') {
            const config = JSON.parse(row.config), data = JSON.parse(row.data);
            const latest = await get('SELECT status, started_at, completed_at, latency_ms, error_code, request_context FROM difficulty_provider_calls WHERE round_id = ? ORDER BY started_at DESC, id DESC LIMIT 1', row.id);
            const frozenConfig = { model: config.model, baseUrl: config.baseUrl, reasoningEffort: config.reasoningEffort || 'low', temperature: data.temperature };
            if (latest) return res.json({
                kind: 'collection-preview-request', source: 'preview', roundId: row.id, frozenConfig,
                latestCall: { status: latest.status, startedAt: latest.started_at, completedAt: latest.completed_at, latencyMs: latest.latency_ms, errorCode: latest.error_code, requestContext: latest.request_context ? JSON.parse(latest.request_context) : null },
                prospective: null,
            });
            let system = await collectionModels.systemForRound(row) || compilePrompt(data);
            const passportScenario = passportScenarioForVersion(row.version_id, researchWorlds);
            if (passportScenario) {
                const desk = await get('SELECT state FROM passport_sessions WHERE round_id = ?', row.id);
                if (desk) system += `\n\nVERIFIED DESK OBSERVATIONS\n${passportContext(JSON.parse(desk.state), passportScenario)}`;
            }
            return res.json({
                kind: 'collection-preview-request', source: 'preview', roundId: row.id, frozenConfig, latestCall: null,
                prospective: {
                    status: 'not_sent', explanation: 'No provider request has been sent. This prospective context uses the saved transcript and desk state now; a future player message is not included.',
                    requestContext: { baseUrl: config.baseUrl, body: buildCompletionBody({ config, system, messages, temperature: data.temperature }) },
                },
            });
        }
        const lastQuestion = messages.findLast(m => m.role === 'user');
        res.json({ system: (await collectionModels.systemForRound(row) || compilePrompt(JSON.parse(row.data))) + (lastQuestion?.deskContext ? `\n\nVERIFIED DESK OBSERVATIONS\n${lastQuestion.deskContext}` : ''), config: JSON.parse(row.config), messages });
    });
    app.get('/api/levels/:id/prompt', member, async (req, res) => res.json({ system: compilePrompt(JSON.parse((await levelRow(req.params.id)).draft)), config: safeConfig() }));
    addOrchestrationRoutes(app, { store, provider, completion: instrumentedCompletion, journal, requireRecording });
    addCollectionRoutes(app, { store, provider, member, owner, versionRow, createRound, passportReviewEnabled });
    addPassportRoutes(app, { store, provider, completion: instrumentedCompletion, member, createRound, accessRound, withRoundLock, publicRound, addDraft, researchWorlds, researchWorldId, collectionModels, passportReviewEnabled, passportScenarioRotation, journal, requireRecording, recordingNoticeRequired });
    const missionRoutes = addMissionArchiveRoutes(app, { store, member, provider, completion: instrumentedCompletion, journal, requireRecording, recordingNoticeRequired, reviewEnabled: Boolean(passportReviewEnabled) });
    addMetricsRoutes(app, { store, enabled: metricsEnabled, secureCookies, authorizeRound: async (req, roundId) => await missionRoutes.authorizeMetricsRound(req, roundId) || accessRound(req, roundId), admin, sessionCreationLimit: metricsSessionCreationLimit, recordingNoticeRequired, recordingAccepted, inceptionEntryPolicy: INCEPTION_ORGANIZER_RECORDING_POLICY });
    app.use('/api', async (req, res) => res.status(404).json({ error: 'Endpoint not found.' }));
    app.use(async (error, req, res, next) => {
        if (error instanceof z.ZodError)
            return res.status(400).json({ error: error.issues.map(i => `${i.path.join('.') || 'Input'}: ${i.message}`).join('; ') });
        const status = error.status || 500;
        if (status === 500)
            console.error('Request failed:', error.message);
        const failureCode = publicFailureCodes.has(error.providerCode) ? error.providerCode : undefined;
        const retryAfterSeconds = publicRetryAfter(error.retryAfterSeconds);
        const rateLimitScope = publicRateLimitScopes.has(error.rateLimitScope) ? error.rateLimitScope : undefined;
        res.status(status).json({ error: status === 500 ? 'The request could not be completed.' : error.message, ...(error.submissionId ? { submissionId: error.submissionId, submissionStatus: error.submissionStatus, receiptConfirmed: Boolean(error.receiptConfirmed), ...(error.transcriptSaved === undefined ? {} : { transcriptSaved: error.transcriptSaved }) } : {}), ...(failureCode ? { failureCode } : {}), ...(retryAfterSeconds ? { retryAfterSeconds } : {}), ...(rateLimitScope ? { rateLimitScope } : {}) });
    });
    return { app, store };
}
