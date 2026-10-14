import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFixture } from './database-fixture.mjs';

test('server-bound paired worlds audit a later share checkpoint and expose false source reports', async () => {
  let falseSource = false;
  const contexts = [];
  const provider = { model: 'fixture-model', baseUrl: 'https://example.test/v1', apiKey: 'fixture-key' };
  const { app, store } = await createFixture({ provider, completion: async context => {
    contexts.push(context);
    const fact = context.system.includes('Private seal is amber.') ? 'amber' : 'cobalt';
    return { text: falseSource ? (fact === 'amber' ? 'cobalt' : 'amber') : fact, model: provider.model, latencyMs: 1, usage: 1 };
  } });
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}/api`;
  let cookie;
  const request = async (path, method = 'GET', body) => {
    const response = await fetch(origin + path, {
      method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json();
    cookie ||= response.headers.get('set-cookie')?.split(';')[0];
    return { status: response.status, body: value };
  };
  const good = result => { assert.ok(result.status >= 200 && result.status < 300, JSON.stringify(result)); return result.body; };
  try {
    good(await request('/setup', 'POST', { name: 'Pair owner', email: 'pair-owner@example.test', password: 'fixture-password' }));
    const config = good(await request('/orchestration/configs', 'POST', {}));
    const draft = { ...config.draft,
      task: 'Decode the private seal after the reader shares a saved finding.',
      contract: { edges: [{ sourceLane: 'A', targetLane: 'B', waitLabel: 'Awaiting color.', choices: [
        { source: 'amber', output: 'north' }, { source: 'cobalt', output: 'south' },
      ] }] },
      slots: [
        { id: 'A', name: 'Reader', systemPrompt: 'Private seal is {{FACT}}.', temperature: 0.3 },
        { id: 'B', name: 'Decoder', systemPrompt: 'Decode the shared seal.', temperature: 0.3 },
        { id: 'C', name: 'Observer', systemPrompt: 'Observe.', temperature: 0.3 },
      ],
    };
    good(await request(`/orchestration/configs/${config.id}`, 'PUT', { revision: config.revision, draft }));
    const pairInput = { testInput: 'Dispatch case 7.', sourceLane: 'A', targetLane: 'B', sourceValues: ['amber', 'cobalt'] };
    assert.equal((await request(`/orchestration/configs/${config.id}/world-pairs`, 'POST', { ...pairInput, sourceValues: ['amber', 'amber'] })).status, 400);
    const playPair = async () => {
      const pair = good(await request(`/orchestration/configs/${config.id}/world-pairs`, 'POST', pairInput));
      assert.equal(pair.runIds.length, 2);
      for (const runId of pair.runIds) {
        const answered = good(await request(`/orchestration/runs/${runId}/messages`, 'POST', { lane: 'A', content: 'Read the private seal.' }));
        const source = answered.messages.at(-1);
        assert.equal(source.publication.status, 'published');
        good(await request(`/orchestration/runs/${runId}/board`, 'POST', { messageId: source.id, targets: ['B'] }));
      }
      return pair;
    };
    const truePair = await playPair();
    assert.deepEqual(contexts.slice(0, 2).map(context => context.system), ['Private seal is amber.', 'Private seal is cobalt.']);
    for (const runId of truePair.runIds) good(await request(`/orchestration/runs/${runId}/messages`, 'POST', { lane: 'B', content: 'Decode the seal.' }));
    const audited = good(await request(`/orchestration/world-pairs/${truePair.pairId}/audit`, 'POST', { content: 'Decode the seal.' }));
    assert.equal(audited.status, 'source-true-necessary-handoff');
    assert.equal(audited.requestNecessity, true);
    assert.equal(audited.sourceTruth, true);
    assert.equal(audited.sourceAccess.onlyFactDifference, true);
    assert.deepEqual(audited.worlds.map(world => world.factValue), ['amber', 'cobalt']);
    falseSource = true;
    const falsePair = await playPair();
    const falseAudit = good(await request(`/orchestration/world-pairs/${falsePair.pairId}/audit`, 'POST', { content: 'Decode the seal.' }));
    assert.equal(falseAudit.status, 'fails-audit');
    assert.equal(falseAudit.requestNecessity, true);
    assert.equal(falseAudit.sourceTruth, false);
    assert.deepEqual(falseAudit.worlds.map(world => world.sourceTruth), [false, false]);
    const changed = await store.run('UPDATE orchestration_world_bindings SET snapshot_hash = ? WHERE run_id = ?', '0'.repeat(64), truePair.runIds[0]);
    assert.equal(changed.changes, 1);
    const stale = good(await request(`/orchestration/world-pairs/${truePair.pairId}/audit`, 'POST', { content: 'Decode the seal.' }));
    assert.equal(stale.status, 'fails-audit');
    assert.equal(stale.worlds[0].bindingValid, false);
  } finally { await new Promise(resolve => server.close(resolve)); await store.db.close(); }
});
