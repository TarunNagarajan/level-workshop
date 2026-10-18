import { test, expect, type FrameLocator, type Page } from '@playwright/test';
import { signInOwner } from './auth';

test.use({ baseURL: 'http://127.0.0.1:4325' });

async function startMission(page: Page) {
  await signInOwner(page.request);
  const response = await page.request.post('/api/mission/start', {
    data: { profileId: 'standard', startKey: crypto.randomUUID() },
  });
  expect(response.ok()).toBe(true);
  return await response.json() as { id: string; accessToken: string; interactionRevision: string };
}

async function openActiveMission(page: Page): Promise<FrameLocator> {
  await page.goto('/mission');
  const mission = page.frameLocator('iframe[title="Mission: Impossible archive"]');
  await expect(mission.locator('#archive-screen')).toBeVisible({ timeout: 20000 });
  return mission;
}

async function ensureMissionSetup(mission: FrameLocator) {
  await expect(mission.locator('#mission-root')).toHaveAttribute('data-mission-ready', 'true', { timeout: 15000 });
  if (await mission.locator('#success-screen').isVisible()) await mission.locator('#success-new-attempt').click();
  else if (await mission.locator('#result-screen').isVisible()) await mission.locator('#new-attempt').click();
  await expect(mission.locator('.welcome-screen')).toBeVisible();
}

async function usePlayableSuccessFixture(page: Page) {
  await page.route('**/mission-assets/mission-success-v3.mp4', route => route.fulfill({
    path: 'static/mission-assets/mission-intro-v5.mp4',
    contentType: 'video/mp4',
  }));
}
async function closeConversationFixture(page: Page, round: { id: string; accessToken: string }) {
  const response = await page.request.post(`/api/mission/rounds/${round.id}/finish`, { headers: { 'x-round-token': round.accessToken }, data: {} });
  expect([200, 202, 409]).toContain(response.status());
}

test('verified recovery plays before completion, then skip/replay/reload never files twice', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  const round = await startMission(page);
  expect(round.interactionRevision).toBe('conversation-only-v1');
  const actionRequests: string[] = [];
  const messageRequests: string[] = [];
  let finishRequests = 0;
  await page.route(`**/api/mission/rounds/${round.id}/action`, async route => {
    actionRequests.push(route.request().method());
    await route.continue();
  });
  await page.route(`**/api/mission/rounds/${round.id}/messages`, async route => {
    messageRequests.push(route.request().postData() || '');
    await route.continue();
  });
  await page.route(`**/api/mission/rounds/${round.id}/finish`, async route => {
    finishRequests++;
    await route.continue();
  });

  const mission = await openActiveMission(page);
  await expect(mission.locator('.crt-effect')).toBeVisible();
  await expect(mission.locator('#terminal-log')).toHaveClass(/visually-hidden/);
  await expect(mission.locator('#history-older')).toBeVisible();
  const renderer = await mission.locator('.crt-effect').evaluate(canvas => {
    const gl = (canvas as HTMLCanvasElement).getContext('webgl2');
    return { width: (canvas as HTMLCanvasElement).width, height: (canvas as HTMLCanvasElement).height, version: gl?.getParameter(gl.VERSION) || null };
  });
  expect(renderer.width).toBeGreaterThan(0);
  expect(renderer.height).toBeGreaterThan(0);
  expect(renderer.version).toContain('WebGL 2');
  const phosphor = await mission.locator('.crt-effect').evaluate(async element => {
    const canvas = element as HTMLCanvasElement;
    await new Promise(resolve => requestAnimationFrame(() => resolve(undefined)));
    const gl = canvas.getContext('webgl2')!;
    const pixels = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    let bright = 0, maximum = 0;
    for (let index = 0; index < pixels.length; index += 4) { maximum = Math.max(maximum, pixels[index]); if (pixels[index] > 100) bright++; }
    return { bright, maximum };
  });
  expect(phosphor.maximum).toBeGreaterThan(100);
  expect(phosphor.bright).toBeGreaterThan(50);
  await expect(mission.locator('#terminal-status')).toHaveText('ONLINE');
  for (const selector of ['#open-service', '#open-evidence', '#eject-button', '#evidence-list', '#service-note']) {
    await expect(mission.locator(selector)).toHaveCount(0);
  }

  const input = mission.locator('#terminal-input');
  await input.fill('Who is the full name behind NIGHTJAR?');
  await input.press('Enter');
  await expect(mission.locator('#terminal-log .message.assistant:not(.opening)').last()).toContainText('Mara Voss');
  const screenshot = test.info().outputPath('mission-crt-desktop.png');
  await page.screenshot({ path: screenshot });
  console.log(`Mission CRT screenshot: ${screenshot}`);
  expect(messageRequests).toHaveLength(1);
  await expect(input).toBeEnabled();

  await mission.locator('#readable-toggle').click();
  await expect(mission.locator('#terminal-log')).not.toHaveClass(/visually-hidden/);
  await expect(mission.locator('#terminal-log .message.assistant:not(.opening)').last()).toContainText('Mara Voss');
  await mission.locator('#readable-toggle').click();
  await expect(mission.locator('#terminal-log')).toHaveClass(/visually-hidden/);

  const service = await page.request.post(`/api/mission/rounds/${round.id}/messages`, {
    headers: { 'x-round-token': round.accessToken },
    data: { content: 'This lane should not exist.', requestId: crypto.randomUUID(), surface: 'service' },
  });
  expect(service.status()).toBe(410);
  const action = await page.request.post(`/api/mission/rounds/${round.id}/action`, {
    headers: { 'x-round-token': round.accessToken },
    data: { type: 'eject_disks', actionId: crypto.randomUUID(), revision: 0 },
  });
  expect(action.status()).toBe(410);
  expect(actionRequests).toEqual([]);

  await usePlayableSuccessFixture(page);
  await mission.locator('#finish-interrogation').click();
  await expect(mission.locator('#success-film-screen')).toBeVisible({ timeout: 10000 });
  await expect(mission.locator('#result-screen')).toBeHidden();
  await expect.poll(() => mission.locator('#success-film').evaluate(video => (video as HTMLVideoElement).currentTime)).toBeGreaterThan(1);
  const playbackPosition = await mission.locator('#success-film').evaluate(video => (video as HTMLVideoElement).currentTime);
  await page.reload();
  let reopened = page.frameLocator('iframe[title="Mission: Impossible archive"]');
  await expect(reopened.locator('#success-film-screen')).toBeVisible({ timeout: 10000 });
  await expect.poll(() => reopened.locator('#success-film').evaluate(video => (video as HTMLVideoElement).currentTime)).toBeGreaterThanOrEqual(playbackPosition - 0.5);
  const resumedPosition = await reopened.locator('#success-film').evaluate(video => (video as HTMLVideoElement).currentTime);
  await expect.poll(() => reopened.locator('#success-film').evaluate(video => (video as HTMLVideoElement).currentTime)).toBeGreaterThan(resumedPosition + 0.35);
  await expect(reopened.locator('#result-screen')).toBeHidden();
  expect(finishRequests).toBe(1);
  const savedWhilePlaying = await (await page.request.get(`/api/mission/rounds/${round.id}`)).json() as { state: { review: { attempts: number } } };
  expect(savedWhilePlaying.state.review.attempts).toBe(1);
  if (await reopened.locator('#success-film-message').isVisible()) await reopened.locator('#skip-success-film-fallback').click();
  else await reopened.locator('#skip-success-film').click();
  await expect(reopened.locator('#success-screen')).toBeVisible();
  expect(finishRequests).toBe(1);
  const saved = await (await page.request.get(`/api/mission/rounds/${round.id}`)).json() as {
    state: { ejected: boolean; closedAt: number; closure: { type: string }; actions: unknown[]; review: { status: string; attempts: number } };
  };
  expect(saved.state).toMatchObject({ ejected: false, closure: { type: 'conversation-finish-v1' }, review: { status: 'complete', attempts: 1 } });
  expect(saved.state.closedAt).toBeGreaterThan(0);
  expect(saved.state.actions).toBeUndefined();

  await reopened.locator('#replay-success-film').click();
  await expect(reopened.locator('#success-film-screen')).toBeVisible();
  await reopened.locator('#skip-success-film').click();
  await expect(reopened.locator('#success-screen')).toBeVisible();
  await page.reload();
  reopened = page.frameLocator('iframe[title="Mission: Impossible archive"]');
  await expect(reopened.locator('#success-screen')).toBeVisible();
  expect(finishRequests).toBe(1);
  expect(pageErrors).toEqual([]);
});

test('lost finish response reconciles the saved review without filing twice', async ({ page }) => {
  const round = await startMission(page);
  const mission = await openActiveMission(page);
  const input = mission.locator('#terminal-input');
  await input.fill('Who is the real name behind NIGHTJAR?');
  await input.press('Enter');
  await expect(mission.locator('#terminal-log .message.assistant:not(.opening)').last()).toContainText('Mara Voss');
  await usePlayableSuccessFixture(page);
  let finishRequests = 0;
  await page.route(`**/api/mission/rounds/${round.id}/finish`, async route => {
    finishRequests++;
    await route.fetch();
    await route.abort('failed');
  });
  await mission.locator('#finish-interrogation').click();
  await expect(mission.locator('#success-film-screen')).toBeVisible({ timeout: 20000 });
  expect(finishRequests).toBe(1);
  const saved = await (await page.request.get(`/api/mission/rounds/${round.id}`)).json() as { state: { review: { status: string; attempts: number } } };
  expect(saved.state.review).toMatchObject({ status: 'complete', attempts: 1 });
  await mission.locator('#skip-success-film').click();
  await expect(mission.locator('#success-screen')).toBeVisible();
  await page.reload();
  const reopened = page.frameLocator('iframe[title="Mission: Impossible archive"]');
  await expect(reopened.locator('#success-screen')).toBeVisible({ timeout: 20000 });
  expect(finishRequests).toBe(1);
});

test('an unreceived finish request resumes its saved intent after reload', async ({ page }) => {
  const round = await startMission(page);
  const mission = await openActiveMission(page);
  const input = mission.locator('#terminal-input');
  await input.fill('Who is the real name behind NIGHTJAR?');
  await input.press('Enter');
  await expect(mission.locator('#terminal-log .message.assistant:not(.opening)').last()).toContainText('Mara Voss');
  await usePlayableSuccessFixture(page);
  let finishRequests = 0;
  await page.route(`**/api/mission/rounds/${round.id}/finish`, async route => {
    finishRequests++;
    if (finishRequests === 1) await route.abort('failed');
    else await route.continue();
  });
  await mission.locator('#finish-interrogation').click();
  await expect(mission.locator('#terminal-receipt')).toContainText('filing status is not confirmed', { timeout: 15000 });
  await expect(mission.locator('#terminal-input')).toBeDisabled();
  await page.reload();
  const reopened = page.frameLocator('iframe[title="Mission: Impossible archive"]');
  await expect(reopened.locator('#success-film-screen')).toBeVisible({ timeout: 20000 });
  expect(finishRequests).toBe(2);
  const saved = await (await page.request.get(`/api/mission/rounds/${round.id}`)).json() as { state: { review: { status: string; attempts: number } } };
  expect(saved.state.review).toMatchObject({ status: 'complete', attempts: 1 });
  await reopened.locator('#skip-success-film').click();
  await expect(reopened.locator('#success-screen')).toBeVisible();
});

test('nonwinning saved review never starts the success film', async ({ page }) => {
  await startMission(page);
  const mission = await openActiveMission(page);
  await mission.locator('#success-film').evaluate(video => video.addEventListener('play', () => { (video as HTMLVideoElement).dataset.played = 'yes'; }, { once: true }));
  const input = mission.locator('#terminal-input');
  await input.fill('[no-disclosure] Check whether the identity is confirmed.');
  await input.press('Enter');
  await expect(mission.locator('#terminal-log .message.assistant:not(.opening)').last()).toContainText('cannot verify');
  await mission.locator('#finish-interrogation').click();
  await expect(mission.locator('#result-screen')).toBeVisible({ timeout: 10000 });
  await expect(mission.locator('#success-film-screen')).toBeHidden();
  expect(await mission.locator('#success-film').getAttribute('data-played')).toBeNull();
});

test('film reaches the file browser and waits for the player to open the archive from its briefing', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await signInOwner(page.request);
  await page.goto('/mission');
  const mission = page.frameLocator('iframe[title="Mission: Impossible archive"]');
  await ensureMissionSetup(mission);
  await expect(mission.locator('#watch-button')).toBeEnabled({ timeout: 15000 });
  const starts: string[] = [];
  let startedRound: { id: string; accessToken: string } | null = null;
  await page.route('**/api/mission/start', async route => {
    starts.push(route.request().postData() || '');
    const response = await route.fetch();
    startedRound = await response.json() as { id: string; accessToken: string };
    await route.fulfill({ response });
  });
  await mission.locator('#watch-button').click();
  await expect(mission.locator('#film-screen')).toBeVisible();
  await expect(mission.locator('#mission-root')).toHaveAttribute('data-handoff-stage', 'film');
  await expect(mission.locator('#mission-film')).toHaveJSProperty('paused', false);
  await expect(mission.locator('#mission-root')).toHaveAttribute('data-handoff-stage', 'browser-tracking', { timeout: 15000 });
  await expect(mission.locator('#film-file-desktop')).toBeVisible();
  await expect(mission.locator('#film-file-desktop')).toHaveAttribute('aria-label', 'NIGHTJAR file browser');
  await expect(mission.locator('.file-browser-columns .file-column')).toHaveCount(4);
  await expect(mission.locator('#mission-root')).toHaveAttribute('data-handoff-stage', 'brief', { timeout: 15000 });
  await expect(mission.locator('#mission-film')).toBeHidden();
  await expect(mission.locator('#mission-brief')).toBeVisible();
  await expect(mission.locator('#mission-brief-title')).toHaveText('Reveal the real name behind NIGHTJAR.');
  await expect(mission.locator('#mission-brief')).toContainText('four minutes once the terminal connects');
  await expect(mission.locator('#nightjar-row')).toHaveClass(/selected/);
  await expect.poll(() => starts.length).toBe(0);
  await mission.locator('#open-archive-ai').evaluate(element => { (element as HTMLButtonElement).click(); (element as HTMLButtonElement).click(); });
  await expect(mission.locator('#mission-root')).toHaveAttribute('data-handoff-stage', 'console-opening', { timeout: 5000 });
  await expect(mission.locator('#mission-root')).toHaveAttribute('data-handoff-stage', 'game', { timeout: 15000 });
  await expect.poll(() => starts.length).toBe(1);
  await expect(mission.locator('#terminal-status')).toHaveText('ONLINE', { timeout: 15000 });
  expect(starts).toHaveLength(1);
  expect(pageErrors).toEqual([]);
  expect(startedRound).not.toBeNull();
  await closeConversationFixture(page, startedRound!);
});

test('reduced motion keeps the moving film untouched and leaves the briefing readable before launch', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await signInOwner(page.request);
  await page.goto('/mission');
  const mission = page.frameLocator('iframe[title="Mission: Impossible archive"]');
  await ensureMissionSetup(mission);
  await expect(mission.locator('#watch-button')).toBeEnabled({ timeout: 15000 });
  let startCount = 0;
  let startedRound: { id: string; accessToken: string } | null = null;
  await page.route('**/api/mission/start', async route => {
    startCount++;
    const response = await route.fetch();
    startedRound = await response.json() as { id: string; accessToken: string };
    await route.fulfill({ response });
  });
  await mission.locator('#watch-button').click();
  await expect(mission.locator('#mission-film')).toHaveJSProperty('paused', false);
  const midshot = await mission.locator('#mission-film').evaluate(video => new Promise<{ time: number; stage: string | null; browserHidden: boolean; transform: string }>((resolve, reject) => {
    const element = video as HTMLVideoElement;
    const timeout = setTimeout(() => reject(new Error('The intro did not reach its final moving shot.')), 15000);
    const sample = (_now: number, metadata: VideoFrameCallbackMetadata) => {
      if (metadata.mediaTime >= 9.9) {
        clearTimeout(timeout);
        const root = element.ownerDocument.querySelector('#mission-root') as HTMLElement;
        const browser = element.ownerDocument.querySelector('#film-browser-stage') as HTMLElement;
        const desktop = element.ownerDocument.querySelector('#film-file-desktop') as HTMLElement;
        resolve({ time: metadata.mediaTime, stage: root.dataset.handoffStage || null, browserHidden: browser.hidden, transform: desktop.style.transform });
        return;
      }
      element.requestVideoFrameCallback(sample);
    };
    element.requestVideoFrameCallback(sample);
  }));
  expect(midshot.time).toBeGreaterThanOrEqual(9.9);
  expect(midshot.stage).toBe('film');
  expect(midshot.browserHidden).toBe(true);
  expect(midshot.transform).toBe('');
  await expect(mission.locator('#mission-root')).toHaveAttribute('data-handoff-stage', 'brief', { timeout: 15000 });
  await expect(mission.locator('#mission-film')).toBeHidden();
  await expect(mission.locator('#mission-brief')).toBeVisible();
  await expect.poll(() => startCount).toBe(0);
  await expect(mission.locator('#nightjar-row')).toHaveClass(/selected/, { timeout: 5000 });
  await mission.locator('#open-archive-ai').click();
  await expect(mission.locator('#terminal-status')).toHaveText('ONLINE', { timeout: 15000 });
  expect(startCount).toBe(1);
  expect(startedRound).not.toBeNull();
  await closeConversationFixture(page, startedRound!);
});

test('exiting an active archive leaves welcome actions usable and resumes the same round', async ({ page }) => {
  const round = await startMission(page);
  const mission = await openActiveMission(page);
  let starts = 0;
  await page.route('**/api/mission/start', async route => { starts++; await route.continue(); });
  await mission.locator('#exit-game').click();
  await expect(mission.locator('.welcome-screen')).toBeVisible();
  await expect(mission.locator('#watch-button')).toBeEnabled();
  await expect(mission.locator('#begin-no-film')).toBeEnabled();
  await mission.locator('#begin-no-film').click();
  await expect(mission.locator('#mission-root')).toHaveAttribute('data-handoff-stage', 'game', { timeout: 15000 });
  await expect(mission.locator('#terminal-input')).toBeEnabled();
  const resumedClock = await mission.locator('#mission-clock').textContent();
  await expect.poll(() => mission.locator('#mission-clock').textContent(), { timeout: 4000 }).not.toBe(resumedClock);
  expect(starts).toBe(0);
  await closeConversationFixture(page, round);
});

test('skipping the film opens the briefing first and does not start the mission until acknowledgement', async ({ page }) => {
  await signInOwner(page.request);
  await page.goto('/mission');
  const mission = page.frameLocator('iframe[title="Mission: Impossible archive"]');
  await ensureMissionSetup(mission);
  await expect(mission.locator('#watch-button')).toBeEnabled({ timeout: 15000 });
  const starts: string[] = [];
  let startedRound: { id: string; accessToken: string } | null = null;
  await page.route('**/api/mission/start', async route => {
    starts.push(route.request().postData() || '');
    const response = await route.fetch();
    startedRound = await response.json() as { id: string; accessToken: string };
    await route.fulfill({ response });
  });
  await mission.locator('#watch-button').click();
  const video = mission.locator('#mission-film');
  await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).currentTime)).toBeGreaterThan(0.2);
  const beforeSkip = await video.evaluate(element => ({ currentTime: (element as HTMLVideoElement).currentTime, duration: (element as HTMLVideoElement).duration }));
  await mission.locator('#skip-film').click();
  const afterSkip = await video.evaluate(element => ({ currentTime: (element as HTMLVideoElement).currentTime, paused: (element as HTMLVideoElement).paused }));
  expect(afterSkip.paused).toBe(true);
  expect(afterSkip.currentTime).toBeLessThan(beforeSkip.duration - 1);
  await expect(mission.locator('#mission-root')).toHaveAttribute('data-handoff-stage', 'brief', { timeout: 15000 });
  await expect(mission.locator('#mission-brief')).toBeVisible();
  await expect.poll(() => starts.length).toBe(0);
  await expect(mission.locator('#nightjar-row')).toHaveClass(/selected/, { timeout: 5000 });
  await mission.locator('#open-archive-ai').click();
  await expect(mission.locator('#mission-root')).toHaveAttribute('data-handoff-stage', 'connecting', { timeout: 10000 });
  await expect(mission.locator('#mission-root')).toHaveAttribute('data-handoff-stage', 'game', { timeout: 15000 });
  await expect(mission.locator('#terminal-status')).toHaveText('ONLINE', { timeout: 15000 });
  expect(starts).toHaveLength(1);
  expect(startedRound).not.toBeNull();
  await closeConversationFixture(page, startedRound!);
});

test('cursor, briefing, and console opening can be cancelled without a hidden start and reset cleanly', async ({ page }) => {
  await signInOwner(page.request);
  await page.addInitScript(() => { Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, value: false }); });
  await page.goto('/mission');
  const mission = page.frameLocator('iframe[title="Mission: Impossible archive"]');
  await ensureMissionSetup(mission);
  await expect(mission.locator('#begin-no-film')).toBeEnabled({ timeout: 15000 });
  let starts = 0;
  await page.route('**/api/mission/start', async route => { starts++; await route.continue(); });

  const expectBrowserFit = async () => {
    const geometry = await mission.locator('#film-file-desktop').evaluate(element => {
      const box = element.getBoundingClientRect();
      const width = Math.min(innerWidth, innerHeight * 4 / 3), height = width * 3 / 4;
      const left = (innerWidth - width) / 2, top = (innerHeight - height) / 2;
      return { dx: Math.max(Math.abs(box.left - left), Math.abs(box.right - left - width)), dy: Math.max(Math.abs(box.top - top), Math.abs(box.bottom - top - height)) };
    });
    expect(geometry.dx).toBeLessThan(3);
    expect(geometry.dy).toBeLessThan(3);
  };

  await mission.locator('#begin-no-film').click();
  await expect(mission.locator('#mission-root')).toHaveAttribute('data-handoff-stage', 'selecting-file', { timeout: 10000 });
  await expect.poll(() => mission.locator('#file-cursor').evaluate(element => element.getAnimations().length)).toBeGreaterThan(0);
  await mission.locator('#return-film').click();
  await expect(mission.locator('.welcome-screen')).toBeVisible();
  await expect(mission.locator('#mission-root')).toHaveAttribute('data-handoff-stage', 'idle');
  await expect(mission.locator('#mission-brief')).toBeHidden();
  await expect(mission.locator('#film-screen')).not.toHaveClass(/brief-open/);
  await expect(mission.locator('#file-cursor')).toBeHidden();
  await expect(mission.locator('#nightjar-row')).not.toHaveClass(/is-pressed/);
  expect(starts).toBe(0);

  await mission.locator('#begin-no-film').click();
  await expect(mission.locator('#mission-root')).toHaveAttribute('data-handoff-stage', 'selecting-file', { timeout: 10000 });
  await expect.poll(() => mission.locator('#file-cursor').evaluate(element => element.getAnimations().length)).toBeGreaterThan(0);
  await mission.locator('#mission-root').evaluate(async element => { if (element.ownerDocument.fullscreenElement) await element.ownerDocument.exitFullscreen(); });
  await page.setViewportSize({ width: 1280, height: 720 });
  await expectBrowserFit();
  await expect(mission.locator('#nightjar-row')).toHaveClass(/is-pressed/, { timeout: 10000 });
  const clickTip = await mission.locator('#nightjar-row').evaluate(row => {
    const box = row.getBoundingClientRect(), cursor = row.ownerDocument.querySelector('#file-cursor') as HTMLElement;
    const coordinates = cursor.style.transform.match(/translate3d\(([-\d.]+)px,\s*([-\d.]+)px/);
    if (!coordinates) return { hit: false, transform: cursor.style.transform, row: { left: box.left, top: box.top, right: box.right, bottom: box.bottom } };
    const x = Number(coordinates[1]) + 2, y = Number(coordinates[2]) + 1;
    return { hit: x >= box.left && x <= box.right && y >= box.top && y <= box.bottom, x, y, transform: cursor.style.transform, row: { left: box.left, top: box.top, right: box.right, bottom: box.bottom } };
  });
  expect(clickTip.hit, JSON.stringify(clickTip)).toBe(true);
  await expect(mission.locator('#mission-root')).toHaveAttribute('data-handoff-stage', 'brief', { timeout: 10000 });
  await expect(mission.locator('#open-archive-ai')).toBeFocused();
  await expectBrowserFit();
  await mission.locator('#open-archive-ai').press('Shift+Tab');
  await expect(mission.locator('#return-from-brief')).toBeFocused();
  await mission.locator('#return-from-brief').press('Tab');
  await expect(mission.locator('#open-archive-ai')).toBeFocused();
  await page.setViewportSize({ width: 390, height: 844 });
  const briefBox = await mission.locator('#mission-brief-window').boundingBox();
  expect(briefBox).not.toBeNull();
  expect(briefBox!.x).toBeGreaterThanOrEqual(0);
  expect(briefBox!.y).toBeGreaterThanOrEqual(0);
  expect(briefBox!.x + briefBox!.width).toBeLessThanOrEqual(390);
  expect(briefBox!.y + briefBox!.height).toBeLessThanOrEqual(844);
  await mission.locator('#open-archive-ai').press('Escape');
  await expect(mission.locator('.welcome-screen')).toBeVisible();
  await expect(mission.locator('#mission-brief')).toBeHidden();
  await expect(mission.locator('#film-screen')).not.toHaveClass(/brief-open/);
  expect(starts).toBe(0);

  await mission.locator('#begin-no-film').click();
  await expect(mission.locator('#mission-root')).toHaveAttribute('data-handoff-stage', 'brief', { timeout: 10000 });
  await mission.locator('#open-archive-ai').click();
  await expect(mission.locator('#mission-root')).toHaveAttribute('data-handoff-stage', 'console-opening');
  await mission.locator('#return-film').click();
  await expect(mission.locator('.welcome-screen')).toBeVisible();
  await expect(mission.locator('#mission-root')).toHaveAttribute('data-handoff-stage', 'idle');
  await expect.poll(() => starts).toBe(0);
});

test('return during a delayed connection leaves the menu usable and retries with the same profile key', async ({ page }) => {
  await signInOwner(page.request);
  await page.goto('/mission');
  const mission = page.frameLocator('iframe[title="Mission: Impossible archive"]');
  await ensureMissionSetup(mission);
  await expect(mission.locator('#watch-button')).toBeEnabled({ timeout: 15000 });
  const startBodies: Record<string, string>[] = [];
  let startedRound: { id: string; accessToken: string } | null = null;
  let releaseFirst!: () => void;
  let releaseFirstResponse!: () => void;
  const firstRequestSeen = new Promise<void>(resolve => { releaseFirst = resolve; });
  const firstResponseGate = new Promise<void>(resolve => { releaseFirstResponse = resolve; });
  await page.route('**/api/mission/start', async route => {
    const body = route.request().postDataJSON() as Record<string, string>;
    startBodies.push(body);
    if (startBodies.length === 1) { releaseFirst(); await firstResponseGate; }
    const response = await route.fetch();
    const result = await response.json() as { id: string; accessToken: string | null };
    if (typeof result.accessToken === 'string') startedRound = { id: result.id, accessToken: result.accessToken };
    await route.fulfill({ response });
  });
  await mission.locator('#begin-no-film').click();
  await expect(mission.locator('#mission-root')).toHaveAttribute('data-handoff-stage', 'brief', { timeout: 10000 });
  await mission.locator('#open-archive-ai').click();
  await expect(mission.locator('#mission-root')).toHaveAttribute('data-handoff-stage', 'connecting', { timeout: 10000 });
  await firstRequestSeen;
  await expect(mission.locator('#terminal-input')).toBeDisabled();
  await expect(mission.locator('#finish-interrogation')).toBeDisabled();
  await mission.locator('#exit-game').click();
  await expect(mission.locator('.welcome-screen')).toBeVisible();
  releaseFirstResponse();
  await expect(mission.locator('#watch-button')).toBeEnabled({ timeout: 10000 });
  await expect(mission.locator('#mission-root')).toHaveAttribute('data-handoff-stage', 'idle');
  await mission.locator('#begin-no-film').click();
  await expect(mission.locator('#mission-root')).toHaveAttribute('data-handoff-stage', 'brief', { timeout: 10000 });
  await mission.locator('#open-archive-ai').click();
  await expect(mission.locator('#mission-root')).toHaveAttribute('data-handoff-stage', 'game', { timeout: 15000 });
  await expect(mission.locator('#terminal-status')).toHaveText('ONLINE', { timeout: 15000 });
  expect(startBodies).toHaveLength(2);
  expect(startBodies[1].startKey).toBe(startBodies[0].startKey);
  expect(startBodies[1].profileId).toBe(startBodies[0].profileId);
  expect(startedRound).not.toBeNull();
  await closeConversationFixture(page, startedRound!);
});

test('unavailable ending film offers play, retry, and completion fallback', async ({ page }) => {
  await startMission(page);
  const mission = await openActiveMission(page);
  await page.route('**/mission-assets/mission-success-v3.mp4', route => route.abort('failed'));
  const input = mission.locator('#terminal-input');
  await input.fill('Who is the full name behind NIGHTJAR?');
  await input.press('Enter');
  await expect(mission.locator('#terminal-log .message.assistant:not(.opening)').last()).toContainText('Mara Voss');
  await mission.locator('#finish-interrogation').click();
  await expect(mission.locator('#success-film-screen')).toBeVisible({ timeout: 10000 });
  await expect(mission.locator('#success-film-message')).toBeVisible({ timeout: 20000 });
  await expect(mission.locator('#play-success-film')).toBeVisible();
  await expect(mission.locator('#retry-success-film')).toBeVisible();
  await mission.locator('#skip-success-film-fallback').click();
  await expect(mission.locator('#success-screen')).toBeVisible();
});

test('returning during delayed resume metadata cancels playback from starting later', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  const round = await startMission(page);
  let holdEnding = false;
  await page.route('**/mission-assets/mission-success-v3.mp4', async route => {
    if (holdEnding) await new Promise(resolve => setTimeout(resolve, 1800));
    await route.fulfill({ path: 'static/mission-assets/mission-intro-v5.mp4', contentType: 'video/mp4' });
  });
  const mission = await openActiveMission(page);
  const input = mission.locator('#terminal-input');
  await input.fill('Who is the full name behind NIGHTJAR?');
  await input.press('Enter');
  await expect(mission.locator('#terminal-log .message.assistant:not(.opening)').last()).toContainText('Mara Voss');
  await mission.locator('#finish-interrogation').click();
  await expect(mission.locator('#success-film-screen')).toBeVisible({ timeout: 10000 });
  await expect.poll(() => mission.locator('#success-film').evaluate(video => (video as HTMLVideoElement).currentTime)).toBeGreaterThan(0.5);
  await expect(mission.locator('#success-film-screen')).toHaveClass(/controls-dim/, { timeout: 5000 });
  await mission.locator('#success-film-screen').dispatchEvent('pointerdown', { pointerType: 'touch', isPrimary: true, button: 0, buttons: 1 });
  await expect(mission.locator('#success-film-screen')).not.toHaveClass(/controls-dim/);
  await expect(mission.locator('#skip-success-film')).toBeVisible();
  await mission.locator('#skip-success-film').click();
  await expect(mission.locator('#success-screen')).toBeVisible();
  await mission.locator('#replay-success-film').click();
  await expect(mission.locator('#success-film-screen')).toBeVisible();
  await expect.poll(() => mission.locator('#success-film').evaluate(video => (video as HTMLVideoElement).currentTime)).toBeGreaterThan(0.5);
  await expect(mission.locator('#success-film-screen')).toHaveClass(/controls-dim/, { timeout: 5000 });
  await page.keyboard.press('Tab');
  await expect(mission.locator('#success-film-screen')).not.toHaveClass(/controls-dim/);

  holdEnding = true;
  await page.reload();
  const resumed = page.frameLocator('iframe[title="Mission: Impossible archive"]');
  await expect(resumed.locator('#success-film-screen')).toBeVisible({ timeout: 10000 });
  const metadataState = await resumed.locator('#success-film').evaluate(video => {
    const media = video as HTMLVideoElement;
    media.dataset.playEvents = '0';
    media.addEventListener('play', () => { media.dataset.playEvents = String(Number(media.dataset.playEvents) + 1); });
    return media.readyState;
  });
  expect(metadataState).toBeLessThan(1);
  await resumed.locator('#return-success-film').click();
  await expect(resumed.locator('.welcome-screen')).toBeVisible();
  await page.waitForTimeout(2200);
  expect(await resumed.locator('#success-film').evaluate(video => (video as HTMLVideoElement).dataset.playEvents)).toBe('0');
  const saved = await (await page.request.get(`/api/mission/rounds/${round.id}`)).json() as { state: { review: { attempts: number } } };
  expect(saved.state.review.attempts).toBe(1);
  expect(pageErrors).toEqual([]);
});

test('phone composer remains usable and CRT history controls navigate older and newer text', async ({ page }) => {
  const round = await startMission(page);
  const mission = await openActiveMission(page);
  const input = mission.locator('#terminal-input');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(input).toBeVisible();
  const composer = await input.boundingBox();
  expect(composer?.height).toBeGreaterThanOrEqual(32);
  expect(composer?.x).toBeGreaterThanOrEqual(0);
  expect((composer?.x || 0) + (composer?.width || 0)).toBeLessThanOrEqual(390);
  expect(Number.parseFloat(await input.evaluate(element => getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(16);
  for (let index = 0; index < 10; index++) {
    const before = await mission.locator('#terminal-log .message.assistant:not(.opening)').count();
    await input.fill(`Repeat the archive details in line ${index}.`);
    await input.press('Enter');
    await expect(mission.locator('#terminal-log .message.assistant:not(.opening)')).toHaveCount(before + 1);
  }
  await expect(mission.locator('#history-older')).toBeEnabled();
  await mission.locator('#history-older').click();
  await expect(mission.locator('#history-newer')).toBeEnabled();
  await mission.locator('#history-newer').click();
  expect(round.interactionRevision).toBe('conversation-only-v1');
});

test('a new long reply opens at its beginning and does not jump when history is being read', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await startMission(page);
  const mission = await openActiveMission(page);
  const input = mission.locator('#terminal-input');
  await input.fill('[long-reply] Show a longer route record.');
  await input.press('Enter');
  await expect(mission.locator('#terminal-log .message.assistant:not(.opening)').last()).toContainText('Mara Voss route detail 90.');
  const canvas = mission.locator('.crt-effect');
  const first = await canvas.getAttribute('aria-label');
  expect(first).toContain('CRT rendering');
  const beforeHistory = await canvas.evaluate(element => {
    const renderer = (element as HTMLCanvasElement & { __missionCrtRenderer?: { getScrollState(): { offset: number; max: number; latestStart: number; visibleFirstLine: string } } }).__missionCrtRenderer;
    return renderer?.getScrollState() || null;
  });
  expect(beforeHistory).not.toBeNull();
  expect(beforeHistory?.max).toBeGreaterThan(beforeHistory?.latestStart || 0);
  expect(beforeHistory?.offset).toBe(beforeHistory?.latestStart);
  expect(beforeHistory?.visibleFirstLine).toBe('ARCHIVE AI');

  await mission.locator('#history-older').click();
  const olderOffset = await canvas.evaluate(element => {
    const renderer = (element as HTMLCanvasElement & { __missionCrtRenderer?: { getScrollState(): { offset: number } } }).__missionCrtRenderer;
    return renderer?.getScrollState().offset;
  });
  const beforeFollowup = await mission.locator('#terminal-log .message.assistant:not(.opening)').count();
  await input.fill('Keep the current history view while I ask a follow-up.');
  await input.press('Enter');
  await expect(mission.locator('#terminal-log .message.assistant:not(.opening)')).toHaveCount(beforeFollowup + 1);
  const afterHistory = await canvas.evaluate(element => {
    const renderer = (element as HTMLCanvasElement & { __missionCrtRenderer?: { getScrollState(): { offset: number } } }).__missionCrtRenderer;
    return renderer?.getScrollState().offset;
  });
  expect(afterHistory).toBe(olderOffset);
  expect(pageErrors).toEqual([]);
});

test('large high-DPI CRT buffers preserve the screen aspect ratio', async ({ browser }) => {
  const context = await browser.newContext({ baseURL: 'http://127.0.0.1:4325', viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2 });
  try {
    const page = await context.newPage();
    await startMission(page);
    const mission = await openActiveMission(page);
    const dimensions = await mission.locator('.crt-effect').evaluate(element => {
      const canvas = element as HTMLCanvasElement;
      return { dpr: devicePixelRatio, cssWidth: canvas.clientWidth, cssHeight: canvas.clientHeight, width: canvas.width, height: canvas.height };
    });
    expect(dimensions.dpr).toBe(2);
    expect(dimensions.width).toBeLessThanOrEqual(2048);
    expect(dimensions.height).toBeLessThanOrEqual(1440);
    expect(dimensions.width / dimensions.height).toBeCloseTo(dimensions.cssWidth / dimensions.cssHeight, 2);
  } finally { await context.close(); }
});

test('lost and restored WebGL context keeps the accessible conversation working', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await startMission(page);
  const mission = await openActiveMission(page);
  const canvas = mission.locator('.crt-effect');
  const loss = await canvas.evaluate(element => {
    const gl = (element as HTMLCanvasElement).getContext('webgl2');
    const extension = gl?.getExtension('WEBGL_lose_context');
    (element as HTMLCanvasElement & { __contextLossExtension?: WEBGL_lose_context }).__contextLossExtension = extension || undefined;
    extension?.loseContext();
    return Boolean(extension);
  });
  test.skip(!loss, 'The browser does not expose WEBGL_lose_context.');
  await expect(canvas).toBeHidden();
  await expect(mission.locator('#terminal-log')).not.toHaveClass(/visually-hidden/);
  const restored = await canvas.evaluate(element => {
    const extension = (element as HTMLCanvasElement & { __contextLossExtension?: WEBGL_lose_context }).__contextLossExtension;
    extension?.restoreContext();
    return Boolean(extension);
  });
  expect(restored).toBe(true);
  await page.waitForTimeout(100);
  await expect(canvas).toBeHidden();
  const input = mission.locator('#terminal-input');
  await input.fill('Can the readable fallback still carry this conversation?');
  await input.press('Enter');
  await expect(mission.locator('#terminal-log .message.assistant:not(.opening)').last()).toContainText('Mara Voss');
  expect(pageErrors).toEqual([]);
});

test('a stalled optional telemetry request does not hold a reply or filing', async ({ page }) => {
  const round = await startMission(page);
  const metricsSession = page.waitForResponse(response => response.url().includes('/api/telemetry/session'));
  const mission = await openActiveMission(page);
  await usePlayableSuccessFixture(page);
  await metricsSession;
  let releaseTelemetry!: () => void;
  const telemetryGate = new Promise<void>(resolve => { releaseTelemetry = resolve; });
  let blockedInteractions = 0;
  await page.route('**/api/telemetry/events', async route => {
    const events = route.request().postDataJSON()?.events || [];
    if (events.some((event: { kind?: string; interaction?: string }) => event.kind === 'interaction' && ['reply','finish'].includes(event.interaction || ''))) {
      blockedInteractions++;
      await telemetryGate;
      await route.abort('timedout');
    } else await route.continue();
  });
  try {
    const input = mission.locator('#terminal-input');
    await input.fill('Who is the real name behind NIGHTJAR?');
    await input.press('Enter');
    await expect(mission.locator('#terminal-log .message.assistant:not(.opening)').last()).toContainText('Mara Voss');
    await mission.locator('#finish-interrogation').click();
    await expect(mission.locator('#success-film-screen')).toBeVisible({ timeout: 5000 });
    await mission.locator('#skip-success-film').click();
    await expect(mission.locator('#success-screen')).toBeVisible();
    expect(blockedInteractions).toBeGreaterThanOrEqual(2);
    const saved = await (await page.request.get(`/api/mission/rounds/${round.id}`)).json() as { state: { review: { status: string; attempts: number } } };
    expect(saved.state.review).toMatchObject({ status: 'complete', attempts: 1 });
  } finally { releaseTelemetry(); }
});
