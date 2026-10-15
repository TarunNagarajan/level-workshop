import { test, expect } from '@playwright/test';
import { signInOwner } from './auth';

test.use({ baseURL: 'http://127.0.0.1:4323' });

test('rotating passport reference serves an inspectable case without exposing its semantic ID or truth', async ({ page }) => {
  await signInOwner(page.request);
  await page.request.put('/api/tutorial', { data: { result: 'skipped' } });
  await page.goto('/reference');
  await page.getByRole('button', { name: 'Open the counter' }).click();
  const active = await (await page.request.get('http://127.0.0.1:4323/api/reference/active')).json();
  expect(active.round.versionId).toBe('reference-passport-case');
  expect(active.round.inspectionMode).toBe('documents');
  expect(JSON.stringify(active)).not.toContain('The passenger is travelling on their valid passport');

  await page.getByRole('button', { name: 'Inspect passport', exact: true }).click();
  await expect(page.getByRole('dialog').getByText('PQ 104 882', { exact: true })).toBeVisible();
  await page.getByLabel('Close dialog').click();
  await page.getByRole('button', { name: 'Inspect boarding pass', exact: true }).click();
  await expect(page.getByRole('dialog').getByText('PQ 104 228', { exact: true })).toBeVisible();
  const pageSources = await page.locator('script[src]').evaluateAll(nodes => nodes.map(node => (node as HTMLScriptElement).src));
  for (const src of pageSources) {
    const script = await (await page.request.get(src)).text();
    expect(script).not.toContain('The passenger is travelling on their valid passport');
    expect(script).not.toContain('reference-passport-case-ticket-number-swap');
  }
});
