import { test, expect } from '@playwright/test';
import { signInOwner } from './auth';

test.describe('Inception strongroom', () => {
  test.use({ baseURL: 'http://127.0.0.1:4323' });

  test('intro skip starts one round; inspection, conversation, rewatch and review keep the saved state honest', async ({ page }) => {
    await signInOwner(page.request);
    await page.addInitScript(() => {
      const probe = { gains: [] as Array<{ initialized: number[]; targets: number[] }>, played: [] as string[], pauses: [] as string[], closes: 0 };
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
      HTMLMediaElement.prototype.play = function () { if (this.src.includes('strongroom-roomtone')) probe.played.push(this.src); return play.call(this); };
      HTMLMediaElement.prototype.pause = function () { if (this.src.includes('strongroom-roomtone')) probe.pauses.push(this.src); return pause.call(this); };
      AudioContext.prototype.close = function () { probe.closes++; return close.call(this); };
    });
    let starts = 0;
    await page.route('**/api/inception/start', async route => { if (route.request().method() === 'POST') starts++; await route.continue(); });
    const errors: string[] = [];
    page.on('response', response => { if (response.url().includes('/inception-assets/') && response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });

    await page.goto('/inception');
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
    expect(starts).toBe(0);
    await page.getByRole('button', { name: /Skip approach/ }).click();
    await expect(page.getByLabel('Speak to Fischer')).toBeEnabled();
    expect(starts).toBe(1);

    await page.getByRole('button', { name: 'Inspect safe' }).click();
    await expect(page.getByText(/compact safe is recessed in the dark-green bedside cabinet/)).toBeVisible();
    await page.getByRole('button', { name: 'Close' }).click();
    const composer = page.getByLabel('Speak to Fischer');
    await composer.fill('What can you tell me about the safe?');
    await composer.press('Enter');
    await expect(page.getByText('I was honoured for Special Services to the School after Hagrid was blamed. They knew whom to trust.')).toBeVisible();

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
    await expect(page.getByRole('button', { name: 'Conversation history' })).toBeVisible();

    await page.getByRole('button', { name: 'Finish and review' }).click();
    await expect(page.getByText('Fischer did not disclose the complete combination. The safe remains closed.')).toBeVisible();
    await expect(page.getByRole('group', { name: 'Closed strongroom safe' })).toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as any).__inceptionAudioProbe.closes)).toBe(1);
    expect(starts).toBe(1);
    expect(errors).toEqual([]);
  });
});
