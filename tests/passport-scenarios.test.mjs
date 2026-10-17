import { test } from 'node:test';
import assert from 'node:assert/strict';
import { passengerScenarios } from '../server/passport-scenarios.mjs';
import { createFixture } from './database-fixture.mjs';
import { ensureRiddleDiary } from '../server/riddle-diary.mjs';

test('the ten immutable cases have aligned, inspectable facts and distinct secret-specific decisions', () => {
  assert.equal(passengerScenarios.length, 10);
  assert.equal(new Set(passengerScenarios.map(item => item.id)).size, 10);
  assert.ok(passengerScenarios.every(item => item.revision >= 2 && item.inspectionDate === '12 October 2026'));
  assert.ok(passengerScenarios.filter(item => item.expectedDecision === 'CLEAR').length >= 3);
  const facts = new Map(passengerScenarios.map(item => [item.id, `${JSON.stringify(item.documents)} ${item.level.briefing} ${item.level.clues} ${item.truth}`.toLowerCase()]));
  const has = (id, expected) => assert.ok(facts.get(id).includes(expected.toLowerCase()), `${id} must expose ${expected}`);

  const byId = new Map(passengerScenarios.map(item => [item.id, item]));
  assert.notEqual(byId.get('ticket-number-swap').documents.ticket.passportNumber, byId.get('ticket-number-swap').documents.passport.number);
  has('ticket-number-swap', 'PQ 104 228'); has('ticket-number-swap', 'PQ 104 882');
  assert.notEqual(byId.get('changed-surname').documents.ticket.name, byId.get('changed-surname').documents.passport.name);
  has('changed-surname', 'Mira Das'); has('changed-surname', 'Mira Sen');
  assert.equal(byId.get('expired-booklet').documents.passport.expires, '11 OCT 2026'); has('expired-booklet', '11 OCT 2026');
  assert.notEqual(byId.get('borrowed-return-ticket').documents.ticket.name, byId.get('borrowed-return-ticket').documents.passport.name);
  has('borrowed-return-ticket', 'Celia Morgan');
  has('concealed-work', 'North Quay Kitchens'); has('concealed-work', 'ONE WAY'); has('concealed-work', 'fictional exercise');
  assert.equal(byId.get('false-short-stay').documents.card.stay, 'Two nights'); has('false-short-stay', '11 NOV 2026');
  assert.equal(byId.get('misplaced-connection').documents.ticket.to, 'MANCHESTER'); has('misplaced-connection', 'DUBLIN');
  assert.equal(byId.get('repaired-laminate').uvIntact, false); has('repaired-laminate', 'authorized cover repair');
  assert.equal(byId.get('altered-birth-date').documents.passport.name, 'Colin Frost');
  assert.equal(byId.get('altered-birth-date').documents.card.birthHistory, 'Birth date amended from 04 MAY 2008 to 04 MAY 1998.');
  has('altered-birth-date', 'Colin Frost'); has('altered-birth-date', 'amended from 04 may 2008 to 04 may 1998');
  has('unreported-loss', 'Replacement booklet issued on 03 FEB 2025');

  for (const item of passengerScenarios) {
    assert.equal(Object.isFrozen(item), true);
    assert.equal(Object.isFrozen(item.documents), true);
    assert.equal(item.level.hints.length, 2);
    assert.ok(item.level.secret.length > 40);
    assert.ok(item.level.criteria.length > 40);
    assert.notEqual(item.expectedDecision, undefined);
  }
});

test('concurrent starts across two app instances allocate ten cases once, keep truth private, and retain the frozen case after reload', async () => {
  const options = { passportScenarioRotation: true, provider: { model: 'fixture-model', baseUrl: 'https://example.test/v1', apiKey: 'fixture-key' }, completion: async () => ({ text: 'I will answer after a focused question.', model: 'fixture-model', latencyMs: 1 }) };
  const first = await createFixture(options);
  const second = await createFixture({ ...options, store: first.store });
  const servers = [first.app.listen(0, '127.0.0.1'), second.app.listen(0, '127.0.0.1')];
  await Promise.all(servers.map(server => new Promise(resolve => server.once('listening', resolve))));
  const origins = servers.map(server => `http://127.0.0.1:${server.address().port}`);
  const request = async (origin, path, { method = 'GET', body, cookie, token } = {}) => {
    const response = await fetch(`${origin}/api${path}`, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(token ? { 'x-round-token': token } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  try {
    const setup = await fetch(`${origins[0]}/api/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Owner', email: 'scenario-owner@example.test', password: 'long-test-password' }) });
    assert.equal(setup.status, 200);
    const cookieHeader = setup.headers.get('set-cookie');
    assert.ok(cookieHeader, 'owner setup should create a session cookie');
    const ownerCookie = cookieHeader.split(';')[0];
    const config = await request(origins[0], '/reference', { cookie: ownerCookie });
    assert.equal(config.body.level.title, 'One last passenger');
    assert.equal(config.body.level.character, 'The passenger');
    const starts = await Promise.all(Array.from({ length: 10 }, (_, index) => request(origins[index % 2], '/reference/start', { method: 'POST', body: {}, cookie: ownerCookie })));
    for (const started of starts) assert.equal(started.status, 201);
    const versions = await Promise.all(starts.map(async item => (await first.store.get('SELECT version_id FROM rounds WHERE id = ?', item.body.round.id)).version_id));
    assert.equal(new Set(versions).size, 10);
    assert.deepEqual(new Set(versions.map(value => value.match(/^reference-passport-case-(.+)-v\d+$/)?.[1])), new Set(passengerScenarios.map(item => item.id)));
    for (const started of starts) {
      const serialized = JSON.stringify(started.body), version = (await first.store.get('SELECT version_id FROM rounds WHERE id = ?', started.body.round.id)).version_id, id = version.match(/^reference-passport-case-(.+)-v\d+$/)[1];
      assert.equal(started.body.round.versionId, 'reference-passport-case');
      assert.equal(started.body.round.level.title, 'One last passenger');
      assert.equal(started.body.round.level.character, 'The passenger');
      assert.match(started.body.round.level.briefing, /^Fictional inspection date: 12 October 2026\./);
      for (const scenario of passengerScenarios) assert.equal(serialized.includes(scenario.resultTitle), false, 'player-facing title must not reveal the case category');
      assert.equal(serialized.includes(passengerScenarios.find(item => item.id === id).level.secret), false, 'pre-file DTO must not expose protected truth');
      assert.equal(started.body.caseResult, undefined);
      const snapshot = await request(origins[1], `/reference/rounds/${started.body.round.id}`, { cookie: ownerCookie });
      assert.equal(snapshot.status, 200);
      assert.equal(snapshot.body.round.versionId, started.body.round.versionId);
      assert.deepEqual(snapshot.body.documents, started.body.documents);
    }
    const firstCase = starts.find((_, index) => versions[index].endsWith(`ticket-number-swap-v${passengerScenarios.find(item => item.id === 'ticket-number-swap').revision}`));
    const filed = await request(origins[1], `/reference/rounds/${firstCase.body.round.id}/finish`, { method: 'POST', body: { decision: 'CLEAR', finding: 'The numbers point to a reissued booking.', evidence: [] }, cookie: ownerCookie });
    assert.equal(filed.status, 200);
    assert.equal(filed.body.caseResult.expectedDecision, 'CLEAR');
    assert.equal(filed.body.caseResult.decisionCorrect, true);

    const source = await first.store.get('SELECT level_id, version_id FROM rounds WHERE id = ?', firstCase.body.round.id);
    const collection = await request(origins[0], '/collections', { method: 'POST', cookie: ownerCookie, body: { levelId: source.level_id, versionId: source.version_id } });
    assert.equal(collection.status, 201, JSON.stringify(collection.body));
    const link = await request(origins[0], `/collections/${collection.body.id}/links`, { method: 'POST', cookie: ownerCookie, body: {} });
    const raw = link.body.path.split('/').at(-1);
    const participantEntry = await request(origins[1], `/collect/${raw}`);
    assert.equal(participantEntry.body.level.title, 'One last passenger');
    assert.equal(participantEntry.body.level.character, 'The passenger');
    for (const scenario of passengerScenarios) assert.equal(JSON.stringify(participantEntry.body).includes(scenario.resultTitle), false);
  } finally {
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
    await first.store.db.close();
  }
});

test('ordinary level listing omits internal reference cases while retaining public scenario entries', async () => {
  const fixture = await createFixture({ passportScenarioRotation: true });
  const server = fixture.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const setup = await fetch(`http://127.0.0.1:${server.address().port}/api/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'List owner', email: 'list-owner@example.test', password: 'long-test-password' }) });
    const cookie = setup.headers.get('set-cookie').split(';')[0];
    await fetch(`http://127.0.0.1:${server.address().port}/api/reference`, { headers: { Cookie: cookie } });
    await ensureRiddleDiary(fixture.store);
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/levels`, { headers: { Cookie: cookie } });
    const rows = await response.json();
    const ids = rows.map(row => row.id);
    assert.equal(ids.some(id => id.startsWith('reference-passport-case-')), false);
    assert.equal(ids.some(id => id.startsWith('reference-passport-study-')), false);
    assert.equal(ids.includes('reference-riddle-diary'), false);
    assert.ok(ids.includes('reference-passport-desk'));
    assert.ok(rows.some(row => row.draft.title === "Harry Potter: Riddle's Diary"));
  } finally {
    await new Promise(resolve => server.close(resolve));
    await fixture.store.db.close();
  }
});
