import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import express from 'express';
import sharp from 'sharp';
import { chromium, expect } from '@playwright/test';
import { createFixture } from '../tests/database-fixture.mjs';
import { passportEvidenceWorlds } from './passport-dynamic-adapter.mjs';
import { auditEventCut } from './event-cut-contract.mjs';
import { auditTemporalObserverCut } from './temporal-observer-cut.mjs';
import { normalizePlayerActionResponse } from './normalize-player-observation.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const outDir = 'research/browser-uv-paths';
mkdirSync(outDir, { recursive: true });
const sourceFiles = ['server/workshop.mjs', 'server/passport-reference.mjs', 'src/App.tsx', 'src/PassportReference.tsx',
  'research/passport-dynamic-adapter.mjs', 'research/event-cut-contract.mjs', 'research/observer-relative-cut.mjs',
  'research/temporal-observer-cut.mjs', 'research/normalize-player-observation.mjs', 'research/uv-conditional-path-study.mjs'];
const sourceHashes = Object.fromEntries(sourceFiles.map(path => [path, digest(readFileSync(path))]));
const bundleFiles = ['index.html', ...readdirSync('dist/client/assets').map(name => `assets/${name}`),
  ...readdirSync('dist/client/reference-assets').map(name => `reference-assets/${name}`)];
const bundleHashes = Object.fromEntries(bundleFiles.map(path => [path, digest(readFileSync(`dist/client/${path}`))]));
const paths = [
  ['lamp:uv'],
  ['open', 'turn', 'lamp:uv'],
  ['card', 'open', 'compare', 'turn', 'lamp:uv'],
];
const worldIds = ['match-intact', 'match-broken'];
const worlds = passportEvidenceWorlds({ boundary: 'player' }).filter(world => worldIds.includes(world.id));
const graph = auditEventCut({ worlds, requiredAction: 'lamp:uv', maxPairs: 50000 });
assert.equal(graph.status, 'certified');
assert.deepEqual(graph.revealTrace.actions, ['lamp:uv']);

const predicted = new Map();
for (const world of worlds) for (const path of paths) {
  let state = world.initialState;
  const stages = [];
  for (const action of path) {
    assert.ok(world.enabled(state).includes(action), `${world.id}: ${action} unavailable after ${stages.map(stage => stage.action).join(',')}`);
    state = world.step(state, action);
    stages.push({ action, evidence: world.observe(state), enabled: world.enabled(state) });
  }
  predicted.set(`${world.id}:${path.join(',')}`, stages);
}

const browser = await chromium.launch({ headless: true });
let port = 0;
async function runWorld(worldId, path) {
  const name = `${worldId}-${path.map(action => action.replace(':', '-')).join('-')}`;
  const { app, store } = await createFixture({ researchWorlds: true, researchWorldId: worldId,
    provider: { model: 'fixture-model', baseUrl: 'https://example.test/v1', apiKey: 'fixture-key' },
    completion: async () => ({ text: 'These documents are mine.', model: 'fixture-model', latencyMs: 1, usage: 5 }) });
  app.use(express.static(resolve('dist/client')));
  app.get('/{*path}', (_req, res) => res.sendFile(resolve('dist/client/index.html')));
  const server = app.listen(port, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  try {
    const setup = await fetch(`${base}/api/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Study owner', email: 'uv-paths@example.test', password: 'long-test-password' }) });
    assert.equal(setup.status, 200);
    const page = await context.newPage(), pending = [], received = [], errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => {
      if (!response.url().startsWith(base) || response.request().method() !== 'GET') return;
      pending.push((async () => {
        const bytes = await response.body();
        received.push({ path: new URL(response.url()).pathname, status: response.status(),
          contentType: response.headers()['content-type'] || '', hash: digest(bytes) });
      })());
    });
    const trace = [], parity = [];
    async function capture(action, body = null) {
      await page.waitForLoadState('networkidle');
      await page.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.images].map(img => img.decode().catch(() => {}))); });
      await Promise.all(pending);
      const png = await page.screenshot({ path: `${outDir}/${name}-${action.replace(':', '-')}.png`, fullPage: true, animations: 'disabled' });
      const normalized = body ? normalizePlayerActionResponse(body) : null;
      const snapshot = { textHash: digest(await page.locator('body').innerText()),
        accessibilityHash: digest(await page.locator('body').ariaSnapshot()),
        screenshotPixelHash: digest(await sharp(png).ensureAlpha().raw().toBuffer()),
        coverPixelHash: '', exifHash: null, actionPayloadHash: normalized ? digest(JSON.stringify(normalized)) : null,
        actionPayload: normalized, network: received.splice(0).sort((a, b) => a.path.localeCompare(b.path)) };
      trace.push({ action, capture: snapshot, screenshotHash: digest(png) });
    }
    await page.goto(`${base}/reference/research/preview`, { waitUntil: 'networkidle' });
    await expect(page.getByRole('heading', { name: 'One last passenger', exact: true })).toBeVisible();
    await capture('intro');
    const startedResponse = page.waitForResponse(response => response.url().endsWith('/api/reference/research/preview') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Open the counter' }).click();
    const startReply = await startedResponse;
    assert.equal(startReply.status(), 201);
    const started = await startReply.json();
    await expect(page.getByText('INTERVIEW IN PROGRESS', { exact: false })).toBeVisible();
    await page.addStyleTag({ content: '.counter-status span:last-child { visibility: hidden !important; }' });
    await capture('closed', started);
    const expected = predicted.get(`${worldId}:${path.join(',')}`);
    for (const [index, action] of path.entries()) {
      if (await page.getByRole('dialog').count()) await page.getByLabel('Close dialog').click();
      const response = page.waitForResponse(item => item.url().includes(`/api/reference/rounds/${started.round.id}/action`)
        && item.request().postDataJSON()?.action === (action === 'lamp:uv' ? 'lamp' : action));
      if (action === 'open') await page.getByRole('button', { name: 'Inspect passport', exact: true }).click();
      if (action === 'card') await page.getByRole('button', { name: 'Request arrival card' }).click();
      if (action === 'compare') await page.getByRole('button', { name: 'Compare signatures' }).click();
      if (action === 'turn') {
        await page.getByRole('button', { name: 'Inspect passport', exact: true }).click();
        await page.getByRole('dialog').getByRole('button', { name: 'Turn page' }).click();
      }
      if (action === 'lamp:uv') await page.getByRole('button', { name: 'Toggle inspection lamp' }).click();
      const reply = await response;
      assert.equal(reply.status(), 200);
      const body = await reply.json();
      assert.deepEqual(body.documents, expected[index].evidence.documents);
      assert.deepEqual(body.state.events.map(({ action, object, value, page, observation }) => ({ action, object, value, page, observation })),
        expected[index].evidence.desk.events);
      parity.push({ action, documentsMatch: true, eventsMatch: true, revision: body.state.revision });
      await expect(page.locator('.desk-observation p')).toHaveText(body.observation);
      await capture(action, body);
    }
    assert.deepEqual(errors, []);
    return { worldId, path, name, trace, parity };
  } finally {
    await context.close();
    await new Promise(resolve => server.close(resolve));
    await store.db.close();
  }
}

try {
  const rows = [];
  for (const path of paths) for (const id of worldIds) rows.push(await runWorld(id, path));
  const verdicts = [];
  for (const path of paths) {
    const [left, right] = rows.filter(row => row.path.join(',') === path.join(','));
    for (const channel of ['domText', 'accessibility', 'renderedPixels', 'actionPayload', 'downloadedBytes']) {
      const result = auditTemporalObserverCut(left.trace, right.trace, { requiredAction: 'lamp:uv', channel });
      verdicts.push({ path, ...result });
      assert.equal(result.status, channel === 'downloadedBytes' ? 'unrevealed' : 'revealed-at-event', `${path.join('→')} ${channel}`);
    }
  }
  const report = { status: 'passed', browser: browser.version(), sourceHashes, bundleHashes,
    scope: 'Two UV worlds; direct lamp, open-turn-lamp, and card-open-compare-turn-lamp paths. Actual first-use reducer, player serializer, local HTTP and Chromium. No repeats, arbitrary moves, provider calls, or all-browser-path certificate.',
    graph: { status: graph.status, exploredPairs: graph.exploredPairs, shortestReveal: graph.revealTrace.actions },
    paths, rows, verdicts };
  writeFileSync('research/uv-conditional-path-study.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, browserFixtures: rows.length, paths: paths.length,
    graphPairs: graph.exploredPairs, earlyDifferences: verdicts.filter(row => row.status === 'exposed-before-event').length }));
} finally { await browser.close(); }
