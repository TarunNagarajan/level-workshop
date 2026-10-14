import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import express from 'express';
import { chromium, expect } from '@playwright/test';
import { createFixture } from '../tests/database-fixture.mjs';
import { compileVisibilityManifest } from './visibility-manifest.mjs';

const { app, store } = await createFixture({
  provider: { model: 'fixture-model', baseUrl: 'https://example.test/v1', apiKey: 'fixture-key' },
  completion: async () => ({ text: 'The documents are mine.', model: 'fixture-model', latencyMs: 1, usage: 1 }),
});
app.use(express.static(resolve('dist/client')));
app.get('/{*path}', (req, res) => res.sendFile(resolve('dist/client/index.html')));
const server = app.listen(0, '127.0.0.1');
await new Promise(done => server.once('listening', done));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
const mismatch = (_, leaves) => {
  const passport = leaves.filter(leaf => leaf.text.includes('E. Vale'));
  const card = leaves.filter(leaf => leaf.text.includes('N. Vale'));
  return passport.length && card.length ? [passport[0].path, card[0].path] : [];
};
const facts = [
  { id: 'passportSignature', variants: ['E. Vale'] },
  { id: 'cardSignature', variants: ['N. Vale'] },
  { id: 'signatureMismatch', derive: mismatch },
  { id: 'stampDate', variants: ['14 MAR 2024', '14 March 2024'] },
  { id: 'uvIntact', variants: ['thread is intact', 'document is genuine and unaltered'] },
  { id: 'protectedTravellerName', variants: ['Noah Vale'] },
];
const sourceHashes = Object.fromEntries(['src/PassportReference.tsx', 'server/passport-reference.mjs', 'research/visibility-manifest.mjs', 'research/reference-dom-visibility.mjs'].map(name => [name, createHash('sha256').update(readFileSync(name)).digest('hex')]));
const bundleFiles = ['index.html', ...readdirSync('dist/client/assets').filter(name => /\.(?:js|css|svg)$/.test(name)).map(name => `assets/${name}`)];
const bundleHashes = Object.fromEntries(bundleFiles.map(name => [name, createHash('sha256').update(readFileSync(`dist/client/${name}`)).digest('hex')]));
const screenshotDir = process.env.TEST_DATABASE === 'postgres'
  ? 'research/browser-visibility-postgres' : 'research/browser-visibility';
mkdirSync(screenshotDir, { recursive: true });
try {
  const owner = await browser.newContext();
  const setup = await owner.request.post(`${base}/api/setup`, { data: { name: 'DOM owner', email: 'dom-visibility@example.test', password: 'long-test-password' } });
  assert.equal(setup.status(), 200);
  const linkResponse = await owner.request.post(`${base}/api/reference/links`, { data: {} });
  assert.equal(linkResponse.status(), 200);
  const link = await linkResponse.json();
  const blind = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await blind.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  const responses = []; const pendingResponses = []; const networkErrors = [];
  const safePath = url => new URL(url).pathname
    .replace(/\/reference\/play\/[^/]+/, '/reference/play/:token')
    .replace(/\/api\/reference\/play\/[^/]+/, '/api/reference/play/:token')
    .replace(/\/api\/reference\/rounds\/[^/]+/, '/api/reference/rounds/:id');
  page.on('response', response => {
    if (!response.url().startsWith(base)) return;
    const path = safePath(response.url());
    const contentType = response.headers()['content-type'] || '';
    if (!(/json|javascript|text\/css|text\/html/.test(contentType))) return;
    pendingResponses.push((async () => {
      try {
        const raw = await response.text();
        const body = contentType.includes('json') ? JSON.parse(raw) : raw;
        responses.push({ path, status: response.status(), kind: path.startsWith('/api/') ? 'api' : 'asset', body });
      } catch (error) { networkErrors.push({ path, message: error.message }); }
    })());
  });
  await page.goto(`${base}${link.path}`);
  await expect(page.getByRole('heading', { name: 'One last passenger', exact: true })).toBeVisible();
  const frames = [];
  const visibleHistory = [];
  const accessibleHistory = [];
  async function capture(stage, screenshot = false) {
    await Promise.allSettled(pendingResponses.splice(0));
    const renderedText = await page.locator('body').innerText();
    const domText = await page.locator('body').textContent();
    const accessible = await page.locator('body').ariaSnapshot();
    visibleHistory.push(renderedText);
    accessibleHistory.push(accessible);
    frames.push({ stage, surfaces: {
      renderedText, domText, accessible,
      cumulativeRenderedText: visibleHistory.join('\n'),
      cumulativeAccessibility: accessibleHistory.join('\n'),
      browserApiResponses: responses.filter(item => item.kind === 'api').map(({ path, status, body }) => ({ path, status, body })),
      browserTextAssets: responses.filter(item => item.kind === 'asset').map(({ path, status, body }) => ({ path, status, body })),
    } });
    if (screenshot) await page.screenshot({ path: `${screenshotDir}/${stage}.png`, fullPage: false, animations: 'disabled' });
  }
  await capture('intro');
  await page.getByLabel('Your name').fill('Blind observer');
  await page.getByRole('button', { name: 'Open the counter' }).click();
  await expect(page.getByText('INTERVIEW IN PROGRESS', { exact: false })).toBeVisible();
  await capture('closed', true);
  await page.getByRole('button', { name: 'Inspect passport', exact: true }).click();
  await expect(page.getByRole('dialog').getByText('E. Vale', { exact: true })).toBeVisible();
  await capture('opened', true);
  await page.getByRole('dialog').getByRole('button', { name: 'Turn page', exact: true }).click();
  await expect(page.getByRole('dialog').getByText('14 MAR 2024', { exact: true })).toBeVisible();
  await capture('turned');
  await page.getByLabel('Close dialog').click();
  await page.getByRole('button', { name: 'Request arrival card' }).click();
  await expect(page.getByText('Signed N. Vale.', { exact: false })).toBeVisible();
  await capture('card', true);
  await page.getByRole('button', { name: 'Compare signatures', exact: true }).click();
  await expect(page.getByRole('dialog').getByText('N. Vale', { exact: true })).toBeVisible();
  await capture('compared', true);
  await page.getByLabel('Close dialog').click();
  await page.getByRole('button', { name: 'Toggle inspection lamp' }).click();
  await expect(page.getByText('The UV security thread is intact.', { exact: false })).toBeVisible();
  await capture('uv');
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(networkErrors, []);
  const boundaries = {
    visibleNow: ['renderedText'],
    accessibleNow: ['accessible'],
    domText: ['domText'],
    visibleHistory: ['cumulativeRenderedText', 'cumulativeAccessibility'],
    browserNetworkApi: ['browserApiResponses'],
    browserNetworkAssets: ['browserTextAssets'],
    browserNetworkAccessible: ['browserApiResponses', 'browserTextAssets'],
  };
  const rules = [
    ...['passportSignature', 'cardSignature', 'signatureMismatch', 'stampDate', 'uvIntact'].map((factId, index) => ({ factId, boundary: 'visibleHistory', earliestStage: ['opened', 'card', 'compared', 'turned', 'uv'][index], mustReveal: true })),
    { factId: 'protectedTravellerName', boundary: 'visibleHistory', never: true },
    ...['passportSignature', 'cardSignature', 'signatureMismatch', 'stampDate', 'uvIntact'].map((factId, index) =>
      ({ factId, boundary: 'browserNetworkAccessible', earliestStage: ['opened', 'card', 'compared', 'turned', 'uv'][index], mustReveal: true })),
    { factId: 'protectedTravellerName', boundary: 'browserNetworkAccessible', never: true },
  ];
  const manifest = compileVisibilityManifest({ facts, frames, boundaries, rules });
  assert.equal(manifest.firstByBoundary.passportSignature.visibleNow.stage, 'opened');
  assert.equal(manifest.firstByBoundary.cardSignature.visibleNow.stage, 'card');
  assert.equal(manifest.firstByBoundary.stampDate.visibleNow.stage, 'turned');
  assert.equal(manifest.firstByBoundary.uvIntact.visibleNow.stage, 'uv');
  assert.equal(manifest.firstByBoundary.signatureMismatch.visibleHistory.stage, 'card');
  assert.equal(manifest.firstByBoundary.protectedTravellerName.visibleHistory, null);
  assert.equal(manifest.firstByBoundary.passportSignature.browserNetworkApi.stage, 'opened');
  assert.equal(manifest.firstByBoundary.cardSignature.browserNetworkApi.stage, 'card');
  assert.equal(manifest.firstByBoundary.signatureMismatch.browserNetworkApi.stage, 'card');
  assert.equal(manifest.firstByBoundary.stampDate.browserNetworkApi.stage, 'turned');
  assert.equal(manifest.firstByBoundary.stampDate.browserNetworkAssets, null);
  assert.equal(manifest.firstByBoundary.uvIntact.browserNetworkAccessible.stage, 'uv');
  assert.equal(manifest.firstByBoundary.protectedTravellerName.browserNetworkAccessible, null);
  const report = {
    boundary: 'Actual local blind-player Chromium DOM text, accessibility snapshots, and same-origin JSON/text response bodies along one UI path. Network response bodies are scanned in memory and not archived. Cumulative surfaces represent facts a player could retain from prior screens or inspect in the browser. Excludes image OCR, live deployment, and alternate click paths.',
    sourceHashes, bundleHashes,
    screenshotHashes: Object.fromEntries(['closed', 'opened', 'card', 'compared'].map(stage => [stage, createHash('sha256').update(readFileSync(`${screenshotDir}/${stage}.png`)).digest('hex')])),
    browser: browser.version(), viewport: { width: 1440, height: 1000 }, pageErrors, networkErrors,
    networkResponseCount: responses.length,
    networkResponseHashes: responses.map(({ path, status, kind, body }) => ({ path, status, kind,
      hash: createHash('sha256').update(JSON.stringify(body)).digest('hex') })),
    ...manifest,
  };
  const outputPath = process.env.TEST_DATABASE === 'postgres'
    ? 'research/reference-dom-visibility-postgres.json' : 'research/reference-dom-visibility.json';
  writeFileSync(outputPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ outputPath, browser: report.browser, status: report.status, stages: report.stages, verdicts: report.verdicts.map(({ factId, status, firstExposure }) => ({ factId, status, firstStage: firstExposure?.stage ?? null })), screenshots: ['closed', 'opened', 'card', 'compared'] }, null, 2));
  await blind.close();
  await owner.close();
} finally {
  await browser.close();
  await new Promise(done => server.close(done));
  await store.db.close();
}
