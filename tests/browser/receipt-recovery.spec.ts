import { test, expect } from '@playwright/test';
import { signInOwner } from './auth';

test('unknown receipt recovery reuses the original content and keeps the edited draft', async ({ page }) => {
  await signInOwner(page.request);
  await page.goto('/');
  if (await page.getByRole('button', { name: 'Skip tour' }).count()) await page.getByRole('button', { name: 'Skip tour' }).click();
  await page.getByRole('button', { name: 'Levels', exact: true }).click();
  await page.locator('.level-table .level-row').filter({ hasText: "Riddle's diary" }).click();
  await page.getByRole('button', { name: 'Start test', exact: true }).click();
  const openingReplies = await page.locator('.conversation .message.assistant').count();

  const requests: { content: string; requestId: string }[] = [];
  await page.route('**/api/rounds/*/messages', async route => {
    requests.push(route.request().postDataJSON());
    const response = await route.fetch();
    if (requests.length === 1) await route.abort('failed');
    else await route.fulfill({ response });
  });

  await page.getByLabel('Message to target').fill('Original prompt for receipt recovery.');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByRole('button', { name: 'Check previous submission' })).toBeVisible();
  await page.getByLabel('Message to target').fill('A different draft that must remain unsent.');
  await page.getByRole('button', { name: 'Check previous submission' }).click();

  await expect(page.getByText(/Original prompt for receipt recovery\./)).toBeVisible();
  await expect(page.getByLabel('Message to target')).toHaveValue('A different draft that must remain unsent.');
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual(requests[0]);
  await expect(page.locator('.conversation .message.user')).toHaveCount(1);
  await expect(page.locator('.conversation .message.assistant')).toHaveCount(openingReplies + 1);
});
