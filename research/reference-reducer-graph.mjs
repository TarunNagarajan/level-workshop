import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createFixture } from '../tests/database-fixture.mjs';
import { applyPassportAction, initialPassportState, passportContext } from '../server/passport-reference.mjs';

// Every non-positional physical action accepted by the route is represented.
// Move coordinates are continuous; one valid representative per object is
// sufficient for factual visibility because the reducer and context only use
// positions for placement. The API parity run below also tests other points.
const choices = [
  ['open', { action: 'open' }], ['turn', { action: 'turn' }],
  ...['warm', 'uv', 'off'].map(value => [`lamp:${value}`, { action: 'lamp', value }]),
  ['card', { action: 'card' }],
  ...['passport', 'ticket', 'card'].map(object => [`present:${object}`, { action: 'present', object }]),
  ['compare', { action: 'compare' }],
  ...['passport', 'ticket', 'card'].map(object => [`move:${object}`, { action: 'move', object, position: { x: 44, y: 58 } }]),
  ['hint', { action: 'hint' }],
];
assert.equal(choices.length, 14);
const labels = new Map(choices);
const sourceFiles = ['server/passport-reference.mjs', 'research/reference-reducer-graph.mjs', 'tests/database-fixture.mjs'];
const sourceHashes = Object.fromEntries(sourceFiles.map(name => [name, createHash('sha256').update(readFileSync(name)).digest('hex')]));
const seen = state => ({
  identity: state.events.some(event => event.page === 1),
  stamp: state.events.some(event => event.action === 'turn' && event.page === 2),
  uv: state.events.some(event => event.action === 'lamp' && event.value === 'uv'),
});
function abstract(state) {
  return JSON.stringify({ page: state.page, lamp: state.lamp, cardRequested: state.cardRequested,
    compared: state.compared, hintsUsed: state.hintsUsed, presented: state.presented,
    selected: state.selected, seen: seen(state) });
}
function legal(state, choice) {
  try { return applyPassportAction(state, { revision: state.revision, ...choice }, { id: 'graph-event', at: 0 }); }
  catch (error) { if (error.status === 400) return null; throw error; }
}
function step(state, name) {
  const choice = labels.get(name);
  assert.ok(choice, `Unknown action: ${name}`);
  const result = legal(state, choice);
  assert.ok(result, `Action ${name} should be legal`);
  return result;
}

const queue = [{ state: initialPassportState(), trace: [] }];
const visited = new Map();
const edgeCounts = Object.fromEntries(choices.map(([name]) => [name, 0]));
const witnesses = {};
let head = 0, edges = 0, collisionChecks = 0, moveCoordinateChecks = 0, maxTraceLength = 0;
while (head < queue.length) {
  const { state, trace } = queue[head++];
  const key = abstract(state), context = passportContext(state);
  maxTraceLength = Math.max(maxTraceLength, trace.length);
  const transitions = choices.map(([name, choice]) => ({ name, result: legal(state, choice) }));
  const transitionSignature = JSON.stringify(transitions.map(({ name, result }) => [name, result?.observation ?? null, result ? abstract(result.state) : null]));
  if (visited.has(key)) {
    assert.deepEqual(visited.get(key), { context, transitionSignature }, 'Abstract-equivalent states differ in context or a physical-action transition');
    collisionChecks++;
    continue;
  }
  visited.set(key, { context, transitionSignature });
  if (visited.size > 100000) throw new Error('Abstract state bound reached; result would be inconclusive');
  const history = seen(state);
  assert.equal(context.includes('signature E. Vale.'), history.identity);
  assert.equal(context.includes('signed N. Vale.'), state.cardRequested);
  assert.equal(context.includes('Oslo entry stamp dated'), history.stamp);
  assert.equal(context.includes('UV thread:'), history.uv);
  assert.equal(context.includes('initial differs from the passport signature'), state.compared);
  assert.equal(context.includes('Noah Vale'), false);
  if (history.identity && state.cardRequested && !state.compared && !witnesses.mismatchBeforeCompare) witnesses.mismatchBeforeCompare = trace;
  if (history.uv && !witnesses.uvAfterLamp) witnesses.uvAfterLamp = trace;
  if (state.compared && !witnesses.compare) witnesses.compare = trace;
  if (history.stamp && !witnesses.stamp) witnesses.stamp = trace;
  if (state.hintsUsed === 2 && !witnesses.bothHints) witnesses.bothHints = trace;
  for (const object of ['passport', 'ticket', 'card']) {
    for (const position of [{ x: 10, y: 30 }, { x: 88, y: 82 }]) {
      const alternate = legal(state, { action: 'move', object, position });
      const representative = transitions.find(row => row.name === `move:${object}`).result;
      assert.equal(alternate?.observation ?? null, representative?.observation ?? null);
      assert.equal(alternate ? abstract(alternate.state) : null, representative ? abstract(representative.state) : null);
      moveCoordinateChecks++;
    }
  }
  for (const { name, result } of transitions) {
    if (!result) continue;
    edgeCounts[name]++;
    edges++;
    // Ignoring only event count, UUID/time, revision, and positions merges
    // repetitions that cannot add a new fact. The 200-action route limit only
    // removes longer paths; it cannot create a new observation.
    queue.push({ state: result.state, trace: [...trace, name] });
  }
}
assert.ok(witnesses.mismatchBeforeCompare);
assert.ok(witnesses.uvAfterLamp);
assert.ok(witnesses.compare);
assert.ok(witnesses.stamp);
assert.ok(witnesses.bothHints);

// Exercise the compiled trace against the real HTTP route on each database
// adapter. The reducer is shared, while this detects serialization, routing,
// and persistence differences. A deterministic walk also hits repeat actions.
const { app, store } = await createFixture({
  provider: { model: 'fixture-model', baseUrl: 'https://example.test/v1', apiKey: 'fixture-key' },
  completion: async () => ({ text: 'The documents are mine.', model: 'fixture-model', latencyMs: 1, usage: 1 }),
});
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
async function request(path, { method = 'GET', body, cookie, token } = {}) {
  const response = await fetch(`${base}/api${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(token ? { 'x-round-token': token } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
}
let parityActions = 0, parityRounds = 0, invalidChecks = 0;
try {
  const owner = await request('/setup', { method: 'POST', body: { name: 'Graph owner', email: 'graph-study@example.test', password: 'long-test-password' } });
  assert.equal(owner.status, 200);
  const link = await request('/reference/links', { method: 'POST', body: {}, cookie: owner.cookie });
  assert.equal(link.status, 200);
  const traces = Object.values(witnesses).concat([
    ['open', 'turn', 'turn', 'open', 'open', 'card', 'compare', 'compare', 'present:ticket', 'present:passport', 'present:passport', 'lamp:uv', 'lamp:warm', 'lamp:off'],
    ['hint', 'hint', 'move:passport', 'move:ticket', 'card', 'move:card', 'present:card', 'present:card'],
  ]);
  let seed = 20261003;
  const random = () => ((seed = (1664525 * seed + 1013904223) >>> 0) / 2 ** 32);
  for (let index = 0; index < 16; index++) {
    let generatedState = initialPassportState();
    const trace = [];
    for (let depth = 0; depth < 20; depth++) {
      const enabled = choices.filter(([, choice]) => legal(generatedState, choice));
      const [name, choice] = enabled[Math.floor(random() * enabled.length)];
      trace.push(name);
      generatedState = legal(generatedState, choice).state;
    }
    traces.push(trace);
  }
  for (const trace of traces) {
    const started = await request(link.body.path, { method: 'POST', body: { tester: 'Reducer observer' } });
    assert.equal(started.status, 201);
    let local = initialPassportState();
    const id = started.body.round.id, token = started.body.round.accessToken;
    parityRounds++;
    for (const name of trace) {
      let input = { revision: local.revision, ...labels.get(name) };
      if (name.startsWith('move:')) input = { ...input, position: { x: 76, y: 33 } };
      const expected = applyPassportAction(local, input, { id: 'comparison-event', at: 0 });
      const actual = await request(`/reference/rounds/${id}/action`, { method: 'POST', body: input, token });
      assert.equal(actual.status, 200, `${name}: ${JSON.stringify(actual.body)}`);
      assert.equal(actual.body.observation, expected.observation);
      const comparable = value => ({ ...value, revision: 0, events: value.events.map(({ id: _id, at: _at, ...event }) => event) });
      assert.deepEqual(comparable(actual.body.state), comparable(expected.state));
      const context = await request(`/reference/rounds/${id}/context`, { cookie: owner.cookie });
      assert.equal(context.status, 200);
      assert.equal(context.body.observations, passportContext(expected.state));
      local = expected.state;
      parityActions++;
    }
    const invalid = await request(`/reference/rounds/${id}/action`, { method: 'POST', body: { revision: local.revision - 1, action: 'open' }, token });
    assert.equal(invalid.status, 409);
    invalidChecks++;
  }
} finally {
  await new Promise(resolve => server.close(resolve));
  await store.db.close();
}
const report = {
  scope: 'Reachable abstract graph of the actual passport physical-action reducer, with repeats, presentation, hints, lamp modes, movement representatives, and API parity on selected paths. Positions, event IDs/times/count and revision are abstracted; questions, filing, images, other authored worlds, and live deployment are outside this graph.',
  databaseAdapter: process.env.TEST_DATABASE === 'postgres' ? 'PGlite PostgreSQL' : 'Node SQLite',
  sourceHashes, abstractStates: visited.size, transitionEdges: edges, collisionChecks, moveCoordinateChecks, maxTraceLength, edgeCounts, witnesses,
  findings: { verifiedDeskUvOnlyAfterLamp: true, verifiedDeskExplicitMismatchOnlyAfterCompare: true,
    derivedMismatchBeforeCompare: true, protectedTravellerNameAbsentFromVerifiedDesk: true },
  apiParity: { rounds: parityRounds, actions: parityActions, staleRevisionRejections: invalidChecks },
};
const outputPath = process.env.TEST_DATABASE === 'postgres' ? 'research/reference-reducer-graph-postgres.json' : 'research/reference-reducer-graph.json';
writeFileSync(outputPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ outputPath, abstractStates: report.abstractStates, transitionEdges: edges, apiParity: report.apiParity, findings: report.findings }));
