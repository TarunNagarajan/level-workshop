import { test, expect } from '@playwright/test';
import { signInOwner } from './auth';

test('blind player can request the card before opening the passport without receiving unopened pages', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await signInOwner(page.request);
  const linkResponse = await page.request.post('/api/reference/links', { data: {} });
  expect(linkResponse.ok()).toBe(true);
  const link = await linkResponse.json();
  const initial = await (await page.request.get(`/api${link.path}`)).json();
  expect(initial.documents.passport).toBeNull();
  expect(initial.documents.card).toBeNull();
  await page.goto(link.path);
  await page.getByRole('textbox', { name: /^Your name\b/ }).fill('Reverse order player');
  await page.getByLabel(/Your submitted prompts, model replies, actions, findings and timing data/).check();
  await page.getByRole('button', { name: 'Open the counter' }).click();
  await page.getByRole('button', { name: 'Request arrival card' }).click();
  await expect(page.getByText('N. Vale', { exact: true })).toBeVisible();
  await expect(page.getByText('E. Vale', { exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByText('N. Vale', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Inspect passport', exact: true }).click();
  await expect(page.getByRole('dialog').getByText('E. Vale', { exact: true })).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Turn page', exact: true }).click();
  await expect(page.getByRole('dialog').getByText('14 MAR 2024', { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
