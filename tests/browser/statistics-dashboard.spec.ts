import { test, expect } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

test('owner opens, filters, reviews, exports, closes and signs out of standalone Inception statistics', async ({ page }) => {
  const consoleErrors: string[] = [];
  const telemetryRequests: string[] = [];
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('request', request => { if (request.url().includes('/telemetry/')) telemetryRequests.push(request.url()); });
  await page.goto('/stats');
  await expect(page.getByRole('heading', { name: 'Statistics' })).toBeVisible();
  await expect(page.getByLabel('Owner key')).toBeVisible();
  await page.getByLabel('Owner key').fill('browser-statistics-fixture-key');
  await page.getByRole('button', { name: 'Open statistics' }).click();
  await expect(page.getByText('Started attempts', { exact: true })).toBeVisible();
  await expect(page.getByText('Avery Player')).toBeVisible();
  await expect(page.getByText('Morgan Player')).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Time to reveal' })).toBeVisible();
  const screenshot = resolve('work/statistics-dashboard/owner-dashboard.png');
  await mkdir(dirname(screenshot), { recursive: true });
  await page.screenshot({ path: screenshot, fullPage: true });

  await page.getByLabel('Outcome').selectOption('won');
  await expect(page.getByText('Avery Player')).toBeVisible();
  await expect(page.getByText('Morgan Player')).toHaveCount(0);
  await page.getByLabel('Outcome').selectOption('all');
  await page.getByLabel('Search player name or round ID').fill('Avery');
  await expect(page.getByText('Morgan Player')).toHaveCount(0);
  const player = page.getByRole('button', { name: 'Avery Player' });
  await player.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Avery Player' })).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'Saved conversation', exact: true })).toBeVisible();
  await expect(dialog.getByText('Assistant · opening', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Avery Player' }).click();
  const transcript = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download transcript' }).click();
  const transcriptFile = await transcript;
  expect(transcriptFile.suggestedFilename()).toContain('inception-attempt-');
  await page.getByRole('button', { name: 'Close attempt details' }).click();

  await page.getByLabel('Search player name or round ID').fill('');
  await expect(page.getByRole('button', { name: 'Morgan Player' })).toBeVisible();
  const fullExport = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export all' }).click();
  const exportFile = await fullExport;
  expect(exportFile.suggestedFilename()).toContain('inception-attempts-');
  expect(JSON.parse(await readFile((await exportFile.path())!, 'utf8')).items).toHaveLength(26);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByLabel('Owner key')).toBeVisible();
  expect(telemetryRequests).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

test('late detail and paging responses cannot replace a closed drawer or newly filtered page', async ({ page }) => {
  await page.goto('/stats');
  await page.getByLabel('Owner key').fill('browser-statistics-fixture-key');
  await page.getByRole('button', { name: 'Open statistics' }).click();
  await expect(page.getByRole('button', { name: 'Load more attempts' })).toBeVisible();

  let releaseMore!: () => void;
  const moreStarted = new Promise<void>(resolveStart => {
    page.route('**/api/statistics/attempts?*cursor=*', async route => {
      resolveStart();
      await new Promise<void>(resolveDelay => { releaseMore = resolveDelay; });
      try { await route.continue(); } catch { /* A filter change aborts the old request. */ }
    });
  });
  await page.getByRole('button', { name: 'Load more attempts' }).click();
  await moreStarted;
  await page.getByLabel('Outcome').selectOption('won');
  await expect(page.locator('.stats-attempts-table tbody tr')).toHaveCount(1);
  releaseMore();
  await page.waitForTimeout(150);
  await expect(page.locator('.stats-attempts-table tbody tr')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Avery Player' })).toBeVisible();

  let releaseDetail!: () => void;
  const detailStarted = new Promise<void>(resolveStart => {
    page.route('**/api/statistics/attempts/22222222-2222-4222-8222-222222222222', async route => {
      resolveStart();
      await new Promise<void>(resolveDelay => { releaseDetail = resolveDelay; });
      try { await route.continue(); } catch { /* Closing the drawer aborts this request. */ }
    });
  });
  await page.getByRole('button', { name: 'Avery Player' }).click();
  await detailStarted;
  await page.getByRole('button', { name: 'Close attempt details' }).click();
  releaseDetail();
  await page.waitForTimeout(150);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('unauthorized deep link displays sign-in and does not request statistics records', async ({ page }) => {
  const statsRequests: string[] = [];
  page.on('request', request => { if (/\/api\/statistics\/(summary|attempts|capacity)/.test(request.url())) statsRequests.push(request.url()); });
  await page.goto('/stats');
  await expect(page.getByRole('heading', { name: 'Statistics' })).toBeVisible();
  await expect(page.getByLabel('Owner key')).toBeVisible();
  expect(statsRequests).toEqual([]);
});

test('signing out during an export resets export state after signing back in', async ({ page }) => {
  await page.goto('/stats');
  await page.getByLabel('Owner key').fill('browser-statistics-fixture-key');
  await page.getByRole('button', { name: 'Open statistics' }).click();
  await expect(page.getByRole('button', { name: 'Export all' })).toBeEnabled();

  let releaseExportPage!: () => void;
  let reachedExportPage!: () => void;
  const exportPageStarted = new Promise<void>(resolveStart => { reachedExportPage = resolveStart; });
  await page.route('**/api/statistics/attempts?*cursor=*', async route => {
    reachedExportPage();
    await new Promise<void>(resolveDelay => { releaseExportPage = resolveDelay; });
    try { await route.continue(); } catch { /* Signing out aborts the export request. */ }
  });
  await page.getByRole('button', { name: 'Export all' }).click();
  await exportPageStarted;
  await expect(page.getByRole('button', { name: '25 records' })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByLabel('Owner key')).toBeVisible();
  releaseExportPage();
  await page.unroute('**/api/statistics/attempts?*cursor=*');

  await page.getByLabel('Owner key').fill('browser-statistics-fixture-key');
  await page.getByRole('button', { name: 'Open statistics' }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export all' }).click();
  expect((await download).suggestedFilename()).toContain('inception-attempts-');
});

test('export authorization failure expires the owner session without downloading or an unhandled rejection', async ({ page }) => {
  const pageErrors: string[] = [];
  let downloaded = false;
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('download', () => { downloaded = true; });
  await page.goto('/stats');
  await page.getByLabel('Owner key').fill('browser-statistics-fixture-key');
  await page.getByRole('button', { name: 'Open statistics' }).click();
  await expect(page.getByText('Started attempts', { exact: true })).toBeVisible();
  await page.route('**/api/statistics/attempts?*', route => route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'Forbidden' }) }));
  await page.getByRole('button', { name: 'Export all' }).click();
  await expect(page.getByLabel('Owner key')).toBeVisible();
  await expect(page.getByText('Your owner session expired. Sign in again to continue.')).toBeVisible();
  await page.waitForTimeout(100);
  expect(downloaded).toBe(false);
  expect(pageErrors).toEqual([]);
  await page.unroute('**/api/statistics/attempts?*');
  await page.getByLabel('Owner key').fill('browser-statistics-fixture-key');
  await page.getByRole('button', { name: 'Open statistics' }).click();
  await expect(page.getByText('Started attempts', { exact: true })).toBeVisible();
});

test('logout failure keeps private data hidden, blocks sign in and offers a retry', async ({ page }) => {
  await page.goto('/stats');
  await page.getByLabel('Owner key').fill('browser-statistics-fixture-key');
  await page.getByRole('button', { name: 'Open statistics' }).click();
  await expect(page.getByText('Started attempts', { exact: true })).toBeVisible();
  await page.route('**/api/logout', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Unavailable' }) }));
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByLabel('Owner key')).toBeVisible();
  await expect(page.getByText('Sign out could not be confirmed. Your browser may still have an owner session. Retry sign out before signing in.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open statistics' })).toBeDisabled();
  await expect(page.getByText('Started attempts', { exact: true })).toHaveCount(0);
  await page.unroute('**/api/logout');
  await page.getByRole('button', { name: 'Retry sign out' }).click();
  await expect(page.getByRole('button', { name: 'Open statistics' })).toBeEnabled();
  await page.getByLabel('Owner key').fill('browser-statistics-fixture-key');
  await page.getByRole('button', { name: 'Open statistics' }).click();
  await expect(page.getByText('Started attempts', { exact: true })).toBeVisible();
});
