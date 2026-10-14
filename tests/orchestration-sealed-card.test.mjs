import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFixture } from './database-fixture.mjs';

test('sealed observation creates a causal source event and separates diagnostic from scored handoffs', async () => {
  let wrongSource = false;
  let earlySourceReply = 'amber';
  const provider = { model: 'fixture-model', baseUrl: 'https://example.test/v1', apiKey: 'fixture-key' };
  const { app, store } = await createFixture({ provider, completion: async context => {
    let text;
    if (context.system.includes('The dispatch seal is closed.')) text = earlySourceReply;
    else if (context.system.includes('The opened dispatch seal shows ')) {
      const fact = context.system.includes('shows amber.') ? 'amber' : 'cobalt';
      text = wrongSource ? (fact === 'amber' ? 'cobalt' : 'amber') : fact;
    } else if (context.system.includes('Trusted seal fact: amber')) text = 'amber';
    else if (context.system.includes('Trusted seal fact: cobalt')) text = 'cobalt';
    else if (context.system.includes('\nSOURCE_A="amber"\nREQUIRED')) text = 'north';
    else if (context.system.includes('\nSOURCE_A="cobalt"\nREQUIRED')) text = 'south';
    else text = 'Awaiting color.';
    return { text, model: provider.model, latencyMs: 1, usage: 1 };
  } });
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}/api`;
  let cookie;
  const request = async (path, method = 'GET', body) => {
    const response = await fetch(origin + path, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json();
    cookie ||= response.headers.get('set-cookie')?.split(';')[0];
    return { status: response.status, body: value };
  };
  const good = response => { assert.ok(response.status >= 200 && response.status < 300, JSON.stringify(response)); return response.body; };
  try {
    good(await request('/setup', 'POST', { name: 'Sealed card owner', email: 'sealed-card@example.test', password: 'fixture-password' }));
    const config = good(await request('/orchestration/configs', 'POST', {}));
    const draft = { ...config.draft, task: 'Use only an observed seal and saved handoff.',
      contract: { edges: [{ sourceLane: 'A', targetLane: 'B', waitLabel: 'Awaiting color.', choices: [
        { source: 'amber', output: 'north' }, { source: 'cobalt', output: 'south' },
      ] }] },
      slots: [
        { id: 'A', name: 'Reader', systemPrompt: 'Read the dispatch seal only after a verified inspection. Reply with one color label.', temperature: 0 },
        { id: 'B', name: 'Decoder', systemPrompt: 'Use the saved source state.', temperature: 0 },
        { id: 'C', name: 'Observer', systemPrompt: 'Observe only.', temperature: 0 },
      ],
    };
    good(await request(`/orchestration/configs/${config.id}`, 'PUT', { revision: config.revision, draft }));
    const pairInput = { testInput: 'Dispatch case 7.', sourceLane: 'A', targetLane: 'B', sourceValues: ['amber', 'cobalt'], observationMode: 'sealed-card' };
    const newPair = () => request(`/orchestration/configs/${config.id}/world-pairs`, 'POST', pairInput).then(good);
    const earlyPair = await newPair();
    const earlyRun = earlyPair.runIds[0];
    const unopened = good(await request(`/orchestration/runs/${earlyRun}/world-pair`)).pair;
    assert.equal(unopened.factValue, null);
    assert.equal(unopened.observed, false);
    const early = good(await request(`/orchestration/runs/${earlyRun}/messages`, 'POST', { lane: 'A', content: 'Read the seal.' }));
    assert.equal(early.messages.at(-1).content, 'amber');
    assert.equal(early.messages.at(-1).publication.status, 'rejected');
    assert.match(early.messages.at(-1).context.system, /The dispatch seal is closed/);
    assert.equal((await request(`/orchestration/runs/${earlyRun}/board`, 'POST', { messageId: early.messages.at(-1).id, targets: ['B'] })).status, 409);
    earlySourceReply = 'Awaiting inspection.';
    const waiting = good(await request(`/orchestration/runs/${earlyPair.runIds[1]}/messages`, 'POST', { lane: 'A', content: 'Read the seal.' }));
    assert.equal(waiting.messages.at(-1).publication.status, 'waiting');
    const cleanPair = await newPair();
    const cleanRuns = await Promise.all(cleanPair.runIds.map(id => request(`/orchestration/runs/${id}`).then(good)));
    assert.deepEqual(cleanRuns.map(run => run.snapshot), [cleanRuns[0].snapshot, cleanRuns[0].snapshot]);
    for (const [index, runId] of cleanPair.runIds.entries()) {
      const closed = good(await request(`/orchestration/runs/${runId}/world-pair`)).pair;
      assert.equal(closed.factValue, null);
      const opened = good(await request(`/orchestration/runs/${runId}/objects/dispatch-seal/open`, 'POST', { factValue: index ? 'amber' : 'cobalt' }));
      assert.equal(opened.factValue, index ? 'cobalt' : 'amber', 'Client-supplied fact is ignored.');
      assert.equal(opened.eventSeq, 1);
      assert.equal((await request(`/orchestration/runs/${runId}/objects/dispatch-seal/open`, 'POST')).status, 409);
      const sourceRun = good(await request(`/orchestration/runs/${runId}/messages`, 'POST', { lane: 'A', content: 'Read the observed seal.' }));
      const source = sourceRun.messages.at(-1);
      assert.equal(source.content, index ? 'cobalt' : 'amber');
      assert.equal(source.publication.status, 'published');
      assert.equal(source.publication.sourceTruth, true);
      assert.equal(source.publication.scoreEligible, true);
      assert.equal(source.publication.observationEventSeq, 1);
      assert.match(source.context.system, /VERIFIED OBJECT OBSERVATION/);
      good(await request(`/orchestration/runs/${runId}/board`, 'POST', { messageId: source.id, targets: ['B'] }));
      const recipient = good(await request(`/orchestration/runs/${runId}/messages`, 'POST', { lane: 'B', content: 'Decode the shared seal.' }));
      assert.equal(recipient.messages.at(-1).publication.scoreEligible, true);
      const score = good(await request(`/orchestration/runs/${runId}/score-preview`));
      assert.equal(score.status, 'eligible');
      assert.equal(score.expected, index ? 'south' : 'north');
      assert.deepEqual((await request(`/orchestration/runs/${runId}/events`).then(good)).map(event => event.kind), ['observe', 'turn', 'share', 'turn']);
    }
    const cleanAudit = good(await request(`/orchestration/world-pairs/${cleanPair.pairId}/audit`, 'POST', { content: 'Decode the shared seal.' }));
    assert.equal(cleanAudit.status, 'source-true-necessary-handoff');
    assert.equal(cleanAudit.sourceAccess.identicalBeforeObservation, true);
    assert.equal(cleanAudit.sourceAccess.onlyFactDifference, true);
    assert.equal(cleanAudit.requestNecessity, true);
    assert.deepEqual(cleanAudit.worlds.map(world => world.observationValid), [true, true]);
    assert.deepEqual(cleanAudit.recipientUptake.map(item => [item.tested, item.bodyMatchesAuditedAfter, item.wholeLabelCorrect, item.scoreEligible]), [[true, true, true, true], [true, true, true, true]]);
    wrongSource = true;
    const falsePair = await newPair();
    for (const runId of falsePair.runIds) {
      good(await request(`/orchestration/runs/${runId}/objects/dispatch-seal/open`, 'POST'));
      const sourceRun = good(await request(`/orchestration/runs/${runId}/messages`, 'POST', { lane: 'A', content: 'Read the observed seal.' }));
      const source = sourceRun.messages.at(-1);
      assert.equal(source.publication.status, 'published');
      assert.equal(source.publication.sourceTruth, false);
      assert.equal(source.publication.scoreEligible, false);
      good(await request(`/orchestration/runs/${runId}/board`, 'POST', { messageId: source.id, targets: ['B'] }));
      const recipient = good(await request(`/orchestration/runs/${runId}/messages`, 'POST', { lane: 'B', content: 'Decode the shared seal.' }));
      assert.equal(recipient.messages.at(-1).publication.status, 'published');
      assert.equal(recipient.messages.at(-1).publication.scoreEligible, false);
      assert.equal((await request(`/orchestration/runs/${runId}/score-preview`).then(good)).status, 'diagnostic-only');
    }
    const falseAudit = good(await request(`/orchestration/world-pairs/${falsePair.pairId}/audit`, 'POST', { content: 'Decode the shared seal.' }));
    assert.equal(falseAudit.requestNecessity, true);
    assert.equal(falseAudit.sourceTruth, false);
    assert.deepEqual(falseAudit.worlds.map(world => world.observationValid), [true, true]);
    assert.equal(falseAudit.status, 'fails-audit');
    assert.deepEqual(falseAudit.recipientUptake.map(item => [item.tested, item.bodyMatchesAuditedAfter, item.wholeLabelCorrect, item.scoreEligible]), [[true, true, false, false], [true, true, false, false]]);
    const event = (await store.get('SELECT payload FROM orchestration_events WHERE run_id = ? AND seq = 1', cleanPair.runIds[0]));
    await store.run('UPDATE orchestration_events SET payload = ? WHERE run_id = ? AND seq = 1', JSON.stringify({ ...JSON.parse(event.payload), factValue: 'cobalt' }), cleanPair.runIds[0]);
    const tampered = good(await request(`/orchestration/world-pairs/${cleanPair.pairId}/audit`, 'POST', { content: 'Decode the shared seal.' }));
    assert.equal(tampered.status, 'fails-audit');
    assert.equal(tampered.worlds[0].observationValid, false);
    assert.equal((await request(`/orchestration/runs/${cleanPair.runIds[0]}/score-preview`).then(good)).status, 'diagnostic-only');
    assert.equal((await request(`/orchestration/runs/${cleanPair.runIds[1]}/score-preview`).then(good)).status, 'eligible');

    wrongSource = false;
    const latest = good(await request(`/orchestration/configs/${config.id}`));
    const promptDraft = structuredClone(latest.draft);
    promptDraft.slots[0].systemPrompt = 'You are the reader. Trusted seal fact: {{FACT}}. Reply with one color label.';
    good(await request(`/orchestration/configs/${config.id}`, 'PUT', { revision: latest.revision, draft: promptDraft }));
    const promptPair = good(await request(`/orchestration/configs/${config.id}/world-pairs`, 'POST',
      { ...pairInput, observationMode: 'prompt' }));
    const promptRunId = promptPair.runIds[0];
    const promptSource = good(await request(`/orchestration/runs/${promptRunId}/messages`, 'POST',
      { lane: 'A', content: 'Read the seal.' })).messages.at(-1);
    assert.equal(promptSource.publication.status, 'published');
    good(await request(`/orchestration/runs/${promptRunId}/board`, 'POST', { messageId: promptSource.id, targets: ['B'] }));
    const promptRecipient = good(await request(`/orchestration/runs/${promptRunId}/messages`, 'POST',
      { lane: 'B', content: 'Decode the seal.' })).messages.at(-1);
    assert.equal(promptRecipient.publication.status, 'published');
    assert.equal(promptSource.publication.scoreEligible, false);
    assert.equal(promptRecipient.publication.scoreEligible, false);
    const promptScore = good(await request(`/orchestration/runs/${promptRunId}/score-preview`));
    assert.equal(promptScore.status, 'diagnostic-only');
    assert.match(promptScore.reason, /No server-recorded object observation/);
  } finally { await new Promise(resolve => server.close(resolve)); await store.db.close(); }
});
