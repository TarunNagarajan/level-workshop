import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import express from 'express';
import sharp from 'sharp';
import { chromium, expect } from '@playwright/test';
import { createFixture } from '../tests/database-fixture.mjs';
import { auditTemporalObserverCut } from './temporal-observer-cut.mjs';
import { normalizePlayerActionResponse } from './normalize-player-observation.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const outDir = 'research/browser-temporal-assets';
mkdirSync(outDir, { recursive: true });
const sourceFiles = ['server/workshop.mjs', 'server/passport-reference.mjs', 'src/App.tsx', 'src/PassportReference.tsx',
  'research/observer-relative-cut.mjs', 'research/temporal-observer-cut.mjs',
  'research/normalize-player-observation.mjs', 'research/temporal-asset-cut-study.mjs'];
const sourceHashes = Object.fromEntries(sourceFiles.map(path => [path, digest(readFileSync(path))]));
const bundleFiles = ['index.html', ...readdirSync('dist/client/assets').map(name => `assets/${name}`),
  ...readdirSync('dist/client/reference-assets').map(name => `reference-assets/${name}`)];
const bundleHashes = Object.fromEntries(bundleFiles.map(path => [path, digest(readFileSync(`dist/client/${path}`))]));
const browser = await chromium.launch({ headless: true });
let port = 0;

async function alteredBook(value) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="720" viewBox="0 0 1200 720">
    <rect width="1200" height="720" rx="33" fill="#612d30"/>
    <path d="M28 35Q300 4 600 34Q900 4 1172 35V689Q900 661 600 692Q300 661 28 689Z" fill="#eadfc4" stroke="#a58e65" stroke-width="8"/>
    <path d="M600 34V692" stroke="#b4a17a" stroke-width="12"/>
    <rect x="155" y="40" width="890" height="55" fill="#6b3440"/>
    <text x="600" y="80" text-anchor="middle" fill="#fff2d1" font-family="Georgia,serif" font-size="43">CARD SIGNATURE: ${value}</text>
    <path d="M92 160h440M668 160h440M92 600h440M668 600h440" stroke="#d3c4a2" stroke-width="3"/>
  </svg>`;
  return sharp(Buffer.from(svg)).webp({ quality: 90 }).toBuffer();
}

async function runWorld(condition, order, value) {
  const world = value === 'E. Vale' ? 'match-intact' : 'mismatch-intact';
  const name = `${condition}-${order.join('-')}-${value.startsWith('E') ? 'match' : 'mismatch'}`;
  const replacement = condition === 'injected' ? await alteredBook(value) : null;
  if (replacement) writeFileSync(`${outDir}/${name}.webp`, replacement);
  const { app, store } = await createFixture({ researchWorlds: true, researchWorldId: world,
    provider: { model: 'fixture-model', baseUrl: 'https://example.test/v1', apiKey: 'fixture-key' },
    completion: async () => ({ text: 'These documents are mine.', model: 'fixture-model', latencyMs: 1, usage: 5 }) });
  if (replacement) app.get('/reference-assets/open-book.webp', (_req, res) => res.type('image/webp').send(replacement));
  app.use(express.static(resolve('dist/client')));
  app.get('/{*path}', (_req, res) => res.sendFile(resolve('dist/client/index.html')));
  const server = app.listen(port, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  try {
    const setup = await fetch(`${base}/api/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Study owner', email: 'temporal-asset@example.test', password: 'long-test-password' }) });
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
    const trace = [], actionFacts = {};
    async function capture(action, actionBody = null) {
      await page.waitForLoadState('networkidle');
      await page.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.images].map(img => img.decode().catch(() => {}))); });
      await Promise.all(pending);
      const png = await page.screenshot({ path: `${outDir}/${name}-${action}.png`, fullPage: true, animations: 'disabled' });
      const pixels = await sharp(png).ensureAlpha().raw().toBuffer();
      const normalized = actionBody ? normalizePlayerActionResponse(actionBody) : null;
      const snapshot = { textHash: digest(await page.locator('body').innerText()),
        accessibilityHash: digest(await page.locator('body').ariaSnapshot()),
        screenshotPixelHash: digest(pixels), coverPixelHash: '', exifHash: null,
        actionPayloadHash: normalized ? digest(JSON.stringify(normalized)) : null,
        actionPayload: normalized,
        network: received.splice(0).sort((a, b) => a.path.localeCompare(b.path)) };
      trace.push({ action, capture: snapshot, screenshotHash: digest(png) });
    }
    await page.goto(`${base}/reference/research/preview`, { waitUntil: 'networkidle' });
    await expect(page.getByRole('heading', { name: 'One last passenger', exact: true })).toBeVisible();
    await capture('intro');
    const startedResponse = page.waitForResponse(response => response.url().endsWith('/api/reference/research/preview') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Open the counter' }).click();
    const startedReply = await startedResponse;
    assert.equal(startedReply.status(), 201);
    const started = await startedReply.json();
    assert.equal(started.documents.card, null);
    await expect(page.getByText('INTERVIEW IN PROGRESS', { exact: false })).toBeVisible();
    await page.addStyleTag({ content: '.counter-status span:last-child { visibility: hidden !important; }' });
    await capture('closed', started);
    for (const action of order) {
      let actionBody;
      if (await page.getByRole('dialog').count()) await page.getByLabel('Close dialog').click();
      if (action === 'open') {
        const response = page.waitForResponse(item => item.url().includes(`/api/reference/rounds/${started.round.id}/action`) && item.request().postDataJSON()?.action === 'open');
        await page.getByRole('button', { name: 'Inspect passport', exact: true }).click();
        const body = await (await response).json();
        actionBody = body;
        if (!body.state.cardRequested) assert.equal(body.documents.card, null);
        else assert.equal(body.documents.card.signature, value);
        actionFacts.openCardRequested = body.state.cardRequested;
        await expect(page.getByRole('dialog').locator('img[src="/reference-assets/open-book.webp"]')).toBeVisible();
      } else if (action === 'card') {
        const response = page.waitForResponse(item => item.url().includes(`/api/reference/rounds/${started.round.id}/action`) && item.request().postDataJSON()?.action === 'card');
        await page.getByRole('button', { name: 'Request arrival card' }).click();
        const body = await (await response).json();
        actionBody = body;
        actionFacts.cardSignature = body.documents.card.signature;
        await page.getByRole('button', { name: 'Inspect arrival card', exact: true }).click();
        await expect(page.getByRole('dialog').getByText(value, { exact: true })).toBeVisible();
      }
      await capture(action, actionBody);
    }
    assert.deepEqual(errors, []);
    return { condition, order, value, world, name, trace, actionFacts, replacementHash: replacement ? digest(replacement) : null };
  } finally {
    await context.close();
    await new Promise(resolve => server.close(resolve));
    await store.db.close();
  }
}

try {
  const rows = [];
  for (const condition of ['clean', 'injected']) for (const order of [['open', 'card'], ['card', 'open']]) {
    for (const value of ['E. Vale', 'N. Vale']) rows.push(await runWorld(condition, order, value));
  }
  const intro = rows.map(row => row.trace[0].capture), closed = rows.map(row => row.trace[1].capture);
  for (const field of ['textHash', 'accessibilityHash', 'screenshotPixelHash']) {
    assert.equal(new Set(intro.map(row => row[field])).size, 1, `Intro ${field} differs.`);
    assert.equal(new Set(closed.map(row => row[field])).size, 1, `Closed ${field} differs.`);
  }
  assert.equal(new Set(intro.map(row => JSON.stringify(row.network))).size, 1);
  assert.equal(new Set(closed.map(row => JSON.stringify(row.network))).size, 1);
  assert.equal(new Set(closed.map(row => row.actionPayloadHash)).size, 1);
  const verdicts = [];
  for (const condition of ['clean', 'injected']) for (const order of [['open', 'card'], ['card', 'open']]) {
    const [left, right] = rows.filter(row => row.condition === condition && row.order.join(',') === order.join(','));
    assert.equal(left.actionFacts.cardSignature, 'E. Vale'); assert.equal(right.actionFacts.cardSignature, 'N. Vale');
    for (const channel of ['renderedPixels', 'downloadedBytes', 'accessibility', 'actionPayload']) {
      const result = auditTemporalObserverCut(left.trace, right.trace, { requiredAction: 'card', channel });
      verdicts.push({ condition, order, ...result });
      const expected = channel === 'accessibility' || channel === 'actionPayload' ? 'revealed-at-event'
        : channel === 'downloadedBytes' && condition === 'clean' ? 'unrevealed'
          : channel === 'downloadedBytes' && order[0] === 'card' ? 'revealed-after-event'
            : condition === 'injected' && order[0] === 'open' ? 'exposed-before-event' : 'revealed-at-event';
      assert.equal(result.status, expected, `${condition} ${order.join('→')} ${channel}`);
      if (result.status === 'exposed-before-event') {
        assert.equal(result.firstDifferentAction, 'open');
        assert.deepEqual(result.differingResources, ['/reference-assets/open-book.webp']);
      }
    }
  }
  const report = { status: 'passed', browser: browser.version(), sourceHashes, bundleHashes,
    scope: 'Two worlds, two browser action orders, clean and injected later-loading open-book asset. Exact initial and closed observations; first divergence per selected channel. SQLite, fixed viewport, deterministic completion, no OCR or all-path claim.',
    rows, verdicts };
  writeFileSync('research/temporal-asset-cut-study.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, browserFixtures: rows.length,
    cleanCardFirstReveal: true, injectedOpenBypass: true, cardFirstOrderPreserved: true }));
} finally { await browser.close(); }
