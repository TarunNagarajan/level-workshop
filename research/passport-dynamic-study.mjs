import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createFixture } from '../tests/database-fixture.mjs';
import { compilePrompt } from '../server/levels.mjs';
import { applyPassportAction, initialPassportState, passportContext, passportLevel, passportScenario, playerDocuments } from '../server/passport-reference.mjs';
import { auditDynamicEvidence } from './dynamic-evidence-audit.mjs';
import { passportEvidenceWorlds, passportPlayerEvidence } from './passport-dynamic-adapter.mjs';

const sourceFiles = ['server/passport-reference.mjs', 'server/world-bound-template.mjs', 'server/levels.mjs', 'research/dynamic-evidence-audit.mjs', 'research/passport-dynamic-adapter.mjs', 'research/passport-dynamic-study.mjs'];
const sourceHashes = Object.fromEntries(sourceFiles.map(name => [name, createHash('sha256').update(readFileSync(name)).digest('hex')]));
const audits = Object.fromEntries(['player', 'verifiedDesk'].map(boundary => [boundary,
  auditDynamicEvidence({ worlds: passportEvidenceWorlds({ boundary }), maxBeliefStates: 10000 })]));
for (const result of Object.values(audits)) {
  assert.equal(result.status, 'analyzed');
  assert.equal(result.adaptivePolicyStatus, 'guaranteed');
  assert.equal(result.initialPartitions[0].adaptiveWorstCaseActions, 2);
}
const projection = result => ({
  status: result.status, adaptivePolicyStatus: result.adaptivePolicyStatus,
  exploredBeliefStates: result.exploredBeliefStates, transitionEdges: result.transitionEdges,
  initialPartitions: result.initialPartitions,
  worlds: result.worlds.map(row => ({
    worldId: row.worldId, answer: row.answer, initialSufficient: row.initialSufficient,
    shortestDecision: row.shortestDecision, requiredOnEveryResolvingPath: row.requiredOnEveryResolvingPath,
    compareBypass: row.shortestDecisionWithout.compare,
  })),
});
const staticPrompt = compilePrompt(passportLevel);
const modelWorldConsistency = passportEvidenceWorlds().map(world => {
  const contradictions = [];
  if (world.scenario.documents.card.signature !== passportScenario.documents.card.signature && staticPrompt.includes('N. Vale')) contradictions.push('Static prompt still asserts the default N. Vale signature.');
  if (world.scenario.uvIntact !== passportScenario.uvIntact && staticPrompt.includes('UV thread is intact')) contradictions.push('Static prompt still asserts an intact UV thread.');
  return { worldId: world.id, consistentWithStaticPrompt: contradictions.length === 0, contradictions };
});
assert.equal(modelWorldConsistency.filter(row => !row.consistentWithStaticPrompt).length, 3);

const { app, store } = await createFixture({
  provider: { model: 'fixture-model', baseUrl: 'https://example.test/v1', apiKey: 'fixture-key' },
  completion: async () => ({ text: 'The documents are mine.', model: 'fixture-model', latencyMs: 1, usage: 1 }),
});
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const commands = {
  open: { action: 'open' }, turn: { action: 'turn' }, card: { action: 'card' },
  'lamp:uv': { action: 'lamp', value: 'uv' }, compare: { action: 'compare' },
  'move:passport': { action: 'move', object: 'passport', position: { x: 44, y: 58 } },
};
async function request(path, { method = 'GET', body, cookie, token } = {}) {
  const response = await fetch(`${origin}/api${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(token ? { 'x-round-token': token } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
}
let checkedStages = 0, checkedActions = 0;
try {
  const owner = await request('/setup', { method: 'POST', body: { name: 'Dynamic audit owner', email: 'dynamic-passport@example.test', password: 'long-test-password' } });
  assert.equal(owner.status, 200);
  const link = await request('/reference/links', { method: 'POST', body: {}, cookie: owner.cookie });
  assert.equal(link.status, 200);
  const blind = await request(link.body.path);
  assert.equal(blind.status, 200);
  assert.deepEqual(blind.body.documents, playerDocuments(initialPassportState()));
  const paths = [
    ['card', 'open', 'turn', 'lamp:uv', 'compare', 'move:passport'],
    ['open', 'move:passport', 'lamp:uv', 'card', 'compare', 'turn'],
  ];
  for (const path of paths) {
    const started = await request(link.body.path, { method: 'POST', body: { tester: 'Dynamic audit player' } });
    assert.equal(started.status, 201);
    const round = started.body.round, url = `/reference/rounds/${round.id}`;
    let local = initialPassportState();
    async function check(response) {
      assert.equal(response.status < 300, true);
      assert.equal(response.body.state.revision, local.revision);
      assert.deepEqual(response.body.documents, playerDocuments(local));
      assert.deepEqual(passportPlayerEvidence(response.body.state), passportPlayerEvidence(local));
      const desk = await request(`${url}/context`, { cookie: owner.cookie });
      assert.equal(desk.status, 200);
      assert.equal(desk.body.observations, passportContext(local));
      checkedStages++;
    }
    await check(started);
    for (const name of path) {
      const localResult = applyPassportAction(local, { revision: local.revision, ...commands[name] }, { id: `evidence-${local.revision}`, at: 0, scenario: passportScenario });
      const reply = await request(`${url}/action`, { method: 'POST', body: { revision: local.revision, ...commands[name] }, token: round.accessToken });
      local = localResult.state;
      assert.equal(reply.body.observation, localResult.observation);
      await check(reply);
      checkedActions++;
    }
  }
  const report = {
    boundary: 'Four counterfactual document states call the production physical reducer and player/verified-desk serializers. The variants now have separate local research routes; this reducer audit itself still checks the default HTTP route on two first-use action paths. The routed-world study separately checks four complete target requests. Excludes dialogue, filing, hints, repeat actions, image pixels, and client bundle.',
    databaseAdapter: process.env.TEST_DATABASE === 'postgres' ? 'PGlite PostgreSQL' : 'Node SQLite',
    sourceHashes, paths, checkedStages, checkedActions,
    playerAudit: projection(audits.player), verifiedDeskAudit: projection(audits.verifiedDesk),
    modelStaticPromptHash: createHash('sha256').update(staticPrompt).digest('hex'),
    modelWorldConsistency,
    modelFullRequestWarning: 'The unchanged public reference prompt contradicts three alternate worlds and is retained here as a negative control. Each local research route now uses a separate world-consistent level version, checked in passport-routed-worlds-study.mjs.',
  };
  const outputPath = process.env.TEST_DATABASE === 'postgres' ? 'research/passport-dynamic-study-postgres.json' : 'research/passport-dynamic-study.json';
  writeFileSync(outputPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ outputPath, databaseAdapter: report.databaseAdapter, checkedStages, checkedActions,
    playerBeliefStates: report.playerAudit.exploredBeliefStates, worstCaseActions: report.playerAudit.initialPartitions[0].adaptiveWorstCaseActions,
    staticPromptContradictions: modelWorldConsistency.filter(row => !row.consistentWithStaticPrompt).length }));
} finally {
  await new Promise(resolve => server.close(resolve));
  await store.db.close();
}
