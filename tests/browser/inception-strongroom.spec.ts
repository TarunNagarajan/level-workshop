import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { signInOwner } from './auth';

async function finishApproachForTest(page: import('@playwright/test').Page) {
  const video = page.locator('video.inception-intro-video').first();
  await expect(video).toBeVisible();
  await video.evaluate(element => {
    const media = element as HTMLVideoElement;
    media.pause();
    if (Number.isFinite(media.duration) && media.duration > 0) media.currentTime = media.duration;
    media.dispatchEvent(new Event('ended', { bubbles: true }));
  });
  await expect(page.locator('.inception-play')).toBeVisible();
  await expect(page.locator('.inception-play')).not.toHaveClass(/is-handoff-locked/);
  await expect(page.locator('.inception-root')).not.toHaveAttribute('inert', '');
}

async function acceptInceptionRecordingNotice(page: import('@playwright/test').Page) {
  const notice = page.getByRole('heading', { name: 'Before you enter Inception' });
  const root = page.locator('.inception-root');
  await expect(notice.or(root)).toBeVisible({ timeout: 10000 });
  if (await notice.isVisible()) {
    await page.getByRole('checkbox', { name: 'I understand and agree to this recording.' }).check();
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(notice).toHaveCount(0);
  }
}

async function startFreshAttempt(page: import('@playwright/test').Page, skipApproach = true) {
  await acceptInceptionRecordingNotice(page);
  await expect(page.locator('.inception-root')).toBeVisible();
  const returnedMenu = page.getByRole('button', { name: 'Return to main menu' });
  if (await returnedMenu.count()) {
    const entryPoster = page.getByRole('button', { name: /Click (anywhere to begin|to continue)/ });
    if (await entryPoster.isVisible()) {
      await entryPoster.click();
      await expect(page.locator('.inception-root')).not.toHaveAttribute('inert', '');
    }
    await returnedMenu.click();
    const continueButton = page.getByRole('button', { name: 'Click to continue' });
    await expect(continueButton).toBeVisible();
    await continueButton.click();
    await expect(page.getByRole('region', { name: 'Strongroom approach' })).toBeVisible();
    if (skipApproach) await finishApproachForTest(page);
    return;
  }
  if (await page.locator('.inception-root').getAttribute('inert') !== null && await page.locator('.inception-play').count()) {
    await page.getByRole('button', { name: /Click (anywhere to begin|to continue)/ }).click();
    await expect(page.locator('.inception-root')).not.toHaveAttribute('inert', '');
  }
  const expiredFinish = page.getByRole('button', { name: 'Finish and review' });
  if (await expiredFinish.count()) {
    await expiredFinish.click();
    const next = page.getByRole('button', { name: /^(Start a new attempt|Return to main menu)$/ });
    await expect(next).toBeVisible();
    if (await page.getByRole('button', { name: 'Return to main menu' }).count()) {
      await page.getByRole('button', { name: 'Return to main menu' }).click();
      await page.getByRole('button', { name: 'Click to continue' }).click();
      await expect(page.getByRole('region', { name: 'Strongroom approach' })).toBeVisible();
      if (skipApproach) await finishApproachForTest(page);
      return;
    }
  }
  const composer = page.getByLabel('Speak to Fischer');
  if (await composer.count()) {
    const finish = page.getByRole('button', { name: 'Finish and review' });
    if (await finish.count()) {
      await finish.click();
      const next = page.getByRole('button', { name: /^(Start a new attempt|Return to main menu)$/ });
      await expect(next).toBeVisible();
      if (await page.getByRole('button', { name: 'Return to main menu' }).count()) {
        await page.getByRole('button', { name: 'Return to main menu' }).click();
        await page.getByRole('button', { name: 'Click to continue' }).click();
        await expect(page.getByRole('region', { name: 'Strongroom approach' })).toBeVisible();
        if (skipApproach) await finishApproachForTest(page);
        return;
      }
    }
  }
  const replay = page.getByRole('button', { name: 'Start a new attempt' });
  if (await replay.count()) { await replay.click(); await expect(page.getByRole('region', { name: 'Strongroom approach' })).toBeVisible(); if (skipApproach) await finishApproachForTest(page); return; }
  const consent = page.getByRole('checkbox', { name: /I understand and agree to this recording/ });
  if (await consent.count()) await consent.check();
  const begin = page.getByRole('button', { name: /^Click (anywhere to begin|to continue)$/ });
  if (await begin.count()) {
    if (await consent.count()) await consent.check();
    await begin.click();
    if (skipApproach) { await expect(page.getByRole('region', { name: 'Strongroom approach' })).toBeVisible(); await finishApproachForTest(page); }
  }
  if (skipApproach) await expect(page.locator('.inception-play')).not.toHaveClass(/is-handoff-locked/);
}

async function expectComposerStatusesHidden(page: import('@playwright/test').Page) {
  await expect(page.locator('.inception-composer .inception-send-status')).toHaveCount(0);
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

  test('Escape cancels the approach, exits real fullscreen, and returns to the poster without starting a round', async ({ page }) => {
    await signInOwner(page.request);
    let starts = 0;
    await page.route('**/api/inception/start', async route => { if (route.request().method() === 'POST') starts++; await route.continue(); });
    await page.goto('/inception');
    await acceptInceptionRecordingNotice(page);
    const entry = page.getByRole('button', { name: 'Click to continue' });
    await entry.click();
    await expect(page.getByRole('region', { name: 'Strongroom approach' })).toBeVisible();
    expect(await page.evaluate(() => document.fullscreenElement === document.documentElement)).toBeTruthy();
    await page.keyboard.press('Escape');
    await expect(entry).toBeVisible();
    await expect(entry).toBeEnabled();
    await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBeTruthy();
    expect(starts).toBe(0);
  });

  test('double-clicking the intro starts exactly once and keeps the paused film through a delayed receipt', async ({ page }) => {
    await signInOwner(page.request);
    let starts = 0, messagePosts = 0, releaseStart!: () => void, markStartReceived!: () => void;
    const startReceived = new Promise<void>(resolve => { markStartReceived = resolve; });
    const startGate = new Promise<void>(resolve => { releaseStart = resolve; });
    await page.route('**/api/inception/start', async route => {
      if (route.request().method() === 'POST') { starts++; markStartReceived(); await startGate; }
      await route.continue();
    });
    page.on('request', request => { if (request.method() === 'POST' && /\/api\/rounds\/[^/]+\/messages$/.test(request.url())) messagePosts++; });
    await page.goto('/inception');
    await acceptInceptionRecordingNotice(page);
    const entry = page.getByRole('button', { name: /Click (anywhere to begin|to continue)/ });
    await entry.evaluate(button => button.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true })));
    await expect(entry).toBeVisible();
    await expect(page.locator('.inception-intro-video')).toHaveCount(0);
    expect(starts).toBe(0);

    await entry.click();
    await expect(page.getByRole('region', { name: 'Strongroom approach' })).toBeVisible();
    const introVideo = page.locator('.inception-intro-video').first();
    await introVideo.dblclick({ delay: 35 });
    await startReceived;
    expect(starts).toBe(1);
    await expect(page.getByRole('region', { name: 'Strongroom approach' })).toBeVisible();
    await expect(introVideo).toHaveJSProperty('paused', true);
    await expect(page.getByText('Checking the saved start request…')).toHaveCount(0);
    await expect(page.locator('.inception-entry-recovery, .inception-media-recovery')).toHaveCount(0);
    releaseStart();
    await expect(page.getByLabel('Speak to Fischer')).toBeEnabled({ timeout: 10000 });
    await expect(page.locator('.inception-intro-video')).toHaveCount(0);
    await page.getByRole('log', { name: 'Conversation transcript' }).dblclick();
    await page.getByLabel('Speak to Fischer').dblclick();
    expect(starts).toBe(1);
    expect(messagePosts).toBe(0);
  });

  test('a definitive intro-skip start rejection returns to a usable poster with its error', async ({ page }) => {
    await signInOwner(page.request);
    await page.goto('/inception');
    await acceptInceptionRecordingNotice(page);
    await startFreshAttempt(page, false);
    const intro = page.getByRole('region', { name: 'Strongroom approach' });
    await expect(intro).toBeVisible();
    let starts = 0;
    await page.route('**/api/inception/start', async route => {
      if (route.request().method() === 'POST') {
        starts++;
        await route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'The fixture rejected this start.' }) });
        return;
      }
      await route.continue();
    });
    await page.locator('.inception-intro-video').first().dblclick({ delay: 30 });
    const entry = page.getByRole('button', { name: /Click (anywhere to begin|to continue)/ });
    await expect(entry).toBeEnabled({ timeout: 10000 });
    await expect(entry).toContainText('The fixture rejected this start.');
    await expect(intro).toHaveCount(0);
    expect(starts).toBe(1);
    await entry.click();
    await expect(intro).toBeVisible();
  });

  test('double-clicking an early success film frame fades to opaque black and returns once without extra requests', async ({ page }) => {
    test.setTimeout(90000);
    await signInOwner(page.request);
    await page.addInitScript(() => localStorage.setItem('workshop-inception-sound', JSON.stringify({ muted: true, volume: 0.45 })));
    const protectedPosts: string[] = [];
    page.on('request', request => {
      if (request.method() === 'POST' && /\/api\/(inception\/start|inception\/rounds\/[^/]+\/review|rounds\/[^/]+\/messages)$/.test(request.url())) protectedPosts.push(request.url());
    });
    await page.goto('/inception');
    await acceptInceptionRecordingNotice(page);
    await startFreshAttempt(page);
    await page.getByLabel('Speak to Fischer').fill('[fixture:inception-disclosure]');
    await page.getByLabel('Speak to Fischer').press('Enter');
    await expect(page.getByText(/The combination is \d{6}\./)).toBeVisible();
    await page.getByRole('button', { name: 'Finish and review' }).click();
    const ending = page.locator('.inception-success-ending');
    const video = ending.locator('video');
    await expect(video).toBeVisible();
    const videoHandle = await video.elementHandle();
    expect(videoHandle).not.toBeNull();
    await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).currentTime)).toBeGreaterThan(0.05);
    await expect.poll(() => ending.evaluate(element => Number.parseFloat(getComputedStyle(element).opacity))).toBeLessThan(0.99);
    const requestsAtSkip = [...protectedPosts];
    await page.evaluate(() => {
      const probe = { active: true, frames: [] as Array<{ className: string; opacity: number; parentIsBody: boolean; zIndex: number }> };
      (window as any).__endingSkipCoverProbe = probe;
      const sample = () => {
        if (!probe.active) return;
        const cover = document.querySelector<HTMLElement>('.inception-cinematic-cover');
        if (cover) probe.frames.push({ className: cover.className, opacity: Number.parseFloat(getComputedStyle(cover).opacity), parentIsBody: cover.parentElement === document.body, zIndex: Number.parseInt(getComputedStyle(cover).zIndex, 10) });
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    await ending.dblclick({ delay: 30 });
    await expect.poll(() => videoHandle!.evaluate(element => (element as HTMLVideoElement).volume)).toBe(0);
    expect(await videoHandle!.evaluate(element => ({ muted: (element as HTMLVideoElement).muted, volume: (element as HTMLVideoElement).volume }))).toMatchObject({ muted: true, volume: 0 });
    await expect(page.getByRole('button', { name: 'Click to continue' })).toBeVisible({ timeout: 10000 });
    await expect(page.locator('.inception-success-ending, .inception-result, .inception-play')).toHaveCount(0);
    const coverFrames = await page.evaluate(() => { const probe = (window as any).__endingSkipCoverProbe; probe.active = false; return probe.frames as Array<{ className: string; opacity: number; parentIsBody: boolean; zIndex: number }>; });
    const skipFrames = coverFrames.filter(frame => frame.className.includes('ending-skip'));
    expect(skipFrames.length).toBeGreaterThan(0);
    expect(skipFrames.every(frame => frame.parentIsBody)).toBeTruthy();
    expect(skipFrames.every(frame => frame.zIndex > 2147483001)).toBeTruthy();
    expect(protectedPosts).toEqual(requestsAtSkip);
    await page.reload();
    await expect(page.getByRole('button', { name: 'Click to continue' })).toBeVisible();
    await expect(page.locator('.inception-result, .inception-play')).toHaveCount(0);
  });

  test('intro skip starts one round; inspection, conversation and review keep the saved state honest', async ({ page }) => {
    test.setTimeout(120000);
    await signInOwner(page.request);
    await page.addInitScript(() => {
      const probe: any = { gains: [] as Array<{ initialized: number[]; targets: number[] }>, attempted: [] as string[], played: [] as string[], pauses: [] as Array<{ path: string; time: number }>, gameplayElement: null as HTMLAudioElement | null, gameplayPlayCalls: 0, closes: 0 };
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
        if (this.src.includes('strongroom-score-gameplay-v1.mp3')) {
          probe.played.push(this.src);
          probe.gameplayElement = this as HTMLAudioElement;
          probe.gameplayPlayCalls++;
        }
        if (this.src.includes('strongroom-roomtone')) probe.played.push(this.src);
        return play.call(this);
      };
      HTMLMediaElement.prototype.pause = function () { if (this.src.includes('strongroom-score-gameplay-v1.mp3')) probe.pauses.push({ path: this.src, time: this.currentTime }); return pause.call(this); };
      AudioContext.prototype.close = function () { probe.closes++; return close.call(this); };
    });
    let starts = 0;
    await page.route('**/api/inception/start', async route => { if (route.request().method() === 'POST') starts++; await route.continue(); });
    const errors: string[] = [];
    page.on('response', response => { if (response.url().includes('/inception-assets/') && response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });

    await page.goto('/inception/?profile=sealed');
    await acceptInceptionRecordingNotice(page);
    expect(page.url()).toContain('/inception/?profile=sealed');
    await expect(page.locator('.sidebar, nav[aria-label="Main navigation"]')).toHaveCount(0);
    await expect(page.locator('a[href]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Click to continue' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Standard|Story|Guarded|Sealed/ })).toHaveCount(0);
    const media = await (await page.request.get('/inception-assets/manifest.json')).json();
    for (const path of [media.closedFrame, media.openFrame, media.bridgeFrame, media.entryPoster, media.entryWordmark, media.introVideo, media.captions, media.successVideo, media.gameplayLoop, media.roomTone, media.portraits?.eames, media.portraits?.fischer].filter(Boolean)) {
      expect((await page.request.get(path)).ok(), `media asset should be served: ${path}`).toBeTruthy();
    }
    const posterCover = await page.evaluate(() => {
      const poster = document.querySelector<HTMLElement>('.inception-entry-poster')!;
      const points = [[1, 1], [innerWidth - 2, 1], [1, innerHeight - 2], [innerWidth - 2, innerHeight - 2]];
      return { bounds: poster.getBoundingClientRect().toJSON(), viewport: { width: innerWidth, height: innerHeight }, hits: points.map(([x, y]) => document.elementFromPoint(x, y)?.closest('.inception-entry-poster') === poster) };
    });
    expect(posterCover.bounds.left).toBe(0);
    expect(posterCover.bounds.top).toBe(0);
    expect(posterCover.bounds.width).toBeGreaterThanOrEqual(posterCover.viewport.width - 1);
    expect(posterCover.bounds.height).toBeGreaterThanOrEqual(posterCover.viewport.height - 1);
    expect(posterCover.hits.every(Boolean)).toBeTruthy();
    await page.getByRole('button', { name: 'Click to continue' }).click();
    await expect(page.getByRole('region', { name: 'Strongroom approach' })).toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as any).__inceptionAudioProbe.gains.length)).toBeGreaterThanOrEqual(3);
    const initialAudio = await page.evaluate(() => (window as any).__inceptionAudioProbe);
    expect(initialAudio.gains[1].initialized[0]).toBe(0, 'the gameplay deck starts at zero before its fixed master mix opens');
    expect(initialAudio.gains[0].targets.some((gain: number) => gain > 0 && gain <= 0.7)).toBeTruthy();
    expect(initialAudio.attempted.some((path: string) => path.includes('strongroom-score-gameplay-v1.mp3'))).toBeTruthy();
    expect(initialAudio.attempted.some((path: string) => /strongroom-score-(calm|developing|urgent)-v1\.mp3/.test(path))).toBeFalsy();
    await expect(page.locator('.inception-intro-chrome')).toHaveCount(0);
    await expect(page.locator('.inception-intro button')).toHaveCount(0);
    expect(starts).toBe(0);
    expect(await page.evaluate(() => document.fullscreenElement === document.documentElement)).toBeTruthy();
    await finishApproachForTest(page);
    await expect(page.getByLabel('Speak to Fischer')).toBeEnabled();
    expect(starts).toBe(1);

    await expect.poll(() => page.evaluate(() => (window as any).__inceptionAudioProbe.gameplayElement?.duration || 0)).toBeGreaterThan(120);
    await expect.poll(() => page.evaluate(() => (window as any).__inceptionAudioProbe.gameplayPlayCalls)).toBeGreaterThan(0);
    await page.evaluate(() => { (window as any).__inceptionAudioProbe.gameplayElement.currentTime = 31.8; });
    const beforeClockJump = await page.evaluate(() => {
      const probe = (window as any).__inceptionAudioProbe;
      const originalNow = Date.now.bind(Date);
      probe.originalNow = originalNow;
      probe.simulatedNow = originalNow();
      Date.now = () => probe.simulatedNow;
      return { path: probe.gameplayElement.src, plays: probe.gameplayPlayCalls, gainTargets: probe.gains[0].targets.length };
    });
    await page.evaluate(() => { (window as any).__inceptionAudioProbe.simulatedNow += 120_000; });
    await page.waitForTimeout(300);
    await page.evaluate(() => { (window as any).__inceptionAudioProbe.simulatedNow += 105_000; });
    await page.waitForTimeout(1100);
    const afterClockJump = await page.evaluate(() => {
      const probe = (window as any).__inceptionAudioProbe;
      return { path: probe.gameplayElement.src, time: probe.gameplayElement.currentTime, plays: probe.gameplayPlayCalls, gainTargets: probe.gains[0].targets.length };
    });
    expect(afterClockJump.path).toContain('strongroom-score-gameplay-v1.mp3');
    expect(afterClockJump.time).toBeGreaterThan(32.5);
    expect(afterClockJump.plays).toBe(beforeClockJump.plays);
    expect(afterClockJump.gainTargets).toBe(beforeClockJump.gainTargets);

    await page.getByRole('button', { name: 'Inspect safe' }).click();
    await expect(page.getByText(/compact safe is recessed in the dark-green bedside cabinet/)).toBeVisible();
    await page.getByRole('button', { name: 'Close' }).click();
    const composer = page.getByLabel('Speak to Fischer');
    const musicBeforeReply = await page.evaluate(() => {
      const probe = (window as any).__inceptionAudioProbe;
      return { path: probe.gameplayElement.src, time: probe.gameplayElement.currentTime, plays: probe.gameplayPlayCalls, gainTargets: probe.gains[0].targets.length };
    });
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
    const musicAfterReply = await page.evaluate(() => {
      const probe = (window as any).__inceptionAudioProbe;
      return { path: probe.gameplayElement.src, time: probe.gameplayElement.currentTime, plays: probe.gameplayPlayCalls, gainTargets: probe.gains[0].targets.length };
    });
    expect(musicAfterReply.path).toBe(musicBeforeReply.path);
    expect(musicAfterReply.time).toBeGreaterThan(musicBeforeReply.time);
    expect(musicAfterReply.plays).toBe(musicBeforeReply.plays);
    expect(musicAfterReply.gainTargets).toBe(musicBeforeReply.gainTargets);
    await page.evaluate(() => { (window as any).__inceptionAudioProbe.gameplayElement.currentTime = 127.55; });
    await page.waitForTimeout(1000);
    const afterLoopWrap = await page.evaluate(() => {
      const probe = (window as any).__inceptionAudioProbe;
      return { path: probe.gameplayElement.src, time: probe.gameplayElement.currentTime, plays: probe.gameplayPlayCalls, gainTargets: probe.gains[0].targets.length };
    });
    expect(afterLoopWrap.path).toBe(musicAfterReply.path);
    expect(afterLoopWrap.time).toBeGreaterThan(0);
    expect(afterLoopWrap.time).toBeLessThan(1.5);
    expect(afterLoopWrap.plays).toBe(musicAfterReply.plays);
    expect(afterLoopWrap.gainTargets).toBe(musicAfterReply.gainTargets);
    await page.evaluate(() => { const probe = (window as any).__inceptionAudioProbe; Date.now = probe.originalNow; });
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
    const beforeMute = await page.evaluate(() => {
      const probe = (window as any).__inceptionAudioProbe;
      return { path: probe.gameplayElement.src, time: probe.gameplayElement.currentTime };
    });
    await page.getByRole('button', { name: 'Mute sound' }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__inceptionAudioProbe.gains[0].targets.at(-1))).toBe(0);
    const mutedAudio = await page.evaluate(() => (window as any).__inceptionAudioProbe);
    expect(mutedAudio.pauses.length).toBeGreaterThan(0);
    const pausedAt = await page.evaluate(() => (window as any).__inceptionAudioProbe.gameplayElement.currentTime);
    await page.waitForTimeout(250);
    expect(await page.evaluate(() => (window as any).__inceptionAudioProbe.gameplayElement.currentTime)).toBe(pausedAt);
    await page.getByRole('button', { name: 'Unmute sound' }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__inceptionAudioProbe.gains[0].targets.at(-1))).toBeGreaterThan(0);
    await expect.poll(() => page.evaluate(() => (window as any).__inceptionAudioProbe.gameplayElement.paused)).toBe(false);
    const afterUnmute = await page.evaluate(() => {
      const probe = (window as any).__inceptionAudioProbe;
      return { path: probe.gameplayElement.src, time: probe.gameplayElement.currentTime };
    });
    expect(afterUnmute.path).toBe(beforeMute.path);
    expect(afterUnmute.time).toBeGreaterThanOrEqual(pausedAt);
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

    const parkedTranscriptCount = await transcript.locator('article').count();
    await page.keyboard.press('Escape');
    const entryButton = page.getByRole('button', { name: 'Click to continue' });
    await expect(entryButton).toBeVisible();
    await expect(page.locator('.inception-root')).toHaveAttribute('inert', '');
    await composer.evaluate(element => (element as HTMLTextAreaElement).focus());
    expect(await composer.evaluate(element => document.activeElement === element)).toBeFalsy();
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => Boolean(document.activeElement?.closest('.inception-root')))).toBeFalsy();
    await entryButton.click();
    await expect(page.getByRole('region', { name: 'Inception strongroom' })).toBeVisible();
    expect(starts).toBe(1);
    await expect(transcript.locator('article')).toHaveCount(parkedTranscriptCount);

    await page.getByRole('button', { name: 'Finish and review' }).click();
    await expect(page.getByText('The dream gives way. The safe stays locked.')).toBeVisible();
    await expect(page.getByRole('group', { name: 'Closed strongroom safe' })).toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as any).__inceptionAudioProbe.closes)).toBe(1);
    await expect(page.locator('.inception-top-actions button[aria-label$="sound"]')).toBeDisabled();
    await expect(page.locator('.inception-sound-recovery')).toHaveCount(0);
    expect(starts).toBe(1);
    expect(errors).toEqual([]);
    const replay = page.getByRole('button', { name: 'Return to main menu' });
    const gainsBeforeReplay = await page.evaluate(() => (window as any).__inceptionAudioProbe.gains.length as number);
    await replay.click();
    await expect(page.getByRole('button', { name: 'Click to continue' })).toBeVisible();
    expect(starts).toBe(1);
    await page.getByRole('button', { name: 'Click to continue' }).click();
    await expect(page.getByRole('region', { name: 'Strongroom approach' })).toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as any).__inceptionAudioProbe.gains.length)).toBeGreaterThanOrEqual(gainsBeforeReplay + 3);
    expect(starts).toBe(1);
    await finishApproachForTest(page);
    await expect(page.getByLabel('Speak to Fischer')).toBeEnabled();
    expect(starts).toBe(2);
    await page.getByRole('button', { name: 'Finish and review' }).click();
    await expect(page.getByRole('button', { name: /^(Return to main menu|Start a new attempt)$/ })).toBeVisible();
  });

  test('a delayed Enter reply restores keyboard input for the next prompt', async ({ page }) => {
    await signInOwner(page.request);
    await page.goto('/inception');
    await startFreshAttempt(page);
    const composer = page.getByLabel('Speak to Fischer');
    const transcript = page.getByRole('log', { name: 'Conversation transcript' });
    let releaseReply!: () => void;
    let markRequestStarted!: () => void;
    const requestStarted = new Promise<void>(resolve => { markRequestStarted = resolve; });
    const replyGate = new Promise<void>(resolve => { releaseReply = resolve; });
    await page.route('**/api/rounds/*/messages', async route => {
      if (route.request().method() === 'POST') { markRequestStarted(); await replyGate; }
      await route.continue();
    });

    const initialCount = await transcript.locator('article').count();
    await composer.focus();
    await page.keyboard.type('What can you tell me about the safe?');
    await page.keyboard.press('Enter');
    await requestStarted;
    await expect(page.getByRole('button', { name: 'Sending to Fischer' })).toBeVisible();
    releaseReply();
    await expect(transcript.locator('article')).toHaveCount(initialCount + 2);
    await expect(composer).toBeFocused();

    await page.unroute('**/api/rounds/*/messages');
    const nextCount = await transcript.locator('article').count();
    await page.keyboard.type('Tell me one more thing about the room.');
    await expect(composer).toHaveValue('Tell me one more thing about the room.');
    await page.keyboard.press('Enter');
    await expect(transcript.locator('article')).toHaveCount(nextCount + 2);
  });

  test('a pointer Send reply returns focus to the composer', async ({ page }) => {
    await signInOwner(page.request);
    await page.goto('/inception');
    await startFreshAttempt(page);
    const composer = page.getByLabel('Speak to Fischer');
    const transcript = page.getByRole('log', { name: 'Conversation transcript' });
    const count = await transcript.locator('article').count();
    await composer.fill('What can you tell me about the safe?');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(transcript.locator('article')).toHaveCount(count + 2);
    await expect(composer).toBeFocused();
  });

  test('a reply arriving after leaving cannot focus the hidden composer', async ({ page }) => {
    await signInOwner(page.request);
    await page.goto('/inception');
    await startFreshAttempt(page);
    const composer = page.getByLabel('Speak to Fischer');
    let releaseReply!: () => void;
    let markRequestStarted!: () => void;
    const requestStarted = new Promise<void>(resolve => { markRequestStarted = resolve; });
    const replyGate = new Promise<void>(resolve => { releaseReply = resolve; });
    const replyResponse = page.waitForResponse(response => response.request().method() === 'POST' && /\/api\/rounds\/[^/]+\/messages$/.test(response.url()));
    await page.route('**/api/rounds/*/messages', async route => {
      if (route.request().method() === 'POST') { markRequestStarted(); await replyGate; }
      await route.continue();
    });
    await composer.focus();
    await page.keyboard.type('What can you tell me about the safe?');
    await page.keyboard.press('Enter');
    await requestStarted;
    await page.keyboard.press('Escape');
    const entry = page.getByRole('button', { name: 'Click to continue' });
    await expect(entry).toBeVisible();
    releaseReply();
    await replyResponse;
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(composer).toBeDisabled();
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('Click to continue');
    await expect(composer).not.toBeFocused();
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
    await expect(page.getByRole('button', { name: 'Sending to Fischer' })).toBeVisible();
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
    await expect(page.getByRole('button', { name: 'Sending to Fischer' })).toBeVisible();
    await transcript.evaluate(element => { element.scrollTop = 0; });
    await transcript.evaluate(element => { element.scrollTop = element.scrollHeight; });
    await expect.poll(() => transcript.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThan(4);
    allowResponse();
    await expect(transcript.locator('article')).toHaveCount(count + 2);
    await expect.poll(() => transcript.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThan(6);

    const originalViewport = page.viewportSize()!;
    const exitFullscreen = page.getByRole('button', { name: 'Exit fullscreen' });
    if (await exitFullscreen.count()) await exitFullscreen.click();
    await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
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
    await expect(page.getByRole('button', { name: 'Click to continue' })).toHaveCount(0);
    expect(messageRequests).toBe(2);
    await page.getByRole('button', { name: 'Finish and review' }).click();
    await expect(page.getByText('The dream gives way. The safe stays locked.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Return to main menu' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Start a new attempt' })).toHaveCount(0);
  });

  test('a confirmed provider failure clears only the terminal receipt and needs an explicit new send', async ({ page }) => {
    test.setTimeout(60000);
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
        if (body.content.includes('[fixture:rate-limit-once]')) {
          markFailureStarted(); await failureGate;
          const response = await route.fetch();
          await route.fulfill({ response, json: { ...(await response.json()), retryAfterSeconds: 10 } });
          return;
        }
      }
      await route.continue();
    });
    await composer.fill('[fixture:rate-limit-once] Confirm this explicit retry path.');
    await expect(page.getByRole('button', { name: 'Send' })).toBeEnabled();
    await composer.press('Enter');
    await failureStarted;
    await expectComposerStatusesHidden(page);
    releaseFailureFixture();
    await expect(page.getByText('Usage limit reached. Your prompt is saved. Wait before trying again.')).toBeVisible();
    await expectComposerStatusesHidden(page);
    await expect(page.getByRole('button', { name: 'Retry saved message' })).toHaveCount(0);
    await expect(composer).toHaveValue('[fixture:rate-limit-once] Confirm this explicit retry path.');
    expect(requestIds).toHaveLength(1);
    await expect(page.getByRole('button', { name: /^Retry in 00:/ })).toBeDisabled();
    await composer.press('Enter');
    expect(requestIds).toHaveLength(1);
    await expect(page.getByRole('button', { name: 'Send' })).toBeEnabled({ timeout: 12000 });
    await composer.press('Enter');
    await expect(page.getByText(/I was honoured for Special Services/)).toBeVisible();
    expect(requestIds).toHaveLength(2);
    expect(requestIds[0]).not.toBe(requestIds[1]);
    await page.getByRole('button', { name: 'Finish and review' }).click();
    await expect(page.getByText('The dream gives way. The safe stays locked.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Return to main menu' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Start a new attempt' })).toHaveCount(0);
  });

  test('an accepted but unresolved receipt has bounded recovery and retries with the same ID', async ({ page }) => {
    await page.addInitScript(() => {
      const originalFetch = window.fetch.bind(window);
      (window as any).__recoveryGets = 0;
      window.fetch = async (input, init = {}) => {
        const url = typeof input === 'string' ? input : input instanceof Request ? input.url : '';
        if (/\/api\/inception\/rounds\/[^/]+$/.test(url) && init.method !== 'POST') {
          (window as any).__recoveryGets++;
          const signal = init.signal;
          return await new Promise<Response>((_resolve, reject) => {
            if (signal?.aborted) reject(new DOMException('Timed out.', 'AbortError'));
            else signal?.addEventListener('abort', () => reject(new DOMException('Timed out.', 'AbortError')), { once: true });
          });
        }
        return originalFetch(input, init);
      };
    });
    await signInOwner(page.request);
    await page.goto('/inception');
    await startFreshAttempt(page);
    await page.evaluate(() => { (window as any).__recoveryGets = 0; });
    const composer = page.getByLabel('Speak to Fischer');
    const requestIds: string[] = [];
    let accepted = false;
    await page.route('**/api/rounds/*/messages', async route => {
      if (route.request().method() !== 'POST') { await route.continue(); return; }
      requestIds.push(route.request().postDataJSON().requestId);
      if (!accepted) {
        accepted = true;
        await route.fetch();
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'The saved reply is still being checked.', submissionId: 'fixture-pending', submissionStatus: 'pending', receiptConfirmed: true }) });
        return;
      }
      await route.continue();
    });
    await composer.fill('Tell me about the safe.');
    await composer.press('Enter');
    await expect(page.getByRole('button', { name: 'Checking message receipt' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Retry saved message' })).toBeVisible({ timeout: 10000 });
    expect(await page.evaluate(() => (window as any).__recoveryGets)).toBe(1);
    expect(requestIds).toHaveLength(1);
    await page.getByRole('button', { name: 'Retry saved message' }).click();
    await expect(page.getByText(/I was honoured for Special Services/)).toBeVisible();
    expect(requestIds).toHaveLength(2);
    expect(requestIds[0]).toBe(requestIds[1]);
  });

  test('a late callback from the previous lifecycle cannot unlock a newer receipt check', async ({ page }) => {
    await signInOwner(page.request);
    await page.goto('/inception');
    await startFreshAttempt(page);
    const composer = page.getByLabel('Speak to Fischer');
    const requestIds: string[] = [];
    let releaseFirst!: () => void, releaseSecond!: () => void;
    let firstStarted!: () => void, secondStarted!: () => void;
    let firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    let secondGate = new Promise<void>(resolve => { releaseSecond = resolve; });
    const firstStart = new Promise<void>(resolve => { firstStarted = resolve; });
    const secondStart = new Promise<void>(resolve => { secondStarted = resolve; });
    await page.route('**/api/rounds/*/messages', async route => {
      if (route.request().method() !== 'POST') { await route.continue(); return; }
      requestIds.push(route.request().postDataJSON().requestId);
      if (requestIds.length === 1) { firstStarted(); await firstGate; }
      else { secondStarted(); await secondGate; }
      await route.continue();
    });
    await composer.fill('Tell me about the safe.');
    await composer.press('Enter');
    await firstStart;
    await page.getByRole('button', { name: 'Leave strongroom' }).click();
    const continueButton = page.getByRole('button', { name: 'Click to continue' });
    await expect(continueButton).toBeVisible();
    await continueButton.click();
    await expect(composer).toBeVisible();
    await page.getByRole('button', { name: 'Retry saved message' }).click();
    await secondStart;
    expect(requestIds).toHaveLength(2);
    expect(requestIds[0]).toBe(requestIds[1]);
    releaseFirst();
    await expect(page.getByRole('button', { name: 'Checking message receipt' })).toBeVisible();
    releaseSecond();
    await expect(page.getByText(/I was honoured for Special Services/)).toBeVisible();
  });

  test('a daily capacity failure shows a saved cooldown and opens the deliberate new attempt flow', async ({ page }) => {
    await signInOwner(page.request);
    await page.goto('/inception');
    await startFreshAttempt(page);
    const composer = page.getByLabel('Speak to Fischer');
    const failureStarted = new Promise<void>(resolve => {
      void page.route('**/api/rounds/*/messages', async route => {
        if (route.request().method() === 'POST' && route.request().postDataJSON().content.includes('[fixture:rate-limit-once]')) {
          const response = await route.fetch();
          const body = await response.json();
          await route.fulfill({ response, json: { ...body, retryAfterSeconds: 30 } });
          resolve();
          return;
        }
        await route.continue();
      });
    });
    await composer.fill('[fixture:rate-limit-once] Check daily capacity before I continue.');
    await composer.press('Enter');
    await failureStarted;
    const cooldownAction = page.getByRole('button', { name: /^Retry in 00:2[0-9]$/ });
    await expect(cooldownAction).toBeVisible();
    await page.reload();
    await page.getByRole('button', { name: 'Click to continue' }).click();
    await expect(page.getByRole('button', { name: /^Retry in 00:2[0-9]$/ })).toBeVisible();
    await expect(composer).toBeVisible();
    await expect(page.getByRole('button', { name: 'Start a new attempt' })).toBeVisible();
    await expect(composer).toHaveValue('[fixture:rate-limit-once] Check daily capacity before I continue.');
    await page.getByRole('button', { name: 'Start a new attempt' }).click();
    await expect(page.getByRole('button', { name: 'Click anywhere to begin' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Inception strongroom' })).toHaveCount(0);
    const actorScope = await page.evaluate(async () => (await (await fetch('/api/inception')).json()).actorScope as string);
    const savedNextDraft = await page.evaluate(scope => sessionStorage.getItem(`workshop-inception-next-attempt-draft:${scope}`), actorScope);
    expect(JSON.parse(savedNextDraft || 'null')).toMatchObject({ actorScope, draft: '[fixture:rate-limit-once] Check daily capacity before I continue.' });
    await page.getByRole('button', { name: 'Click anywhere to begin' }).click();
    await expect(page.getByRole('region', { name: 'Strongroom approach' })).toBeVisible();
    await finishApproachForTest(page);
    await expect(composer).toBeVisible();
    await expect(composer).toHaveValue('[fixture:rate-limit-once] Check daily capacity before I continue.');
    await expect(page.getByRole('button', { name: 'Send' })).toBeEnabled();
    expect(await page.evaluate(scope => sessionStorage.getItem(`workshop-inception-next-attempt-draft:${scope}`), actorScope)).toBeNull();
  });

  test('a hung review response and recovery check release the finish controls', async ({ page }) => {
    await page.addInitScript(() => {
      const originalFetch = window.fetch.bind(window);
      const originalSetTimeout = window.setTimeout.bind(window);
      (window as any).__hangReview = false;
      (window as any).__hungReviewRequests = { POST: 0, GET: 0 };
      window.setTimeout = ((handler: TimerHandler, timeout = 0, ...args: any[]) => originalSetTimeout(handler, timeout >= 4000 ? 100 : timeout, ...args)) as typeof window.setTimeout;
      window.fetch = async (input, init = {}) => {
        const url = typeof input === 'string' ? input : input instanceof Request ? input.url : '';
        const method = (init.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
        if ((window as any).__hangReview && /\/api\/inception\/rounds\/[^/]+\/review$/.test(url)) {
          (window as any).__hungReviewRequests[method]++;
          return await new Promise<Response>((_resolve, reject) => {
            const signal = init.signal || (input instanceof Request ? input.signal : undefined);
            const abort = () => reject(new DOMException('Fixture request timed out.', 'AbortError'));
            if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
          });
        }
        return originalFetch(input, init);
      };
    });
    await signInOwner(page.request);
    await page.goto('/inception');
    await acceptInceptionRecordingNotice(page);
    await startFreshAttempt(page);
    const composer = page.getByLabel('Speak to Fischer');
    await composer.fill('[fixture:inception-disclosure] Tell me what you remember.');
    await composer.press('Enter');
    await expect(page.getByText(/The combination is \d{6}\./)).toBeVisible();
    await page.evaluate(() => { (window as any).__hangReview = true; });
    await page.getByRole('button', { name: 'Finish and review' }).click();
    const retryReview = page.getByRole('button', { name: 'Retry review' });
    await expect(retryReview).toBeEnabled({ timeout: 8000 });
    expect(await page.evaluate(() => (window as any).__hungReviewRequests)).toEqual({ POST: 1, GET: 1 });
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
    await acceptInceptionRecordingNotice(page);
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
    await page.locator('.inception-success-ending-video').evaluate(element => {
      const video = element as HTMLVideoElement;
      video.pause();
      if (Number.isFinite(video.duration) && video.duration > 0) video.currentTime = video.duration;
      video.dispatchEvent(new Event('ended', { bubbles: true }));
    });
    await page.waitForFunction(() => Boolean(document.querySelector('.inception-cinematic-cover.return-black') && document.querySelector('.inception-entry-poster')));
    const returnedPoster = page.locator('.inception-entry-poster');
    await expect(returnedPoster).toBeDisabled();
    await expect(returnedPoster).toHaveCSS('opacity', '1');
    await page.waitForFunction(() => Boolean(document.querySelector('.inception-cinematic-cover.return-reveal') && document.querySelector('.inception-entry-poster')));
    await expect(returnedPoster).toBeDisabled();
    await expect(returnedPoster).toHaveCSS('opacity', '1');
    await page.keyboard.press('Enter');
    await expect(returnedPoster).toBeDisabled();
    await expect(page.locator('.inception-intro-video')).toHaveCount(0);
    await expect(returnedPoster).toBeEnabled({ timeout: 2000 });
    await expect(returnedPoster).toHaveCSS('opacity', '1');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Click to continue' })).toBeVisible();
    await page.goto('/inception');
    await expect(page.getByRole('button', { name: 'Click to continue' })).toBeVisible();
    await expect(page.locator('.inception-result')).toHaveCount(0);
    expect(reviewPosts).toBe(1);
  });

  test('a confirmed failed attempt returns to the continue poster without losing its record or starting until clicked', async ({ page }) => {
    await signInOwner(page.request);
    await page.goto('/inception/?profile=guarded');
    await acceptInceptionRecordingNotice(page);
    await startFreshAttempt(page);
    let starts = 0, reviewPosts = 0;
    page.on('request', request => {
      if (request.method() !== 'POST') return;
      if (request.url().endsWith('/api/inception/start')) starts++;
      if (/\/api\/inception\/rounds\/[^/]+\/review$/.test(request.url())) reviewPosts++;
    });
    const composer = page.getByLabel('Speak to Fischer');
    await composer.fill('[fixture:inception-no-disclosure] The combination remains unknown.');
    await composer.press('Enter');
    await expect(page.getByRole('button', { name: 'Finish and review' })).toBeVisible();
    const failedRoundId = await page.evaluate(() => JSON.parse(sessionStorage.getItem('workshop-inception-session') || '{}').id as string);
    expect(failedRoundId).toBeTruthy();
    await page.getByRole('button', { name: 'Finish and review' }).click();
    await expect(page.getByText('The dream gives way. The safe stays locked.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Return to main menu' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Start a new attempt' })).toHaveCount(0);
    expect(reviewPosts).toBe(1);

    await page.getByRole('button', { name: 'Return to main menu' }).click();
    const continueButton = page.getByRole('button', { name: 'Click to continue' });
    await expect(continueButton).toBeVisible();
    await expect(page).toHaveURL(/\/inception\/?\?profile=guarded$/);
    await expect(page.locator('.inception-result')).toHaveCount(0);
    expect(starts).toBe(0);
    expect(reviewPosts).toBe(1);
    const savedFailure = await page.evaluate(async roundId => {
      const roundResponse = await fetch(`/api/inception/rounds/${roundId}`);
      const reviewResponse = await fetch(`/api/inception/rounds/${roundId}/review`);
      const round = await roundResponse.json(), review = await reviewResponse.json();
      return { roundStatus: roundResponse.status, reviewStatus: reviewResponse.status, messages: round.round?.messages || round.messages || [], review: review.review || review };
    }, failedRoundId);
    expect(savedFailure.roundStatus).toBe(200);
    expect(savedFailure.reviewStatus).toBe(200);
    expect(savedFailure.messages.some((message: { content?: string }) => message.content?.includes('[fixture:inception-no-disclosure]'))).toBeTruthy();
    expect(savedFailure.review).toMatchObject({ status: 'complete', verdict: 'not_recovered' });

    await page.reload();
    await expect(page.getByRole('button', { name: 'Click to continue' })).toBeVisible();
    await expect(page.locator('.sidebar, nav[aria-label="Main navigation"]')).toHaveCount(0);
    await expect(page.locator('.inception-result')).toHaveCount(0);
    expect(starts).toBe(0);
    expect(reviewPosts).toBe(1);
    const continueAfterReload = page.getByRole('button', { name: 'Click to continue' });
    await continueAfterReload.click();
    await expect(page.getByRole('region', { name: 'Strongroom approach' })).toBeVisible();
    await finishApproachForTest(page);
    await expect(page.getByLabel('Speak to Fischer')).toBeEnabled();
    expect(starts).toBe(1);
    const freshRoundId = await page.evaluate(() => JSON.parse(sessionStorage.getItem('workshop-inception-session') || '{}').id as string);
    expect(freshRoundId).toBeTruthy();
    expect(freshRoundId).not.toBe(failedRoundId);
    const preservedAfterContinue = await page.evaluate(async roundId => {
      const [round, review] = await Promise.all([
        fetch(`/api/inception/rounds/${roundId}`).then(response => response.json()),
        fetch(`/api/inception/rounds/${roundId}/review`).then(response => response.json()),
      ]);
      return { messages: round.round?.messages || round.messages || [], review: review.review || review };
    }, failedRoundId);
    expect(preservedAfterContinue.messages.some((message: { content?: string }) => message.content?.includes('[fixture:inception-no-disclosure]'))).toBeTruthy();
    expect(preservedAfterContinue.review).toMatchObject({ status: 'complete', verdict: 'not_recovered' });
  });

  test('a saved disclosure opens the safe only after judged review and captures desktop and phone states', async ({ page }) => {
    test.setTimeout(90000);
    const snapshotDirectory = join(process.cwd(), 'work', 'inception-production', 'acceptance-screenshots');
    mkdirSync(snapshotDirectory, { recursive: true });
    await signInOwner(page.request);
    const telemetryBatches: string[] = [];
    const protectedActions: string[] = [];
    await page.addInitScript(() => {
      const lifecycle = { closed: 0, audioElements: [] as HTMLAudioElement[] };
      Object.defineProperty(window, '__inceptionAudioLifecycle', { value: lifecycle });
      const NativeAudio = window.Audio;
      (window as any).Audio = function () { const audio = new NativeAudio(); lifecycle.audioElements.push(audio); return audio; };
      const close = AudioContext.prototype.close;
      AudioContext.prototype.close = function () {
        return close.call(this).then(() => { lifecycle.closed++; });
      };
    });
    page.on('request', request => { if (request.method() === 'POST' && /\/api\/(inception\/start|inception\/rounds\/[^/]+\/review|rounds\/[^/]+\/messages)/.test(request.url())) protectedActions.push(request.url()); });
    page.on('request', request => { if (request.method() === 'POST' && request.url().includes('/api/telemetry/events')) telemetryBatches.push(request.postData() || ''); });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/inception');
    await acceptInceptionRecordingNotice(page);
    await expect(page.locator('.inception-root')).toBeVisible();
    await startFreshAttempt(page);
    await expect(page.getByLabel('Speak to Fischer')).toBeEnabled();
    await expect(page.getByRole('group', { name: 'Closed strongroom safe' })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('button', { name: 'Click to continue' })).toBeVisible();
    await page.getByRole('button', { name: 'Click to continue' }).click();
    await expect(page.locator('.inception-root')).not.toHaveAttribute('inert', '');
    await expect(page.locator('.inception-cinematic-cover')).toHaveCount(0);
    const exitFullscreenAfterReload = page.getByRole('button', { name: 'Exit fullscreen' });
    if (await exitFullscreenAfterReload.count()) await exitFullscreenAfterReload.click();
    await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
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
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect.poll(() => telemetryBatches.join('\n'), { timeout: 5000 }).toContain('"interaction":"review"');
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
    const successManifest = await page.evaluate(async () => (await (await fetch('/inception-assets/manifest.json')).json()) as { successVideo: string; successFilmDurationSeconds: number; successDurationSeconds: number; successTitleFadeStartSeconds: number; successTitleFadeEndSeconds: number; successLogoStartSeconds: number; successLogoFadeStartSeconds: number });
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
    const endingVideo = page.locator('.inception-success-ending video');
    const sameStream = await endingVideo.evaluate(video => ({ source: video.querySelector('source')?.getAttribute('src'), controls: (video as HTMLVideoElement).controls, tracks: video.querySelectorAll('track').length }));
    expect(sameStream.source).toBe(successManifest.successVideo);
    expect(sameStream.controls).toBe(false);
    await expect(page.locator('.inception-success-ending button, .inception-success-ending input, .inception-success-ending video[controls]')).toHaveCount(0);
    const setEndingTime = async (seconds: number) => endingVideo.evaluate((video, time) => { const media = video as HTMLVideoElement; media.currentTime = time; media.dispatchEvent(new Event('timeupdate')); }, seconds);
    await setEndingTime(successManifest.successFilmDurationSeconds + 0.3);
    await expect(page.locator('.inception-success-ending')).toHaveClass(/is-title-card/);
    await expect(page.locator('.inception-ending-title-card')).toHaveCount(0);
    await setEndingTime(successManifest.successFilmDurationSeconds + 0.85);
    await expect(page.getByRole('heading', { name: 'INCEPTION', exact: true })).toBeVisible();
    await setEndingTime(successManifest.successTitleFadeStartSeconds + 0.1);
    await expect(page.locator('.inception-success-ending')).toHaveClass(/is-card-exit/);
    await expect.poll(() => page.locator('.inception-ending-title-card').evaluate(element => Number.parseFloat(getComputedStyle(element).opacity))).toBeGreaterThan(0);
    await expect.poll(() => page.locator('.inception-ending-title-card').evaluate(element => Number.parseFloat(getComputedStyle(element).opacity))).toBeLessThan(1);
    await setEndingTime(successManifest.successTitleFadeEndSeconds + 0.1);
    await expect(page.locator('.inception-ending-title-card')).toHaveCount(0);
    await expect(page.locator('.inception-ending-logo-card')).toHaveCount(0);
    await setEndingTime(successManifest.successLogoStartSeconds + 0.1);
    const logoCard = page.locator('.inception-ending-logo-card');
    await expect(logoCard).toBeVisible();
    await expect(logoCard.getByRole('img', { name: 'CSES' })).toBeVisible();
    const logoLayout = await logoCard.locator('img').evaluate(image => { const rect = image.getBoundingClientRect(); return { width: rect.width, centerX: rect.left + rect.width / 2, centerY: rect.top + rect.height / 2, viewportWidth: innerWidth, viewportHeight: innerHeight, dpr: devicePixelRatio }; });
    expect(logoLayout.width).toBeLessThanOrEqual(400);
    expect(logoLayout.width * logoLayout.dpr).toBeLessThanOrEqual(1080);
    expect(Math.abs(logoLayout.centerX - logoLayout.viewportWidth / 2)).toBeLessThan(1);
    expect(Math.abs(logoLayout.centerY - logoLayout.viewportHeight / 2)).toBeLessThan(1);
    await setEndingTime(successManifest.successLogoFadeStartSeconds + 0.1);
    await expect.poll(() => logoCard.evaluate(element => Number.parseFloat(getComputedStyle(element).opacity))).toBeLessThan(1);
    await expect(page.getByText(/CSES ML Team|Brought to you by/)).toHaveCount(0);
    await endingVideo.evaluate(video => { const media = video as HTMLVideoElement; media.currentTime = media.duration; media.dispatchEvent(new Event('ended')); });
    await expect(page.locator('.inception-success-ending')).toHaveClass(/is-title-card/);
    await expect(page.locator('.inception-result')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Click to continue' })).toBeVisible({ timeout: 6000 });
    await expect(page.locator('.inception-success-ending')).toHaveCount(0);
    await expect(page.locator('.inception-play, .inception-result')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => (window as any).__inceptionAudioLifecycle.closed)).toBeGreaterThan(0);
    expect(protectedActions).toHaveLength(requestsAtWin);

    await page.reload();
    await expect(page.getByRole('button', { name: 'Click to continue' })).toBeVisible();
    await expect(page.locator('.inception-play, .inception-result, .inception-success-ending')).toHaveCount(0);
    expect(protectedActions).toHaveLength(requestsAtWin);
    await page.evaluate(async () => {
      const config = await (await fetch('/api/inception')).json();
      localStorage.removeItem(`workshop-inception-completed-round:${config.actorScope}`);
    });
    await page.reload();
    await expect(page.getByRole('button', { name: 'Click to continue' })).toBeVisible();
    await page.getByRole('button', { name: 'Click to continue' }).click();
    await expect(page.locator('.inception-root')).not.toHaveAttribute('inert', '');
    await expect(page.locator('.inception-cinematic-cover')).toHaveCount(0);
    await expect(page.getByRole('group', { name: 'Strongroom safe open' })).toBeVisible();
    await expect(page.getByRole('log', { name: 'Conversation transcript' })).toContainText('[fixture:inception-disclosure]');
    await expect(page.locator('.inception-success-ending')).toHaveCount(0);
    expect(protectedActions).toHaveLength(requestsAtWin);
    const telemetry = telemetryBatches.join('\n');
    for (const marker of ['"view":"inception"', '"phase":"compose"', '"interaction":"inspect"', '"interaction":"reply"', '"interaction":"finish"', '"interaction":"review"']) expect(telemetry).toContain(marker);
    expect(telemetry).not.toContain('[fixture:inception-disclosure]');
    expect(telemetry).not.toContain('The combination is ');
  });

  test('the healthy manifest-timed approach waits for native video end without starting early', async ({ page }) => {
    await signInOwner(page.request);
    await page.goto('/inception');
    await acceptInceptionRecordingNotice(page);
    await expect(page.locator('.inception-root')).toBeVisible();
    await expect.poll(() => page.locator('.inception-entry-poster, .inception-play').count()).toBe(1);
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
    await acceptInceptionRecordingNotice(page);
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
    await expect(page.getByRole('button', { name: 'Click to continue' })).toBeVisible();
  });

  test('a failed intro shows recovery controls and can be retried or continued', async ({ page }) => {
    await page.addInitScript(() => { Element.prototype.requestFullscreen = async function () { throw new Error('fullscreen denied by fixture'); }; });
    const introPath = (await (await page.request.get('/inception-assets/manifest.json')).json()).introVideo as string;
    await page.route(`**${introPath}`, route => route.abort());
    await signInOwner(page.request);
    await page.goto('/inception');
    await acceptInceptionRecordingNotice(page);
    await expect(page.locator('.inception-root')).toBeVisible();
    await expect.poll(() => page.locator('.inception-entry-poster, .inception-play').count()).toBe(1);
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
    await expect(page.getByRole('button', { name: 'Click to continue' })).toBeVisible();
    await expect(page).toHaveURL(/\/inception\/?$/);
    await page.getByRole('button', { name: 'Click to continue' }).click();
    await expect(page.getByRole('region', { name: 'Strongroom approach' })).toBeVisible();
    await finishApproachForTest(page);
    await expect(page.getByLabel('Speak to Fischer')).toBeEnabled();
  });

  test('a lost intro start receipt retries the same request key and reuses the created round', async ({ page }) => {
    await signInOwner(page.request);
    await page.goto('/inception?profile=standard');
    await expect(page.locator('.inception-root')).toBeVisible();
    await startFreshAttempt(page, false);
    await expect(page.getByRole('region', { name: 'Strongroom approach' })).toBeVisible();
    let firstRoundId = '';
    const requestKeys: string[] = [];
    const profileIds: string[] = [];
    await page.route('**/api/inception/start', async route => {
      if (route.request().method() !== 'POST') { await route.continue(); return; }
      requestKeys.push(route.request().postDataJSON().clientStartId);
      profileIds.push(route.request().postDataJSON().profileId);
      const response = await route.fetch();
      const session = await response.json();
      if (requestKeys.length === 1) { firstRoundId = session.round.id; await route.abort(); }
      else await route.fulfill({ response, json: session });
    });
    await finishApproachForTest(page);
    await expect(page.getByRole('button', { name: 'Retry start' })).toBeVisible();
    const firstRequestId = requestKeys[0];
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Click to continue' })).toBeVisible();
    expect(requestKeys).toHaveLength(1);
    await page.getByRole('button', { name: 'Click to continue' }).click();
    await expect(page.getByRole('region', { name: 'Strongroom approach' })).toBeVisible();
    await finishApproachForTest(page);
    await expect(page.getByLabel('Speak to Fischer')).toBeEnabled();
    expect(requestKeys).toHaveLength(2);
    expect(requestKeys[1]).toBe(firstRequestId);
    expect(profileIds).toEqual(['standard', 'standard']);
    expect(firstRoundId).not.toBe('');
    await expect.poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem('workshop-inception-session') || '{}').id)).toBe(firstRoundId);
  });

  test('a fresh Inception attempt uses the configured Warm-up default', async ({ page }) => {
    await signInOwner(page.request);
    await page.goto('/inception');
    await expect(page.locator('.inception-root')).toBeVisible();
    await startFreshAttempt(page, false);
    await expect(page.getByRole('region', { name: 'Strongroom approach' })).toBeVisible();
    let profileId = '';
    await page.route('**/api/inception/start', async route => {
      if (route.request().method() === 'POST') profileId = route.request().postDataJSON().profileId;
      await route.continue();
    });
    await finishApproachForTest(page);
    expect(profileId).toBe('story');
    await expect(page.getByLabel('Speak to Fischer')).toBeEnabled();
  });

  test('a failed Standard acknowledgement does not select Standard for the next retry', async ({ page }) => {
    await signInOwner(page.request);
    const config = await (await page.request.get('/api/inception')).json() as { actorScope: string };
    await page.goto('/inception');
    await page.evaluate(actorScope => localStorage.setItem(`workshop-inception-completed-round:${actorScope}`, JSON.stringify({ roundId: 'completed-standard-fixture', profileId: 'standard', outcome: 'failed' })), config.actorScope);
    await page.reload();
    await expect(page.locator('.inception-root')).toBeVisible();
    await startFreshAttempt(page, false);
    await expect(page.getByRole('region', { name: 'Strongroom approach' })).toBeVisible();
    let profileId = '';
    await page.route('**/api/inception/start', async route => {
      if (route.request().method() === 'POST') profileId = route.request().postDataJSON().profileId;
      await route.continue();
    });
    await finishApproachForTest(page);
    expect(profileId).toBe('story');
    await expect(page.getByLabel('Speak to Fischer')).toBeEnabled();
  });

  test('leaving and continuing an active Standard round resumes its same round without a new start', async ({ page }) => {
    await signInOwner(page.request);
    await page.goto('/inception?profile=standard');
    await acceptInceptionRecordingNotice(page);
    await expect(page.locator('.inception-root')).toBeVisible();
    await startFreshAttempt(page, false);
    await expect(page.getByRole('region', { name: 'Strongroom approach' })).toBeVisible();
    const startProfiles: string[] = [];
    await page.route('**/api/inception/start', async route => {
      if (route.request().method() === 'POST') startProfiles.push(route.request().postDataJSON().profileId);
      await route.continue();
    });
    await finishApproachForTest(page);
    await expect(page.getByLabel('Speak to Fischer')).toBeEnabled();
    const roundId = await page.evaluate(() => JSON.parse(sessionStorage.getItem('workshop-inception-session') || '{}').id as string);
    expect(startProfiles).toEqual(['standard']);
    await page.getByRole('button', { name: 'Leave strongroom' }).click();
    await expect(page.getByRole('button', { name: 'Click to continue' })).toBeVisible();
    await page.getByRole('button', { name: 'Click to continue' }).click();
    await expect(page.getByLabel('Speak to Fischer')).toBeEnabled();
    expect(startProfiles).toEqual(['standard']);
    await expect.poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem('workshop-inception-session') || '{}').id)).toBe(roundId);
  });
});
