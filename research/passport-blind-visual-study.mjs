import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import express from 'express';
import sharp from 'sharp';
import { chromium, expect } from '@playwright/test';
import { createFixture } from '../tests/database-fixture.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const sourceFiles = ['server/workshop.mjs', 'server/passport-reference.mjs', 'server/world-bound-template.mjs', 'src/App.tsx', 'src/PassportReference.tsx', 'research/passport-blind-visual-study.mjs'];
const sourceHashes = Object.fromEntries(sourceFiles.map(path => [path, digest(readFileSync(path))]));
const bundleFiles = ['index.html', ...readdirSync('dist/client/assets').map(name => `assets/${name}`),
  ...readdirSync('dist/client/reference-assets').map(name => `reference-assets/${name}`)];
const bundleHashes = Object.fromEntries(bundleFiles.map(path => [path, digest(readFileSync(`dist/client/${path}`))]));
const worldIds = ['match-intact', 'match-broken', 'mismatch-intact', 'mismatch-broken'];
const browser = await chromium.launch({ headless: true });
const screenshotDir = 'research/browser-blind-worlds';
mkdirSync(screenshotDir, { recursive: true });
let fixedPort = 0;

async function capture(page, file) {
  await page.evaluate(() => document.fonts.ready);
  const png = await page.screenshot({ path: `${screenshotDir}/${file}.png`, fullPage: true, animations: 'disabled' });
  const raw = await sharp(png).ensureAlpha().raw().toBuffer();
  return { text: await page.locator('body').innerText(), accessibility: await page.locator('body').ariaSnapshot(),
    pngHash: digest(png), pixelHash: digest(raw) };
}
function normalizeStarted(body) {
  const value = structuredClone(body);
  value.round.id = '<opaque-round-id>';
  value.round.accessToken = '<opaque-capability>';
  value.round.startedAt = 0; value.round.deadline = 0;
  value.round.messages = value.round.messages.map(message => ({ ...message, id: '<opaque-message-id>', createdAt: 0 }));
  if (value.state?.events) value.state.events = value.state.events.map(event => ({ ...event, id: '<opaque-event-id>', at: 0 }));
  return value;
}
async function runWorld(id, { replaceCover = false } = {}) {
  const { app, store } = await createFixture({
    researchWorlds: true, researchWorldId: id,
    provider: { model: 'fixture-model', baseUrl: 'https://example.test/v1', apiKey: 'fixture-key' },
    completion: async () => ({ text: 'These documents are mine.', model: 'fixture-model', latencyMs: 1, usage: 5 }),
  });
  if (replaceCover) app.get('/reference-assets/passport-cover.webp', (_req, res) => res.sendFile(resolve('dist/client/reference-assets/stamp.webp')));
  app.use(express.static(resolve('dist/client')));
  app.get('/{*path}', (_req, res) => res.sendFile(resolve('dist/client/index.html')));
  const server = app.listen(fixedPort, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  fixedPort = server.address().port;
  const base = `http://127.0.0.1:${fixedPort}`;
  const contexts = [];
  try {
    const setup = await fetch(`${base}/api/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Study owner', email: 'blind-visual@example.test', password: 'long-test-password' }) });
    assert.equal(setup.status, 200);
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    contexts.push(context);
    const page = await context.newPage();
    const errors = [], networkErrors = [], pending = [], responses = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => {
      if (!response.url().startsWith(base) || response.request().method() !== 'GET') return;
      pending.push((async () => {
        try {
          const bytes = await response.body();
          responses.push({ path: new URL(response.url()).pathname, status: response.status(), contentType: response.headers()['content-type'] || '', hash: digest(bytes), bytes });
        } catch (error) { networkErrors.push(error.message); }
      })());
    });
    await page.goto(`${base}/reference/research/preview`, { waitUntil: 'networkidle' });
    await expect(page.getByRole('heading', { name: 'One last passenger', exact: true })).toBeVisible();
    await Promise.all(pending);
    const configResponse = responses.find(item => item.path === '/api/reference/research/preview');
    assert.ok(configResponse);
    const config = JSON.parse(configResponse.bytes.toString('utf8'));
    assert.equal(config.documents.passport, null); assert.equal(config.documents.card, null);
    const intro = await capture(page, `intro-${id}${replaceCover ? '-asset-control' : ''}`);
    const initialNetwork = responses.map(({ path, status, contentType, hash }) => ({ path, status, contentType, hash }))
      .sort((left, right) => left.path.localeCompare(right.path) || left.hash.localeCompare(right.hash));
    const imageNetwork = initialNetwork.filter(item => item.contentType.startsWith('image/'));
    assert.ok(imageNetwork.some(item => item.path === '/reference-assets/passport-cover.webp'));
    assert.deepEqual(errors, []); assert.deepEqual(networkErrors, []);
    if (replaceCover) return { id, intro: { ...intro, configHash: digest(configResponse.bytes), initialNetwork, imageNetwork }, errors, networkErrors };

    const startResponse = page.waitForResponse(response => response.url().endsWith('/api/reference/research/preview') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Open the counter' }).click();
    const started = await (await startResponse).json();
    assert.equal(started.round.versionId, 'reference-passport-study');
    await expect(page.getByText('INTERVIEW IN PROGRESS', { exact: false })).toBeVisible();
    await page.addStyleTag({ content: '.counter-status span:last-child { visibility: hidden !important; }' });
    const closed = await capture(page, `closed-${id}`);
    const cardResponse = page.waitForResponse(response => response.url().includes(`/api/reference/rounds/${started.round.id}/action`) && response.request().postDataJSON()?.action === 'card');
    await page.getByRole('button', { name: 'Request arrival card' }).click();
    const cardBody = await (await cardResponse).json();
    await page.getByRole('button', { name: 'Inspect arrival card', exact: true }).click();
    await expect(page.getByRole('dialog').getByText(cardBody.documents.card.signature, { exact: true })).toBeVisible();
    const card = await capture(page, `card-${id}`);
    await page.getByLabel('Close dialog').click();
    const uvResponse = page.waitForResponse(response => response.url().includes(`/api/reference/rounds/${started.round.id}/action`) && response.request().postDataJSON()?.action === 'lamp');
    await page.getByRole('button', { name: 'Toggle inspection lamp' }).click();
    const uvBody = await (await uvResponse).json();
    await expect(page.getByText(uvBody.observation, { exact: true })).toBeVisible();
    const uv = await capture(page, `card-uv-${id}`);

    const second = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    contexts.push(second);
    const lampFirstPage = await second.newPage();
    await lampFirstPage.goto(`${base}/reference/research/preview`, { waitUntil: 'networkidle' });
    await lampFirstPage.getByRole('button', { name: 'Open the counter' }).click();
    await expect(lampFirstPage.getByText('INTERVIEW IN PROGRESS', { exact: false })).toBeVisible();
    await lampFirstPage.addStyleTag({ content: '.counter-status span:last-child { visibility: hidden !important; }' });
    const lampFirstResponse = lampFirstPage.waitForResponse(response => response.url().includes('/api/reference/rounds/') && response.url().endsWith('/action') && response.request().postDataJSON()?.action === 'lamp');
    await lampFirstPage.getByRole('button', { name: 'Toggle inspection lamp' }).click();
    const lampFirstBody = await (await lampFirstResponse).json();
    const lampFirst = await capture(lampFirstPage, `uv-first-${id}`);
    assert.deepEqual(errors, []); assert.deepEqual(networkErrors, []);
    return { id,
      intro: { ...intro, configHash: digest(configResponse.bytes), initialNetwork, imageNetwork },
      closed: { ...closed, normalizedRoundHash: digest(JSON.stringify(normalizeStarted(started))) },
      card: { ...card, signature: cardBody.documents.card.signature,
        normalizedResponseHash: digest(JSON.stringify(normalizeStarted(cardBody))) },
      uv: { ...uv, observation: uvBody.observation }, lampFirst,
      lampFirstResponseHash: digest(JSON.stringify(normalizeStarted(lampFirstBody))),
      errors, networkErrors };
  } finally {
    for (const context of contexts) await context.close();
    await new Promise(resolve => server.close(resolve));
    await store.db.close();
  }
}

try {
  const rows = [];
  for (const id of worldIds) rows.push(await runWorld(id));
  const same = key => new Set(rows.map(row => key(row))).size === 1;
  for (const field of ['text', 'accessibility', 'pixelHash', 'configHash']) assert.equal(same(row => row.intro[field]), true, `Initial ${field} differs.`);
  assert.equal(same(row => JSON.stringify(row.intro.initialNetwork)), true, 'Initial GET network differs.');
  assert.equal(same(row => JSON.stringify(row.intro.imageNetwork)), true, 'Initial image bytes differ.');
  assert.equal(same(row => row.closed.normalizedRoundHash), true, 'Closed round payloads differ beyond opaque values.');
  assert.equal(same(row => row.closed.text), true, 'Closed visible text differs.');
  assert.equal(same(row => row.closed.pixelHash), true, 'Closed decoded pixels differ.');
  for (const row of rows) {
    assert.equal(row.card.signature, row.id.startsWith('match-') ? 'E. Vale' : 'N. Vale');
    assert.equal(row.uv.observation.includes(row.id.endsWith('-intact') ? 'intact' : 'broken'), true);
    assert.equal(row.lampFirst.text.includes('N. Vale'), false, 'UV-first path exposed the unrequested card signature.');
  }
  const cardGroups = Object.groupBy(rows, row => row.card.signature);
  for (const group of Object.values(cardGroups)) {
    assert.equal(new Set(group.map(row => row.card.pixelHash)).size, 1, 'UV changed card-only pixels.');
    assert.equal(new Set(group.map(row => row.card.accessibility)).size, 1, 'UV changed card-only accessibility.');
    assert.equal(new Set(group.map(row => row.card.normalizedResponseHash)).size, 1, 'UV changed card-only response.');
  }
  const uvGroups = Object.groupBy(rows, row => row.id.endsWith('-intact') ? 'intact' : 'broken');
  for (const group of Object.values(uvGroups)) {
    assert.equal(new Set(group.map(row => row.lampFirst.pixelHash)).size, 1, 'Card relation changed UV-first pixels.');
    assert.equal(new Set(group.map(row => row.lampFirst.accessibility)).size, 1, 'Card relation changed UV-first accessibility.');
    assert.equal(new Set(group.map(row => row.lampFirstResponseHash)).size, 1, 'Card relation changed UV-first response.');
  }
  assert.notEqual(cardGroups['E. Vale'][0].card.pixelHash, cardGroups['N. Vale'][0].card.pixelHash);
  assert.notEqual(uvGroups.intact[0].lampFirst.pixelHash, uvGroups.broken[0].lampFirst.pixelHash);
  const control = await runWorld('match-intact', { replaceCover: true });
  const baseline = rows[0];
  assert.equal(control.intro.configHash, baseline.intro.configHash, 'Asset control changed player configuration.');
  assert.equal(control.intro.text, baseline.intro.text, 'Asset control changed rendered text.');
  assert.notEqual(control.intro.pixelHash, baseline.intro.pixelHash, 'Asset control did not change intro pixels.');
  assert.notEqual(JSON.stringify(control.intro.imageNetwork), JSON.stringify(baseline.intro.imageNetwork), 'Asset control did not change image bytes.');
  const screenshotHashes = Object.fromEntries([...worldIds.flatMap(id => [`intro-${id}`, `closed-${id}`, `card-${id}`, `card-uv-${id}`, `uv-first-${id}`]), 'intro-match-intact-asset-control']
    .map(name => [name, digest(readFileSync(`${screenshotDir}/${name}.png`))]));
  const report = {
    status: 'passed', browser: browser.version(), sourceHashes, bundleHashes, screenshotHashes,
    scope: 'Four isolated local worlds on one player path and port; same built client and fresh browser context per world. Initial full-page decoded pixels and GET bodies compared exactly. Closed round payload normalized only for opaque IDs, token, and clock. Two first-use action orders. No live model or image OCR.',
    initial: { path: '/reference/research/preview', textHash: digest(baseline.intro.text), accessibilityHash: digest(baseline.intro.accessibility), pixelHash: baseline.intro.pixelHash, configHash: baseline.intro.configHash, network: baseline.intro.initialNetwork },
    worlds: rows.map(row => ({ id: row.id, closedPixelHash: row.closed.pixelHash, closedRoundHash: row.closed.normalizedRoundHash,
      cardSignature: row.card.signature, cardPixelHash: row.card.pixelHash,
      cardAccessibilityHash: digest(row.card.accessibility), cardResponseHash: row.card.normalizedResponseHash,
      uvObservation: row.uv.observation,
      uvFirstPixelHash: row.lampFirst.pixelHash, uvFirstAccessibilityHash: digest(row.lampFirst.accessibility),
      uvFirstResponseHash: row.lampFirstResponseHash, cardUvPixelHash: row.uv.pixelHash })),
    rasterControl: { sameConfig: true, sameRenderedText: true, imageNetworkChanged: true, introPixelsChanged: true,
      baselinePixelHash: baseline.intro.pixelHash, substitutedPixelHash: control.intro.pixelHash },
  };
  writeFileSync('research/passport-blind-visual-study.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, worlds: rows.length, introPixelsIdentical: true, introNetworkIdentical: true, twoActionOrders: true, rasterControlDetected: true }));
} finally { await browser.close(); }
