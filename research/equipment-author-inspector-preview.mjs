import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import express from 'express';
import { chromium, expect } from '@playwright/test';

const hash = value => createHash('sha256').update(value).digest('hex');
const paths = ['research/equipment-author-inspector.html', 'research/equipment-first-use-study.json',
  'research/equipment-browser-study.json', 'research/equipment-browser-protocol.json',
  'research/equipment-author-inspector-preview.mjs'];
const sourceHashes = Object.fromEntries(paths.map(path => [path, hash(readFileSync(path))]));
mkdirSync('research/inspector-equipment', { recursive: true });
const app = express();
app.use(express.static(resolve('research')));
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
    await page.goto(`${base}/equipment-author-inspector.html`, { waitUntil: 'networkidle' });
    await expect(page.getByRole('heading', { name: 'Inspection boundary' })).toBeVisible();
    await expect(page.locator('#pair figure')).toHaveCount(2);
    await expect(page.locator('#pair img').first()).toHaveJSProperty('complete', true);
    await expect(page.locator('#status')).toContainText('First screen difference: Measure voltage');
    await page.locator('#timeline button').filter({ hasText: 'Measure voltage' }).click();
    await expect(page.locator('#pair img').first()).toHaveAttribute('src', /measureVoltage\.png$/);
    await page.locator('#condition').selectOption('initialVoltageLeak');
    await expect(page.locator('#status')).toContainText('Early exposure');
    assert.ok((await page.locator('#status').getAttribute('class')).includes('leak'));
    await page.locator('#condition').selectOption('clipboardShortcut');
    await expect(page.locator('#status')).toContainText('Early exposure');
    await page.locator('#factor').selectOption('fuse');
    await page.locator('#condition').selectOption('fuseAvailabilityLeak');
    await expect(page.locator('#status')).toContainText('Early exposure');
    await page.getByRole('button', { name: 'Player view' }).click();
    await expect(page.locator('#analysis')).toBeHidden();
    await expect(page.locator('#pair figcaption strong').first()).toHaveText('World 1');
    await page.getByRole('button', { name: 'Author audit' }).click();
    await expect(page.locator('#analysis')).toBeVisible();
    await page.locator('#condition').selectOption('baseline');
    await page.locator('#path').selectOption('3');
    await expect(page.locator('#timeline button')).toHaveCount(5);
    const imageChecks = await page.locator('#pair img').evaluateAll(images => images.map(image => ({ complete: image.complete, width: image.naturalWidth })));
    assert.ok(imageChecks.every(item => item.complete && item.width > 0));
    await page.locator('#pair img').first().click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.locator('#zoom-image')).toHaveJSProperty('naturalWidth', 1280);
    await page.getByRole('button', { name: 'Close image' }).click();
    await expect(page.getByRole('dialog')).toBeHidden();
    assert.deepEqual(errors, []);
    const file = `research/inspector-equipment/${label}.png`;
    const screenshot = await page.screenshot({ path: file, fullPage: true, animations: 'disabled' });
    captures.push({ label, viewport, file, screenshotHash: hash(screenshot), imageChecks, interactionsPassed: true });
    await context.close();
  }
  const studyContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  for (const task of ['A', 'B']) for (const view of ['player', 'audit']) {
    const page = await studyContext.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${base}/equipment-author-inspector.html?study=${task}&view=${view}`, { waitUntil: 'networkidle' });
    await expect(page.locator('#toolbar')).toBeHidden();
    await expect(page.locator('#pair figure')).toHaveCount(2);
    await expect(page.locator('#timeline button')).toHaveCount(task === 'A' ? 1 : 2);
    await expect(page.locator('#analysis'))[view === 'audit' ? 'toBeVisible' : 'toBeHidden']();
    if (view === 'player') {
      await expect(page.locator('#status')).toHaveText('Two player views of the same action history.');
      await expect(page.locator('#pair figcaption strong').first()).toHaveText('World 1');
      assert.ok(!(await page.locator('body').innerText()).includes('Fuse-dependent control'));
    } else await expect(page.locator('#status')).toContainText('Early exposure');
    assert.deepEqual(errors, []);
    if (task === 'B' && view === 'player') {
      const screenshot = await page.screenshot({ path: 'research/inspector-equipment/study-player.png', fullPage: true, animations: 'disabled' });
      captures.push({ label: 'study-player', file: 'research/inspector-equipment/study-player.png', screenshotHash: hash(screenshot), interactionsPassed: true });
    }
    await page.close();
  }
  await studyContext.close();
  const report = { status: 'passed', browser: browser.version(), sourceHashes, captures,
    scope: 'Local static author-inspector prototype over saved equipment browser reports. Desktop/mobile and four locked study-view interaction checks, no human participant or production integration.' };
  writeFileSync('research/equipment-author-inspector-preview.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, captures: captures.length, interactionChecks: 6 }));
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
