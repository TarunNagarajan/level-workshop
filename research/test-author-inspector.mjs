import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import express from 'express';
import { chromium, expect } from '@playwright/test';

const app = express();
app.use(express.static(resolve('research')));
const server = app.listen(0, '127.0.0.1');
await new Promise(done => server.once('listening', done));
const browser = await chromium.launch({ headless: true });
const base = `http://127.0.0.1:${server.address().port}/author-inspector.html`;
const errors = [];
mkdirSync('research/inspector-visibility', { recursive: true });
try {
  const desktop = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  desktop.on('pageerror', error => errors.push(error.message));
  await desktop.goto(base);
  await expect(desktop.getByRole('heading', { name: 'Dependency inspector' })).toBeVisible();
  await expect(desktop.getByText('Earlier reveals make this claim impossible')).toBeVisible();
  await expect(desktop.getByText('Open, then request the card')).toBeVisible();
  const browserTrace = desktop.getByRole('heading', { name: 'Actual blind-browser trace' }).locator('..');
  assert.match(await browserTrace.innerText(), /Network first exposure: card/);
  assert.match(await browserTrace.innerText(), /history first exposure: card/);
  await desktop.screenshot({ path: 'research/inspector-visibility/desktop.png', fullPage: true });
  await desktop.getByRole('button', { name: 'Next' }).click();
  await desktop.getByRole('button', { name: 'Next' }).click();
  await expect(desktop.getByText('The player now has both ingredients', { exact: false })).toBeVisible();
  await desktop.getByRole('group', { name: 'Information boundary' }).getByRole('button', { name: 'Player API and assets' }).click();
  await desktop.getByRole('group', { name: 'Proposed reveal' }).getByRole('button', { name: 'Turn page' }).click();
  await expect(desktop.getByText('No early proof from this preflight')).toBeVisible();
  assert.match(await browserTrace.innerText(), /Network first exposure: turned/);
  assert.match(await browserTrace.innerText(), /history first exposure: turned/);
  await desktop.getByRole('group', { name: 'Proposed reveal' }).getByRole('button', { name: 'Use UV lamp' }).click();
  await expect(desktop.getByText('No early proof from this preflight')).toBeVisible();
  assert.match(await browserTrace.innerText(), /Network first exposure: uv/);
  assert.equal((await desktop.locator('body').innerText()).includes('Noah Vale'), false);
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
  mobile.on('pageerror', error => errors.push(error.message));
  await mobile.goto(base);
  await expect(mobile.getByText('Earlier reveals make this claim impossible')).toBeVisible();
  await mobile.screenshot({ path: 'research/inspector-visibility/mobile.png', fullPage: true });
  assert.deepEqual(errors, []);
  const sourceFiles = ['research/author-inspector.html', 'research/reference-prerequisite-audit.json', 'research/reference-reveal-repairs.json', 'research/reference-dom-visibility.json', 'research/test-author-inspector.mjs'];
  const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex');
  const report = { browser: browser.version(), desktop: { width: 1440, height: 1000 }, mobile: { width: 390, height: 844 }, pageErrors: errors,
    interactions: ['compare proof and browser exposure', 'bypass step replay', 'delayed stamp with browser timing', 'UV no-early-proof and browser timing'],
    sourceHashes: Object.fromEntries(sourceFiles.map(path => [path, digest(path)])),
    screenshotHashes: Object.fromEntries(['desktop', 'mobile'].map(name => [name, digest(`research/inspector-visibility/${name}.png`)])) };
  writeFileSync('research/author-inspector-preview.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ browser: report.browser, interactions: report.interactions.length, pageErrors: errors.length, screenshots: Object.keys(report.screenshotHashes).length }));
} finally {
  await browser.close();
  await new Promise(done => server.close(done));
}
