import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFixture } from './database-fixture.mjs';

test('score preview follows a verified object through two saved specialist handoffs', async () => {
  const provider = { model: 'fixture-model', baseUrl: 'https://example.test/v1', apiKey: 'fixture-key' };
  const { app, store } = await createFixture({ provider, completion: async context => {
    const system = context.system;
    const text = system.includes('The opened dispatch seal shows amber.') ? 'amber'
      : system.includes('The opened dispatch seal shows cobalt.') ? 'cobalt'
        : system.includes('\nSOURCE_A="amber"\nREQUIRED') ? 'north'
          : system.includes('\nSOURCE_A="cobalt"\nREQUIRED') ? 'south'
            : system.includes('\nSOURCE_B="north"\nREQUIRED') ? 'falcon'
              : system.includes('\nSOURCE_B="south"\nREQUIRED') ? 'heron' : 'Awaiting inspection.';
    return { text, model: provider.model, latencyMs: 1, usage: 1 };
  } });
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}/api`;
  let cookie;
  const request = async (path, method = 'GET', body) => {
    const response = await fetch(origin + path, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json();
    cookie ||= response.headers.get('set-cookie')?.split(';')[0];
    assert.ok(response.ok, JSON.stringify(value));
    return value;
  };
  try {
    await request('/setup', 'POST', { name: 'Score chain owner', email: 'score-chain@example.test', password: 'fixture-password' });
    const config = await request('/orchestration/configs', 'POST', {});
    const draft = { ...config.draft, task: 'Read, decode, and allocate a sealed dispatch.',
      contract: { edges: [
        { sourceLane: 'A', targetLane: 'B', waitLabel: 'Awaiting color.', choices: [
          { source: 'amber', output: 'north' }, { source: 'cobalt', output: 'south' },
        ] },
        { sourceLane: 'B', targetLane: 'C', waitLabel: 'Awaiting route.', choices: [
          { source: 'north', output: 'falcon' }, { source: 'south', output: 'heron' },
        ] },
      ] },
      slots: [
        { id: 'A', name: 'Reader', systemPrompt: 'Read the verified seal.', temperature: 0 },
        { id: 'B', name: 'Decoder', systemPrompt: 'Decode the saved seal.', temperature: 0 },
        { id: 'C', name: 'Allocator', systemPrompt: 'Allocate from the saved route.', temperature: 0 },
      ] };
    await request(`/orchestration/configs/${config.id}`, 'PUT', { revision: config.revision, draft });
    const pair = await request(`/orchestration/configs/${config.id}/world-pairs`, 'POST', {
      testInput: 'Dispatch case 9.', sourceLane: 'A', targetLane: 'B', sourceValues: ['amber', 'cobalt'], observationMode: 'sealed-card',
    });
    for (const [index, runId] of pair.runIds.entries()) {
      await request(`/orchestration/runs/${runId}/objects/dispatch-seal/open`, 'POST', {});
      const a = (await request(`/orchestration/runs/${runId}/messages`, 'POST', { lane: 'A', content: 'Read.' })).messages.at(-1);
      await request(`/orchestration/runs/${runId}/board`, 'POST', { messageId: a.id, targets: ['B'] });
      const b = (await request(`/orchestration/runs/${runId}/messages`, 'POST', { lane: 'B', content: 'Decode.' })).messages.at(-1);
      assert.equal(b.content, index ? 'south' : 'north');
      assert.equal((await request(`/orchestration/runs/${runId}/score-preview`)).status, 'incomplete');
      await request(`/orchestration/runs/${runId}/board`, 'POST', { messageId: b.id, targets: ['C'] });
      const c = (await request(`/orchestration/runs/${runId}/messages`, 'POST', { lane: 'C', content: 'Allocate.' })).messages.at(-1);
      assert.equal(c.content, index ? 'heron' : 'falcon');
      const score = await request(`/orchestration/runs/${runId}/score-preview`);
      assert.equal(score.status, 'eligible');
      assert.equal(score.expected, c.content);
      assert.deepEqual((await request(`/orchestration/runs/${runId}/events`)).map(event => event.kind),
        ['observe', 'turn', 'share', 'turn', 'share', 'turn']);
    }
  } finally { await new Promise(resolve => server.close(resolve)); await store.db.close(); }
});
