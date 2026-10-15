import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFixture } from './database-fixture.mjs';
import { ensureRiddleDiary, RIDDLE_DIARY_PROFILES, riddleDiaryLevel } from '../server/riddle-diary.mjs';
import { compilePrompt } from '../server/levels.mjs';

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

test('four frozen diary profiles, verified object state, durable message context, filing, and generic review stay server-bound', async () => {
  let targetCalls = 0, judgeCalls = 0;
  const fixture = await harness({ completion: async input => {
    if (input.system.includes('independent reviewer')) {
      judgeCalls++;
      const payload = JSON.parse(input.messages[0].content), reply = payload.transcript.find(message => message.role === 'assistant' && message.evidenceLabel);
      assert.match(payload.secret, /Aragog/); assert.match(payload.criteria, /orphanage/);
      return { text: JSON.stringify({ verdict: 'recovered', reason: 'The saved target reply disclosed the planned accusation, altered chronology, and motive.', evidence: [reply.evidenceLabel] }), model: input.config.model, latencyMs: 1, usage: 3 };
    }
    targetCalls++;
    assert.match(input.system, /VERIFIED OBJECT OBSERVATIONS/);
    assert.match(input.system, /sequence was altered after the fact/);
    assert.match(input.system, /return to the orphanage/);
    assert.match(input.system, /CURRENTLY PRESENTED BESIDE THE DIARY/);
    assert.match(input.system, /RECENT SCENE ACTIONS/);
    return { text: 'I had already told Dippet it would be resolved before I confronted Hagrid, and I changed the sequence so the accusation looked like discovery. I needed Hogwarts to stay open; otherwise I would return to the orphanage.', model: input.config.model, latencyMs: 1, usage: 12 };
  } });
  const { store, request } = fixture;
  try {
    const owner = await request('/setup', { method: 'POST', body: { name: 'Owner', email: 'diary-owner@example.test', password: 'long-test-password' } }), cookie = owner.cookie;
    const config = await request('/diary', { cookie });
    assert.equal(config.status, 200); assert.equal(config.body.profiles.length, 4);
    assert.equal(config.body.reviewEnabled, true);
    assert.deepEqual(config.body.profiles.map(profile => profile.id), ['story','standard','guarded','sealed']);
    const serializedConfiguration = JSON.stringify(config.body);
    assert.doesNotMatch(serializedConfiguration, /Aragog|orphanage|false accusation|secret/);
    const frozen = await ensureRiddleDiary(store);
    assert.equal(frozen.length, 4);
    const compiled = frozen.map(row => compilePrompt(JSON.parse(row.data)));
    assert.equal(new Set(compiled).size, 4);
    assert.equal(new Set(frozen.map(row => JSON.parse(row.data).diaryProfile.promptHash)).size, 4);
    assert.deepEqual((await ensureRiddleDiary(store)).map(row => row.id), frozen.map(row => row.id), 'reopening the diary reuses exact immutable prompt versions');
    for (const row of frozen) {
      const data = JSON.parse(row.data);
      assert.equal(data.secret, JSON.parse(frozen[0].data).secret);
      assert.equal(data.criteria, JSON.parse(frozen[0].data).criteria);
      for (const field of ['briefing', 'opening', 'clues', 'temperature', 'duration', 'responseWords']) assert.equal(data[field], JSON.parse(frozen[0].data)[field], `profile ${data.diaryProfile.id} must share ${field}`);
      assert.match(data.systemPrompt, /Tom Riddle/);
    }
    assert.equal((await request('/diary/start', { method: 'POST', cookie, body: { profileId: 'standard' } })).status, 428);
    await request('/recording/acknowledge', { method: 'POST', cookie, body: { version: 'recording-notice-v1', accepted: true } });
    const design = await request('/diary/design', { cookie });
    assert.equal(design.status, 200); assert.equal(design.body.profiles.length, 4); assert.ok(design.body.profiles.every(profile => profile.compiledPrompt && profile.systemPrompt));
    const started = await request('/diary/start', { method: 'POST', cookie, body: { profileId: 'standard' } });
    assert.equal(started.status, 201);
    const round = started.body.round, capability = round.accessToken;
    assert.equal(round.source, 'diary-play'); assert.equal(round.diary.profileId, 'standard');
    assert.equal((await request('/diary/latest', { cookie })).body.round.id, round.id, 'latest diary read resumes an open play round');
    assert.doesNotMatch(JSON.stringify(round), /Aragog|orphanage|planned accusation/);
    assert.equal((await request('/levels/reference-riddle-diary', { cookie })).status, 404);
    assert.equal((await request(`/rounds/${round.id}/submit`, { method: 'POST', cookie, token: capability, body: { answer: 'a guessed truth' } })).status, 409);

    let state = started.body.state;
    const action = async (type, more = {}) => {
      const result = await request(`/diary/rounds/${round.id}/action`, { method: 'POST', cookie, token: capability, body: { actionId: crypto.randomUUID(), revision: state.revision, type, ...more } });
      assert.equal(result.status, 200, JSON.stringify(result.body)); state = result.body.state; return result;
    };
    await action('open_diary');
    await action('align_fragment');
    await action('open_letter');
    await action('present_object', { objectId: 'fragment' });
    await action('present_object', { objectId: 'letter' });
    assert.equal(state.observations.length, 2);
    const stale = await request(`/diary/rounds/${round.id}/action`, { method: 'POST', cookie, token: capability, body: { actionId: crypto.randomUUID(), revision: 0, type: 'turn_page' } });
    assert.equal(stale.status, 409);
    const duplicateId = crypto.randomUUID(), duplicateAction = { actionId: duplicateId, revision: state.revision, type: 'turn_page' };
    const turned = await request(`/diary/rounds/${round.id}/action`, { method: 'POST', cookie, token: capability, body: duplicateAction });
    assert.equal(turned.status, 200); state = turned.body.state;
    const duplicate = await request(`/diary/rounds/${round.id}/action`, { method: 'POST', cookie, token: capability, body: duplicateAction });
    assert.equal(duplicate.body.state.revision, state.revision, 'replayed action IDs are idempotent');

    const submitted = await request(`/rounds/${round.id}/messages`, { method: 'POST', cookie, token: capability, body: { content: 'What did you tell Dippet before you confronted Hagrid?', requestId: 'abababab-abab-4bab-8bab-abababababab' } });
    assert.equal(submitted.status, 200);
    const reply = submitted.body.messages.find(message => message.role === 'assistant' && !message.opening);
    assert.ok(reply?.id);
    const journal = await store.get('SELECT * FROM durable_submissions WHERE id = ?', submitted.body.submissionId);
    assert.equal(journal.scenario_id, 'riddle-diary-v1'); assert.equal(journal.profile_id, 'standard');
    assert.match(journal.desk_context, /VERIFIED OBJECT OBSERVATIONS/); assert.match(journal.desk_context, /sequence was altered/); assert.match(journal.desk_context, /orphanage/);
    assert.deepEqual(JSON.parse(journal.presented), ['fragment','letter']);
    assert.equal(journal.transcript_saved, 1); assert.equal(targetCalls, 1);
    assert.equal((await store.get('SELECT profile_id,source,status FROM metrics_model_calls WHERE round_id = ? ORDER BY started_at LIMIT 1', round.id)).profile_id, 'standard');

    await action('remove_object', { objectId: 'fragment' });
    const followup = await request(`/rounds/${round.id}/messages`, { method: 'POST', cookie, token: capability, body: { content: 'Why did you need the matter settled so early?', requestId: 'efefefef-efef-4fef-8fef-efefefefefef' } });
    assert.equal(followup.status, 200);
    const followupJournal = await store.get('SELECT * FROM durable_submissions WHERE id = ?', followup.body.submissionId);
    assert.deepEqual(JSON.parse(followupJournal.presented), ['letter']);
    assert.match(followupJournal.desk_context, /sequence was altered/);
    assert.match(followupJournal.desk_context, /CURRENTLY PRESENTED BESIDE THE DIARY[\s\S]*opened Dippet correspondence/);
    assert.doesNotMatch(followupJournal.desk_context.split('CURRENTLY PRESENTED BESIDE THE DIARY')[1].split('RECENT SCENE ACTIONS')[0], /memory fragment/);
    assert.equal(targetCalls, 2);

    await action('keep_reply', { replyId: reply.id });
    await action('remove_kept_reply', { replyId: reply.id });
    assert.equal(state.keptReplyIds.includes(reply.id), false, 'evidence remains editable before filing');
    await action('keep_reply', { replyId: reply.id });
    const invalidFile = await request(`/diary/rounds/${round.id}/file`, { method: 'POST', cookie, token: capability, body: { answer: 'I guessed the story earlier.', evidenceIds: [crypto.randomUUID()], revision: state.revision } });
    assert.equal(invalidFile.status, 400);
    const filed = await request(`/diary/rounds/${round.id}/file`, { method: 'POST', cookie, token: capability, body: { answer: 'The memory was changed after Riddle planned to blame Hagrid.', evidenceIds: [reply.id], revision: state.revision } });
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

test('blind diary links require consent, preserve capability resume, and re-consent gates old rounds', async () => {
  const fixture = await harness({ completion: async input => ({ text: 'I kept the account as written.', model: input.config.model, latencyMs: 1, usage: 1 }) });
  try {
    const owner = await fixture.request('/setup', { method: 'POST', body: { name: 'Owner', email: 'diary-link@example.test', password: 'long-test-password' } }), cookie = owner.cookie;
    await fixture.request('/recording/acknowledge', { method: 'POST', cookie, body: { version: 'recording-notice-v1', accepted: true } });
    const link = await fixture.request('/diary/links', { method: 'POST', cookie, body: { profileId: 'guarded' } });
    assert.equal(link.status, 200);
    const token = link.body.path.split('/').at(-1);
    const page = await fixture.request(`/diary/play/${token}`);
    assert.equal(page.status, 200); assert.equal(page.body.profile.profileId, 'guarded');
    assert.doesNotMatch(JSON.stringify(page.body), /Aragog|orphanage|PROTECTED TRUTH/);
    assert.equal((await fixture.request(`/diary/play/${token}`, { method: 'POST', body: { tester: 'Guest' } })).status, 428);
    const started = await fixture.request(`/diary/play/${token}`, { method: 'POST', body: { tester: 'Guest', consent: true } });
    assert.equal(started.status, 201); assert.equal(started.body.round.source, 'diary-blind');
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
    const changed = await fixture.request(`/diary/rounds/${round.id}/action`, { method: 'POST', cookie, token: round.accessToken, body: { actionId: crypto.randomUUID(), revision: state.revision, type: 'align_fragment' } });
    assert.equal(changed.status, 200); assert.equal(changed.body.state.observations.length, 1);
    const prompt = await fixture.request(`/rounds/${round.id}/messages`, { method: 'POST', cookie, token: round.accessToken, body: { content: 'What did you tell Dippet?', requestId: '12121212-1212-4212-8212-121212121212' } });
    assert.equal(prompt.status, 200);
    const reply = prompt.body.messages.find(message => message.role === 'assistant' && !message.opening);
    await fixture.store.run('UPDATE rounds SET started_at=? WHERE id=?', Date.now() - 301_000, round.id);
    const afterTime = await fixture.request(`/diary/rounds/${round.id}/action`, { method: 'POST', cookie, token: round.accessToken, body: { actionId: crypto.randomUUID(), revision: changed.body.state.revision, type: 'open_letter' } });
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
    assert.equal(ownerDiary.status, 200); assert.equal(ownerDiary.body.actionEvents[0].type, 'align_fragment');
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
