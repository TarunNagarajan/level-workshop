import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import express from 'express';
import sharp from 'sharp';
import { chromium, expect } from '@playwright/test';
import { createFixture } from '../tests/database-fixture.mjs';
import { certifyObserverCut } from './observer-relative-cut.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const outDir = 'research/browser-asset-facts';
mkdirSync(outDir, { recursive: true });
const sourceFiles = ['server/workshop.mjs', 'server/passport-reference.mjs', 'src/App.tsx', 'src/PassportReference.tsx',
  'research/observer-relative-cut.mjs', 'research/asset-fact-boundary-study.mjs'];
const sourceHashes = Object.fromEntries(sourceFiles.map(path => [path, digest(readFileSync(path))]));
const bundleFiles = ['index.html', ...readdirSync('dist/client/assets').map(name => `assets/${name}`),
  ...readdirSync('dist/client/reference-assets').map(name => `reference-assets/${name}`)];
const bundleHashes = Object.fromEntries(bundleFiles.map(path => [path, digest(readFileSync(`dist/client/${path}`))]));
const browser = await chromium.launch({ headless: true });
let port = 0;

async function cover(carrier, value) {
  const label = carrier === 'raster' ? value : 'INSPECTION COPY';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1110" viewBox="0 0 800 1110">
    <rect width="800" height="1110" rx="35" fill="#571f25"/>
    <rect x="18" y="18" width="764" height="1074" rx="27" fill="none" stroke="#bda46c" stroke-width="4"/>
    <text x="400" y="190" text-anchor="middle" fill="#d7c389" font-family="Georgia,serif" font-size="61" letter-spacing="8">RIVOMARA</text>
    <path d="M400 376v230m0-120c-90-100-115-70-70 0m70 36c90-100 115-70 70 0" fill="none" stroke="#bda46c" stroke-width="12"/>
    <rect x="105" y="655" width="590" height="170" fill="#e8dcc0" stroke="#ad955c" stroke-width="5"/>
    <text x="400" y="713" text-anchor="middle" fill="#4b3030" font-family="Georgia,serif" font-size="30">CARD SIGNATURE</text>
    <text x="400" y="785" text-anchor="middle" fill="#301d22" font-family="Georgia,serif" font-size="65">${label}</text>
    <text x="400" y="963" text-anchor="middle" fill="#d7c389" font-family="Georgia,serif" font-size="65" letter-spacing="5">PASSPORT</text>
  </svg>`;
  let pipeline = sharp(Buffer.from(svg)).webp({ quality: 90 });
  if (carrier === 'metadata') pipeline = pipeline.withExif({ IFD0: { ImageDescription: `card-signature=${value}` } });
  return pipeline.toBuffer();
}

async function run(carrier, value) {
  const world = value === 'E. Vale' ? 'match-intact' : 'mismatch-intact';
  const bytes = await cover(carrier, value);
  const name = `${carrier}-${value.startsWith('E') ? 'match' : 'mismatch'}`;
  writeFileSync(`${outDir}/${name}.webp`, bytes);
  const { app, store } = await createFixture({ researchWorlds: true, researchWorldId: world,
    provider: { model: 'fixture-model', baseUrl: 'https://example.test/v1', apiKey: 'fixture-key' },
    completion: async () => ({ text: 'These documents are mine.', model: 'fixture-model', latencyMs: 1, usage: 5 }) });
  app.get('/reference-assets/passport-cover.webp', (_req, res) => res.type('image/webp').send(bytes));
  app.use(express.static(resolve('dist/client')));
  app.get('/{*path}', (_req, res) => res.sendFile(resolve('dist/client/index.html')));
  const server = app.listen(port, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  try {
    const page = await context.newPage(), errors = [], responses = [], pending = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => {
      if (!response.url().startsWith(base) || response.request().method() !== 'GET') return;
      pending.push((async () => {
        const body = await response.body();
        responses.push({ path: new URL(response.url()).pathname, status: response.status(), hash: digest(body),
          contentType: response.headers()['content-type'] || '' });
      })());
    });
    await page.goto(`${base}/reference/research/preview`, { waitUntil: 'networkidle' });
    await expect(page.getByRole('heading', { name: 'One last passenger', exact: true })).toBeVisible();
    await Promise.all(pending);
    assert.deepEqual(errors, []);
    const text = await page.locator('body').innerText(), accessibility = await page.locator('body').ariaSnapshot();
    const png = await page.screenshot({ path: `${outDir}/${name}.png`, fullPage: true, animations: 'disabled' });
    const screenshotPixels = await sharp(png).ensureAlpha().raw().toBuffer();
    const coverPixels = await sharp(bytes).ensureAlpha().raw().toBuffer();
    const metadata = await sharp(bytes).metadata();
    const network = responses.sort((a, b) => a.path.localeCompare(b.path));
    assert.equal(network.find(row => row.path === '/reference-assets/passport-cover.webp')?.hash, digest(bytes));
    assert.equal(network.find(row => row.path === '/api/reference/research/preview')?.status, 200);
    return { carrier, value, world, textHash: digest(text), accessibilityHash: digest(accessibility),
      screenshotPixelHash: digest(screenshotPixels), screenshotHash: digest(png), coverPixelHash: digest(coverPixels),
      coverByteHash: digest(bytes), exifHash: metadata.exif ? digest(metadata.exif) : null,
      exifContainsValue: metadata.exif?.includes(Buffer.from(`card-signature=${value}`)) ?? false,
      network, errors };
  } finally {
    await context.close();
    await new Promise(resolve => server.close(resolve));
    await store.db.close();
  }
}

try {
  const rows = [];
  for (const carrier of ['raster', 'metadata']) for (const value of ['E. Vale', 'N. Vale']) rows.push(await run(carrier, value));
  assert.equal(new Set(rows.map(row => row.textHash)).size, 1);
  assert.equal(new Set(rows.map(row => row.accessibilityHash)).size, 1);
  assert.equal(new Set(rows.map(row => JSON.stringify(row.network.filter(item => item.path !== '/reference-assets/passport-cover.webp')))).size, 1);
  const cuts = {};
  for (const carrier of ['raster', 'metadata']) {
    const [a, b] = rows.filter(row => row.carrier === carrier);
    const screen = certifyObserverCut(a, b, ['domText', 'accessibility', 'renderedPixels']);
    const downloadable = certifyObserverCut(a, b, ['downloadedBytes']);
    cuts[carrier] = { screen, downloadable };
    assert.equal(screen.channels.resourceRequests, true);
    assert.deepEqual(screen.differingRequests, []);
    assert.equal(a.textHash, b.textHash); assert.equal(a.accessibilityHash, b.accessibilityHash);
    assert.deepEqual(a.network.map(row => [row.path, row.status, row.contentType]), b.network.map(row => [row.path, row.status, row.contentType]));
    const differingPaths = a.network.filter((row, index) => row.hash !== b.network[index].hash).map(row => row.path);
    assert.deepEqual(differingPaths, ['/reference-assets/passport-cover.webp']);
    assert.notEqual(a.coverByteHash, b.coverByteHash);
    if (carrier === 'raster') {
      assert.equal(screen.status, 'exposed'); assert.equal(downloadable.status, 'exposed');
      assert.notEqual(a.coverPixelHash, b.coverPixelHash);
      assert.notEqual(a.screenshotPixelHash, b.screenshotPixelHash);
      assert.equal(a.exifHash, null); assert.equal(b.exifHash, null);
    } else {
      assert.equal(screen.status, 'equivalent'); assert.equal(downloadable.status, 'exposed');
      assert.equal(a.coverPixelHash, b.coverPixelHash);
      assert.equal(a.screenshotPixelHash, b.screenshotPixelHash);
      assert.notEqual(a.exifHash, b.exifHash);
      assert.equal(a.exifContainsValue, true); assert.equal(b.exifContainsValue, true);
    }
  }
  const report = { status: 'passed', browser: browser.version(), sourceHashes, bundleHashes,
    scope: 'Two counterfactual card-signature values crossed with visible-raster and metadata carriers at the same pre-card asset URL. One local Chromium viewport; SQLite fixtures; no OCR, live provider, or general image-semantic certificate.',
    pairs: rows.map(({ carrier, value, world, textHash, accessibilityHash, screenshotPixelHash, screenshotHash,
      coverPixelHash, coverByteHash, exifHash, exifContainsValue, network }) => ({ carrier, value, world,
      textHash, accessibilityHash, screenshotPixelHash, screenshotHash, coverPixelHash, coverByteHash,
      exifHash, exifContainsValue, network })),
    cuts, witness: { firstDifferingResource: '/reference-assets/passport-cover.webp',
      raster: 'same API/DOM/accessibility; different cover bytes, cover pixels and screenshot pixels',
      metadata: 'same API/DOM/accessibility and decoded pixels; different cover bytes and EXIF ImageDescription' } };
  writeFileSync('research/asset-fact-boundary-study.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, fixtures: rows.length, rasterPixelLeak: true, metadataByteLeak: true }));
} finally { await browser.close(); }
