import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { signInOwner } from './auth';

async function startFreshAttempt(page: import('@playwright/test').Page, skipApproach = true) {
  await expect(page.locator('.inception-root')).toBeVisible();
  const expiredFinish = page.getByRole('button', { name: 'Finish and review' });
  if (await expiredFinish.count()) { await expiredFinish.click(); await expect(page.getByRole('button', { name: 'Start a new attempt' })).toBeVisible(); }
  const composer = page.getByLabel('Speak to Fischer');
  if (await composer.count()) {
    const finish = page.getByRole('button', { name: 'Finish and review' });
    if (await finish.count()) { await finish.click(); await expect(page.getByRole('button', { name: 'Start a new attempt' })).toBeVisible(); }
  }
  const replay = page.getByRole('button', { name: 'Start a new attempt' });
  if (await replay.count()) { await replay.click(); await expect(page.getByRole('region', { name: 'Strongroom approach' })).toBeVisible(); if (skipApproach) { await page.keyboard.press('Escape'); await expect(page.locator('.inception-play')).not.toHaveClass(/is-handoff-locked/); } return; }
  const consent = page.getByRole('checkbox', { name: /I understand and agree to this recording/ });
  if (await consent.count()) await consent.check();
  const begin = page.getByRole('button', { name: 'Begin without film' });
  if (skipApproach && await begin.count()) await begin.click();
  else { await page.getByRole('button', { name: 'Watch and begin' }).click(); if (skipApproach) await page.keyboard.press('Escape'); }
  if (skipApproach) await expect(page.locator('.inception-play')).not.toHaveClass(/is-handoff-locked/);
}

async function expectComposerStatusesHidden(page: import('@playwright/test').Page) {
  const geometry = await page.locator('.inception-composer .inception-send-status').evaluateAll(elements => elements.map(element => {
    const rect = element.getBoundingClientRect();
    return { width: rect.width, height: rect.height, position: getComputedStyle(element).position };
  }));
  expect(geometry.length).toBeGreaterThan(0);
  expect(geometry.every(item => item.width <= 1 && item.height <= 1 && item.position === 'absolute')).toBeTruthy();
}

async function expectCaptionCenteredInEncodedBar(page: import('@playwright/test').Page, videoSelector: string, captionSelector = '.inception-film-caption') {
  const values = await page.evaluate(({ videoSelector, captionSelector }) => {
    const video = document.querySelector<HTMLVideoElement>(videoSelector)!;
    const caption = document.querySelector<HTMLElement>(captionSelector)!;
    const bands = caption.closest<HTMLElement>('.inception-film-caption-bands')!;
    const rect = video.getBoundingClientRect(), captionRect = caption.getBoundingClientRect(), bandsRect = bands.getBoundingClientRect();
    const width = video.videoWidth || 1920, height = video.videoHeight || 1080;
    const scale = Math.min(rect.width / width, rect.height / height);
    const drawnWidth = width * scale, drawnHeight = height * scale;
    const left = rect.left + (rect.width - drawnWidth) / 2, top = rect.top + (rect.height - drawnHeight) / 2;
    return {
      text: caption.textContent?.trim() || '',
      captionCenterX: (captionRect.left + captionRect.right) / 2,
      captionCenterY: (captionRect.top + captionRect.bottom) / 2,
      expectedCenterX: left + drawnWidth / 2,
      expectedCenterY: top + drawnHeight * (1010 / 1080),
      lowerBarTop: top + drawnHeight * (940 / 1080),
      encodedBottom: top + drawnHeight,
      captionTop: captionRect.top,
      captionBottom: captionRect.bottom,
      bandsLeft: bandsRect.left,
      expectedBandsLeft: left,
      bandsWidth: bandsRect.width,
      expectedBandsWidth: drawnWidth,
      fontSize: Number.parseFloat(getComputedStyle(caption).fontSize),
      bandHeight: drawnHeight * (140 / 1080),
    };
  }, { videoSelector, captionSelector });
  expect(values.text).not.toBe('');
  expect(Math.abs(values.captionCenterX - values.expectedCenterX)).toBeLessThan(2);
  expect(Math.abs(values.captionCenterY - values.expectedCenterY)).toBeLessThan(2);
  expect(Math.abs(values.bandsLeft - values.expectedBandsLeft)).toBeLessThan(2);
  expect(Math.abs(values.bandsWidth - values.expectedBandsWidth)).toBeLessThan(2);
  expect(values.captionTop).toBeGreaterThanOrEqual(values.lowerBarTop - 1);
  expect(values.captionBottom).toBeLessThanOrEqual(values.encodedBottom + 1);
  expect(values.fontSize).toBeGreaterThanOrEqual(8);
  expect(values.fontSize).toBeLessThanOrEqual(Math.min(30, values.bandHeight * .4) + .1);
  return values.text;
}

test.describe('Inception strongroom', () => {
  test.use({ baseURL: 'http://127.0.0.1:4323' });

  test('intro skip starts one round; inspection, conversation and review keep the saved state honest', async ({ page }) => {
    await signInOwner(page.request);
    await page.addInitScript(() => {
      const probe = { gains: [] as Array<{ initialized: number[]; targets: number[] }>, attempted: [] as string[], played: [] as string[], pauses: [] as string[], closes: 0, failNextScore: true, failures: 0 };
      Object.defineProperty(window, '__inceptionAudioProbe', { value: probe });
      const createGain = AudioContext.prototype.createGain;
      AudioContext.prototype.createGain = function () {
        const node = createGain.call(this), initialized: number[] = [], targets: number[] = [], gain = node.gain;
        const setValue = gain.setValueAtTime.bind(gain), setTarget = gain.setTargetAtTime.bind(gain);
        gain.setValueAtTime = ((value: number, at: number) => { initialized.push(value); return setValue(value, at); }) as typeof gain.setValueAtTime;
        gain.setTargetAtTime = ((value: number, at: number, constant: number) => { targets.push(value); return setTarget(value, at, constant); }) as typeof gain.setTargetAtTime;
        probe.gains.push({ initialized, targets }); return node;
      };
      const play = HTMLMediaElement.prototype.play, pause = HTMLMediaElement.prototype.pause, close = AudioContext.prototype.close;
      HTMLMediaElement.prototype.play = function () {
        if (this.src.includes('strongroom-score-')) probe.attempted.push(this.src);
        if (this.src.includes('strongroom-roomtone')) {
          probe.played.push(this.src);
        }
        if (this.src.includes('strongroom-score-calm') && probe.failNextScore) {
          probe.failNextScore = false; probe.failures++;
          return Promise.reject(new DOMException('Autoplay blocked by test', 'NotAllowedError'));
        }
        return play.call(this);
      };
      HTMLMediaElement.prototype.pause = function () { if (this.src.includes('strongroom-roomtone')) probe.pauses.push(this.src); return pause.call(this); };
      AudioContext.prototype.close = function () { probe.closes++; return close.call(this); };
    });
    let starts = 0;
    await page.route('**/api/inception/start', async route => { if (route.request().method() === 'POST') starts++; await route.continue(); });
    const errors: string[] = [];
    page.on('response', response => { if (response.url().includes('/inception-assets/') && response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });

    await page.goto('/inception');
    await expect(page.getByRole('button', { name: /Standard/ })).toHaveAttribute('aria-pressed', 'true');
    const media = await (await page.request.get('/inception-assets/manifest.json')).json();
    for (const path of [media.closedFrame, media.openFrame, media.bridgeFrame, media.introVideo, media.captions, media.approvedTrack, media.roomTone, media.portraits?.eames, media.portraits?.fischer].filter(Boolean)) {
      expect((await page.request.get(path)).ok(), `media asset should be served: ${path}`).toBeTruthy();
    }
    await page.getByRole('checkbox', { name: /I understand and agree to this recording/ }).check();
    await page.getByRole('button', { name: 'Watch and begin' }).click();
    await expect(page.getByRole('region', { name: 'Strongroom approach' })).toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as any).__inceptionAudioProbe.gains.length)).toBeGreaterThanOrEqual(3);
    const initialAudio = await page.evaluate(() => (window as any).__inceptionAudioProbe);
    expect(initialAudio.gains[0].initialized[0]).toBe(0);
    expect(initialAudio.gains[0].targets.some((gain: number) => gain > 0 && gain <= 0.7)).toBeTruthy();
    expect(initialAudio.attempted.some((path: string) => path.includes('strongroom-score-calm-v1.mp3'))).toBeTruthy();
    expect(initialAudio.played.some((path: string) => path.includes('strongroom-roomtone-v1.mp3'))).toBeTruthy();
    const recoveredAudio = await page.evaluate(() => (window as any).__inceptionAudioProbe);
    expect(recoveredAudio.failures).toBe(1);
    expect(recoveredAudio.played.length).toBeGreaterThanOrEqual(1);
    await expect(page.locator('.inception-intro-chrome')).toHaveCount(0);
    await expect(page.locator('.inception-intro button')).toHaveCount(0);
    expect(starts).toBe(0);
    await page.keyboard.press('Escape');
    await expect(page.getByLabel('Speak to Fischer')).toBeEnabled();
    expect(starts).toBe(1);

    await page.getByRole('button', { name: 'Inspect safe' }).click();
    await expect(page.getByText(/compact safe is recessed in the dark-green bedside cabinet/)).toBeVisible();
    await page.getByRole('button', { name: 'Close' }).click();
    const composer = page.getByLabel('Speak to Fischer');
    await composer.fill('What can you tell me about the safe?');
    await expect(page.getByRole('button', { name: 'Send' })).toBeEnabled();
    await composer.press('Enter');
    const transcript = page.getByRole('log', { name: 'Conversation transcript' });
    await expect(transcript.getByRole('img', { name: 'Eames' })).toBeVisible();
    await expect(transcript.getByRole('img', { name: 'Fischer' }).last()).toBeVisible();
    await expect(transcript.locator('article>span')).toHaveCount(0);
    await expect(composer).toBeFocused();
    await expect(transcript.getByText('What can you tell me about the safe?')).toBeVisible();
    await expect(transcript.getByText('I was honoured for Special Services to the School after Hagrid was blamed. They knew whom to trust.')).toBeVisible();
    await expect(page.getByRole('button', { name: /Conversation history|Full conversation/i })).toHaveCount(0);
    for (let index = 0; index < 5; index++) {
      const count = await transcript.locator('article').count();
      if (index === 3) await transcript.evaluate(element => { element.scrollTop = 0; });
      await composer.fill(`What else do you remember about the room? ${index + 1}`);
      await expect(page.getByRole('button', { name: 'Send' })).toBeEnabled();
      await composer.press('Enter');
      await expect(transcript.locator('article')).toHaveCount(count + 2);
    }
    await transcript.evaluate(element => { element.scrollTop = element.scrollHeight; });
    const bottomBefore = await transcript.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop);
    await composer.fill('One more question about the dream.');
    await expect(page.getByRole('button', { name: 'Send' })).toBeEnabled();
    await composer.press('Enter');
    await expect.poll(() => transcript.locator('article').count()).toBe(15);
    await expect.poll(() => transcript.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThanOrEqual(Math.max(4, bottomBefore + 2));

    const before = await page.getByRole('timer').getAttribute('aria-label');
    await expect(page.getByRole('button', { name: 'Rewatch approach' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Mute sound' }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__inceptionAudioProbe.gains[0].targets.at(-1))).toBe(0);
    const mutedAudio = await page.evaluate(() => (window as any).__inceptionAudioProbe);
    expect(mutedAudio.pauses.length).toBeGreaterThan(0);
    await page.getByRole('button', { name: 'Unmute sound' }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__inceptionAudioProbe.gains[0].targets.at(-1))).toBeGreaterThan(0);
    const after = await page.getByRole('timer').getAttribute('aria-label');
    const seconds = (value: string | null) => { const match = /^(\d+):(\d+) remaining$/.exec(value || ''); return match ? Number(match[1]) * 60 + Number(match[2]) : 0; };
    expect(Math.abs(seconds(before) - seconds(after))).toBeLessThanOrEqual(2);

    await page.getByRole('button', { name: 'Exit fullscreen' }).click();
    await page.setViewportSize({ width: 390, height: 600 });
    await expect(page.getByLabel('Speak to Fischer')).toBeVisible();
    const width = await page.locator('body').evaluate(element => ({ scroll: element.scrollWidth, client: element.clientWidth }));
    expect(width.scroll).toBeLessThanOrEqual(width.client + 1);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole('log', { name: 'Conversation transcript' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Conversation history|Full conversation/i })).toHaveCount(0);

    await page.getByRole('button', { name: 'Finish and review' }).click();
    await expect(page.getByText('The dream gives way. The safe stays locked.')).toBeVisible();
    await expect(page.getByRole('group', { name: 'Closed strongroom safe' })).toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as any).__inceptionAudioProbe.closes)).toBe(1);
    await expect(page.locator('.inception-top-actions button[aria-label$="sound"]')).toBeDisabled();
    await expect(page.locator('.inception-sound-recovery')).toHaveCount(0);
    expect(starts).toBe(1);
    expect(errors).toEqual([]);
    const replay = page.getByRole('button', { name: 'Start a new attempt' });
    await replay.click();
    await expect(page.getByRole('region', { name: 'Strongroom approach' })).toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as any).__inceptionAudioProbe.gains.length)).toBe(2);
    expect(starts).toBe(1);
    await page.keyboard.press('Escape');
    await expect(page.getByLabel('Speak to Fischer')).toBeEnabled();
    expect(starts).toBe(2);
    await page.getByRole('button', { name: 'Finish and review' }).click();
    await expect(page.getByRole('button', { name: 'Start a new attempt' })).toBeVisible();
  });

  test('transcript follows scrolling at reply arrival, not only when Send is pressed', async ({ page }) => {
    test.setTimeout(90000);
    await signInOwner(page.request);
    await page.goto('/inception');
    await startFreshAttempt(page);
    const composer = page.getByLabel('Speak to Fischer');
    const transcript = page.getByRole('log', { name: 'Conversation transcript' });
    for (let index = 0; index < 8; index++) {
      const count = await transcript.locator('article').count();
      await composer.fill(`What do you remember about the room? ${index}`);
      await expect(page.getByRole('button', { name: 'Send' })).toBeEnabled();
      await composer.press('Enter');
      await expect(transcript.locator('article')).toHaveCount(count + 2);
    }
    await expect.poll(() => transcript.evaluate(element => element.scrollHeight > element.clientHeight)).toBeTruthy();

    let allowResponse!: () => void;
    let requestStarted!: () => void;
    let started = new Promise<void>(resolve => { requestStarted = resolve; });
    let gate = new Promise<void>(resolve => { allowResponse = resolve; });
    await page.route('**/api/rounds/*/messages', async route => {
      if (route.request().method() === 'POST') { requestStarted(); await gate; }
      await route.continue();
    });
    let count = await transcript.locator('article').count();
    await composer.fill('Take me back to the earlier question.');
    await expect(page.getByRole('button', { name: 'Send' })).toBeEnabled();
    await composer.press('Enter');
    await started;
    await transcript.evaluate(element => { element.scrollTop = 0; });
    await transcript.focus();
    await expect.poll(() => transcript.evaluate(element => element.scrollTop)).toBeLessThan(3);
    allowResponse();
    await expect(transcript.locator('article')).toHaveCount(count + 2);
    await expect.poll(() => transcript.evaluate(element => element.scrollTop)).toBeLessThan(4);
    await expect(transcript).toBeFocused();

    await page.unroute('**/api/rounds/*/messages');
    started = new Promise<void>(resolve => { requestStarted = resolve; });
    gate = new Promise<void>(resolve => { allowResponse = resolve; });
    await page.route('**/api/rounds/*/messages', async route => {
      if (route.request().method() === 'POST') { requestStarted(); await gate; }
      await route.continue();
    });
    count = await transcript.locator('article').count();
    await composer.fill('One more question after reading back.');
    await expect(page.getByRole('button', { name: 'Send' })).toBeEnabled();
    await composer.press('Enter');
    await started;
    await transcript.evaluate(element => { element.scrollTop = 0; });
    await transcript.evaluate(element => { element.scrollTop = element.scrollHeight; });
    await expect.poll(() => transcript.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThan(4);
    allowResponse();
    await expect(transcript.locator('article')).toHaveCount(count + 2);
    await expect.poll(() => transcript.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThan(6);

    const originalViewport = page.viewportSize()!;
    for (const viewport of [{ width: 1366, height: 768 }, { width: 1440, height: 900 }, { width: 1920, height: 1080 }]) {
      await page.setViewportSize(viewport);
      const rows = await transcript.locator('article').evaluateAll(elements => elements.map(element => {
        const portrait = element.querySelector('img')!.getBoundingClientRect();
        const text = element.querySelector('p')!.getBoundingClientRect();
        const style = getComputedStyle(element);
        return { portraitLeft: portrait.left, portraitWidth: portrait.width, textLeft: text.left, textWidth: text.width, display: style.display, background: style.backgroundColor, borderTop: style.borderTopWidth };
      }));
      expect(rows.length).toBeGreaterThan(2);
      for (const row of rows) {
        expect(row.display).toBe('grid');
        expect(row.portraitWidth).toBe(38);
        expect(row.background).toBe('rgba(0, 0, 0, 0)');
        expect(row.borderTop).toBe('0px');
        expect(row.portraitLeft).toBeCloseTo(rows[0].portraitLeft, 1);
        expect(row.textLeft).toBeCloseTo(rows[0].textLeft, 1);
        expect(row.textWidth).toBeCloseTo(rows[0].textWidth, 1);
      }
      expect(await page.locator('body').evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    }
    await page.setViewportSize(originalViewport);
    await composer.fill(Array.from({ length: 12 }, (_, index) => `Long thought ${index + 1}`).join('\n'));
    const expanded = await composer.evaluate(element => ({ height: element.getBoundingClientRect().height, max: Number.parseFloat(getComputedStyle(element).maxHeight), resize: getComputedStyle(element).resize, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight }));
    expect(expanded.resize).toBe('none');
    expect(expanded.height).toBeLessThanOrEqual(expanded.max + 1);
    expect(expanded.scrollHeight).toBeGreaterThan(expanded.clientHeight);
    await composer.fill('');
  });

  test('an expired pending message recovers the same receipt and can still finish for review', async ({ page }) => {
    await signInOwner(page.request);
    await page.goto('/inception');
    await startFreshAttempt(page);
    const composer = page.getByLabel('Speak to Fischer');
    await expect(composer).toBeEnabled();
    let firstRequestId = '';
    let messageRequests = 0;
    await page.route('**/api/rounds/*/messages', async route => {
      if (route.request().method() === 'POST') {
        messageRequests++;
        const body = route.request().postDataJSON();
        firstRequestId ||= body.requestId;
        if (messageRequests === 1) { await route.abort(); return; }
        expect(body.requestId).toBe(firstRequestId);
      }
      await route.continue();
    });
    await composer.fill('Tell me about the safe.');
    await expect(page.getByRole('button', { name: 'Send' })).toBeEnabled();
    await composer.press('Enter');
    await expect(page.getByRole('button', { name: 'Retry saved message' })).toBeVisible();
    await expectComposerStatusesHidden(page);
    await page.evaluate(() => { const original = Date.now; Date.now = () => original() + 301000; });
    await expect(page.getByRole('group', { name: 'Finish the expired conversation' })).toBeVisible({ timeout: 5000 });
    await expect(page.getByLabel('Speak to Fischer')).toBeVisible();
    await expect(page.getByLabel('Speak to Fischer')).toBeDisabled();
    await page.getByRole('group', { name: 'Finish the expired conversation' }).getByRole('button', { name: 'Retry saved message' }).click();
    await expect(page.getByRole('button', { name: 'Finish and review' })).toBeVisible();
    expect(messageRequests).toBe(2);
    await page.getByRole('button', { name: 'Finish and review' }).click();
    await expect(page.getByRole('button', { name: 'Start a new attempt' })).toBeVisible();
  });

  test('a confirmed provider failure clears only the terminal receipt and needs an explicit new send', async ({ page }) => {
    await signInOwner(page.request);
    await page.goto('/inception');
    await startFreshAttempt(page);
    const composer = page.getByLabel('Speak to Fischer');
    await expect(composer).toBeEnabled();
    const requestIds: string[] = [];
    let releaseFailureFixture!: () => void, markFailureStarted!: () => void;
    const failureGate = new Promise<void>(resolve => { releaseFailureFixture = resolve; });
    const failureStarted = new Promise<void>(resolve => { markFailureStarted = resolve; });
    await page.route('**/api/rounds/*/messages', async route => {
      if (route.request().method() === 'POST') {
        const body = route.request().postDataJSON();
        requestIds.push(body.requestId);
        if (body.content.includes('[fixture:rate-limit-once]')) { markFailureStarted(); await failureGate; }
      }
      await route.continue();
    });
    await composer.fill('[fixture:rate-limit-once] Tell me about the safe.');
    await expect(page.getByRole('button', { name: 'Send' })).toBeEnabled();
    await composer.press('Enter');
    await failureStarted;
    await expectComposerStatusesHidden(page);
    releaseFailureFixture();
    await expect(page.getByText('Usage limit reached. Your prompt is saved. Wait before trying again.')).toBeVisible();
    await expectComposerStatusesHidden(page);
    await expect(page.getByRole('button', { name: 'Retry saved message' })).toHaveCount(0);
    await expect(composer).toHaveValue('[fixture:rate-limit-once] Tell me about the safe.');
    expect(requestIds).toHaveLength(1);
    await expect(page.getByRole('button', { name: 'Send' })).toBeDisabled();
    await composer.press('Enter');
    expect(requestIds).toHaveLength(1);
    await expect(page.getByRole('button', { name: 'Send' })).toBeEnabled({ timeout: 5000 });
    await composer.press('Enter');
    await expect(page.getByText(/I was honoured for Special Services/)).toBeVisible();
    expect(requestIds).toHaveLength(2);
    expect(requestIds[0]).not.toBe(requestIds[1]);
    await page.getByRole('button', { name: 'Finish and review' }).click();
    await expect(page.getByRole('button', { name: 'Start a new attempt' })).toBeVisible();
  });

  test('a lost review response recovers from persisted review polling without a second provider request', async ({ page }) => {
    await signInOwner(page.request);
    await page.addInitScript(() => {
      const originalFetch = window.fetch.bind(window);
      window.fetch = async (input, init = {}) => {
        const url = typeof input === 'string' ? input : input instanceof Request ? input.url : '';
        if (/\/api\/inception\/rounds\/[^/]+\/review/.test(url) && init.method === 'POST') {
          const controller = new AbortController(), timeout = window.setTimeout(() => controller.abort(), 80);
          try { return await originalFetch(input, { ...init, signal: controller.signal }); }
          finally { window.clearTimeout(timeout); }
        }
        return originalFetch(input, init);
      };
    });
    await page.goto('/inception');
    await expect(page.locator('.inception-root')).toBeVisible();
    await startFreshAttempt(page);
    await expect(page.getByLabel('Speak to Fischer')).toBeEnabled();
    await page.getByLabel('Speak to Fischer').fill('[fixture:inception-disclosure] [fixture:slow-review]');
    await expect(page.getByRole('button', { name: 'Send' })).toBeEnabled();
    await page.getByLabel('Speak to Fischer').press('Enter');
    await expect(page.getByText(/The combination is \d{6}\./)).toBeVisible();
    await expectComposerStatusesHidden(page);
    const composerBeforeReview = await page.locator('.inception-composer').boundingBox();
    const finishBeforeReview = await page.getByRole('button', { name: 'Finish and review' }).boundingBox();
    expect(composerBeforeReview).not.toBeNull();
    expect(finishBeforeReview).not.toBeNull();

    let reviewPosts = 0, reviewGets = 0;
    page.on('request', request => {
      if (!request.url().includes('/api/inception/rounds/') || !request.url().endsWith('/review')) return;
      if (request.method() === 'POST') reviewPosts++;
      if (request.method() === 'GET') reviewGets++;
    });
    await page.getByRole('button', { name: 'Finish and review' }).click();
    await page.waitForTimeout(300);
    await expect(page.locator('.inception-result')).toHaveCount(0);
    await expect(page.locator('.inception-composer')).toBeVisible();
    await expectComposerStatusesHidden(page);
    await expect(page.getByLabel('Speak to Fischer')).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Finish and review' })).toBeDisabled();
    const composerDuringReview = await page.locator('.inception-composer').boundingBox();
    const finishDuringReview = await page.getByRole('button', { name: 'Finish and review' }).boundingBox();
    expect(Math.abs(composerDuringReview!.height - composerBeforeReview!.height)).toBeLessThanOrEqual(1);
    expect(Math.abs(composerDuringReview!.y - composerBeforeReview!.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(finishDuringReview!.y - finishBeforeReview!.y)).toBeLessThanOrEqual(1);
    await expect(page.getByRole('group', { name: 'Strongroom safe open' })).toBeVisible({ timeout: 10000 });
    expect(reviewGets).toBeGreaterThan(0);
    expect(reviewPosts).toBe(1);
    await expect(page.locator('.inception-success-ending')).toBeVisible();
    await expect(page.locator('.inception-result')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.locator('.inception-root')).toHaveCount(0);
    await page.goto('/inception');
    await expect(page.getByText('The lock turns. You’re inside.')).toBeVisible();
    expect(reviewPosts).toBe(1);
  });

  test('a saved disclosure opens the safe only after judged review and captures desktop and phone states', async ({ page }) => {
    test.setTimeout(90000);
    const snapshotDirectory = join(process.cwd(), 'work', 'inception-production', 'acceptance-screenshots');
    mkdirSync(snapshotDirectory, { recursive: true });
    await signInOwner(page.request);
    const telemetryBatches: string[] = [];
    const protectedActions: string[] = [];
    await page.addInitScript(() => {
      const lifecycle = { closed: 0 };
      Object.defineProperty(window, '__inceptionAudioLifecycle', { value: lifecycle });
      const close = AudioContext.prototype.close;
      AudioContext.prototype.close = function () {
        return close.call(this).then(() => { lifecycle.closed++; });
      };
    });
    page.on('request', request => { if (request.method() === 'POST' && /\/api\/(inception\/start|inception\/rounds\/[^/]+\/review|rounds\/[^/]+\/messages)/.test(request.url())) protectedActions.push(request.url()); });
    page.on('request', request => { if (request.method() === 'POST' && request.url().includes('/api/telemetry/events')) telemetryBatches.push(request.postData() || ''); });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/inception');
    await expect(page.locator('.inception-root')).toBeVisible();
    await startFreshAttempt(page);
    await expect(page.getByLabel('Speak to Fischer')).toBeEnabled();
    await expect(page.getByRole('group', { name: 'Closed strongroom safe' })).toBeVisible();
    await page.reload();
    await expect(page.getByLabel('Speak to Fischer')).toBeEnabled();
    await expect(page.getByRole('group', { name: 'Closed strongroom safe' })).toBeVisible();
    await expect.poll(() => page.locator('.safe-hotspot').evaluate(button => (button as HTMLElement).getBoundingClientRect().width)).toBeGreaterThan(100);
    const geometry = await page.evaluate(async () => {
      const root = document.querySelector('.inception-root')!.getBoundingClientRect();
      const stage = document.querySelector('.inception-safe.with-art')!.getBoundingClientRect();
      const target = document.querySelector('.safe-hotspot')!.getBoundingClientRect();
      const dialogue = document.querySelector('.inception-dialogue')!.getBoundingClientRect();
      const frame = stage;
      const scale = Math.max(frame.width / 1672, frame.height / 941), drawWidth = 1672 * scale, drawHeight = 941 * scale;
      const offsetX = (frame.width - drawWidth) / 2, offsetY = (frame.height - drawHeight) / 2;
      const expectedLeft = frame.left + offsetX + drawWidth * 0.3553;
      const expectedTop = frame.top + offsetY + drawHeight * 0.424;
      const expectedWidth = drawWidth * 0.2871, expectedHeight = drawHeight * 0.3985;
      return { root: { left: root.left, top: root.top, width: root.width, height: root.height }, stage: { left: stage.left, top: stage.top, width: stage.width, height: stage.height }, target: { left: target.left, top: target.top, width: target.width, height: target.height }, expected: { left: expectedLeft, top: expectedTop, width: expectedWidth, height: expectedHeight }, dialogueLeft: dialogue.left, mobile: matchMedia('(max-width:760px)').matches };
    });
    if (!geometry.mobile) {
      expect(Math.abs(geometry.stage.left - geometry.root.left)).toBeLessThan(2);
      expect(Math.abs(geometry.stage.top - geometry.root.top)).toBeLessThan(2);
      expect(Math.abs(geometry.stage.width - geometry.root.width * 0.55)).toBeLessThan(3);
      expect(Math.abs(geometry.stage.height - geometry.root.height)).toBeLessThan(2);
    }
    await page.screenshot({ path: join(snapshotDirectory, 'inception-play-desktop.png') });
    console.log('Inception desktop bounds', JSON.stringify(geometry));
    expect(Math.abs(geometry.target.left - geometry.expected.left)).toBeLessThan(3);
    expect(Math.abs(geometry.target.top - geometry.expected.top)).toBeLessThan(3);
    expect(Math.abs(geometry.target.width - geometry.expected.width)).toBeLessThan(3);
    expect(Math.abs(geometry.target.height - geometry.expected.height)).toBeLessThan(3);
    expect(geometry.dialogueLeft).toBeGreaterThan(geometry.target.left + geometry.target.width);
    await page.getByRole('button', { name: 'Inspect safe' }).click();
    await expect(page.getByRole('dialog')).toContainText('twelve rounded metal buttons');
    await expect(page.getByRole('img', { name: /Close view of the compact green safe/ })).toBeVisible();
    await expect(page.getByRole('dialog').locator('button').first()).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(page.getByRole('dialog').locator('button').last()).toBeFocused();
    await page.getByRole('button', { name: 'Close' }).click();
    await expect(page.getByRole('button', { name: 'Inspect safe' })).toBeFocused();

    const composer = page.getByLabel('Speak to Fischer');
    await composer.fill('[fixture:inception-disclosure]');
    await expect(page.getByRole('button', { name: 'Send' })).toBeEnabled();
    await composer.press('Enter');
    await expect(page.getByText(/The combination is \d{6}\./)).toBeVisible();
    await expectComposerStatusesHidden(page);
    await expect(page.getByRole('group', { name: 'Closed strongroom safe' })).toBeVisible();

    let releaseReview!: () => void;
    let markReviewStarted!: () => void;
    const reviewGate = new Promise<void>(resolve => { releaseReview = resolve; });
    const reviewStarted = new Promise<void>(resolve => { markReviewStarted = resolve; });
    await page.route('**/api/inception/rounds/*/review', async route => {
      if (route.request().method() === 'POST') { markReviewStarted(); await reviewGate; }
      await route.continue();
    });
    await page.getByRole('button', { name: 'Finish and review' }).click();
    await reviewStarted;
    await expect(page.getByRole('group', { name: 'Closed strongroom safe' })).toBeVisible();
    await expect(page.locator('.inception-result')).toHaveCount(0);
    await expect(page.locator('.inception-revealed-code')).toHaveCount(0);
    const lcdPhoneBounds: Array<Record<string, number>> = [];
    const captureLcdBounds = async () => page.evaluate(() => {
      const stage = document.querySelector('.inception-safe.with-art')!.getBoundingClientRect();
      const lcd = document.querySelector('.inception-revealed-code')!.getBoundingClientRect();
      const scale = Math.max(stage.width / 1672, stage.height / 941), drawnWidth = 1672 * scale, drawnHeight = 941 * scale;
      const offsetX = (stage.width - drawnWidth) / 2, offsetY = (stage.height - drawnHeight) / 2;
      return { left: lcd.left, top: lcd.top, width: lcd.width, height: lcd.height, expectedLeft: stage.left + offsetX + drawnWidth * 0.45395, expectedTop: stage.top + offsetY + drawnHeight * 0.55473, expectedWidth: drawnWidth * 0.06938, expectedHeight: drawnHeight * 0.03188 };
    });
    await page.setViewportSize({ width: 390, height: 600 });
    releaseReview();
    const phoneLcd = page.locator('.inception-revealed-code');
    await expect(phoneLcd).toHaveText('528491', { timeout: 8000 });
    lcdPhoneBounds.push(await captureLcdBounds());
    await page.screenshot({ path: join(snapshotDirectory, 'inception-confirmed-code-phone-390x600.png') });
    for (const bounds of lcdPhoneBounds) {
      expect(Math.abs(bounds.left - bounds.expectedLeft)).toBeLessThan(3);
      expect(Math.abs(bounds.top - bounds.expectedTop)).toBeLessThan(3);
      expect(Math.abs(bounds.width - bounds.expectedWidth)).toBeLessThan(3);
      expect(Math.abs(bounds.height - bounds.expectedHeight)).toBeLessThan(3);
    }
    await expect(page.locator('.inception-success-ending')).toBeVisible();
    await expect(page.locator('.inception-result')).toHaveCount(0);
    const successManifest = await page.evaluate(async () => (await (await fetch('/inception-assets/manifest.json')).json()) as { successVideo: string; successDurationSeconds: number });
    expect(successManifest.successDurationSeconds).toBeGreaterThan(0);
    await expect(page.locator('.inception-success-ending')).toBeVisible();
    expect(await page.locator('.inception-success-ending source').getAttribute('src')).toBe(successManifest.successVideo);
    await expect.poll(async () => (await page.locator('.inception-success-ending video').evaluate(video => (video as HTMLVideoElement).currentTime)) > 0.1 || (await page.getByRole('button', { name: /Play ending/ }).count()) > 0, { timeout: 8000 }).toBe(true);
    const successCaption = page.locator('.inception-success-ending .inception-film-caption');
    await expect(successCaption).toHaveText('The safe opens.');
    await page.locator('.inception-success-ending video').evaluate(video => (video as HTMLVideoElement).pause());
    for (const viewport of [{ width: 1920, height: 1080 }, { width: 1440, height: 900 }, { width: 390, height: 600 }, { width: 844, height: 390 }]) {
      await page.setViewportSize(viewport);
      await page.waitForTimeout(80);
      expect(await expectCaptionCenteredInEncodedBar(page, '.inception-success-ending video')).toBe('The safe opens.');
    }
    await page.setViewportSize({ width: 320, height: 600 });
    await page.locator('.inception-success-ending video').evaluate(video => { (video as HTMLVideoElement).currentTime = 20.2; });
    await expect(successCaption).toHaveText('Fischer understands what his father wanted him to know.');
    const endingFit = await successCaption.evaluate(element => ({ height: element.clientHeight, contentHeight: element.scrollHeight }));
    expect(endingFit.contentHeight).toBeLessThanOrEqual(endingFit.height + 1);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(80);
    await page.waitForTimeout(750);
    await page.screenshot({ path: join(snapshotDirectory, 'inception-success-ending-desktop.png') });
    const requestsAtWin = protectedActions.length;
    await expect(page.locator('.inception-success-ending button, .inception-success-ending input, .inception-success-ending video[controls]')).toHaveCount(0);
    await page.locator('.inception-success-ending video').evaluate(video => video.dispatchEvent(new Event('ended')));
    await expect(page.locator('.inception-success-ending')).toHaveClass(/is-title-card/);
    await expect(page.locator('.inception-result')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'INCEPTION', exact: true })).toBeVisible({ timeout: 10000 });
    await expect(page.locator('.inception-result')).toHaveCount(0);
    await expect.poll(() => page.locator('.inception-success-ending').evaluate(element => element.classList.contains('is-card-exit')), { timeout: 10000 }).toBe(true);
    await expect.poll(() => page.getByRole('heading', { name: 'INCEPTION', exact: true }).evaluate(element => Number.parseFloat(getComputedStyle(element).opacity)), { timeout: 1000 }).toBeLessThan(0.9);
    const titleOpacity = await page.getByRole('heading', { name: 'INCEPTION', exact: true }).evaluate(element => Number.parseFloat(getComputedStyle(element).opacity));
    const titleAnimationState = await page.evaluate(() => {
      const title = document.querySelector<HTMLElement>('.inception-ending-title-card')!;
      return { reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches, animations: title.getAnimations().map(animation => ({ playState: animation.playState, currentTime: animation.currentTime, name: animation.animationName })) };
    });
    expect(titleOpacity, JSON.stringify(titleAnimationState)).toBeGreaterThan(0);
    expect(titleOpacity, JSON.stringify(titleAnimationState)).toBeLessThan(0.9);
    await expect(page.getByRole('heading', { name: 'INCEPTION', exact: true })).toHaveCount(0, { timeout: 2000 });
    await expect(page.locator('.inception-ending-credit-card')).toHaveCount(0);
    await expect(page.locator('.inception-success-ending')).toBeVisible();
    await expect(page.getByText('CSES ML Team')).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(13000);
    await expect(page.locator('.inception-success-ending')).toBeVisible();
    await expect(page.getByText('CSES ML Team')).toBeVisible();
    await expect(page.locator('.inception-result')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => (window as any).__inceptionAudioLifecycle.closed)).toBeGreaterThan(0);
    expect(protectedActions).toHaveLength(requestsAtWin);
    await page.keyboard.press('Escape');
    await expect(page.locator('.inception-root')).toHaveCount(0);
    await page.goto('/inception');
    await expect(page.locator('.inception-root')).toHaveClass(/is-immersive/);
    await expect(page.getByRole('group', { name: 'Strongroom safe open' })).toBeVisible();
    await expect(page.getByRole('log', { name: 'Conversation transcript' })).toContainText('[fixture:inception-disclosure]');
    await expect(page.locator('.inception-result')).toBeVisible();
    await expect(page.getByRole('button', { name: /Rewatch ending/ })).toBeVisible();
    await page.getByRole('button', { name: /Rewatch ending/ }).click();
    await expect(page.locator('.inception-success-ending')).toBeVisible();
    await expect(page.locator('.inception-result')).toHaveCount(0);
    expect(protectedActions).toHaveLength(requestsAtWin);
    await page.keyboard.press('Escape');
    await expect(page.locator('.inception-root')).toHaveCount(0);
    await expect.poll(() => telemetryBatches.join('\n'), { timeout: 20000 }).toContain('"interaction":"review"');
    await page.unroute('**/api/inception/rounds/*/review');
    await page.goto('/inception');
    await expect(page.locator('.inception-root')).toHaveClass(/is-immersive/);
    await expect(page.getByRole('group', { name: 'Strongroom safe open' })).toBeVisible();
    await expect(page.locator('.inception-success-ending')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Rewatch ending/ })).toBeVisible();

    await page.screenshot({ path: join(snapshotDirectory, 'inception-open-desktop.png') });
    await expect(page.getByRole('button', { name: 'Inspect the inside' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Start a new attempt/ })).toBeVisible();
    await expect(page.getByRole('group', { name: 'Strongroom safe open' })).toBeVisible();
    const exitFullscreen = page.getByRole('button', { name: 'Exit fullscreen' });
    if (await exitFullscreen.count()) await exitFullscreen.click();
    await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
    await page.setViewportSize({ width: 390, height: 600 });
    await expect.poll(() => page.evaluate(() => innerHeight)).toBe(600);
    const phone600 = await page.evaluate(() => {
      const stage = document.querySelector('.inception-safe.with-art')!.getBoundingClientRect();
      const header = document.querySelector('.inception-topbar')!.getBoundingClientRect();
      const dialogue = document.querySelector('.inception-dialogue')!.getBoundingClientRect();
      return { stageTop: stage.top, stageBottom: stage.bottom, headerBottom: header.bottom, dialogueTop: dialogue.top, viewportHeight: innerHeight };
    });
    expect(phone600.stageTop).toBeGreaterThanOrEqual(phone600.headerBottom - 2);
    expect(phone600.dialogueTop).toBeGreaterThanOrEqual(phone600.stageBottom - 2);
    expect(phone600.stageBottom).toBeLessThanOrEqual(phone600.viewportHeight);
    const phoneResult = await page.evaluate(() => ({
      actionsBottom: document.querySelector('.inception-result-actions')!.getBoundingClientRect().bottom,
      dialogueBottom: document.querySelector('.inception-dialogue')!.getBoundingClientRect().bottom,
      actionButtons: [...document.querySelectorAll('.inception-result-actions button')].map(button => {
        const rect = button.getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom, visible: rect.width > 0 && rect.height > 0 };
      }),
    }));
    expect(phoneResult.actionButtons.length).toBeGreaterThan(0);
    expect(phoneResult.actionButtons.every(button => button.visible && button.top >= 0 && button.bottom <= phoneResult.dialogueBottom + 1)).toBeTruthy();
    expect(phoneResult.actionsBottom).toBeLessThanOrEqual(phoneResult.dialogueBottom + 1);
    await page.screenshot({ path: join(snapshotDirectory, 'inception-open-phone-390x600.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: join(snapshotDirectory, 'inception-open-phone-390x844.png') });
    await page.setViewportSize({ width: 844, height: 390 });
    const landscape = await page.evaluate(() => ({
      footerBottom: document.querySelector('.inception-play-footer')!.getBoundingClientRect().bottom,
      viewportHeight: innerHeight,
      composerBottom: document.querySelector('.inception-composer')?.getBoundingClientRect().bottom ?? null,
      savedBottom: document.querySelector('.inception-conversation-saved')?.getBoundingClientRect().bottom ?? null,
      resultBottom: document.querySelector('.inception-result')!.getBoundingClientRect().bottom,
      dialogueBottom: document.querySelector('.inception-dialogue')!.getBoundingClientRect().bottom,
    }));
    expect(landscape.footerBottom).toBeLessThanOrEqual(landscape.viewportHeight + 1);
    expect(landscape.composerBottom).toBeNull();
    expect(landscape.savedBottom).not.toBeNull();
    expect(landscape.resultBottom).toBeLessThanOrEqual(landscape.footerBottom + 1);
    expect(landscape.dialogueBottom).toBeLessThanOrEqual(landscape.viewportHeight + 1);
    await page.screenshot({ path: join(snapshotDirectory, 'inception-open-landscape-844x390.png') });
    await page.setViewportSize({ width: 1440, height: 900 });
    const widths = await page.locator('body').evaluate(element => ({ scroll: element.scrollWidth, client: element.clientWidth }));
    expect(widths.scroll).toBeLessThanOrEqual(widths.client + 1);
    const telemetryPosted = page.waitForResponse(response => response.url().includes('/api/telemetry/events') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Leave strongroom' }).click();
    const telemetryResponse = await telemetryPosted;
    expect(telemetryResponse.ok()).toBeTruthy();
    const telemetry = telemetryBatches.join('\n');
    for (const marker of ['"view":"inception"', '"phase":"compose"', '"interaction":"inspect"', '"interaction":"reply"', '"interaction":"finish"', '"interaction":"review"']) expect(telemetry).toContain(marker);
    expect(telemetry).not.toContain('[fixture:inception-disclosure]');
    expect(telemetry).not.toContain('The combination is ');
  });

  test('the healthy manifest-timed approach waits for native video end without starting early', async ({ page }) => {
    await signInOwner(page.request);
    await page.goto('/inception');
    await expect(page.locator('.inception-root')).toBeVisible();
    await expect.poll(() => page.locator('.inception-entry, .inception-play').count()).toBe(1);
    if (await page.locator('.inception-entry').count()) {
      await expect(page.getByRole('button', { name: 'Mute sound' })).toBeVisible();
      await page.getByRole('button', { name: 'Mute sound' }).click();
      await expect(page.getByRole('button', { name: 'Unmute sound' })).toBeVisible();
      await page.getByRole('button', { name: 'Unmute sound' }).click();
    }
    await startFreshAttempt(page, false);
    await expect(page.getByRole('region', { name: 'Strongroom approach' })).toBeVisible();
    const introDuration = await page.evaluate(async () => (await (await fetch('/inception-assets/manifest.json')).json()).introDurationSeconds as number);
    expect(introDuration).toBeGreaterThan(0);
    test.setTimeout((introDuration + 45) * 1000);
    await expect.poll(() => page.locator('video.inception-intro-video').evaluate(video => (video as HTMLVideoElement).duration), { timeout: 15000 }).toBeCloseTo(introDuration, 0);
    let starts = 0;
    await page.route('**/api/inception/start', async route => { if (route.request().method() === 'POST') starts++; await route.continue(); });
    await expect.poll(() => page.locator('video.inception-intro-video').evaluate(video => (video as HTMLVideoElement).currentTime), { timeout: (introDuration + 18) * 1000 }).toBeGreaterThan(introDuration - 5);
    expect(starts).toBe(0);
    await expect(page.locator('video.inception-intro-video')).not.toHaveJSProperty('ended', true);
    await expect(page.getByRole('region', { name: 'Strongroom approach' })).toBeVisible();
    await expect(page.getByLabel('Speak to Fischer')).toBeEnabled({ timeout: 10000 });
    expect(starts).toBe(1);
  });

  test('intro captions follow the encoded lower bar across desktop, portrait phone and landscape', async ({ page }) => {
    await page.addInitScript(() => { Element.prototype.requestFullscreen = async function () { throw new Error('fullscreen denied by fixture'); }; });
    await signInOwner(page.request);
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto('/inception');
    await expect(page.locator('.inception-root')).toBeVisible();
    await startFreshAttempt(page, false);
    const caption = page.locator('.inception-intro .inception-film-caption');
    await expect(caption).toHaveText('You are Eames.');
    await page.locator('.inception-intro-video').evaluate(video => (video as HTMLVideoElement).pause());
    const snapshotDirectory = join(process.cwd(), 'work', 'inception-production', 'acceptance-screenshots');
    mkdirSync(snapshotDirectory, { recursive: true });
    for (const viewport of [{ width: 1920, height: 1080 }, { width: 1440, height: 900 }, { width: 390, height: 600 }, { width: 844, height: 390 }]) {
      await page.setViewportSize(viewport);
      await page.waitForTimeout(80);
      expect(await expectCaptionCenteredInEncodedBar(page, '.inception-intro-video')).toBe('You are Eames.');
      if (viewport.width === 390) await page.screenshot({ path: join(snapshotDirectory, 'inception-intro-caption-phone-390x600.png') });
    }
    await page.setViewportSize({ width: 320, height: 600 });
    await page.locator('.inception-intro-video').evaluate(video => { (video as HTMLVideoElement).currentTime = 12.2; });
    await expect(caption).toHaveText('In this encounter, he cannot remember the combination.');
    const introFit = await caption.evaluate(element => ({ height: element.clientHeight, contentHeight: element.scrollHeight }));
    expect(introFit.contentHeight).toBeLessThanOrEqual(introFit.height + 1);
    await page.keyboard.press('Escape');
    await expect(page.getByLabel('Speak to Fischer')).toBeEnabled();
  });

  test('a failed intro shows recovery controls and can be retried or continued', async ({ page }) => {
    await page.addInitScript(() => { Element.prototype.requestFullscreen = async function () { throw new Error('fullscreen denied by fixture'); }; });
    const introPath = (await (await page.request.get('/inception-assets/manifest.json')).json()).introVideo as string;
    await page.route(`**${introPath}`, route => route.abort());
    await signInOwner(page.request);
    await page.goto('/inception');
    await expect(page.locator('.inception-root')).toBeVisible();
    await expect.poll(() => page.locator('.inception-entry, .inception-play').count()).toBe(1);
    await startFreshAttempt(page, false);
    await expect(page.getByRole('region', { name: 'Strongroom approach' })).toBeVisible();
    await expect(page.locator('.inception-root')).toHaveClass(/is-immersive/);
    await expect(page.getByRole('button', { name: 'Retry approach' })).toBeVisible({ timeout: 12000 });
    await expect(page.getByRole('button', { name: 'Continue' })).toBeVisible();
    await page.unroute(`**${introPath}`);
    await page.getByRole('button', { name: 'Retry approach' }).click();
    await expect(page.locator('video.inception-intro-video')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Continue' })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.getByLabel('Speak to Fischer')).toBeEnabled();
    await page.keyboard.press('Escape');
    await expect(page).toHaveURL(/\/$/);
  });

  test('a lost intro start receipt retries the same request key and reuses the created round', async ({ page }) => {
    await signInOwner(page.request);
    await page.goto('/inception');
    await expect(page.locator('.inception-root')).toBeVisible();
    await startFreshAttempt(page, false);
    await expect(page.getByRole('region', { name: 'Strongroom approach' })).toBeVisible();
    let firstRoundId = '';
    const requestKeys: string[] = [];
    await page.route('**/api/inception/start', async route => {
      if (route.request().method() !== 'POST') { await route.continue(); return; }
      requestKeys.push(route.request().postDataJSON().clientStartId);
      const response = await route.fetch();
      const session = await response.json();
      if (requestKeys.length === 1) { firstRoundId = session.round.id; await route.abort(); }
      else await route.fulfill({ response, json: session });
    });
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Retry start' })).toBeVisible();
    await page.getByRole('button', { name: 'Retry start' }).click();
    await expect(page.getByLabel('Speak to Fischer')).toBeEnabled();
    expect(requestKeys).toHaveLength(2);
    expect(requestKeys[1]).toBe(requestKeys[0]);
    expect(firstRoundId).not.toBe('');
    await expect.poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem('workshop-inception-session') || '{}').id)).toBe(firstRoundId);
  });
});
