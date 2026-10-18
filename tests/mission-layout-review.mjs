import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

const url = process.argv[2] || 'http://127.0.0.1:4325/mission-client/index.html';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const pageErrors = [];
page.on('pageerror', error => pageErrors.push(error.message));
page.on('console', message => { if (message.type() === 'error') pageErrors.push(message.text()); });
await page.route('**/api/**', route => route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'Layout review fixture.' }) }));

try {
  await page.goto(url);
  await page.locator('#archive-screen').waitFor({ state: 'attached' });
  await page.evaluate(async () => {
    document.querySelectorAll('.screen').forEach(screen => { screen.hidden = true; });
    document.querySelector('#archive-screen').hidden = false;
    await document.fonts.load('20px Terminess');
  });
  await page.waitForTimeout(500);

  const measure = () => page.evaluate(() => {
    const box = selector => {
      const { x, y, width, height, right, bottom } = document.querySelector(selector).getBoundingClientRect();
      return { x, y, width, height, right, bottom };
    };
    const canvas = document.querySelector('.crt-effect');
    const gl = canvas.getContext('webgl2');
    const input = document.querySelector('#terminal-input');
    return {
      viewport: { width: innerWidth, height: innerHeight },
      screen: box('#terminal-screen'), canvas: box('.crt-effect'), input: box('#terminal-input'),
      font: Number.parseFloat(getComputedStyle(input).fontSize), canvasWidth: canvas.width,
      canvasHeight: canvas.height, webgl: gl?.getParameter(gl.VERSION) || null,
      inputHit: document.elementFromPoint(box('#terminal-input').x + 12, box('#terminal-input').y + 12)?.closest('textarea')?.id || null,
      overflow: document.documentElement.scrollWidth > innerWidth || document.documentElement.scrollHeight > innerHeight,
      obsoleteControls: ['#open-service', '#open-evidence', '#eject-button', '#service-note', '#evidence-list'].filter(selector => document.querySelector(selector)),
    };
  });

  const results = [];
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport);
    await page.waitForTimeout(180);
    const layout = await measure();
    assert.ok(layout.screen.width > 0 && layout.screen.height > 0, 'CRT screen remains visible');
    assert.ok(layout.input.x >= 0 && layout.input.right <= viewport.width, 'composer stays inside the viewport');
    assert.ok(layout.input.height >= 32, 'composer stays touch usable');
    assert.ok(layout.font >= 16, 'mobile composer text remains readable');
    assert.equal(layout.inputHit, 'terminal-input', 'composer receives pointer input');
    assert.equal(layout.webgl?.includes('WebGL 2'), true, 'WebGL 2 is available');
    assert.ok(layout.canvasWidth > 0 && layout.canvasHeight > 0, 'CRT backing buffer was allocated');
    assert.deepEqual(layout.obsoleteControls, [], 'rejected equipment UI is absent');
    assert.equal(layout.overflow, false, 'screen fits the viewport');
    if (viewport.height < 500) await page.screenshot({ path: 'test-results/mission-layout-landscape.png', fullPage: true });
    results.push(layout);
  }
  assert.deepEqual(pageErrors, []);
  console.log(JSON.stringify({ status: 'passed', layouts: results }, null, 2));
} finally {
  await browser.close();
}
