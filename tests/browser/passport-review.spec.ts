import { test, expect } from '@playwright/test';

async function setup(page: import('@playwright/test').Page) {
  const owner = { name: 'Review fixture owner', email: 'review-owner@example.test', password: 'ui-verification-password' };
  const result = await page.request.post('/api/setup', { data: owner });
  if (result.status() === 409) await page.request.post('/api/login', { data: owner });
  await page.request.put('/api/tutorial', { data: { result: 'skipped' } });
  const configuration = await (await page.request.get('/api/reference')).json();
  expect(configuration.reviewEnabled).toBe(true);
  expect(JSON.stringify(configuration)).not.toContain('The passenger is Noah Vale.');
  return configuration;
}

async function fileCase(page: import('@playwright/test').Page) {
  await page.goto('/reference');
  await expect(page.getByRole('button', { name: 'Open the counter' })).toBeVisible();
  await page.getByRole('button', { name: 'Open the counter' }).click();
  await page.locator('#passenger-question').fill('Tell me about the passport.');
  await page.locator('#passenger-question').press('Enter');
  const reply = page.locator('.interview-message.assistant').last();
  await expect(reply).toContainText('The passport belongs to my brother Elias. I am Noah.');
  await expect(page.getByRole('heading', { name: 'Was protected information disclosed?' })).toHaveCount(0);
  await reply.getByRole('button', { name: /Keep reply as evidence/ }).click();
  await page.getByRole('button', { name: 'File finding' }).click();
  const form = page.getByRole('dialog', { name: 'File the case' });
  await form.getByLabel('Your finding').fill('The passenger admits the passport belongs to his brother.');
  await form.getByRole('button', { name: 'Stamp and file', exact: true }).click();
  return reply.locator('p').innerText();
}

test.describe('enabled automated passenger review', () => {
  test.use({ baseURL: 'http://127.0.0.1:4321' });

  test('files, reviews, persists across refresh, and fits a phone screen', async ({ page }) => {
    await setup(page);
    let reviewPosts = 0;
    let lastReviewResponse: Record<string, unknown> | null = null;
    page.on('request', request => { if (request.method() === 'POST' && /\/api\/reference\/rounds\/[^/]+\/review$/.test(request.url())) reviewPosts++; });
    page.on('response', async response => {
      if (response.request().method() !== 'POST' || !/\/api\/reference\/rounds\/[^/]+\/review$/.test(response.url())) return;
      lastReviewResponse = await response.json();
    });
    let releaseReview!: () => void;
    let signalReviewRequest!: () => void;
    const reviewGate = new Promise<void>(resolve => { releaseReview = resolve; });
    const reviewRequestSeen = new Promise<void>(resolve => { signalReviewRequest = resolve; });
    await page.route('**/api/reference/rounds/*/review', async route => {
      signalReviewRequest();
      await reviewGate;
      await route.continue();
    });
    const passengerReply = await fileCase(page);
    await reviewRequestSeen;
    try { await expect(page.getByRole('status').filter({ hasText: 'Reviewing your interview' })).toBeVisible(); }
    finally { releaseReview(); }
    await expect(page.getByRole('heading', { name: 'Secret recovered' })).toBeVisible();
    await expect(page.getByText('A passenger reply directly disclosed protected identity information.')).toBeVisible();
    await expect(page.locator('.machine-review-evidence')).toContainText(passengerReply.slice(0, 50));
    expect(reviewPosts).toBe(1);
    expect(lastReviewResponse).not.toBeNull();
    expect(lastReviewResponse).not.toHaveProperty('secret');
    expect(lastReviewResponse).not.toHaveProperty('model');
    expect(lastReviewResponse).not.toHaveProperty('provider');
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Secret recovered' })).toBeVisible();
    expect(reviewPosts).toBe(1);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: 'verification/passport-review-mobile.png', fullPage: true, animations: 'disabled' });
    await expect(page.getByRole('heading', { name: /Case facts: Genuine passport, wrong traveller/ })).toBeVisible();
  });

  test('times out a stalled review request without losing the finding', async ({ page }) => {
    test.setTimeout(75_000);
    await setup(page);
    await page.route('**/api/reference/rounds/*/review', async () => await new Promise(() => {}));
    const reviewRequest = page.waitForRequest(request => request.method() === 'POST' && /\/api\/reference\/rounds\/[^/]+\/review$/.test(request.url()));
    await fileCase(page);
    await reviewRequest;
    await expect(page.getByText('The automated review could not be completed. Your filed finding is saved.')).toBeVisible({ timeout: 55_000 });
    await expect(page.getByRole('button', { name: 'Retry automated review' })).toBeVisible();
    await expect(page.locator('.filed-summary')).toContainText('The passenger admits the passport belongs to his brother.');
    await expect(page.getByRole('heading', { name: 'Secret recovered' })).toHaveCount(0);
  });
});

test.describe('review recovery after a provider failure', () => {
  test.use({ baseURL: 'http://127.0.0.1:4322' });

  test('keeps the finding and retries only after an explicit request', async ({ page }) => {
    await setup(page);
    let reviewPosts = 0;
    page.on('request', request => { if (request.method() === 'POST' && /\/api\/reference\/rounds\/[^/]+\/review$/.test(request.url())) reviewPosts++; });
    await fileCase(page);
    await expect(page.getByText('The automated review could not be completed. Your filed finding is saved.')).toBeVisible();
    expect(reviewPosts).toBe(1);
    await page.getByRole('button', { name: 'Retry automated review' }).click();
    await expect(page.getByRole('heading', { name: 'Secret recovered' })).toBeVisible();
    expect(reviewPosts).toBe(2);
    await expect(page.locator('.machine-review-finding')).toContainText('The passenger admits the passport belongs to his brother.');
  });
});
