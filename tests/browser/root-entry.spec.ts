import { test, expect } from '@playwright/test';
import { signInOwner } from './auth';

test.use({ baseURL: 'http://127.0.0.1:4319' });

test('opt-in main website entry remembers authors and owner pause clears their sessions', async ({ page, browser }) => {
  await signInOwner(page.request);
  await page.request.put('/api/tutorial', { data: { result: 'skipped' } });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /^Levels/ })).toBeVisible();
  await page.getByRole('button', { name: 'Team', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Main website entry' })).toBeVisible();
  await expect(page.getByText('Name-only entry is available')).toBeVisible();

  const visitorContext = await browser.newContext();
  const visitor = await visitorContext.newPage();
  await visitor.goto('/');
  await expect(visitor.getByRole('heading', { name: 'Enter the workshop.' })).toBeVisible();
  await expect(visitor.getByRole('textbox', { name: /^Your name\b/ })).toBeEnabled();
  await visitor.getByRole('textbox', { name: /^Your name\b/ }).fill('Root visitor');
  await visitor.getByRole('button', { name: 'Enter workshop' }).click();
  await expect(visitor.getByRole('heading', { name: 'Find your way around.' })).toBeVisible();
  await visitor.getByRole('button', { name: 'Skip tour' }).click();
  await expect(visitor.getByRole('heading', { name: /^Levels/ })).toBeVisible();
  const firstUser = (await (await visitor.request.get('/api/bootstrap')).json()).user as { id: string; role: string };
  expect(firstUser.role).toBe('editor');
  await visitor.reload();
  await expect(visitor.getByText('Root visitor', { exact: true })).toBeVisible();
  await expect(visitor.getByRole('dialog')).toHaveCount(0);

  await page.getByRole('button', { name: 'Pause entry' }).click();
  await expect(page.getByText('Name-only entry is paused')).toBeVisible();
  await visitor.reload();
  await expect(visitor.getByRole('heading', { name: 'Enter the workshop.' })).toBeVisible();
  await expect(visitor.getByRole('alert')).toContainText(/paused/i);

  await page.getByRole('button', { name: 'Reopen entry' }).click();
  await expect(page.getByText('Name-only entry is available')).toBeVisible();
  await visitor.reload();
  await visitor.getByRole('textbox', { name: /^Your name\b/ }).fill('Root visitor');
  await visitor.getByRole('button', { name: 'Enter workshop' }).click();
  await expect(visitor.getByRole('heading', { name: 'Find your way around.' })).toBeVisible();
  await visitor.getByRole('button', { name: 'Skip tour' }).click();
  const secondUser = (await (await visitor.request.get('/api/bootstrap')).json()).user as { id: string; role: string };
  expect(secondUser.role).toBe('editor');
  expect(secondUser.id).not.toBe(firstUser.id);
  await visitor.getByRole('button', { name: 'Sign out' }).click();
  await expect(visitor.getByRole('heading', { name: 'Enter the workshop.' })).toBeVisible();
  await expect(visitor.getByRole('textbox', { name: /^Your name\b/ })).toHaveValue('');
  await visitorContext.close();
});
