import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test.use({ baseURL: 'http://127.0.0.1:4320' });

test('owner dashboard reads real fixture metrics while editor and anonymous access stay blocked', async ({ page, browser }) => {
  const runtimeErrors: string[] = [];
  page.on('pageerror', error => runtimeErrors.push(error.message));
  const needsSetup = (await (await page.request.get('/api/bootstrap')).json()).needsSetup;
  await page.goto('/');
  if (needsSetup) await page.getByRole('textbox', { name: /^Your name\b/ }).fill('Metrics owner');
  await page.getByLabel('Email').fill('metrics-owner@example.test');
  await page.getByLabel('Password').fill('metrics-verification-password');
  await page.getByRole('button', { name: needsSetup ? 'Create account' : 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: /^Levels/ })).toBeVisible();
  if (await page.getByRole('button', { name: 'Skip tour' }).isVisible()) await page.getByRole('button', { name: 'Skip tour' }).click();

  await page.getByRole('button', { name: 'Metrics', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Usage and timing' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Metrics date window' })).toHaveValue('30');
  await expect(page.getByText('Reading/thinking is a UI phase estimate', { exact: false })).toBeVisible();
  await expect.poll(async () => {
    const response = await page.request.get('/api/metrics/summary');
    expect(response.status()).toBe(200);
    const summary = await response.json();
    return summary.browser.sessions;
  }).toBeGreaterThan(0);

  const levels = await (await page.request.get('/api/levels')).json() as Array<{ id: string; ownerId: string; draft: { title: string } }>;
  const currentUser = (await (await page.request.get('/api/bootstrap')).json()).user as { id: string };
  const source = levels.find(level => level.ownerId === currentUser.id);
  expect(source, 'the fixture includes a conversation scenario').toBeTruthy();
  const detail = await (await page.request.get(`/api/levels/${source!.id}`)).json() as { versions: Array<{ id: string }> };
  const created = await page.request.post('/api/collections', { data: { levelId: source!.id, versionId: detail.versions[0].id } });
  expect(created.ok()).toBe(true);
  const collectionId = (await created.json()).id as string;
  const linkResponse = await page.request.post(`/api/collections/${collectionId}/links`, { data: {} });
  expect(linkResponse.ok()).toBe(true);
  const linkPath = (await linkResponse.json()).path as string;
  const participantContext = await browser.newContext();
  const participant = await participantContext.newPage();
  const telemetryBodies: string[] = [];
  const telemetryResponses: Array<{ status: number; requestBody: string }> = [];
  let releaseTelemetrySession!: () => void;
  let markTelemetrySessionStarted!: () => void;
  const telemetrySessionGate = new Promise<void>(resolve => { releaseTelemetrySession = resolve; });
  const telemetrySessionStarted = new Promise<void>(resolve => { markTelemetrySessionStarted = resolve; });
  await participant.route('**/api/telemetry/session', async route => {
    markTelemetrySessionStarted();
    await telemetrySessionGate;
    await route.continue();
  });
  participant.on('request', request => {
    if (request.method() !== 'POST' || !request.url().includes('/api/telemetry/events')) return;
    telemetryBodies.push(request.postData() || '');
  });
  participant.on('response', response => {
    if (!response.url().includes('/api/telemetry/events')) return;
    telemetryResponses.push({ status: response.status(), requestBody: response.request().postData() || '' });
  });
  await participant.goto(linkPath);
  await participant.getByRole('textbox', { name: /^Your name\b/ }).fill('Metrics sample participant');
  await participant.getByLabel(/Your submitted prompts, model replies, actions, findings and timing data/).check();
  await participant.getByRole('button', { name: 'Start playthrough' }).click();
  await expect(participant.getByLabel('Message to target')).toBeVisible();
  await telemetrySessionStarted;
  const privateText = 'This private test phrase must stay in the workshop request only.';
  await participant.getByLabel('Message to target').fill(privateText);
  await participant.getByLabel('Message to target').blur();
  await participant.getByRole('button', { name: 'Send message' }).click();
  await expect(participant.locator('.conversation')).toContainText(/I was honoured for Special Services to the School after Hagrid was blamed/);
  // Events generated while consent is already granted but the session is
  // unresolved must be retained, then sent after this response establishes it.
  const openedSessionResponse = participant.waitForResponse(response => response.url().includes('/api/telemetry/session') && response.request().method() === 'POST');
  const measuredActionBatch = participant.waitForResponse(response => {
    const body = response.request().postData() || '';
    return response.url().includes('/api/telemetry/events') && body.includes('compose') && body.includes('round_action') && response.ok();
  });
  releaseTelemetrySession();
  await openedSessionResponse;
  await measuredActionBatch;
  await participant.unroute('**/api/telemetry/session');
  await participant.goto('/'); // flushes the scoped interval before leaving the round
  await expect.poll(async () => {
    const summary = await (await page.request.get('/api/metrics/summary')).json();
    return summary.modelCalls.total;
  }).toBeGreaterThan(0);
  const liveSummary = await (await page.request.get('/api/metrics/summary')).json();
  expect(liveSummary.modelCalls.inFlight).toBe(0);
  expect(liveSummary.byProfile.some((row: { collectionId: string; source: string; calls: number }) => row.collectionId === collectionId && row.source === 'participant' && row.calls > 0)).toBe(true);
  expect(liveSummary.browser.events).toBeGreaterThan(0);
  expect(telemetryBodies.join('\n')).toContain('compose');
  expect(telemetryBodies.join('\n')).toContain('round_action');
  expect(telemetryBodies.join('\n')).not.toContain(privateText);
  const windowFrom = Date.now() - 30 * 86400000;
  const windowTo = Date.now() + 1000;
  const storedMetrics = await (await page.request.get(`/api/metrics/export?from=${windowFrom}&to=${windowTo}&limit=100`)).json();
  const participantEvents = storedMetrics.items.filter((item: { type: string; collectionId?: string; source?: string; profileId?: string; roundId?: string }) => item.type === 'event' && item.collectionId === collectionId && item.source === 'participant' && item.profileId && item.roundId);
  expect(participantEvents.length).toBeGreaterThan(0);
  expect(participantEvents.some((item: { activeMs?: number; composeMs?: number; waitingMs?: number }) => (item.activeMs || 0) > 0 || (item.composeMs || 0) > 0 || (item.waitingMs || 0) > 0)).toBe(true);
  expect(telemetryResponses.filter(row => row.status >= 400), `all participant telemetry batches are accepted: ${JSON.stringify(telemetryResponses.filter(row => row.status >= 400))}`).toEqual([]);

  await page.getByRole('button', { name: 'Refresh' }).click();
  const callCard = page.locator('.metrics-card').filter({ hasText: 'Model calls' });
  await expect(callCard).toContainText(/succeeded · 0 failed · 0 interrupted · 0 in flight/);
  await expect(callCard.locator('strong')).not.toHaveText('0');
  await participantContext.close();

  const rawSummary = await (await page.request.get('/api/metrics/summary')).text();
  expect(rawSummary).not.toContain('metrics-owner@example.test');
  expect(rawSummary).not.toContain('metrics-verification-password');
  await page.screenshot({ path: 'verification/metrics-owner-desktop.png', fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('heading', { name: 'Usage and timing' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'verification/metrics-owner-mobile.png', fullPage: true, animations: 'disabled' });

  const exportPages: string[] = [];
  await page.route(/\/api\/metrics\/export/, async route => {
    const cursor = new URL(route.request().url()).searchParams.get('cursor');
    exportPages.push(cursor || 'first');
    const pageNumber = cursor === 'page-2' ? 2 : cursor === 'page-3' ? 3 : 1;
    const items = Array.from({ length: pageNumber === 3 ? 1 : 100 }, (_, index) => ({ type: 'event', id: `fixture-${pageNumber}-${index}`, recordedAt: index }));
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ schema: 'owner-metrics', schemaVersion: 1, items, nextCursor: pageNumber < 3 ? `page-${pageNumber + 1}` : null, pageLimit: 100 }) });
  });
  const completeDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export all pages' }).click();
  const completed = await completeDownload;
  const exported = JSON.parse(await readFile((await completed.path())!, 'utf8')) as { items: unknown[] };
  expect(exportPages).toEqual(['first', 'page-2', 'page-3']);
  expect(exported.items).toHaveLength(201);

  let slowExportStarted = false;
  await page.unroute(/\/api\/metrics\/export/);
  await page.route(/\/api\/metrics\/export/, async route => {
    const cursor = new URL(route.request().url()).searchParams.get('cursor');
    if (!cursor) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ schema: 'owner-metrics', schemaVersion: 1, items: [], nextCursor: 'slow-page', pageLimit: 100 }) });
    slowExportStarted = true;
    await new Promise(resolve => setTimeout(resolve, 3000));
    try { await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ schema: 'owner-metrics', schemaVersion: 1, items: [], nextCursor: null, pageLimit: 100 }) }); } catch { /* the client cancelled this page */ }
  });
  const cancelledDownload = page.waitForEvent('download', { timeout: 1200 }).catch(() => null);
  await page.getByRole('button', { name: 'Export all pages' }).click();
  await expect(page.getByRole('button', { name: 'Cancel export' })).toBeVisible();
  await expect.poll(() => slowExportStarted).toBe(true);
  await page.getByRole('button', { name: 'Cancel export' }).click();
  await expect(page.getByRole('button', { name: 'Export all pages' })).toBeVisible();
  expect(await cancelledDownload).toBeNull();
  await page.unroute(/\/api\/metrics\/export/);

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: 'Team', exact: true }).click();
  await page.getByRole('button', { name: 'Create workshop link' }).click();
  const invitation = await page.getByLabel('Invitation link', { exact: true }).inputValue();
  const editorContext = await browser.newContext();
  const editorPage = await editorContext.newPage();
  editorPage.on('pageerror', error => runtimeErrors.push(error.message));
  await editorPage.goto(invitation);
  await editorPage.getByRole('textbox', { name: /^Your name\b/ }).fill('Metrics editor');
  await editorPage.getByRole('button', { name: 'Enter workshop' }).click();
  if (await editorPage.getByRole('button', { name: 'Skip tour' }).isVisible()) await editorPage.getByRole('button', { name: 'Skip tour' }).click();
  await expect(editorPage.getByRole('button', { name: 'Metrics', exact: true })).toHaveCount(0);
  expect((await editorPage.request.get('/api/metrics/summary')).status()).toBe(403);
  await editorPage.goto('/metrics');
  await expect(editorPage.getByText('This page is not available for this account.')).toBeVisible();
  await expect(editorPage.getByRole('heading', { name: 'Usage and timing' })).toHaveCount(0);
  await editorContext.close();

  const anonymousContext = await browser.newContext();
  const anonymous = await anonymousContext.newPage();
  expect([401, 403]).toContain((await anonymous.request.get('http://127.0.0.1:4320/api/metrics/summary')).status());
  await anonymous.goto('/metrics');
  await expect(anonymous.getByRole('heading', { name: 'Usage and timing' })).toHaveCount(0);
  await anonymousContext.close();
  expect(runtimeErrors).toEqual([]);
});
