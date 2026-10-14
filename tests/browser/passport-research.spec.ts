import { test, expect } from '@playwright/test';
import { signInOwner } from './auth';

test('four local passport worlds expose the signature and UV result only after physical actions', async ({ page }) => {
  await signInOwner(page.request);
  await page.request.put('/api/tutorial', { data: { result: 'skipped' } });
  const initialConfigs: string[] = [];
  const versions = new Set<string>();
  for (const [id, signature, uvWord] of [
    ['match-intact', 'E. Vale', 'intact'],
    ['match-broken', 'E. Vale', 'broken'],
    ['mismatch-intact', 'N. Vale', 'intact'],
    ['mismatch-broken', 'N. Vale', 'broken'],
  ]) {
    const errors: string[] = [];
    const onError = (error: Error) => errors.push(error.message);
    page.on('pageerror', onError);
    const configurationResponse = page.waitForResponse(response => response.url().endsWith(`/api/reference/research/${id}`) && response.request().method() === 'GET');
    await page.goto(`/reference/research/${id}`);
    const configuration = await (await configurationResponse).json();
    initialConfigs.push(JSON.stringify(configuration));
    expect(configuration.documents.passport).toBeNull();
    expect(configuration.documents.card).toBeNull();
    expect(configuration.level.secret).toBeUndefined();
    await expect(page.getByText(`LOCAL RESEARCH · ${id.toUpperCase()}`)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Explore the design' })).toHaveCount(0);
    const startResponse = page.waitForResponse(response => response.url().endsWith(`/api/reference/research/${id}`) && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Open the counter' }).click();
    const started = await (await startResponse).json();
    versions.add(started.round.versionId);
    expect(started.round.versionId).toBe(`reference-passport-study-v1-${id}`);
    expect(started.documents.card).toBeNull();
    await page.getByRole('button', { name: 'Inspect passport', exact: true }).click();
    await expect(page.getByRole('dialog').getByText('E. Vale', { exact: true })).toBeVisible();
    await page.getByLabel('Close dialog').click();
    const cardResponse = page.waitForResponse(response => response.url().endsWith(`/api/reference/rounds/${started.round.id}/action`) && response.request().postDataJSON()?.action === 'card');
    await page.getByRole('button', { name: 'Request arrival card' }).click();
    const card = await (await cardResponse).json();
    expect(card.documents.card.signature).toBe(signature);
    await page.getByRole('button', { name: 'Inspect arrival card', exact: true }).click();
    await expect(page.getByRole('dialog').getByText(signature, { exact: true })).toBeVisible();
    await page.getByLabel('Close dialog').click();
    const lampResponse = page.waitForResponse(response => response.url().endsWith(`/api/reference/rounds/${started.round.id}/action`) && response.request().postDataJSON()?.action === 'lamp');
    await page.getByRole('button', { name: 'Toggle inspection lamp' }).click();
    const lamp = await (await lampResponse).json();
    expect(lamp.observation).toContain(uvWord);
    await expect(page.getByText(lamp.observation, { exact: true })).toBeVisible();
    if (id === 'match-broken' || id === 'mismatch-intact') await page.screenshot({ path: `verification/passport-research-${id}.png`, fullPage: true, animations: 'disabled' });
    await page.reload();
    await expect(page.getByText(`LOCAL RESEARCH · ${id.toUpperCase()}`)).toBeVisible();
    const restored = await (await page.request.get(`/api/reference/rounds/${started.round.id}`)).json();
    expect(restored.documents.card.signature).toBe(signature);
    expect(restored.state.lamp).toBe('uv');
    expect(errors).toEqual([]);
    page.off('pageerror', onError);
  }
  expect(new Set(initialConfigs).size).toBe(1);
  expect(versions.size).toBe(4);
  expect(await (await page.request.get('/api/reference/active')).json()).toBeNull();
});
