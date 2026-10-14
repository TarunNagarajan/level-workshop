import express from 'express';
import cookieParser from 'cookie-parser';
import { randomBytes, randomUUID, createHash, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { z } from 'zod';
import { complete, modelConfig } from './model.mjs';
import { emptyLevel, levelSchema, seedLevels, compilePrompt, playerLevel, validatePlayable } from './levels.mjs';
import { addPassportRoutes } from './passport-reference.mjs';
import { addOrchestrationRoutes } from './orchestration.mjs';
import { addCollectionRoutes, createCollectionModelServices } from './collections.mjs';
const scrypt = promisify(scryptCallback);
const id = () => randomUUID();
const token = () => randomBytes(32).toString('base64url');
const hash = value => createHash('sha256').update(value).digest('hex');
const isPassportVersion = versionId => versionId === 'reference-passport-desk-v1' || versionId.startsWith('reference-passport-study-v1-');
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
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
export function createWorkshop({ store, provider = modelConfig(), completion = complete, ownerKey = '', sharingKey = '', secureCookies = false, publicOrigin = '', researchWorlds = false, researchWorldId = '' } = {}) {
    if (!store)
        throw new Error('A persistent store is required.');
    const cookieOptions = { httpOnly: true, sameSite: 'strict', path: '/', secure: secureCookies, maxAge: 30 * 86400000 };
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
        next();
    });
    const member = (req, res, next) => req.user ? next() : res.status(401).json({ error: 'Sign in to use the workshop.' });
    const admin = (req, res, next) => req.user?.role === 'admin' ? next() : res.status(403).json({ error: 'Only the workspace owner can do this.' });
    const owner = async (req, levelId) => {
        const row = await get('SELECT * FROM levels WHERE id = ?', levelId);
        if (!row)
            fail(404, 'This level does not exist.');
        if (row.owner_id !== req.user.id && req.user.role !== 'admin')
            fail(403, 'Only the level author or workspace owner can edit this draft. Duplicate it to make your own version.');
        if (levelId === 'reference-passport-desk') fail(409, 'This finished reference is fixed. Create your editable copy from its build guide.');
        return row;
    };
    const levelRow = async (levelId) => { const row = await get('SELECT * FROM levels WHERE id = ?', levelId); if (!row)
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
    const publicRound = row => ({ id: row.id, ...(row.source === 'collection-participant' ? {} : { versionId: row.source === 'reference-research-preview' ? 'reference-passport-study' : row.version_id, model: JSON.parse(row.config).model, source: row.source }), level: playerLevel(JSON.parse(row.data)), tester: row.tester, messages: row.source === 'collection-participant' ? JSON.parse(row.messages).map(({ id: messageId, role, content, createdAt, opening, latencyMs }) => ({ id: messageId, role, content, createdAt, ...(opening ? { opening: true } : {}), ...(Number.isFinite(latencyMs) ? { latencyMs } : {}) })) : JSON.parse(row.messages), startedAt: row.started_at, endedAt: row.ended_at, deadline: row.started_at + JSON.parse(row.data).duration * 1000, answer: row.answer, hintsUsed: row.hints_used });
    const accessRound = async (req) => {
        const row = await get('SELECT * FROM rounds WHERE id = ?', req.params.id);
        if (!row)
            fail(404, 'Test session not found.');
        const supplied = req.get('x-round-token');
        if (!(req.user && (row.author_id === req.user.id || req.user.role === 'admin')) && !(supplied && hash(supplied) === row.token))
            fail(403, 'This test session is private.');
        return row;
    };
    const createRound = async ({ version, userId = null, tester, source, messages, parentId = null, deskState, roundId: requestedRoundId, rawToken: requestedToken, collectionAssignment, frozenConfig, allocationLeaseToken }) => {
        if (isPassportVersion(version.id) && !deskState) fail(409, 'Start this reference from the interactive passport desk.');
        const raw = requestedToken || token();
        const roundId = requestedRoundId || id();
        const data = JSON.parse(version.data);
        validatePlayable(data);
        const initial = messages || [{ id: id(), role: 'assistant', content: data.opening, createdAt: Date.now(), opening: true }];
        const config = frozenConfig || safeConfig();
        const roundValues = [roundId, hash(raw), version.level_id, version.id, userId, source, version.data, JSON.stringify(config), tester, JSON.stringify(initial), Date.now(), parentId];
        const allocationGuard = allocationLeaseToken && collectionAssignment?.source === 'participant';
        const roundInsert = allocationGuard
          ? ['INSERT INTO rounds (id, token, level_id, version_id, author_id, source, data, config, tester, messages, started_at, parent_id) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM difficulty_collection_leases l JOIN difficulty_collections c ON c.id = l.collection_id JOIN difficulty_collection_links k ON k.id = ? AND k.collection_id = c.id WHERE l.collection_id = ? AND l.token = ? AND l.expires > ? AND c.status = ? AND k.revoked = 0 AND k.expires > ?)', ...roundValues, collectionAssignment.linkId, collectionAssignment.collectionId, allocationLeaseToken, Date.now(), 'active', Date.now()]
          : ['INSERT INTO rounds (id, token, level_id, version_id, author_id, source, data, config, tester, messages, started_at, parent_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', ...roundValues];
        const statements = [roundInsert];
        if (deskState) statements.push(allocationGuard
          ? ['INSERT INTO passport_sessions (round_id, state) SELECT ?, ? WHERE EXISTS (SELECT 1 FROM rounds WHERE id = ?)', roundId, JSON.stringify(deskState), roundId]
          : ['INSERT INTO passport_sessions VALUES (?, ?)', roundId, JSON.stringify(deskState)]);
        if (collectionAssignment) statements.push(allocationGuard
          ? ['INSERT INTO difficulty_collection_assignments (id, collection_id, round_id, profile_id, profile_snapshot, source, parent_id, link_id, start_key_hash, consent_at, consent_version, assigned_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM rounds WHERE id = ?)', collectionAssignment.id, collectionAssignment.collectionId, roundId, collectionAssignment.profileId, JSON.stringify(collectionAssignment.profileSnapshot), collectionAssignment.source, collectionAssignment.parentId ?? parentId, collectionAssignment.linkId, collectionAssignment.startKeyHash, collectionAssignment.consentAt, collectionAssignment.consentVersion, collectionAssignment.assignedAt, roundId]
          : ['INSERT INTO difficulty_collection_assignments (id, collection_id, round_id, profile_id, profile_snapshot, source, parent_id, link_id, start_key_hash, consent_at, consent_version, assigned_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', collectionAssignment.id, collectionAssignment.collectionId, roundId, collectionAssignment.profileId, JSON.stringify(collectionAssignment.profileSnapshot), collectionAssignment.source, collectionAssignment.parentId ?? parentId, collectionAssignment.linkId, collectionAssignment.startKeyHash, collectionAssignment.consentAt, collectionAssignment.consentVersion, collectionAssignment.assignedAt]);
        const results = await batch(statements);
        if (!results[0].changes) fail(409, 'This collection is no longer accepting attempts. Retry with the same start key if the attempt was already accepted.');
        return { ...publicRound(await get('SELECT * FROM rounds WHERE id = ?', roundId)), accessToken: raw };
    };
    app.get('/api/bootstrap', async (req, res) => res.json({ needsSetup: !await get('SELECT id FROM users LIMIT 1'), privateEntry: Boolean(ownerKey), user: publicUser(req.user), tutorialDone: Boolean(req.user && await get('SELECT user_id FROM onboarding WHERE user_id = ? AND version >= ?', req.user.id, 1)), model: { model: provider.model, connected: Boolean(provider.apiKey), provider: new URL(provider.baseUrl).hostname } }));
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
    app.get('/api/team', member, async (req, res) => res.json(await all('SELECT id, name, email, role FROM users ORDER BY created_at')));
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
    app.get('/api/enter/:token', async (req, res) => { await sharedLink(req.params.token); res.json({ role: 'editor' }); });
    app.post('/api/enter/:token', authThrottle, async (req, res) => {
      const link = await sharedLink(req.params.token);
      const name = z.string().trim().min(1).max(70).parse(req.body.name);
      if (req.user) return res.json({ user: publicUser(req.user) });
      const user = { id: id(), name, email: `${id()}@workshop.invalid`, password: 'link-only', role: 'editor' };
      await run('INSERT INTO users VALUES (?, ?, ?, ?, ?, ?)', user.id, user.name, user.email, user.password, user.role, Date.now());
      await enter(res, user, link.id);
    });
    app.get('/api/workshop-links', member, admin, async (req, res) => res.json((await all('SELECT id, created_at AS "createdAt", expires, revoked FROM workshop_links ORDER BY created_at DESC')).map(link => ({ ...link, ...(link.id === 'initial-workshop-link' && sharingKey && !link.revoked && link.expires > Date.now() ? { path: `/enter/${sharingKey}` } : {}) }))));
    app.post('/api/workshop-links', member, admin, async (req, res) => {
      const raw = token(); const linkId = id(); const expires = Date.now() + 30 * 86400000;
      await run('INSERT INTO workshop_links (id, token, created_at, expires) VALUES (?, ?, ?, ?)', linkId, hash(raw), Date.now(), expires);
      res.json({ id: linkId, path: `/enter/${raw}`, expires });
    });
    app.delete('/api/workshop-links/:id', member, admin, async (req, res) => {
      await run('UPDATE workshop_links SET revoked = 1 WHERE id = ?', req.params.id); res.json({ ok: true });
    });
    app.post('/api/invites', member, admin, async (req, res) => {
        const raw = token();
        const inviteId = id();
        await run('INSERT INTO invites (id, token, role, expires) VALUES (?, ?, ?, ?)', inviteId, hash(raw), 'editor', Date.now() + 7 * 86400000);
        res.json({ id: inviteId, path: `/join/${raw}` });
    });
    app.get('/api/levels', member, async (req, res) => {
      const rows = await all('SELECT levels.*, users.name AS owner, (SELECT COUNT(*) FROM versions WHERE level_id = levels.id) AS versions, (SELECT COUNT(*) FROM rounds WHERE level_id = levels.id) AS attempts FROM levels JOIN users ON users.id = levels.owner_id ORDER BY updated_at DESC');
      res.json(rows.map(row => ({ id: row.id, draft: JSON.parse(row.draft), revision: row.revision, status: row.status, ownerId: row.owner_id, owner: row.owner, updatedAt: row.updated_at, versions: row.versions, attempts: row.attempts })));
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
        res.json({ level: playerLevel(JSON.parse(v.data)), version: v.number, connected: Boolean(provider.apiKey) });
    });
    app.post('/api/play/:token', async (req, res) => {
        if (!provider.apiKey)
            fail(503, 'The target model is not connected yet. Ask the level author to connect it.');
        const tester = z.string().trim().min(1).max(70).parse(req.body.tester);
        res.status(201).json(await createRound({ version: await publicLink(req.params.token), tester, source: 'blind' }));
    });
    app.post('/api/levels/:id/rounds', member, async (req, res) => {
        const v = await versionRow(z.string().parse(req.body.versionId));
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
    const withRoundLock = async (req, action) => {
        const initial = await accessRound(req);
        const lease = token(); const now = Date.now();
        const claimed = await run('INSERT INTO round_locks VALUES (?, ?, ?) ON CONFLICT(round_id) DO UPDATE SET token = excluded.token, expires = excluded.expires WHERE round_locks.expires <= ?', initial.id, lease, now + 45000, now);
        if (!claimed.changes) fail(409, 'Wait for the current reply before changing this conversation.');
        try { return await action(await accessRound(req), lease); }
        finally { await run('DELETE FROM round_locks WHERE round_id = ? AND token = ?', initial.id, lease); }
    };
    const collectionModels = createCollectionModelServices({ store, provider, completion });
    app.post('/api/rounds/:id/messages', async (req, res) => withRoundLock(req, async (row, lease) => {
        if (isPassportVersion(row.version_id)) fail(409, 'Continue this interview at the interactive reference desk.');
        const content = z.string().trim().min(1).max(4000).parse(req.body.content);
        if (row.ended_at || Date.now() >= row.started_at + JSON.parse(row.data).duration * 1000)
            fail(409, 'The conversation has ended. Submit your answer or start a fresh test.');
        const messages = JSON.parse(row.messages);
        if (messages.filter(m => m.role === 'user').length >= 40)
            fail(409, 'This test has reached its 40-turn limit.');
        const config = JSON.parse(row.config);
        const collectionSystem = await collectionModels.systemForRound(row);
        if (!collectionSystem && config.baseUrl !== provider.baseUrl)
            fail(409, 'The provider changed since this test started. Start a fresh test.');
            const playerMessage = { id: id(), role: 'user', content, createdAt: Date.now() };
            const data = JSON.parse(row.data);
            const system = collectionSystem || compilePrompt(data);
            const { result, callId } = await collectionModels.request({ row, system, messages: [...messages, playerMessage], temperature: data.temperature });
            const next = [...messages, playerMessage, { id: id(), role: 'assistant', content: result.text, createdAt: Date.now(), latencyMs: result.latencyMs, usage: result.usage, model: result.model }];
            const saved = await collectionModels.finish({ row, lease, messages: next, callId, result });
            if (!saved) fail(409, 'This reply took too long to save. Retry your message.');
            res.json(publicRound(await get('SELECT * FROM rounds WHERE id = ?', row.id)));
    }));
    app.post('/api/rounds/:id/hint', async (req, res) => withRoundLock(req, async row => {
        if (isPassportVersion(row.version_id)) fail(409, 'Use the hints at the interactive reference desk.');
        const data = JSON.parse(row.data);
        if (row.ended_at || Date.now() >= row.started_at + data.duration * 1000)
            fail(409, 'This conversation has ended.');
        if (row.hints_used >= data.hints.length)
            fail(400, 'There are no more hints.');
        const messages = [...JSON.parse(row.messages), { id: id(), role: 'hint', content: data.hints[row.hints_used], createdAt: Date.now() }];
        await run('UPDATE rounds SET hints_used = hints_used + 1, messages = ? WHERE id = ?', JSON.stringify(messages), row.id);
        res.json(publicRound(await get('SELECT * FROM rounds WHERE id = ?', row.id)));
    }));
    app.post('/api/rounds/:id/submit', async (req, res) => withRoundLock(req, async row => {
        if (isPassportVersion(row.version_id)) fail(409, 'Stamp and file this case at the interactive reference desk.');
        if (row.ended_at)
            fail(409, 'This answer has already been submitted.');
        const answer = z.string().trim().min(1).max(4000).parse(req.body.answer);
        await run('UPDATE rounds SET answer = ?, ended_at = ? WHERE id = ?', answer, Date.now(), row.id);
        res.json(publicRound(await get('SELECT * FROM rounds WHERE id = ?', row.id)));
    }));
    app.post('/api/rounds/:id/branch', member, async (req, res) => {
        const row = await accessRound(req);
        if (isPassportVersion(row.version_id)) fail(409, 'Replay this reference at the interactive desk.');
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
        const rows = req.query.levelId ? await all('SELECT * FROM rounds WHERE level_id = ? AND NOT EXISTS (SELECT 1 FROM difficulty_collection_assignments WHERE round_id = rounds.id) ORDER BY started_at DESC LIMIT 200', String(req.query.levelId)) : await all('SELECT * FROM rounds WHERE NOT EXISTS (SELECT 1 FROM difficulty_collection_assignments WHERE round_id = rounds.id) ORDER BY started_at DESC LIMIT 200');
        res.json(await Promise.all(rows.map(async row => ({ ...publicRound(row), version: (await versionRow(row.version_id)).number, review: await get('SELECT outcome, note, evidence FROM reviews WHERE round_id = ?', row.id) || null }))));
    });
    app.get('/api/attempts/:id', member, async (req, res) => {
        const row = await get('SELECT * FROM rounds WHERE id = ?', req.params.id);
        if (!row)
            fail(404, 'Test not found.');
        const assignment = await get('SELECT source FROM difficulty_collection_assignments WHERE round_id = ?', row.id);
        if (assignment?.source === 'participant') fail(403, 'Review participant attempts from their collection to keep collection context attached.');
        const desk = isPassportVersion(row.version_id) ? await get('SELECT state FROM passport_sessions WHERE round_id = ?', row.id) : null;
        res.json({ ...publicRound(row), ...(desk ? { desk: JSON.parse(desk.state) } : {}), data: JSON.parse(row.data), config: JSON.parse(row.config), version: (await versionRow(row.version_id)).number, parentId: row.parent_id, review: await get('SELECT reviews.*, users.name AS reviewer FROM reviews JOIN users ON users.id = reviews.reviewer_id WHERE round_id = ?', row.id) || null });
    });
    app.post('/api/attempts/:id/review', member, async (req, res) => {
        const row = await get('SELECT * FROM rounds WHERE id = ?', req.params.id);
        if (!row)
            fail(404, 'Test not found.');
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
        const assignment = await get('SELECT source FROM difficulty_collection_assignments WHERE round_id = ?', row.id);
        if (assignment?.source === 'participant') fail(403, 'Participant attempts do not expose their protection prompt.');
        const messages = JSON.parse(row.messages).filter(m => ['user', 'assistant'].includes(m.role));
        const lastQuestion = messages.findLast(m => m.role === 'user');
        res.json({ system: (await collectionModels.systemForRound(row) || compilePrompt(JSON.parse(row.data))) + (lastQuestion?.deskContext ? `\n\nVERIFIED DESK OBSERVATIONS\n${lastQuestion.deskContext}` : ''), config: JSON.parse(row.config), messages });
    });
    app.get('/api/levels/:id/prompt', member, async (req, res) => res.json({ system: compilePrompt(JSON.parse((await levelRow(req.params.id)).draft)), config: safeConfig() }));
    addOrchestrationRoutes(app, { store, provider, completion });
    addCollectionRoutes(app, { store, provider, member, owner, versionRow, createRound });
    addPassportRoutes(app, { store, provider, completion, member, createRound, accessRound, withRoundLock, publicRound, addDraft, researchWorlds, researchWorldId, collectionModels });
    app.use('/api', async (req, res) => res.status(404).json({ error: 'Endpoint not found.' }));
    app.use(async (error, req, res, next) => {
        if (error instanceof z.ZodError)
            return res.status(400).json({ error: error.issues.map(i => `${i.path.join('.') || 'Input'}: ${i.message}`).join('; ') });
        const status = error.status || 500;
        if (status === 500)
            console.error('Request failed:', error.message);
        res.status(status).json({ error: status === 500 ? 'The request could not be completed.' : error.message });
    });
    return { app, store };
}
