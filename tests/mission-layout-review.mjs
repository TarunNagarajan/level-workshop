import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

const url = process.argv[2] || 'http://127.0.0.1:4392/mission-client/index.html';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 1 });
const pageErrors = [];
page.on('pageerror', error => pageErrors.push(error.message));
await page.route('**/api/**', route => route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'Layout review fixture.' }) }));

try {
  await page.goto(url);
  await page.locator('#archive-screen').waitFor({ state: 'attached' });
  await page.evaluate(() => {
    document.querySelectorAll('.screen').forEach(screen => { screen.hidden = true; });
    document.querySelector('#archive-screen').hidden = false;
  });

  const measure = () => page.evaluate(() => {
    const box = selector => {
      const { x, y, width, height, right, bottom } = document.querySelector(selector).getBoundingClientRect();
      return { x, y, width, height, right, bottom };
    };
    const hit = selector => {
      const element = document.querySelector(selector);
      const rect = element.getBoundingClientRect();
      const target = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      return target?.closest('button')?.id || target?.id || null;
    };
    return {
      viewport: { width: innerWidth, height: innerHeight },
      stage: box('.scene-stage'), glass: box('#terminal-window'), input: box('#terminal-input'),
      status: box('#mission-status'), actions: box('.bench-actions'),
      focusedFont: Number.parseFloat(getComputedStyle(document.querySelector('#terminal-log')).fontSize),
      composerFont: Number.parseFloat(getComputedStyle(document.querySelector('#terminal-input')).fontSize),
      hits: Object.fromEntries(['#focus-screen', '#open-service', '#open-evidence', '#eject-button', '#terminal-input'].map(selector => [selector, hit(selector)])),
      overflow: document.documentElement.scrollWidth > innerWidth || document.documentElement.scrollHeight > innerHeight,
    };
  });

  const assertFocusedLayout = async ({ inputWidth, inputHeight, font }) => {
    const layout = await measure();
    assert.ok(layout.status.bottom <= layout.actions.y, 'status and action bar reserve separate rows');
    assert.ok(layout.glass.x >= layout.stage.x - 1 && layout.glass.right <= layout.stage.right + 1, 'focused terminal glass fits stage width');
    assert.ok(layout.glass.y >= layout.stage.y - 1 && layout.glass.bottom <= layout.stage.bottom + 1, 'focused terminal glass fits between chrome');
    assert.ok(layout.input.x >= layout.glass.x - 1 && layout.input.right <= layout.glass.right + 1, 'composer fits terminal glass');
    assert.ok(layout.input.y >= layout.glass.y - 1 && layout.input.bottom <= layout.glass.bottom + 1, 'composer remains visible in terminal glass');
    assert.ok(layout.input.width >= inputWidth && layout.input.height >= inputHeight, 'composer remains usable');
    assert.ok(layout.focusedFont >= font, 'focused conversation text remains readable');
    assert.equal(layout.overflow, false, 'layout does not overflow viewport');
    for (const [selector, id] of Object.entries({ '#focus-screen': 'focus-screen', '#open-service': 'open-service', '#open-evidence': 'open-evidence', '#eject-button': 'eject-button', '#terminal-input': 'terminal-input' })) {
      assert.equal(layout.hits[selector], id, `${selector} center remains pointer accessible`);
    }
    return layout;
  };

  await page.locator('#focus-screen').click();
  await page.waitForTimeout(450);
  const landscape = await assertFocusedLayout({ inputWidth: 180, inputHeight: 32, font: 13 });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(450);
  const phone = await assertFocusedLayout({ inputWidth: 180, inputHeight: 32, font: 13 });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(450);
  const desktop = await assertFocusedLayout({ inputWidth: 180, inputHeight: 42, font: 16 });

  await page.locator('#focus-screen').click();
  await page.waitForTimeout(450);
  const diskTargets = await page.evaluate(() => Object.fromEntries([
    ['service', '.equipment-service', '.service-hotspot'],
    ['evidence', '.equipment-extraction', '.extraction-hotspot'],
  ].map(([name, imageSelector, hotspotSelector]) => {
    const image = document.querySelector(imageSelector).getBoundingClientRect();
    const hotspot = document.querySelector(hotspotSelector).getBoundingClientRect();
    const caption = document.querySelector(`${hotspotSelector} span`).getBoundingClientRect();
    const target = document.elementFromPoint(hotspot.x + hotspot.width / 2, hotspot.y + hotspot.height / 2);
    return [name, { width: hotspot.width, height: hotspot.height, captionGap: caption.y - image.bottom, hit: target?.closest('button')?.id || null }];
  })));
  for (const [name, target, expectedButton] of [['service', diskTargets.service, 'service-button'], ['evidence', diskTargets.evidence, 'extract-button']]) {
    assert.ok(target.width >= 44 && target.height >= 44, `${name} hotspot meets the 44px target size`);
    assert.ok(target.captionGap >= 8 && target.captionGap <= 14, `${name} label stays close to its disk`);
    assert.equal(target.hit, expectedButton, `${name} disk center is interactive`);
  }

  const framing = [];
  for (const viewport of [{ width: 844, height: 390 }, { width: 390, height: 844 }, { width: 1440, height: 900 }]) {
    await page.setViewportSize(viewport);
    await page.evaluate(() => {
      document.querySelector('#archive-screen').classList.remove('focused');
      document.querySelector('#archive-screen').hidden = true;
      document.querySelector('#film-screen').hidden = false;
    });
    await page.waitForFunction(() => document.querySelector('#mission-film').videoWidth > 0);
    const filmRect = await page.evaluate(() => {
      const video = document.querySelector('#mission-film');
      const frame = video.getBoundingClientRect();
      const ratio = video.videoWidth / video.videoHeight;
      let width = frame.width, height = width / ratio;
      if (height > frame.height) { height = frame.height; width = height * ratio; }
      return { x: frame.x + (frame.width - width) / 2, y: frame.y + (frame.height - height) / 2, width, height };
    });
    await page.evaluate(() => {
      document.querySelector('#film-screen').hidden = true;
      document.querySelector('#archive-screen').hidden = false;
    });
    const normalRect = await page.locator('.bench').boundingBox();
    const difference = { x: normalRect.x - filmRect.x, y: normalRect.y - filmRect.y, width: normalRect.width - filmRect.width, height: normalRect.height - filmRect.height };
    assert.ok(Object.values(difference).every(value => Math.abs(value) <= 1), 'normal rig plane matches the film handoff frame');
    framing.push({ viewport, difference });
  }
  assert.deepEqual(pageErrors, []);
  console.log(JSON.stringify({ status: 'passed', landscape, phone, desktop, diskTargets, framing }, null, 2));
} finally {
  await browser.close();
}
