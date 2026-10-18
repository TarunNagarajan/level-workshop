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
  if (await replay.count()) { await replay.click(); await expect(page.getByRole('region', { name: 'Strongroom approach' })).toBeVisible(); if (skipApproach) { await page.getByRole('button', { name: /Skip approach/ }).click(); await expect(page.locator('.inception-play')).not.toHaveClass(/is-handoff-locked/); } return; }
  const consent = page.getByRole('checkbox', { name: /I understand and agree to this recording/ });
  if (await consent.count()) await consent.check();
  const begin = page.getByRole('button', { name: 'Begin without film' });
  if (skipApproach && await begin.count()) await begin.click();
  else { await page.getByRole('button', { name: 'Watch and begin' }).click(); if (skipApproach) await page.getByRole('button', { name: /Skip approach/ }).click(); }
  if (skipApproach) await expect(page.locator('.inception-play')).not.toHaveClass(/is-handoff-locked/);
}

test.describe('Inception strongroom', () => {
  test.use({ baseURL: 'http://127.0.0.1:4323' });

  test('intro skip starts one round; inspection, conversation, rewatch and review keep the saved state honest', async ({ page }) => {
    await signInOwner(page.request);
    await page.addInitScript(() => {
      const probe = { gains: [] as Array<{ initialized: number[]; targets: number[] }>, played: [] as string[], pauses: [] as string[], closes: 0, failNextRoomTone: true, failures: 0 };
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
        if (this.src.includes('strongroom-roomtone')) {
          probe.played.push(this.src);
          if (probe.failNextRoomTone) { probe.failNextRoomTone = false; probe.failures++; return Promise.reject(new DOMException('Autoplay blocked by test', 'NotAllowedError')); }
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
    for (const path of [media.closedFrame, media.openFrame, media.bridgeFrame, media.introVideo, media.captions, media.approvedTrack, media.roomTone].filter(Boolean)) {
      expect((await page.request.get(path)).ok(), `media asset should be served: ${path}`).toBeTruthy();
    }
    await page.getByRole('checkbox', { name: /I understand and agree to this recording/ }).check();
    await page.getByRole('button', { name: 'Watch and begin' }).click();
    await expect(page.getByRole('region', { name: 'Strongroom approach' })).toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as any).__inceptionAudioProbe.gains.length)).toBe(1);
    const initialAudio = await page.evaluate(() => (window as any).__inceptionAudioProbe);
    expect(initialAudio.gains[0].initialized[0]).toBe(0);
    expect(initialAudio.gains[0].targets.some((gain: number) => gain > 0 && gain <= 0.7)).toBeTruthy();
    expect(initialAudio.played.some((path: string) => path.includes('strongroom-roomtone-v1.mp3'))).toBeTruthy();
    await expect(page.getByRole('button', { name: 'Play sound' })).toBeVisible();
    await page.getByRole('button', { name: 'Play sound' }).click();
    await expect(page.getByRole('button', { name: 'Play sound' })).toHaveCount(0);
    const recoveredAudio = await page.evaluate(() => (window as any).__inceptionAudioProbe);
    expect(recoveredAudio.failures).toBe(1);
    expect(recoveredAudio.played.length).toBeGreaterThanOrEqual(2);
    expect(starts).toBe(0);
    await page.getByRole('button', { name: /Skip approach/ }).click();
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
    await expect(transcript.getByText('EAMES')).toBeVisible();
    await expect(transcript.getByText('FISCHER').last()).toBeVisible();
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
      if (index === 3) await expect.poll(() => transcript.evaluate(element => element.scrollTop)).toBeLessThan(4);
    }
    await transcript.evaluate(element => { element.scrollTop = element.scrollHeight; });
    const bottomBefore = await transcript.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop);
    await composer.fill('One more question about the dream.');
    await expect(page.getByRole('button', { name: 'Send' })).toBeEnabled();
    await composer.press('Enter');
    await expect.poll(() => transcript.locator('article').count()).toBe(15);
    await expect.poll(() => transcript.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThanOrEqual(Math.max(4, bottomBefore + 2));

    const before = await page.getByRole('timer').getAttribute('aria-label');
    await page.getByRole('button', { name: 'Rewatch approach' }).click();
    await expect(page.getByRole('heading', { name: 'Rewatch the approach' })).toBeVisible();
    await expect(page.getByText('Rewatching does not start a new attempt or change the remaining time.')).toBeVisible();
    await page.getByRole('button', { name: 'Close' }).click();
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
    await page.getByRole('button', { name: /Skip approach/ }).click();
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
    await page.route('**/api/rounds/*/messages', async route => {
      if (route.request().method() === 'POST') requestIds.push(route.request().postDataJSON().requestId);
      await route.continue();
    });
    await composer.fill('[fixture:rate-limit-once] Tell me about the safe.');
    await expect(page.getByRole('button', { name: 'Send' })).toBeEnabled();
    await composer.press('Enter');
    await expect(page.getByText(/Fischer could not reply\. Send again to create a new attempt/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Retry saved message' })).toHaveCount(0);
    await expect(composer).toHaveValue('[fixture:rate-limit-once] Tell me about the safe.');
    expect(requestIds).toHaveLength(1);
    await composer.press('Enter');
    await expect(page.getByText(/I was honoured for Special Services/)).toBeVisible();
    expect(requestIds).toHaveLength(2);
    expect(requestIds[0]).not.toBe(requestIds[1]);
    await page.getByRole('button', { name: 'Finish and review' }).click();
    await expect(page.getByRole('button', { name: 'Start a new attempt' })).toBeVisible();
  });

  test('a lost review response recovers from persisted review polling without a second provider request', async ({ page }) => {
    await signInOwner(page.request);
    await page.goto('/inception');
    await expect(page.locator('.inception-root')).toBeVisible();
    await startFreshAttempt(page);
    await expect(page.getByLabel('Speak to Fischer')).toBeEnabled();
    await page.getByLabel('Speak to Fischer').fill('[fixture:inception-disclosure]');
    await expect(page.getByRole('button', { name: 'Send' })).toBeEnabled();
    await page.getByLabel('Speak to Fischer').press('Enter');
    await expect(page.getByText(/The combination is \d{6}\./)).toBeVisible();

    let reviewPosts = 0, reviewGets = 0;
    await page.route('**/api/inception/rounds/*/review', async route => {
      if (route.request().method() === 'GET') reviewGets++;
      if (route.request().method() === 'POST') {
        reviewPosts++;
        const persisted = await route.fetch();
        await new Promise(resolve => setTimeout(resolve, 3200));
        await route.fulfill({ response: persisted });
      } else await route.continue();
    });
    await page.getByRole('button', { name: 'Finish and review' }).click();
    await expect(page.getByRole('group', { name: 'Strongroom safe open' })).toBeVisible({ timeout: 10000 });
    expect(reviewGets).toBeGreaterThan(0);
    expect(reviewPosts).toBe(1);
    await expect(page.getByText('The lock turns. You’re inside.')).toBeVisible();
    await expect(page.locator('.inception-success-ending')).toBeVisible();
  });

  test('a saved disclosure opens the safe only after judged review and captures desktop and phone states', async ({ page }) => {
    const snapshotDirectory = join(process.cwd(), 'work', 'inception-production', 'acceptance-screenshots');
    mkdirSync(snapshotDirectory, { recursive: true });
    await signInOwner(page.request);
    const telemetryBatches: string[] = [];
    const protectedActions: string[] = [];
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
      expect(Math.abs(geometry.stage.width - geometry.root.width * 0.6)).toBeLessThan(3);
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
    releaseReview();
    await expect(page.getByRole('group', { name: 'Strongroom safe open' })).toBeVisible();
    await expect(page.getByText('The lock turns. You’re inside.')).toBeVisible();
    const successManifest = await page.evaluate(async () => (await (await fetch('/inception-assets/manifest.json')).json()) as { successVideo: string; successDurationSeconds: number });
    expect(successManifest.successDurationSeconds).toBeGreaterThan(0);
    await expect(page.locator('.inception-success-ending')).toBeVisible();
    expect(await page.locator('.inception-success-ending source').getAttribute('src')).toBe(successManifest.successVideo);
    await expect.poll(async () => (await page.locator('.inception-success-ending video').evaluate(video => (video as HTMLVideoElement).currentTime)) > 0.1 || (await page.getByRole('button', { name: /Play ending/ }).count()) > 0, { timeout: 8000 }).toBe(true);
    await page.waitForTimeout(750);
    await page.screenshot({ path: join(snapshotDirectory, 'inception-success-ending-desktop.png') });
    const requestsAtWin = protectedActions.length;
    await page.getByRole('button', { name: 'Captions on' }).click();
    await expect(page.getByRole('button', { name: 'Captions off' })).toHaveAttribute('aria-pressed', 'false');
    await page.getByRole('button', { name: 'Captions off' }).click();
    await page.getByRole('button', { name: 'Mute ending sound' }).click();
    await expect(page.getByRole('button', { name: 'Turn ending sound on' })).toBeVisible();
    await page.getByRole('button', { name: 'Turn ending sound on' }).click();
    await page.getByRole('button', { name: 'Skip ending' }).click();
    await expect(page.locator('.inception-success-ending')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Rewatch ending' })).toBeVisible();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.getByRole('button', { name: 'Rewatch ending' }).click();
    await expect(page.locator('.inception-success-ending')).toBeVisible();
    expect(protectedActions).toHaveLength(requestsAtWin);
    await page.getByRole('button', { name: 'Skip ending' }).click();
    await expect(page.locator('.inception-success-ending')).toHaveCount(0);
    await expect.poll(() => telemetryBatches.join('\n'), { timeout: 20000 }).toContain('"interaction":"review"');
    await page.unroute('**/api/inception/rounds/*/review');
    await page.reload();
    await expect(page.locator('.inception-root')).toHaveClass(/is-immersive/);
    await expect(page.getByRole('group', { name: 'Strongroom safe open' })).toBeVisible();
    await expect(page.locator('.inception-success-ending')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Rewatch ending' })).toBeVisible();

    await page.screenshot({ path: join(snapshotDirectory, 'inception-open-desktop.png') });
    await page.getByRole('button', { name: 'Inspect the inside' }).click();
    await expect(page.getByRole('dialog')).toContainText('Inside the strongroom safe');
    await page.getByRole('button', { name: 'Close' }).click();
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
    await startFreshAttempt(page, false);
    await expect(page.getByRole('region', { name: 'Strongroom approach' })).toBeVisible();
    const introDuration = await page.evaluate(async () => (await (await fetch('/inception-assets/manifest.json')).json()).introDurationSeconds as number);
    expect(introDuration).toBeGreaterThan(0);
    test.setTimeout((introDuration + 45) * 1000);
    await expect.poll(() => page.locator('video.inception-intro-video').evaluate(video => (video as HTMLVideoElement).duration), { timeout: 15000 }).toBeCloseTo(introDuration, 0);
    let starts = 0;
    await page.route('**/api/inception/start', async route => { if (route.request().method() === 'POST') starts++; await route.continue(); });
    await expect.poll(() => page.locator('video.inception-intro-video').evaluate(video => (video as HTMLVideoElement).currentTime), { timeout: (introDuration + 8) * 1000 }).toBeGreaterThan(introDuration - 3);
    expect(starts).toBe(0);
    await expect(page.locator('video.inception-intro-video')).not.toHaveJSProperty('ended', true);
    await expect(page.getByRole('region', { name: 'Strongroom approach' })).toBeVisible();
    await expect(page.getByLabel('Speak to Fischer')).toBeEnabled({ timeout: 10000 });
    expect(starts).toBe(1);
  });

  test('a failed intro can be retried or skipped in the fullscreen-denied viewport fallback', async ({ page }) => {
    await page.addInitScript(() => { Element.prototype.requestFullscreen = async function () { throw new Error('fullscreen denied by fixture'); }; });
    const introPath = (await (await page.request.get('/inception-assets/manifest.json')).json()).introVideo as string;
    await page.route(`**${introPath}`, route => route.abort());
    await signInOwner(page.request);
    await page.goto('/inception');
    await expect(page.locator('.inception-root')).toBeVisible();
    await expect.poll(() => page.locator('.inception-entry, .inception-play').count()).toBe(1);
    await startFreshAttempt(page, false);
    await expect(page.getByRole('region', { name: 'Strongroom approach' })).toBeVisible();
    const immersiveButton = page.getByRole('button', { name: 'Immersive view' });
    if (await immersiveButton.count()) await immersiveButton.click();
    await expect(page.locator('.inception-root')).toHaveClass(/is-immersive/);
    await expect(page.getByRole('button', { name: 'Retry approach' })).toBeVisible({ timeout: 12000 });
    await expect(page.getByRole('button', { name: /continue to strongroom/i })).toBeVisible();
    await page.unroute(`**${introPath}`);
    await page.getByRole('button', { name: 'Retry approach' }).click();
    await expect(page.locator('video.inception-intro-video')).toBeVisible();
    await page.getByRole('button', { name: /continue to strongroom/i }).click();
    await expect(page.getByLabel('Speak to Fischer')).toBeEnabled();
    await page.keyboard.press('Escape');
    await expect(page).toHaveURL(/\/$/);
  });
});
