import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFixture } from '../tests/database-fixture.mjs';
import { auditSavedRunWorldPair, bindSavedRunToWorld } from './saved-run-world-audit.mjs';

test('saved HTTP runs separate handoff necessity from source truth', async () => {
  const provider = { model: 'fixture-model', baseUrl: 'https://example.test/v1', apiKey: 'fixture-key' };
  let sourceReply;
  const { app, store } = await createFixture({ provider, completion: async () => ({ text: sourceReply, model: provider.model, latencyMs: 1, usage: 1 }) });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}/api`;
  let cookie;
  const request = async (path, method = 'GET', body) => {
    const response = await fetch(`${origin}${path}`, {
      method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json();
    assert.ok(response.ok, `${method} ${path}: ${JSON.stringify(value)}`);
    cookie ||= response.headers.get('set-cookie')?.split(';')[0];
    return value;
  };
  const contract = { edges: [{ sourceLane: 'A', targetLane: 'B', waitLabel: 'Awaiting color.', choices: [
    { source: 'amber', output: 'north' }, { source: 'cobalt', output: 'south' },
  ] }] };
  const createRun = async (trueColor, reportedColor, sourceSuffix = '', sourceSystemOverride = null) => {
    const draft = {
      title: `Seal case ${trueColor}`, task: 'Decode the private seal after the saved reader reply.', contract,
      slots: [
        { id: 'A', name: 'Seal reader', systemPrompt: sourceSystemOverride ?? `Private seal is ${trueColor}.${sourceSuffix}`, temperature: 0.3 },
        { id: 'B', name: 'Decoder', systemPrompt: 'Decode the shared seal using amber=north and cobalt=south.', temperature: 0.3 },
        { id: 'C', name: 'Observer', systemPrompt: 'Observe only.', temperature: 0.3 },
      ],
    };
    const config = await request('/orchestration/configs', 'POST', { draft });
    const started = await request(`/orchestration/configs/${config.id}/runs`, 'POST', { testInput: 'Dispatch case 7.' });
    const binding = bindSavedRunToWorld(started, trueColor, 'Private seal is {{FACT}}.');
    sourceReply = reportedColor;
    const answered = await request(`/orchestration/runs/${started.id}/messages`, 'POST', { lane: 'A', content: 'Read the private seal.' });
    const source = answered.messages.at(-1);
    assert.equal(source.publication.status, 'published');
    await request(`/orchestration/runs/${started.id}/board`, 'POST', { messageId: source.id, targets: ['B'] });
    return { run: await request(`/orchestration/runs/${started.id}`), binding };
  };
  try {
    const setup = await fetch(`${origin}/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Saved run audit owner', email: 'saved-audit@example.test', password: 'fixture-password' }) });
    assert.equal(setup.status, 200);
    cookie = setup.headers.get('set-cookie')?.split(';')[0];

    const truePair = [await createRun('amber', 'amber'), await createRun('cobalt', 'cobalt')];
    const audit = pair => auditSavedRunWorldPair({
      runs: pair.map(item => item.run), bindings: pair.map(item => item.binding),
      sourceLane: 'A', lane: 'B', content: 'Decode the route.', provider,
    });
    const correct = audit(truePair);
    assert.equal(correct.status, 'source-true-necessary-handoff');
    assert.equal(correct.requestNecessity, true);
    assert.equal(correct.sourceAccess.onlyFactDifference, true);
    assert.equal(correct.sourceTruth, true);
    assert.equal(correct.requestAudit.identicalBefore, true);
    assert.equal(correct.requestAudit.divergesAfter, true);
    assert.deepEqual(correct.worlds.map(world => world.expectedOutcome), ['north', 'south']);

    const swappedPair = [await createRun('amber', 'cobalt'), await createRun('cobalt', 'amber')];
    const swapped = audit(swappedPair);
    assert.equal(swapped.requestNecessity, true, 'A structurally necessary share can still carry two false source values.');
    assert.equal(swapped.sourceTruth, false);
    assert.equal(swapped.status, 'fails-audit');
    assert.deepEqual(swapped.worlds.map(world => world.sourceTruth), [false, false]);
    assert.deepEqual(swapped.worlds.map(world => world.sourceStatus), ['valid', 'valid']);
    sourceReply = 'south';
    const wrongLeft = await request(`/orchestration/runs/${swappedPair[0].run.id}/messages`, 'POST', { lane: 'B', content: 'Decode the shared seal.' });
    sourceReply = 'north';
    const wrongRight = await request(`/orchestration/runs/${swappedPair[1].run.id}/messages`, 'POST', { lane: 'B', content: 'Decode the shared seal.' });
    assert.deepEqual([wrongLeft, wrongRight].map(run => run.messages.at(-1).publication.status), ['published', 'published']);
    assert.deepEqual([wrongLeft, wrongRight].map(run => run.messages.at(-1).content), ['south', 'north']);

    const changedSourcePrompt = audit([truePair[0], await createRun('cobalt', 'cobalt', ' An unrelated instruction changed.')]);
    assert.equal(changedSourcePrompt.requestNecessity, true);
    assert.equal(changedSourcePrompt.sourceTruth, true);
    assert.equal(changedSourcePrompt.sourceAccess.onlyFactDifference, false);
    assert.equal(changedSourcePrompt.status, 'fails-audit');

    const guessedPair = [
      await createRun('amber', 'amber', '', 'Private seal is unknown.'),
      await createRun('cobalt', 'cobalt', '', 'Private seal is unknown.'),
    ];
    const guessed = audit(guessedPair);
    assert.equal(guessed.requestNecessity, true);
    assert.equal(guessed.sourceTruth, true);
    assert.equal(guessed.sourceAccess.different, false);
    assert.equal(guessed.sourceAccess.templateMatched, false);
    assert.equal(guessed.status, 'fails-audit');

    const incidentalPair = [
      await createRun('amber', 'amber', '', 'Private seal is amberfish.'),
      await createRun('cobalt', 'cobalt', '', 'Private seal is cobaltfish.'),
    ];
    const incidental = audit(incidentalPair);
    assert.equal(incidental.requestNecessity, true);
    assert.equal(incidental.sourceTruth, true);
    assert.equal(incidental.sourceAccess.different, true);
    assert.equal(incidental.sourceAccess.templateMatched, false);
    assert.equal(incidental.status, 'fails-audit');

    const staleBinding = auditSavedRunWorldPair({
      runs: truePair.map(item => item.run),
      bindings: [{ ...truePair[0].binding, runId: 'another-run' }, truePair[1].binding],
      sourceLane: 'A', lane: 'B', content: 'Decode the route.', provider,
    });
    assert.equal(staleBinding.worlds[0].bindingValid, false);
    assert.equal(staleBinding.status, 'fails-audit');

    const wrongProvider = auditSavedRunWorldPair({
      runs: truePair.map(item => item.run), bindings: truePair.map(item => item.binding),
      sourceLane: 'A', lane: 'B', content: 'Decode the route.', provider: { ...provider, model: 'different-model' },
    });
    assert.equal(wrongProvider.worlds[0].providerMatchesRun, false);
    assert.equal(wrongProvider.requestNecessity, false);

    sourceReply = 'north';
    await request(`/orchestration/runs/${truePair[0].run.id}/messages`, 'POST', { lane: 'B', content: 'Decode the route.' });
    sourceReply = 'south';
    await request(`/orchestration/runs/${truePair[1].run.id}/messages`, 'POST', { lane: 'B', content: 'Decode the route.' });
    const lateRuns = await Promise.all(truePair.map(item => request(`/orchestration/runs/${item.run.id}`)));
    const lateAudit = auditSavedRunWorldPair({
      runs: lateRuns, bindings: truePair.map(item => item.binding),
      sourceLane: 'A', lane: 'B', content: 'Decode the route.', provider,
    });
    assert.equal(lateAudit.status, 'inconclusive-stage');
    assert.equal(lateAudit.requestNecessity, null);
    assert.deepEqual(lateAudit.worlds.map(world => world.stageBoundaryValid), [false, false]);
    const eventLogs = await Promise.all(lateRuns.map(run => request(`/orchestration/runs/${run.id}/events`)));
    assert.deepEqual(eventLogs.map(events => events.map(event => event.kind)), [['turn', 'share', 'turn'], ['turn', 'share', 'turn']]);
    assert.deepEqual(lateRuns.map(run => run.eventSeq), [3, 3]);
    const restored = auditSavedRunWorldPair({
      runs: lateRuns, bindings: truePair.map(item => item.binding), eventLogs,
      shareEventSeqs: [2, 2], sourceLane: 'A', lane: 'B', content: 'Decode the route.', provider,
    });
    assert.equal(restored.status, 'source-true-necessary-handoff');
    assert.equal(restored.requestNecessity, true);
    const tampered = auditSavedRunWorldPair({
      runs: lateRuns, bindings: truePair.map(item => item.binding),
      eventLogs: [[...eventLogs[0].slice(0, 1), { ...eventLogs[0][1], boardHash: '0'.repeat(64) }, ...eventLogs[0].slice(2)], eventLogs[1]],
      sourceLane: 'A', lane: 'B', content: 'Decode the route.', provider,
    });
    assert.equal(tampered.status, 'invalid-checkpoint');
  } finally {
    await new Promise(resolve => server.close(resolve));
    await store.db.close();
  }
});
