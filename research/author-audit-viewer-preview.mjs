import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import express from 'express';
import { chromium, expect } from '@playwright/test';

const hash = value => createHash('sha256').update(value).digest('hex');
const sourceFiles = ['research/author-audit-viewer.html', 'research/author-audit-equipment.json',
  'research/author-audit-passport.json', 'research/author-audit-viewer-preview.mjs'];
const sourceHashes = Object.fromEntries(sourceFiles.map(path => [path, hash(readFileSync(path))]));
mkdirSync('research/inspector-bundles', { recursive: true });
const app = express(); app.use(express.static(resolve('research')));
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
try {
  const captures = [];
  for (const [viewport, label] of [[{ width: 1440, height: 980 }, 'desktop'], [{ width: 390, height: 844 }, 'mobile']]) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${base}/author-audit-viewer.html`, { waitUntil: 'networkidle' });
    await expect(page.getByRole('heading', { name: 'Inspection bay · interaction audit' })).toBeVisible();
    await expect(page.locator('#pair img')).toHaveCount(2);
    await page.locator('#scenario').selectOption({ label: 'Injected control: fuseAvailabilityLeak' });
    await expect(page.locator('#status')).toContainText('before Inspect fuse');
    await expect(page.locator('#status')).toHaveClass(/leak/);
    await expect(page.locator('.pixel-region')).toHaveCount(2);
    await expect(page.locator('#audit')).toContainText('/api/state');
    await page.locator('#scenario').selectOption({ label: 'Injected control: order-sensitive voltage' });
    await expect(page.locator('#status')).toContainText('before Measure voltage');
    await page.locator('#timeline button').filter({ hasText: 'Move clipboard' }).click();
    await expect(page.locator('#audit')).toContainText('/api/debug-voltage');
    await expect(page.locator('.pixel-region')).toHaveCount(2);
    await page.getByRole('button', { name: 'Player view' }).click();
    await expect(page.locator('#audit')).toBeHidden();
    await expect(page.locator('.pixel-region')).toHaveCount(0);
    await expect(page.locator('#pair figcaption strong').first()).toHaveText('World 1');
    await page.getByRole('button', { name: 'Author audit' }).click();
    await page.locator('#scene').selectOption('passport');
    await expect(page.getByRole('heading', { name: 'Passport counter · interaction audit' })).toBeVisible();
    await page.locator('#scenario').selectOption({ label: 'Injected art: open then card' });
    await expect(page.locator('#status')).toContainText('before Request card');
    await expect(page.locator('#audit')).toContainText('Downloaded GET bytes');
    await page.locator('#timeline button').filter({ hasText: 'Open passport' }).click();
    await expect(page.locator('#pair img').first()).toHaveAttribute('src', /-open\.png$/);
    await expect(page.locator('.pixel-region')).toHaveCount(2);
    await expect(page.locator('#audit')).toContainText('/reference-assets/open-book.webp');
    await expect(page.locator('#audit')).toContainText('screen pixels differ');
    const loaded = await page.locator('#pair img').evaluateAll(images => images.map(image => image.complete && image.naturalWidth > 0));
    assert.ok(loaded.every(Boolean));
    await page.locator('#pair img').first().click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('button', { name: 'Close image' }).click();
    await expect(page.getByRole('dialog')).toBeHidden();
    assert.deepEqual(errors, []);
    const file = `research/inspector-bundles/${label}.png`;
    const png = await page.screenshot({ path: file, fullPage: true, animations: 'disabled' });
    captures.push({ label, file, screenshotHash: hash(png), checksPassed: true });
    await context.close();
  }
  const report = { status: 'passed', browser: browser.version(), sourceHashes, captures,
    scope: 'Generic schema-v1 author viewer over equipment and passport audit bundles. Local desktop/mobile interactions, no production integration or human usability result.' };
  writeFileSync('research/author-audit-viewer-preview.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, bundles: 2, viewports: captures.length }));
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
