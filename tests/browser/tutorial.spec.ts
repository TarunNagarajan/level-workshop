import { test, expect } from '@playwright/test';
import { signInOwner } from './auth';

test('first visit tour navigates the real interface, persists completion and can be reopened', async ({ page, request }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await signInOwner(request);
  // Use a new invited identity so each browser workflow keeps its own preference.
  const invite = await request.post('/api/workshop-links', { data: {} });
  const { path } = await invite.json();
  const context = await page.context().browser()!.newContext(); const colleague = await context.newPage();
  colleague.on('pageerror', error => errors.push(error.message));
  await colleague.goto('http://127.0.0.1:4318' + path);
  await colleague.getByRole('textbox', { name: /^Your name\b/ }).fill('First-time author');
  await colleague.getByRole('button', { name: 'Enter workshop' }).click();
  await expect(colleague.getByRole('heading', { name: 'Find your way around.' })).toBeVisible();
  await colleague.screenshot({ animations: 'disabled', path: 'verification/tutorial-intro.png' });
  await colleague.getByRole('button', { name: 'Show me around' }).click();
  const titles = ['Start with a level.', 'Set the scene.', 'Give the target its instructions.', 'Save a version, then test it.', 'Review what happened.', 'Work with your team.'];
  for (let i = 0; i < titles.length; i++) {
    await expect(colleague.getByRole('heading', { name: titles[i], exact: true })).toBeVisible();
    await expect(colleague.getByTestId('tour-highlight')).toBeVisible();
    if (i === 2) { await expect(colleague.getByRole('tab', { name: 'Instructions' })).toHaveAttribute('aria-selected', 'true'); await colleague.screenshot({ animations: 'disabled', path: 'verification/tutorial-instructions.png' }); }
    if (i === 3) {
      await colleague.getByRole('button', { name: 'Back', exact: true }).click();
      await expect(colleague.getByRole('heading', { name: titles[2] })).toBeVisible();
      await colleague.getByRole('button', { name: 'Next', exact: true }).click();
    }
    await colleague.getByRole('button', { name: i === titles.length - 1 ? 'Finish tour' : 'Next', exact: true }).click();
  }
  await expect(colleague.getByRole('dialog')).toHaveCount(0);
  await colleague.reload(); await expect(colleague.getByRole('heading', { name: /^Levels/ })).toBeVisible();
  await expect(colleague.getByRole('dialog')).toHaveCount(0);
  await colleague.getByRole('button', { name: 'Quick tour', exact: true }).click();
  await colleague.setViewportSize({ width: 390, height: 844 });
  await colleague.getByRole('button', { name: 'Show me around' }).click();
  await colleague.screenshot({ animations: 'disabled', path: 'verification/tutorial-mobile.png' });
  expect(await colleague.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await colleague.keyboard.press('Escape'); await expect(colleague.getByRole('dialog')).toHaveCount(0);
  expect(errors).toEqual([]); await context.close();
});

