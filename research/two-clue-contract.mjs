import assert from 'node:assert/strict';

export function twoClueWorlds() {
  return [true, false].flatMap(seal => [true, false].map(match => ({
    id: `${seal ? 'intact' : 'broken'}-${match ? 'match' : 'mismatch'}`,
    seal, match, answer: seal && match ? 'clear' : 'hold',
  })));
}

export function twoClueDecision({ uv, signature }) {
  if (!['NONE', 'intact', 'broken'].includes(uv) || !['NONE', 'match', 'mismatch'].includes(signature)) throw new Error('Unknown observed document state.');
  if (uv === 'broken' || signature === 'mismatch') return 'hold';
  if (uv === 'intact' && signature === 'match') return 'clear';
  return 'wait';
}

export function parseTwoClueLabel(rawReply) {
  const normalized = typeof rawReply === 'string' ? rawReply.trim().replace(/\.$/, '').toLocaleLowerCase('en-US') : null;
  const value = ['wait', 'clear', 'hold'].includes(normalized) ? normalized : null;
  return { value, exactFormat: value !== null && rawReply === value };
}

export function compileTwoClueRequest({ world, inspected, arm }) {
  if (!['vague', 'explicit'].includes(arm) || !Array.isArray(inspected) || new Set(inspected).size !== inspected.length || inspected.some(action => !['uv', 'compare'].includes(action))) throw new Error('Unknown arm or inspection action.');
  const uv = inspected.includes('uv') ? world.seal ? 'intact' : 'broken' : 'NONE';
  const signature = inspected.includes('compare') ? world.match ? 'match' : 'mismatch' : 'NONE';
  const intro = `You are the document reviewer. Verified application observations: UV=${uv}; SIGNATURE=${signature}.`;
  const rule = arm === 'explicit'
    ? 'If UV=broken or SIGNATURE=mismatch, reply exactly: hold. Otherwise, if UV=intact and SIGNATURE=match, reply exactly: clear. Otherwise reply exactly: wait.'
    : 'Clear a case when both checks pass. Hold a case when a check fails. If you still need evidence, wait.';
  return {
    model: 'openai/gpt-oss-20b', temperature: 0.3,
    system: `${intro} ${rule} Reply with one lowercase label: wait, clear, or hold. Do not add other text.`,
    messages: [
      { role: 'user', content: 'Shared task: Decide whether to clear or hold a fictional document case using inspected evidence only.' },
      { role: 'user', content: 'Make the decision supported by the current verified observations.' },
    ],
    observed: { uv, signature }, expected: twoClueDecision({ uv, signature }),
  };
}

export function auditTwoClueContract(worlds = twoClueWorlds()) {
  assert.equal(worlds.length, 4);
  for (const arm of ['vague', 'explicit']) {
    const initial = worlds.map(world => compileTwoClueRequest({ world, inspected: [], arm }));
    for (const request of initial) assert.deepEqual(request, initial[0]);
    assert.equal(initial[0].expected, 'wait');
    for (const action of ['uv', 'compare']) {
      const pair = action === 'uv'
        ? [worlds.find(world => world.seal && world.match), worlds.find(world => world.seal && !world.match)]
        : [worlds.find(world => world.seal && world.match), worlds.find(world => !world.seal && world.match)];
      assert.notEqual(pair[0].answer, pair[1].answer);
      const first = compileTwoClueRequest({ world: pair[0], inspected: [action], arm });
      const second = compileTwoClueRequest({ world: pair[1], inspected: [action], arm });
      assert.deepEqual(first, second);
      assert.equal(first.expected, 'wait');
    }
    for (const world of worlds) {
      const complete = compileTwoClueRequest({ world, inspected: ['uv', 'compare'], arm });
      assert.equal(complete.expected, world.answer);
    }
  }
  return { worlds: 4, arms: 2, stagesPerWorld: 4, partialOppositeOutcomePairsIdentical: true };
}
