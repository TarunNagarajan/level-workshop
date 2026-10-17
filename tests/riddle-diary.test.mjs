import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createFixture } from './database-fixture.mjs';
import { applyDiaryAction, canonicalRiddleDiaryLevel, diaryObservations, ensureRiddleDiary, initialDiaryState, publicDiaryState, RIDDLE_DIARY_CURRENT_REVISION, RIDDLE_DIARY_LEVEL_ID, RIDDLE_DIARY_PROFILES, riddleDiaryLevel } from '../server/riddle-diary.mjs';
import { compilePrompt, seedLevels } from '../server/levels.mjs';

async function harness(options = {}) {
  const fixture = await createFixture({ recordingNoticeRequired: true, passportReviewEnabled: true, metricsEnabled: true, provider: { model: 'fixture', baseUrl: 'https://example.test/v1', apiKey: 'fixture' }, ...options });
  const server = fixture.app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}/api`;
  const request = async (path, { method = 'GET', body, cookie, token } = {}) => {
    const response = await fetch(origin + path, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(token ? { 'x-round-token': token } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  return { ...fixture, server, request, close: async () => { await new Promise(resolve => server.close(resolve)); await fixture.store.db.close(); } };
}

test('canonical R2 profiles preserve immutable R1 history and keep verified award/library context server-bound', async () => {
  let targetCalls = 0, judgeCalls = 0;
  const fixture = await harness({ completion: async input => {
    if (input.system.includes('independent reviewer')) {
      judgeCalls++;
      const payload = JSON.parse(input.messages[0].content), reply = payload.transcript.find(message => message.role === 'assistant' && message.evidenceLabel);
      assert.match(payload.secret, /opened the Chamber/); assert.match(payload.criteria, /orphanage/);
      return { text: JSON.stringify({ verdict: 'recovered', reason: 'Saved diary replies disclose Riddle opened the Chamber, framed Hagrid and Aragog, and feared returning to the orphanage.', evidence: [reply.evidenceLabel] }), model: input.config.model, latencyMs: 1, usage: 3 };
    }
    targetCalls++;
    assert.match(input.system, /VERIFIED OBJECT OBSERVATIONS/);
    if (targetCalls === 1) assert.match(input.system, /Riddle’s Special Services to the School award/);
    assert.match(input.system, /Hermione identified a Basilisk, not a spider/);
    assert.match(input.system, /Stay within the supplied Chamber of Secrets facts/);
    assert.match(input.system, /CURRENTLY PRESENTED BESIDE THE DIARY/);
    assert.match(input.system, /RECENT SCENE ACTIONS/);
    return { text: 'I opened the Chamber and controlled its Basilisk. I blamed Hagrid and his spider, Aragog, to protect myself. I could not risk Hogwarts closing and being sent back to the orphanage.', model: input.config.model, latencyMs: 1, usage: 12 };
  } });
  const { store, request } = fixture;
  try {
    const owner = await request('/setup', { method: 'POST', body: { name: 'Owner', email: 'diary-owner@example.test', password: 'long-test-password' } }), cookie = owner.cookie;
    const legacyRows = [], createdAt = Date.now();
    await store.run('INSERT INTO levels (id,owner_id,draft,created_at,updated_at) VALUES (?,NULL,?,?,?)', RIDDLE_DIARY_LEVEL_ID, JSON.stringify(riddleDiaryLevel('story', 1)), createdAt, createdAt);
    for (const [index, profile] of RIDDLE_DIARY_PROFILES.entries()) {
      const legacy = riddleDiaryLevel(profile.id, 1), id = `riddle-diary-${profile.id}-r1-${legacy.diaryProfile.snapshotHash.slice(0, 12)}`, data = JSON.stringify(legacy);
      await store.run('INSERT INTO versions (id,level_id,number,data,note,author_id,created_at) VALUES (?,?,?,?,?,NULL,?)', id, RIDDLE_DIARY_LEVEL_ID, index + 1, data, `Frozen R1 ${profile.id}`, createdAt);
      legacyRows.push({ id, data });
    }
    const previouslyDeployedR2 = riddleDiaryLevel('story', 1);
    previouslyDeployedR2.diaryProfile.revision = 2;
    previouslyDeployedR2.diaryScenario.profileRevision = 2;
    const oldMetadata = previouslyDeployedR2.diaryProfile;
    delete previouslyDeployedR2.diaryProfile;
    oldMetadata.snapshotHash = createHash('sha256').update(JSON.stringify(previouslyDeployedR2)).digest('hex');
    previouslyDeployedR2.diaryProfile = oldMetadata;
    const oldR2Json = JSON.stringify(previouslyDeployedR2);
    await store.run('INSERT INTO versions (id,level_id,number,data,note,author_id,created_at) VALUES (?,?,?,?,?,NULL,?)', 'legacy-riddle-diary-story-r2', RIDDLE_DIARY_LEVEL_ID, 5, oldR2Json, 'Previously deployed historical revision 2', createdAt);
    const config = await request('/diary', { cookie });
    assert.equal(config.status, 200); assert.equal(config.body.profiles.length, 4);
    assert.equal(config.body.profileRevision, 2);
    assert.equal(config.body.reviewEnabled, true);
    assert.deepEqual(config.body.profiles.map(profile => profile.id), ['story','standard','guarded','sealed']);
    const serializedConfiguration = JSON.stringify(config.body);
    assert.doesNotMatch(serializedConfiguration, /Aragog|orphanage|false accusation|secret/);
    const frozen = await ensureRiddleDiary(store);
    assert.equal(frozen.length, 4);
    const canonicalStory = frozen.map(row => JSON.parse(row.data)).find(profile => profile.diaryProfile.id === 'story');
    assert.equal(canonicalStory.diaryProfile.revision, 3, 'canonical scene marker takes precedence over a historical noncanonical revision 2');
    assert.equal((await store.get('SELECT data FROM versions WHERE id=?', 'legacy-riddle-diary-story-r2')).data, oldR2Json, 'pre-existing noncanonical revision remains byte-for-byte unchanged');
    const compiled = frozen.map(row => compilePrompt(JSON.parse(row.data)));
    assert.equal(new Set(compiled).size, 4);
    assert.equal(new Set(frozen.map(row => JSON.parse(row.data).diaryProfile.promptHash)).size, 4);
    assert.deepEqual((await ensureRiddleDiary(store)).map(row => row.id), frozen.map(row => row.id), 'reopening the diary reuses exact immutable prompt versions');
    for (const prior of legacyRows) assert.equal((await store.get('SELECT data FROM versions WHERE id=?', prior.id)).data, prior.data, `R1 version ${prior.id} is byte-for-byte unchanged`);
    const r1Hashes = {
      story: ['1813575e64839b269e75e3997b49afb08041d9d307ecc92b381b0b795dfadd8a', '28140d2fe351714bac65afeb57b46dedab0b91c25b66c2e0e88293388f69ce1e'],
      standard: ['6bfb8184680fd3e0f734c0e4207d1b4ac6e19b4e62e3d182bd911251a7573ed2', '9169f8d601c37e1e11de3a60d24919b8f4175fcf52487b41122b9100bde0826c'],
      guarded: ['6266cf9993ff3666100c32ddc3741e957c723c20d28ef4aaf9effdf1c5345061', 'bb6fbeaf3dbef774c3d9c9e3a5e0e4062db4b1b8b8f266101171f5f5588ece62'],
      sealed: ['63356e95f39445cd8747f39686ec1bb898b1ad790c3289c84a9dd09b677c5148', 'fb42e8351ddb27de9b2736aa397472ba265919f5cad0612bc50d059192af4a81'],
    };
    for (const profile of RIDDLE_DIARY_PROFILES) assert.deepEqual([riddleDiaryLevel(profile.id, 1).diaryProfile.promptHash, riddleDiaryLevel(profile.id, 1).diaryProfile.snapshotHash], r1Hashes[profile.id]);
    assert.equal(new Set(RIDDLE_DIARY_PROFILES.map(profile => canonicalRiddleDiaryLevel(profile.id).diaryProfile.snapshotHash)).size, 4);
    for (const row of frozen) {
      const data = JSON.parse(row.data);
      assert.equal(data.secret, JSON.parse(frozen[0].data).secret);
      assert.equal(data.criteria, JSON.parse(frozen[0].data).criteria);
      assert.ok(data.diaryScenario.sceneVersion === 2 && data.diaryProfile.revision >= 2);
      assert.match(data.systemPrompt, /Stay within the supplied Chamber of Secrets facts/);
      assert.match(data.systemPrompt, /never invent supporting letters, altered memories, school records, dates, named witnesses, spells, or new events/i);
      for (const field of ['briefing', 'opening', 'clues', 'temperature', 'duration', 'responseWords']) assert.equal(data[field], JSON.parse(frozen[0].data)[field], `profile ${data.diaryProfile.id} must share ${field}`);
      assert.match(data.systemPrompt, /Tom Riddle/);
    }
    assert.equal((await request('/diary/start', { method: 'POST', cookie, body: { profileId: 'standard' } })).status, 428);
    await request('/recording/acknowledge', { method: 'POST', cookie, body: { version: 'recording-notice-v1', accepted: true } });
    const design = await request('/diary/design', { cookie });
    assert.equal(design.status, 200); assert.equal(design.body.profiles.length, 4); assert.ok(design.body.profiles.every(profile => profile.compiledPrompt && profile.systemPrompt));
    assert.equal(design.body.profileRevision, 2); assert.equal(design.body.history.length, 9);
    assert.ok(design.body.history.some(item => item.profileRevision === 1 && /rearranged the memory/.test(item.criteria)));
    assert.ok(design.body.history.some(item => item.profileRevision === 2 && /Do not require an edited memory/.test(item.criteria)));
    const started = await request('/diary/start', { method: 'POST', cookie, body: { profileId: 'standard' } });
    assert.equal(started.status, 201);
    const round = started.body.round, capability = round.accessToken;
    assert.equal(round.source, 'diary-play'); assert.equal(round.diary.profileId, 'standard');
    assert.equal((await request('/diary/latest', { cookie })).body.round.id, round.id, 'latest diary read resumes an open play round');
    assert.doesNotMatch(JSON.stringify(round), /Aragog|orphanage|planned accusation/);
    assert.equal((await request('/levels/reference-riddle-diary', { cookie })).status, 404);
    assert.equal((await request(`/rounds/${round.id}/submit`, { method: 'POST', cookie, token: capability, body: { answer: 'a guessed truth' } })).status, 409);

    let state = started.body.state;
    assert.equal(state.sceneVersion, 2);
    const action = async (type, more = {}) => {
      const result = await request(`/diary/rounds/${round.id}/action`, { method: 'POST', cookie, token: capability, body: { actionId: crypto.randomUUID(), revision: state.revision, type, ...more } });
      assert.equal(result.status, 200, JSON.stringify(result.body)); state = result.body.state; return result;
    };
    await action('open_diary');
    const draftReport = await request(`/diary/rounds/${round.id}/action`, { method: 'POST', cookie, token: capability, body: { actionId: crypto.randomUUID(), revision: state.revision, type: 'read_report', objectId: 'report' } });
    assert.equal(draftReport.status, 400, 'an unshipped draft report action is not part of the public API');
    const uninspectedPresent = await request(`/diary/rounds/${round.id}/action`, { method: 'POST', cookie, token: capability, body: { actionId: crypto.randomUUID(), revision: state.revision, type: 'present_object', objectId: 'award' } });
    assert.equal(uninspectedPresent.status, 409, 'props cannot be presented before their observation is saved');
    await action('inspect_award');
    await action('inspect_library');
    await action('present_object', { objectId: 'award' });
    await action('present_object', { objectId: 'library' });
    assert.equal(state.awardInspected, true); assert.equal(state.libraryInspected, true);
    assert.equal(state.observations.length, 2);
    const stale = await request(`/diary/rounds/${round.id}/action`, { method: 'POST', cookie, token: capability, body: { actionId: crypto.randomUUID(), revision: 0, type: 'turn_page' } });
    assert.equal(stale.status, 409);
    const duplicateId = crypto.randomUUID(), duplicateAction = { actionId: duplicateId, revision: state.revision, type: 'turn_page' };
    const turned = await request(`/diary/rounds/${round.id}/action`, { method: 'POST', cookie, token: capability, body: duplicateAction });
    assert.equal(turned.status, 200); state = turned.body.state;
    const duplicate = await request(`/diary/rounds/${round.id}/action`, { method: 'POST', cookie, token: capability, body: duplicateAction });
    assert.equal(duplicate.body.state.revision, state.revision, 'replayed action IDs are idempotent');

    const submitted = await request(`/rounds/${round.id}/messages`, { method: 'POST', cookie, token: capability, body: { content: 'How do the award and the Basilisk clue fit your account?', requestId: 'abababab-abab-4bab-8bab-abababababab' } });
    assert.equal(submitted.status, 200);
    const reply = submitted.body.messages.find(message => message.role === 'assistant' && !message.opening);
    assert.ok(reply?.id);
    const journal = await store.get('SELECT * FROM durable_submissions WHERE id = ?', submitted.body.submissionId);
    assert.equal(journal.scenario_id, 'riddle-diary-v1'); assert.equal(journal.profile_id, 'standard');
    assert.match(journal.desk_context, /VERIFIED OBJECT OBSERVATIONS/); assert.match(journal.desk_context, /Riddle received an award for Special Services to the School/); assert.match(journal.desk_context, /Hermione identified a Basilisk, not a spider/);
    assert.deepEqual(JSON.parse(journal.presented), ['award','library']);
    assert.equal(journal.transcript_saved, 1); assert.equal(targetCalls, 1);
    assert.equal((await store.get('SELECT profile_id,source,status FROM metrics_model_calls WHERE round_id = ? ORDER BY started_at LIMIT 1', round.id)).profile_id, 'standard');

    await action('remove_object', { objectId: 'award' });
    const followup = await request(`/rounds/${round.id}/messages`, { method: 'POST', cookie, token: capability, body: { content: 'Why was Hogwarts staying open important to you?', requestId: 'efefefef-efef-4fef-8fef-efefefefefef' } });
    assert.equal(followup.status, 200, JSON.stringify(followup.body));
    const followupJournal = await store.get('SELECT * FROM durable_submissions WHERE id = ?', followup.body.submissionId);
    assert.deepEqual(JSON.parse(followupJournal.presented), ['library']);
    assert.match(followupJournal.desk_context, /Hermione identified a Basilisk, not a spider/);
    assert.match(followupJournal.desk_context, /CURRENTLY PRESENTED BESIDE THE DIARY[\s\S]*open library reference/);
    assert.doesNotMatch(followupJournal.desk_context.split('CURRENTLY PRESENTED BESIDE THE DIARY')[1].split('RECENT SCENE ACTIONS')[0], /award/);
    assert.equal(targetCalls, 2);

    await action('keep_reply', { replyId: reply.id });
    await action('remove_kept_reply', { replyId: reply.id });
    assert.equal(state.keptReplyIds.includes(reply.id), false, 'evidence remains editable before filing');
    await action('keep_reply', { replyId: reply.id });
    const invalidFile = await request(`/diary/rounds/${round.id}/file`, { method: 'POST', cookie, token: capability, body: { answer: 'I guessed the story earlier.', evidenceIds: [crypto.randomUUID()], revision: state.revision } });
    assert.equal(invalidFile.status, 400);
    const filed = await request(`/diary/rounds/${round.id}/file`, { method: 'POST', cookie, token: capability, body: { answer: 'Riddle opened the Chamber, blamed Hagrid and Aragog, and wanted to protect himself from returning to the orphanage.', evidenceIds: [reply.id], revision: state.revision } });
    assert.equal(filed.status, 200); assert.equal(filed.body.round.endedAt !== null, true);
    assert.equal((await request('/diary/active', { cookie })).body, null);
    assert.equal((await request('/diary/latest', { cookie })).body.round.id, round.id, 'latest diary read resumes the filed round');
    const ownerDiary = await request(`/attempts/${round.id}/diary`, { cookie });
    assert.equal(ownerDiary.status, 200); assert.equal(ownerDiary.body.actionEvents.at(-1).type, 'file');
    assert.ok(ownerDiary.body.actionEvents.every(event => event.at && !('content' in event) && !('prompt' in event)));
    const invite = await request('/invites', { method: 'POST', cookie, body: {} });
    const guest = await request(`/invite/${invite.body.path.split('/').at(-1)}`, { method: 'POST', body: { name: 'Member', email: 'diary-member@example.test', password: 'member-password-12345' } });
    const notOwner = await request(`/attempts/${round.id}/diary`, { cookie: guest.cookie });
    assert.equal(notOwner.status, 403);
    await request('/recording/acknowledge', { method: 'POST', cookie: guest.cookie, body: { version: 'recording-notice-v1', accepted: true } });
    assert.equal((await request('/diary/latest', { cookie: guest.cookie })).body, null, 'a member cannot see another account’s diary history');
    const blockedDiagnostic = await request('/diary/start', { method: 'POST', cookie: guest.cookie, body: { profileId: 'story', diagnostic: true } });
    assert.equal(blockedDiagnostic.status, 403, 'diagnostic trials must be restricted to the workspace owner');
    const diagnostic = await request('/diary/start', { method: 'POST', cookie, body: { profileId: 'story', diagnostic: true } });
    assert.equal(diagnostic.status, 201);
    assert.equal((await request('/diary/latest', { cookie })).body.round.id, round.id, 'diagnostic rounds are excluded from the owner play history');
    const review = await request(`/rounds/${round.id}/review`, { method: 'POST', cookie });
    assert.equal(review.status, 200); assert.equal(review.body.machineReview.verdict, 'recovered'); assert.equal(judgeCalls, 1);
    const cached = await request(`/rounds/${round.id}/review`, { cookie }); assert.equal(cached.body.machineReview.verdict, 'recovered'); assert.equal(judgeCalls, 1);
    assert.equal((await store.get('SELECT COUNT(*) AS total FROM metrics_model_calls WHERE round_id=? AND context_kind=?', round.id, 'judge')).total, 1);
    assert.equal((await request(`/attempts/${round.id}/prompt`, { cookie })).status, 403);
  } finally { await fixture.close(); }
});

test('diary owner and blind configuration report transcript review only when workspace review is enabled', async () => {
  const fixture = await harness({ passportReviewEnabled: false });
  try {
    const owner = await fixture.request('/setup', { method: 'POST', body: { name: 'Review setting owner', email: 'review-setting-owner@example.test', password: 'long-test-password' } });
    const config = await fixture.request('/diary', { cookie: owner.cookie });
    assert.equal(config.status, 200);
    assert.equal(config.body.reviewEnabled, false);
    const link = await fixture.request('/diary/links', { method: 'POST', cookie: owner.cookie, body: { profileId: 'story' } });
    assert.equal(link.status, 200);
    const blindConfig = await fixture.request(link.body.path);
    assert.equal(blindConfig.status, 200);
    assert.equal(blindConfig.body.reviewEnabled, false);
  } finally { await fixture.close(); }
});

test('canonical award/library actions are verified and deployed R1 actions remain isolated', () => {
  const fresh = initialDiaryState();
  assert.equal(fresh.sceneVersion, 2);
  const award = applyDiaryAction(fresh, { type: 'inspect_award', actionId: crypto.randomUUID(), revision: 0 }, []);
  assert.equal(award.awardInspected, true);
  assert.match(diaryObservations(award)[0], /Special Services to the School/);
  assert.throws(() => applyDiaryAction(award, { type: 'present_object', objectId: 'library', actionId: crypto.randomUUID(), revision: award.revision }, []), /Inspect the object/);
  const library = applyDiaryAction(award, { type: 'inspect_library', actionId: crypto.randomUUID(), revision: award.revision }, []);
  assert.match(diaryObservations(library)[1], /Basilisk, not a spider/);
  assert.throws(() => applyDiaryAction(library, { type: 'read_report', objectId: 'report', actionId: crypto.randomUUID(), revision: library.revision }, []), /Choose a valid diary action/);
  assert.throws(() => applyDiaryAction(library, { type: 'align_fragment', actionId: crypto.randomUUID(), revision: library.revision }, []), /earlier version/);
  assert.throws(() => applyDiaryAction(library, { type: 'open_letter', actionId: crypto.randomUUID(), revision: library.revision }, []), /not part of this diary scene/);

  const historical = { ...initialDiaryState(1), sceneVersion: undefined, fragmentAligned: false, revision: 0 };
  const oldAlignment = applyDiaryAction(historical, { type: 'align_fragment', actionId: crypto.randomUUID(), revision: 0 }, []);
  assert.equal(oldAlignment.fragmentAligned, true);
  assert.equal(publicDiaryState(historical).sceneVersion, 1);
  assert.match(diaryObservations(oldAlignment)[0], /aligned memory fragment/);
  assert.throws(() => applyDiaryAction(historical, { type: 'inspect_award', actionId: crypto.randomUUID(), revision: 0 }, []), /not part of this earlier diary scene/);
});

test('new workspace diary seed is canonical and replays make the newest play round authoritative', async () => {
  const seed = seedLevels[0];
  assert.equal(seed.secret, 'Riddle opened the Chamber of Secrets and falsely blamed Hagrid and Aragog. He wanted the attacks to stop without exposing himself, because closing Hogwarts would send him back to the orphanage.');
  assert.doesNotMatch(JSON.stringify({ briefing: seed.briefing, secret: seed.secret, opening: seed.opening, clues: seed.clues, hints: seed.hints }), /Dippet|letter|altered memory|rearranged memory|written sequence/i);
  assert.match(seed.systemPrompt, /never invent supporting letters, altered memories, school records, dates, named witnesses, spells, or new events/i);
  const fixture = await harness({ completion: async input => ({ text: 'I was honoured for Special Services to the School after Hagrid was blamed.', model: input.config.model, latencyMs: 1, usage: 1 }) });
  try {
    const owner = await fixture.request('/setup', { method: 'POST', body: { name: 'Replay owner', email: 'diary-replay-owner@example.test', password: 'long-test-password' } });
    await fixture.request('/recording/acknowledge', { method: 'POST', cookie: owner.cookie, body: { version: 'recording-notice-v1', accepted: true } });
    const roundA = await fixture.request('/diary/start', { method: 'POST', cookie: owner.cookie, body: { profileId: 'story' } });
    assert.equal(roundA.status, 201);
    await fixture.store.run('UPDATE rounds SET started_at=? WHERE id=?', Date.now() - 301_000, roundA.body.round.id);
    assert.equal((await fixture.request('/diary/active', { cookie: owner.cookie })).body.round.id, roundA.body.round.id, 'the current expired round remains resumable before replay');
    const roundB = await fixture.request('/diary/start', { method: 'POST', cookie: owner.cookie, body: { profileId: 'sealed' } });
    assert.equal(roundB.status, 201);
    assert.equal((await fixture.request('/diary/active', { cookie: owner.cookie })).body.round.id, roundB.body.round.id, 'the newly started replay supersedes the older expired round');
    const filed = await fixture.request(`/diary/rounds/${roundB.body.round.id}/file`, { method: 'POST', cookie: owner.cookie, token: roundB.body.round.accessToken, body: { answer: 'Riddle accepted the school award after Hagrid was blamed.', evidenceIds: [], revision: roundB.body.state.revision } });
    assert.equal(filed.status, 200);
    assert.equal((await fixture.request('/diary/active', { cookie: owner.cookie })).body, null, 'a filed latest round is not mistaken for an older active one');
    const config = await fixture.request('/diary', { cookie: owner.cookie });
    assert.equal(config.body.activeRoundId, null);
    const latest = await fixture.request('/diary/latest', { cookie: owner.cookie });
    assert.equal(latest.body.round.id, roundB.body.round.id);
    assert.equal(latest.body.round.answer, 'Riddle accepted the school award after Hagrid was blamed.');
  } finally { await fixture.close(); }
});

test('blind diary links require consent, preserve capability resume, and re-consent gates old rounds', async () => {
  const fixture = await harness({ completion: async input => ({ text: 'I kept the account as written.', model: input.config.model, latencyMs: 1, usage: 1 }) });
  try {
    const owner = await fixture.request('/setup', { method: 'POST', body: { name: 'Owner', email: 'diary-link@example.test', password: 'long-test-password' } }), cookie = owner.cookie;
    await fixture.request('/recording/acknowledge', { method: 'POST', cookie, body: { version: 'recording-notice-v1', accepted: true } });
    const link = await fixture.request('/diary/links', { method: 'POST', cookie, body: { profileId: 'guarded' } });
    assert.equal(link.status, 200);
    const token = link.body.path.split('/').at(-1);
    const page = await fixture.request(`/diary/play/${token}`);
    assert.equal(page.status, 200); assert.equal(page.body.profile.profileId, 'guarded'); assert.equal(page.body.profile.profileRevision, 2); assert.equal(page.body.profile.sceneVersion, 2);
    assert.doesNotMatch(JSON.stringify(page.body), /Aragog|orphanage|PROTECTED TRUTH/);
    assert.equal((await fixture.request(`/diary/play/${token}`, { method: 'POST', body: { tester: 'Guest' } })).status, 428);
    const started = await fixture.request(`/diary/play/${token}`, { method: 'POST', body: { tester: 'Guest', consent: true } });
    assert.equal(started.status, 201); assert.equal(started.body.round.source, 'diary-blind'); assert.equal(started.body.state.sceneVersion, 2);
    const round = started.body.round, capability = round.accessToken;
    assert.equal((await fixture.request(`/diary/rounds/${round.id}`, { token: capability })).body.state.revision, 0);
    assert.equal((await fixture.request(`/rounds/${round.id}/recording`, { token: capability })).body.accepted, true);
    await fixture.store.run('UPDATE rounds SET recording_accepted_at=NULL,recording_notice_version=NULL WHERE id=?', round.id);
    assert.equal((await fixture.request(`/rounds/${round.id}/messages`, { method: 'POST', token: capability, body: { content: 'Question before re-accepting', requestId: 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd' } })).status, 428);
    assert.deepEqual((await fixture.request(`/rounds/${round.id}/recording`, { method: 'POST', token: capability, body: { version: 'recording-notice-v1', accepted: true } })).body, { accepted: true, version: 'recording-notice-v1' });
    const accepted = await fixture.request(`/rounds/${round.id}/messages`, { method: 'POST', token: capability, body: { content: 'Question after re-accepting', requestId: 'dededede-dede-4ede-8ede-dededededede' } });
    assert.equal(accepted.status, 200);
  } finally { await fixture.close(); }
});

test('frozen legacy blind links cannot start new rounds but retain saved receipt access', async () => {
  const fixture = await harness();
  const { store, request } = fixture;
  try {
    const owner = await request('/setup', { method: 'POST', body: { name: 'Owner', email: 'legacy-diary-link@example.test', password: 'long-test-password' } });
    const versions = await ensureRiddleDiary(store);
    const legacyData = riddleDiaryLevel('story', 1), legacyId = 'riddle-diary-frozen-legacy-r1';
    await store.run('INSERT INTO versions (id,level_id,number,data,note,author_id,created_at) VALUES (?,?,?,?,?,NULL,?)', legacyId, RIDDLE_DIARY_LEVEL_ID, 50, JSON.stringify(legacyData), 'Frozen earlier workshop profile', Date.now());
    const rawLink = 'legacy-frozen-link-token-0123456789-abcdefghijklmnopqrstuv';
    const rawReceipt = 'legacy-saved-round-token-0123456789-abcdefghijklmnopqrs';
    const tokenHash = value => createHash('sha256').update(value).digest('hex');
    await store.run('INSERT INTO links (id,token,version_id,created_at,expires) VALUES (?,?,?,?,?)', 'legacy-diary-link', tokenHash(rawLink), legacyId, Date.now(), Date.now() + 60_000);
    const config = await request(`/diary/play/${rawLink}`);
    assert.equal(config.status, 200); assert.equal(config.body.profile.sceneVersion, 1); assert.match(config.body.profile.description, /Focused questions/);
    const rejected = await request(`/diary/play/${rawLink}`, { method: 'POST', body: { tester: 'Guest', consent: true } });
    assert.equal(rejected.status, 409); assert.match(rejected.body.error, /current diary link/i);
    assert.equal((await store.get('SELECT COUNT(*) AS count FROM rounds WHERE source=?', 'diary-blind')).count, 0, 'rejected legacy start creates no round or model request');

    const roundId = 'legacy-diary-saved-receipt';
    const messages = [{ id: 'legacy-opening', role: 'assistant', content: legacyData.opening, createdAt: Date.now(), opening: true }];
    await store.run('INSERT INTO rounds (id,token,level_id,version_id,author_id,source,data,config,tester,messages,started_at,recording_accepted_at,recording_notice_version) VALUES (?,?,?,?,NULL,?,?,?,?,?,?,?,?)', roundId, tokenHash(rawReceipt), RIDDLE_DIARY_LEVEL_ID, legacyId, 'diary-blind', JSON.stringify(legacyData), JSON.stringify({ model: 'fixture' }), 'Earlier guest', JSON.stringify(messages), Date.now(), Date.now(), 'recording-notice-v1');
    await store.run('INSERT INTO diary_sessions (round_id,state) VALUES (?,?)', roundId, JSON.stringify(initialDiaryState(1)));
    const receipt = await request(`/diary/rounds/${roundId}`, { token: rawReceipt });
    assert.equal(receipt.status, 200); assert.equal(receipt.body.state.sceneVersion, 1); assert.equal(receipt.body.diary.sceneVersion, 1);
    assert.equal((await request(`/rounds/${roundId}/recording`, { token: rawReceipt })).body.accepted, true);
  } finally { await fixture.close(); }
});

test('PGlite preserves frozen diary state, action history, and private owner reads', async () => {
  const fixture = await harness({ adapter: 'pglite', completion: async input => ({ text: 'A saved diary reply.', model: input.config.model, latencyMs: 1, usage: 1 }) });
  try {
    const owner = await fixture.request('/setup', { method: 'POST', body: { name: 'Owner', email: 'diary-pg@example.test', password: 'long-test-password' } }), cookie = owner.cookie;
    await fixture.request('/recording/acknowledge', { method: 'POST', cookie, body: { version: 'recording-notice-v1', accepted: true } });
    const config = await fixture.request('/diary', { cookie });
    assert.equal(config.status, 200); assert.equal(config.body.profiles.length, 4);
    const started = await fixture.request('/diary/start', { method: 'POST', cookie, body: { profileId: 'story' } });
    assert.equal(started.status, 201);
    const { round, state } = started.body;
    const changed = await fixture.request(`/diary/rounds/${round.id}/action`, { method: 'POST', cookie, token: round.accessToken, body: { actionId: crypto.randomUUID(), revision: state.revision, type: 'inspect_award' } });
    assert.equal(changed.status, 200); assert.equal(changed.body.state.observations.length, 1);
    const prompt = await fixture.request(`/rounds/${round.id}/messages`, { method: 'POST', cookie, token: round.accessToken, body: { content: 'Why was the award given?', requestId: '12121212-1212-4212-8212-121212121212' } });
    assert.equal(prompt.status, 200);
    const reply = prompt.body.messages.find(message => message.role === 'assistant' && !message.opening);
    await fixture.store.run('UPDATE rounds SET started_at=? WHERE id=?', Date.now() - 301_000, round.id);
    const afterTime = await fixture.request(`/diary/rounds/${round.id}/action`, { method: 'POST', cookie, token: round.accessToken, body: { actionId: crypto.randomUUID(), revision: changed.body.state.revision, type: 'inspect_library' } });
    assert.equal(afterTime.status, 409, 'scene actions stop after the five-minute round deadline');
    const kept = await fixture.request(`/diary/rounds/${round.id}/action`, { method: 'POST', cookie, token: round.accessToken, body: { actionId: crypto.randomUUID(), revision: changed.body.state.revision, type: 'keep_reply', replyId: reply.id } });
    assert.equal(kept.status, 200, 'saved target replies can still be selected as evidence after time expires');
    const removed = await fixture.request(`/diary/rounds/${round.id}/action`, { method: 'POST', cookie, token: round.accessToken, body: { actionId: crypto.randomUUID(), revision: kept.body.state.revision, type: 'remove_kept_reply', replyId: reply.id } });
    assert.equal(removed.status, 200, 'evidence remains editable after time expires');
    const reKept = await fixture.request(`/diary/rounds/${round.id}/action`, { method: 'POST', cookie, token: round.accessToken, body: { actionId: crypto.randomUUID(), revision: removed.body.state.revision, type: 'keep_reply', replyId: reply.id } });
    assert.equal(reKept.status, 200);
    const filed = await fixture.request(`/diary/rounds/${round.id}/file`, { method: 'POST', cookie, token: round.accessToken, body: { answer: 'I file my current findings.', evidenceIds: [reply.id], revision: reKept.body.state.revision } });
    assert.equal(filed.status, 200, 'filing remains available after the timer expires');
    const ownerDiary = await fixture.request(`/attempts/${round.id}/diary`, { cookie });
    assert.equal(ownerDiary.status, 200); assert.equal(ownerDiary.body.actionEvents[0].type, 'inspect_award');
    assert.equal(ownerDiary.body.actionEvents.at(-1).type, 'file'); assert.equal(ownerDiary.body.actionEvents.length, 5);
  } finally { await fixture.close(); }
});

test('diary filing does not return success if either guarded persistence update changes no row', async () => {
  let fileWriteMode = 'none';
  const fixture = await harness({ wrapStore: store => ({ ...store, batch: async statements => {
    if (fileWriteMode === 'none' && statements.length === 2 && statements[0][0].includes('UPDATE diary_sessions')) return [{ changes: 0 }, { changes: 0 }];
    if (fileWriteMode === 'partial' && statements.length === 2 && statements[0][0].includes('UPDATE diary_sessions')) return [store.run(statements[0][0], ...statements[0].slice(1)), { changes: 0 }];
    return await store.batch(statements);
  } }) });
  try {
    const owner = await fixture.request('/setup', { method: 'POST', body: { name: 'Owner', email: 'diary-write-failure@example.test', password: 'long-test-password' } }), cookie = owner.cookie;
    await fixture.request('/recording/acknowledge', { method: 'POST', cookie, body: { version: 'recording-notice-v1', accepted: true } });
    const started = await fixture.request('/diary/start', { method: 'POST', cookie, body: { profileId: 'standard' } });
    assert.equal(started.status, 201);
    const { round, state } = started.body;
    const body = { answer: 'A conclusion.', evidenceIds: [], revision: state.revision };
    const failed = await fixture.request(`/diary/rounds/${round.id}/file`, { method: 'POST', cookie, token: round.accessToken, body });
    assert.equal(failed.status, 409);
    assert.equal(JSON.parse((await fixture.store.get('SELECT state FROM diary_sessions WHERE round_id=?', round.id)).state).filed, false);
    assert.equal((await fixture.store.get('SELECT answer,ended_at FROM rounds WHERE id=?', round.id)).ended_at, null);
    fileWriteMode = 'partial';
    const partial = await fixture.request(`/diary/rounds/${round.id}/file`, { method: 'POST', cookie, token: round.accessToken, body });
    assert.equal(partial.status, 409, 'a partial save never returns a filed receipt');
    assert.equal((await fixture.store.get('SELECT answer,ended_at FROM rounds WHERE id=?', round.id)).ended_at, null);
    fileWriteMode = 'ok';
    const saved = await fixture.request(`/diary/rounds/${round.id}/file`, { method: 'POST', cookie, token: round.accessToken, body });
    assert.equal(saved.status, 200); assert.equal(saved.body.state.filed, true);
  } finally { await fixture.close(); }
});
