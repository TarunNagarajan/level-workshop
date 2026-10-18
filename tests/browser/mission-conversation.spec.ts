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

test('conversation-only CRT round accepts dialogue and files one durable review', async ({ page }) => {
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

  await mission.locator('#finish-interrogation').click();
  await expect(mission.locator('#result-screen')).toBeVisible({ timeout: 10000 });
  expect(finishRequests).toBe(1);
  const saved = await (await page.request.get(`/api/mission/rounds/${round.id}`)).json() as {
    state: { ejected: boolean; closedAt: number; closure: { type: string }; actions: unknown[]; review: { status: string; attempts: number } };
  };
  expect(saved.state).toMatchObject({ ejected: false, closure: { type: 'conversation-finish-v1' }, review: { status: 'complete', attempts: 1 } });
  expect(saved.state.closedAt).toBeGreaterThan(0);
  expect(saved.state.actions).toBeUndefined();

  await page.reload();
  const reopened = page.frameLocator('iframe[title="Mission: Impossible archive"]');
  await expect(reopened.locator('#result-screen')).toBeVisible();
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
  let finishRequests = 0;
  await page.route(`**/api/mission/rounds/${round.id}/finish`, async route => {
    finishRequests++;
    await route.fetch();
    await route.abort('failed');
  });
  await mission.locator('#finish-interrogation').click();
  await expect(mission.locator('#result-screen')).toBeVisible({ timeout: 20000 });
  expect(finishRequests).toBe(1);
  const saved = await (await page.request.get(`/api/mission/rounds/${round.id}`)).json() as { state: { review: { status: string; attempts: number } } };
  expect(saved.state.review).toMatchObject({ status: 'complete', attempts: 1 });
  await page.reload();
  const reopened = page.frameLocator('iframe[title="Mission: Impossible archive"]');
  await expect(reopened.locator('#result-screen')).toBeVisible({ timeout: 20000 });
  expect(finishRequests).toBe(1);
});

test('an unreceived finish request resumes its saved intent after reload', async ({ page }) => {
  const round = await startMission(page);
  const mission = await openActiveMission(page);
  const input = mission.locator('#terminal-input');
  await input.fill('Who is the real name behind NIGHTJAR?');
  await input.press('Enter');
  await expect(mission.locator('#terminal-log .message.assistant:not(.opening)').last()).toContainText('Mara Voss');
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
  await expect(reopened.locator('#result-screen')).toBeVisible({ timeout: 20000 });
  expect(finishRequests).toBe(2);
  const saved = await (await page.request.get(`/api/mission/rounds/${round.id}`)).json() as { state: { review: { status: string; attempts: number } } };
  expect(saved.state.review).toMatchObject({ status: 'complete', attempts: 1 });
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
    await expect(mission.locator('#result-screen')).toBeVisible({ timeout: 5000 });
    expect(blockedInteractions).toBeGreaterThanOrEqual(2);
    const saved = await (await page.request.get(`/api/mission/rounds/${round.id}`)).json() as { state: { review: { status: string; attempts: number } } };
    expect(saved.state.review).toMatchObject({ status: 'complete', attempts: 1 });
  } finally { releaseTelemetry(); }
});
