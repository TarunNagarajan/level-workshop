import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createFixture } from '../tests/database-fixture.mjs';
import { compileVisibilityManifest } from './visibility-manifest.mjs';

const captured = [];
const { app, store } = await createFixture({
  provider: { model: 'fixture-model', baseUrl: 'https://example.test/v1', apiKey: 'fixture-key' },
  completion: async input => {
    captured.push(input);
    return { text: 'The documents are mine.', model: 'fixture-model', latencyMs: 1, usage: 1 };
  },
});
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
async function request(path, { method = 'GET', body, cookie, token } = {}) {
  const response = await fetch(`${origin}/api${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(token ? { 'x-round-token': token } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
}

const signatureMismatch = (_, leaves) => {
  const passport = leaves.filter(leaf => leaf.text.includes('E. Vale'));
  const card = leaves.filter(leaf => leaf.text.includes('N. Vale'));
  return passport.length && card.length ? [passport[0].path, card[0].path] : [];
};
const facts = [
  { id: 'passportSignature', variants: ['E. Vale'] },
  { id: 'cardSignature', variants: ['N. Vale'] },
  { id: 'signatureMismatch', derive: signatureMismatch },
  { id: 'stampDate', variants: ['14 MAR 2024', '14 March 2024'] },
  { id: 'uvIntact', variants: ['thread is intact', 'document is genuine and unaltered'] },
  { id: 'protectedTravellerName', variants: ['Noah Vale'] },
];
const bundleFiles = ['index.html', ...readdirSync('dist/client/assets').filter(name => /\.(?:js|css|svg)$/.test(name)).map(name => `assets/${name}`)];
const clientBundle = Object.fromEntries(bundleFiles.map(name => [name, readFileSync(`dist/client/${name}`, 'utf8')]));
const bundleHashes = Object.fromEntries(Object.entries(clientBundle).map(([name, source]) => [name, createHash('sha256').update(source).digest('hex')]));
const sourceFiles = ['server/passport-reference.mjs', 'server/levels.mjs', 'server/workshop.mjs', 'server/model.mjs', 'src/PassportReference.tsx', 'research/visibility-manifest.mjs', 'research/reference-visibility-manifest.mjs'];
const sourceHashes = Object.fromEntries(sourceFiles.map(name => [name, createHash('sha256').update(readFileSync(name)).digest('hex')]));

try {
  const owner = await request('/setup', { method: 'POST', body: { name: 'Manifest owner', email: 'manifest@example.test', password: 'long-test-password' } });
  assert.equal(owner.status, 200);
  const link = await request('/reference/links', { method: 'POST', body: {}, cookie: owner.cookie });
  assert.equal(link.status, 200);
  const blind = await request(link.body.path);
  assert.equal(blind.status, 200);
  const started = await request(link.body.path, { method: 'POST', body: { tester: 'Manifest player' } });
  assert.equal(started.status, 201);
  const roundId = started.body.round.id;
  const token = started.body.round.accessToken;
  let state = started.body.state;
  const frames = [];
  const path = `/reference/rounds/${roundId}`;
  async function frame(stage, actionResponse = null) {
    const message = await request(`${path}/messages`, { method: 'POST', body: { content: 'Please continue.' }, token });
    assert.equal(message.status, 200);
    const actualSystem = captured.at(-1)?.system;
    assert.equal(typeof actualSystem, 'string');
    const splitAt = '\n\nVERIFIED DESK OBSERVATIONS\n';
    assert.equal(actualSystem.split(splitAt).length, 2);
    const context = await request(`${path}/context`, { cookie: owner.cookie });
    assert.equal(context.status, 200);
    assert.equal(actualSystem, context.body.system, 'Owner context preview must match actual target system prompt.');
    const round = await request(path, { token });
    assert.equal(round.status, 200);
    assert.equal(round.body.state.revision, state.revision);
    frames.push({ stage, surfaces: {
      playerBootstrapApi: blind.body,
      playerRoundApi: round.body,
      playerActionApi: actionResponse,
      playerClientBundle: clientBundle,
      modelVerifiedDesk: context.body.observations,
      modelStaticSystem: actualSystem.split(splitAt)[0],
      modelFullSystem: actualSystem,
      modelMessages: captured.at(-1).messages.map(({ role, content }) => ({ role, content })),
    } });
  }
  await frame('closed');
  async function action(stage, input) {
    const reply = await request(`${path}/action`, { method: 'POST', body: { revision: state.revision, ...input }, token });
    assert.equal(reply.status, 200);
    state = reply.body.state;
    await frame(stage, reply.body);
  }
  await action('moved', { action: 'move', object: 'passport', position: { x: 44, y: 54 } });
  await action('opened', { action: 'open', object: 'passport' });
  await action('turned', { action: 'turn', object: 'passport' });
  await action('card', { action: 'card' });
  await action('compared', { action: 'compare' });
  await action('uv', { action: 'lamp', value: 'uv' });
  const boundaries = {
    playerApi: ['playerBootstrapApi', 'playerRoundApi', 'playerActionApi'],
    playerBundle: ['playerClientBundle'],
    playerAccessible: ['playerBootstrapApi', 'playerRoundApi', 'playerActionApi', 'playerClientBundle'],
    modelVerifiedDesk: ['modelVerifiedDesk'],
    modelStaticPrompt: ['modelStaticSystem'],
    modelFullRequest: ['modelFullSystem', 'modelMessages'],
  };
  const strictObjectRules = [
    ...['passportSignature', 'cardSignature', 'signatureMismatch', 'stampDate', 'uvIntact'].map((factId, index) => ({ factId, boundary: 'playerAccessible', earliestStage: ['opened', 'card', 'compared', 'turned', 'uv'][index], mustReveal: true })),
    ...['passportSignature', 'cardSignature', 'signatureMismatch', 'stampDate', 'uvIntact'].map((factId, index) => ({ factId, boundary: 'modelVerifiedDesk', earliestStage: ['opened', 'card', 'compared', 'turned', 'uv'][index], mustReveal: true })),
    { factId: 'protectedTravellerName', boundary: 'playerAccessible', never: true },
  ];
  const manifest = compileVisibilityManifest({ facts, frames, boundaries, rules: strictObjectRules });
  assert.equal(manifest.status, 'violated');
  assert.equal(manifest.firstByBoundary.passportSignature.playerApi.stage, 'opened');
  assert.equal(manifest.firstByBoundary.cardSignature.playerApi.stage, 'card');
  assert.equal(manifest.firstByBoundary.cardSignature.modelVerifiedDesk.stage, 'card');
  assert.equal(manifest.firstByBoundary.cardSignature.modelFullRequest.stage, 'closed');
  assert.equal(manifest.firstByBoundary.cardSignature.modelStaticPrompt.stage, 'closed');
  assert.equal(manifest.firstByBoundary.signatureMismatch.playerApi.stage, 'card');
  assert.equal(manifest.firstByBoundary.signatureMismatch.modelVerifiedDesk.stage, 'card');
  assert.equal(manifest.firstByBoundary.stampDate.playerApi.stage, 'turned');
  assert.equal(manifest.firstByBoundary.stampDate.playerBundle, null);
  assert.equal(manifest.firstByBoundary.protectedTravellerName.playerAccessible, null);
  assert.equal(manifest.firstByBoundary.protectedTravellerName.modelFullRequest.stage, 'closed');
  const report = {
    boundary: 'Actual local blind-player and owner Express routes, captured completion system arguments, and freshly built text assets; one sampled click path, no live deployment, browser DOM, image OCR, or external knowledge.',
    databaseAdapter: process.env.TEST_DATABASE === 'postgres' ? 'PGlite PostgreSQL' : 'Node SQLite',
    factIds: facts.map(fact => fact.id),
    bundleHashes,
    sourceHashes,
    ...manifest,
  };
  const outputPath = process.env.TEST_DATABASE === 'postgres' ? 'research/reference-visibility-manifest-postgres.json' : 'research/reference-visibility-manifest.json';
  writeFileSync(outputPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ outputPath, status: report.status, stages: report.stages, verdicts: report.verdicts.map(({ factId, boundary, status, firstExposure }) => ({ factId, boundary, status, firstStage: firstExposure?.stage ?? null })) }, null, 2));
} finally {
  await new Promise(resolve => server.close(resolve));
  await store.db.close();
}
