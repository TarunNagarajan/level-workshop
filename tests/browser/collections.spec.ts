import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { signInOwner } from './auth';

const referenceLevelId = 'reference-passport-desk';

function collectBrowserErrors(page: import('@playwright/test').Page) {
  const errors: string[] = [];
  let rateLimitedResponses = 0;
  page.on('pageerror', error => errors.push(`pageerror: ${error.message}`));
  page.on('console', message => {
    if (message.type() !== 'error') return;
    if (/status of 429 \(Too Many Requests\)/.test(message.text())) return;
    errors.push(`console: ${message.text()}`);
  });
  page.on('response', response => { if (response.status() === 429) rateLimitedResponses += 1; });
  return { errors, get rateLimitedResponses() { return rateLimitedResponses; } };
}

test('owner can freeze a reference collection, recover a blind session after pause, review and export it', async ({ page, browser }) => {
  const authorErrors = collectBrowserErrors(page);
  await signInOwner(page.request);
  await page.request.put('/api/tutorial', { data: { result: 'skipped' } });
  await page.goto(`/collections/new?levelId=${referenceLevelId}&versionId=reference-passport-desk-v1`);
  await expect(page.getByRole('heading', { name: 'Set up a collection' })).toBeVisible();
  await expect(page.getByText('8 of 12 profiles')).toBeVisible();

  const profileId = page.getByLabel('Stable ID').nth(1);
  await profileId.fill('standard-proof');
  await expect(profileId).toHaveValue('standard-proof');
  expect(await profileId.evaluate(element => element === document.activeElement)).toBe(true);
  await profileId.fill('');
  await expect(page.getByRole('button', { name: /Review and freeze/ })).toBeDisabled();
  await profileId.fill('standard-proof');
  await page.getByRole('button', { name: /Review and freeze/ }).click();
  await expect(page.getByRole('dialog', { name: 'Freeze this collection?' })).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Create frozen collection' }).click();
  await expect(page.getByRole('heading', { name: 'One last passenger' })).toBeVisible();
  await page.getByRole('button', { name: 'Open preview' }).click();
  await expect(page.getByRole('heading', { name: 'One last passenger' })).toBeVisible();
  await page.getByRole('button', { name: 'Open the counter' }).click();
  await page.getByLabel('Question the passenger').fill('Where did you get the passport?');
  await page.getByRole('button', { name: 'Send question' }).click();
  await expect(page.getByText('The passport belongs to my brother Elias. I am Noah.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Inspect profile request' }).click();
  await expect(page.getByRole('heading', { name: 'Recorded provider request' })).toBeVisible();
  await expect(page.locator('.request-code')).toContainText('Where did you get the passport?');
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await page.getByRole('button', { name: 'Back to collection' }).click();
  await expect(page.getByRole('button', { name: 'Create participant link' })).toBeVisible();
  await page.screenshot({ path: 'verification/collections-author-desktop.png', fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: 'Create participant link' }).click();
  const linkField = page.getByLabel('Participant link', { exact: true });
  await expect(linkField).toHaveValue(/\/collect\//);
  const participantUrl = await linkField.inputValue();

  const participantContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const participant = await participantContext.newPage();
  const participantErrors = collectBrowserErrors(participant);
  const admissionBodies: unknown[] = [];
  participant.on('request', request => {
    if (request.method() === 'POST' && /\/api\/collect\/[^/]+$/.test(request.url())) {
      try { admissionBodies.push(request.postDataJSON()); } catch { admissionBodies.push(null); }
    }
  });
  await participant.goto(participantUrl);
  await expect(participant.getByRole('heading', { name: /His documents are here/ })).toBeVisible();
  await participant.getByRole('textbox', { name: /^Your name\b/ }).fill('Collection participant');
  await participant.locator('.collection-consent input').first().check();
  await participant.getByRole('button', { name: 'Start recorded playthrough' }).click();
  await expect(participant.getByText('INTERVIEW IN PROGRESS', { exact: false })).toBeVisible();
  await expect.poll(() => admissionBodies.length).toBe(1);
  const firstBody = admissionBodies[0] as Record<string, unknown>;
  expect(Object.keys(firstBody).sort()).toEqual(['consent', 'startKey', 'tester']);
  expect(firstBody.startKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  expect(firstBody.tester).toBe('Collection participant');
  await participant.getByLabel('Question the passenger').fill('Whose passport is it?');
  await participant.getByRole('button', { name: 'Send question' }).click();
  await expect(participant.getByText('The passport belongs to my brother Elias. I am Noah.', { exact: true })).toBeVisible();
  await expect(participant.getByText(/Standard|Authority boundary|Task boundary/)).toHaveCount(0);
  await participant.screenshot({ path: 'verification/collections-participant-mobile.png', fullPage: true, animations: 'disabled' });

  await page.getByRole('button', { name: 'Pause admission' }).click();
  await expect(page.getByRole('button', { name: 'Resume admission' })).toBeVisible();
  await participant.reload();
  await expect(participant.getByText('INTERVIEW IN PROGRESS', { exact: false })).toBeVisible();
  await expect(participant.getByText('The passport belongs to my brother Elias. I am Noah.', { exact: true })).toBeVisible();
  await expect.poll(() => admissionBodies.length).toBe(2);
  expect(admissionBodies[1]).toEqual(firstBody);
  expect(await participant.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await participant.getByRole('button', { name: 'File finding' }).click();
  await participant.getByLabel('Your finding').fill('The passenger identified the passport as his brother’s.');
  await participant.getByRole('dialog').getByRole('button', { name: 'Stamp and file' }).click();
  await expect(participant.getByText('CASE FILED FOR REVIEW', { exact: true })).toBeVisible();

  await page.getByRole('tab', { name: 'Attempts' }).click();
  await page.getByRole('button', { name: /Collection participant/ }).click();
  await expect(page.getByText('Participant finding:')).toBeVisible();
  await expect(page.getByText('Inspect passport state and action trail')).toBeVisible();
  await page.getByLabel('Reviewer note').fill('Review the submitted finding against the passenger replies.');
  await expect(page.getByText('Provider request health')).toBeVisible();
  await page.getByRole('button', { name: 'Save review and labels' }).click();
  await page.getByRole('tab', { name: 'Comparison' }).click();
  await expect(page.getByText('1', { exact: true }).first()).toBeVisible();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download complete JSON' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^collection-.*\.json$/);
  const exported = JSON.parse(await readFile((await download.path())!, 'utf8')) as { trials: Array<Record<string, unknown>> };
  expect(exported.trials).toHaveLength(2);
  expect(exported.trials.map(trial => trial.source).sort()).toEqual(['participant', 'preview']);
  expect(JSON.stringify(exported)).not.toContain('Collection participant');
  expect(authorErrors.errors, 'author collection browser errors').toEqual([]);
  expect(participantErrors.errors, 'blind passport browser errors').toEqual([]);
  await participantContext.close();
});

test('copied collection keeps its pinned saved version when a newer source version exists', async ({ page }) => {
  const owner = await signInOwner(page.request);
  await page.request.put('/api/tutorial', { data: { result: 'skipped' } });
  const levels = await (await page.request.get('/api/levels')).json() as Array<{ id: string; ownerId: string; draft: { title: string } }>;
  const source = levels.find(level => level.ownerId === owner.user.id && level.id !== referenceLevelId && !/(passport|passenger|boarding|arrival|diary)/i.test(level.draft.title));
  expect(source, 'the test owner has a seeded scenario').toBeTruthy();
  const detailResponse = await page.request.get(`/api/levels/${source!.id}`);
  expect(detailResponse.ok()).toBe(true);
  const detail = await detailResponse.json() as { revision: number; versions: Array<{ id: string }> };
  const pinnedVersion = detail.versions.at(-1)!.id;
  const created = await page.request.post('/api/collections', { data: { levelId: source!.id, versionId: pinnedVersion } });
  expect(created.ok()).toBe(true);
  const collectionId = (await created.json()).id as string;
  const nextVersion = await page.request.post(`/api/levels/${source!.id}/versions`, { data: { revision: detail.revision, note: 'Newer version after frozen snapshot' } });
  expect(nextVersion.ok()).toBe(true);

  await page.goto(`/collections/new?from=${encodeURIComponent(collectionId)}`);
  await expect(page.getByRole('heading', { name: 'Set up a collection' })).toBeVisible();
  await expect(page.getByLabel('Saved version')).toHaveValue(pinnedVersion);
  await expect(page.getByLabel('Saved version').locator('option').filter({ hasText: 'Newer version after frozen snapshot' })).toHaveCount(1);
});

test('copied collection keeps its pinned version when the initial level detail response arrives late', async ({ page }) => {
  const owner = await signInOwner(page.request);
  await page.request.put('/api/tutorial', { data: { result: 'skipped' } });
  const levels = await (await page.request.get('/api/levels')).json() as Array<{ id: string; ownerId: string; draft: { title: string } }>;
  const owned = levels.filter(level => level.ownerId === owner.user.id && level.id !== referenceLevelId);
  expect(owned.length).toBeGreaterThan(1);
  const defaultLevel = owned[0];
  const source = owned[1];
  const detail = await (await page.request.get(`/api/levels/${source.id}`)).json() as { versions: Array<{ id: string }> };
  const pinnedVersion = detail.versions.at(-1)!.id;
  const created = await page.request.post('/api/collections', { data: { levelId: source.id, versionId: pinnedVersion } });
  expect(created.ok()).toBe(true);
  const collectionId = (await created.json()).id as string;
  const update = await page.request.get(`/api/levels/${source.id}`);
  const latest = await update.json() as { revision: number };
  expect((await page.request.post(`/api/levels/${source.id}/versions`, { data: { revision: latest.revision, note: 'Later version' } })).ok()).toBe(true);

  let releaseDefault!: () => void;
  let defaultDetailRequested = false;
  const heldDefault = new Promise<void>(resolve => { releaseDefault = resolve; });
  await page.route(`**/api/levels/${defaultLevel.id}`, async route => {
    defaultDetailRequested = true;
    await heldDefault;
    await route.continue();
  });
  const sourceDetail = page.waitForResponse(response => response.url().includes(`/api/levels/${source.id}`) && response.request().method() === 'GET');
  await page.goto(`/collections/new?from=${encodeURIComponent(collectionId)}&levelId=${defaultLevel.id}`);
  await expect(page.getByRole('heading', { name: 'Set up a collection' })).toBeVisible();
  await sourceDetail;
  if (defaultDetailRequested) releaseDefault();
  await expect(page.getByLabel('Scenario')).toHaveValue(source.id);
  await expect(page.getByLabel('Saved version')).toHaveValue(pinnedVersion);
});

test('generic blind participants stay private and complete exports page beyond 200 attempts', async ({ page, browser }) => {
  test.setTimeout(120000);
  const owner = await signInOwner(page.request);
  await page.request.put('/api/tutorial', { data: { result: 'skipped' } });
  const levels = await (await page.request.get('/api/levels')).json() as Array<{ id: string; ownerId: string; draft: { title: string } }>;
  const source = levels.find(level => level.ownerId === owner.user.id && level.id !== referenceLevelId && !/(passport|passenger|boarding|arrival|diary)/i.test(level.draft.title));
  expect(source, 'the test owner has a seeded conversation scenario').toBeTruthy();
  const detailResponse = await page.request.get(`/api/levels/${source!.id}`);
  const detail = await detailResponse.json() as { versions: Array<{ id: string }> };
  const created = await page.request.post('/api/collections', { data: { levelId: source!.id, versionId: detail.versions[0].id } });
  expect(created.ok()).toBe(true);
  const collectionId = (await created.json()).id as string;
  const linkResponse = await page.request.post(`/api/collections/${collectionId}/links`, { data: {} });
  expect(linkResponse.ok()).toBe(true);
  const linkPath = (await linkResponse.json()).path as string;
  const token = linkPath.split('/').filter(Boolean).at(-1)!;

  for (let index = 0; index < 201; index += 1) {
    const admission = await page.request.post(`/api/collect/${token}`, { data: { tester: `Export sample ${String(index).padStart(3, '0')}`, consent: true, startKey: crypto.randomUUID() } });
    expect(admission.ok(), `sample admission ${index}`).toBe(true);
  }

  const participantContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const participant = await participantContext.newPage();
  const participantErrors = collectBrowserErrors(participant);
  const bootstrapRequests: string[] = [];
  participant.on('request', request => { if (request.url().includes('/api/bootstrap')) bootstrapRequests.push(request.url()); });
  const apiBodies: string[] = [];
  participant.on('response', async response => {
    if (!response.url().includes('/api/collect/')) return;
    try { apiBodies.push(await response.text()); } catch { /* body may be unavailable after navigation */ }
  });
  await participant.goto(linkPath);
  await expect(participant.getByRole('heading', { name: source!.draft.title, exact: true })).toBeVisible();
  await participant.getByRole('textbox', { name: /^Your name\b/ }).fill('Generic blind participant');
  await participant.getByLabel(/Your submitted prompts, model replies, actions, findings and timing data/).check();
  await participant.getByRole('button', { name: 'Start playthrough' }).click();
  await participant.getByLabel('Message to target').fill('A fixed UI check. [fixture:rate-limit-once]');
  await participant.getByRole('button', { name: 'Send message' }).click();
  await expect(participant.getByRole('alert')).toContainText(/could not|failed|failure|temporarily/i);
  await participant.getByRole('button', { name: 'Send message' }).click();
  await expect(participant.locator('.conversation')).toContainText(/I expected the matter to be resolved|matter to be resolved/);
  expect(bootstrapRequests).toHaveLength(0);
  expect(apiBodies.join('\n')).not.toMatch(/compiledPrompt|profileLabel|additionalInstructions|baseUrl|provider|protected truth/i);
  expect(await participant.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await page.goto(`/collections/${collectionId}`);
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download complete JSON' }).click();
  const download = await downloadPromise;
  const exported = JSON.parse(await readFile((await download.path())!, 'utf8')) as { trials: Array<Record<string, unknown>> };
  expect(exported.trials).toHaveLength(202);
  expect(JSON.stringify(exported)).not.toContain('Export sample 000');
  expect(JSON.stringify(exported)).not.toContain('Generic blind participant');
  await expect(page.getByText(/Complete: 202 attempts exported/)).toBeVisible();
  await page.getByRole('tab', { name: 'Attempts' }).click();
  await page.getByRole('button', { name: /Generic blind participant/ }).click();
  await expect(page.getByText('Provider request health')).toBeVisible();
  await expect(page.getByText('rate_limited')).toBeVisible();
  await expect(page.getByText(/saved/)).toBeVisible();
  expect(participantErrors.errors, 'generic blind participant browser errors').toEqual([]);
  expect(participantErrors.rateLimitedResponses, 'expected deterministic fixture rate limit').toBe(1);
  await participantContext.close();
});

test('a new workshop member can create a collection from the reference desk', async ({ page, browser }) => {
  await signInOwner(page.request);
  const invitation = await page.request.post('/api/workshop-links', { data: {} });
  expect(invitation.ok()).toBe(true);
  const invitePath = (await invitation.json()).path as string;
  const memberContext = await browser.newContext();
  const member = await memberContext.newPage();
  await member.goto(invitePath);
  await member.getByRole('textbox', { name: /^Your name\b/ }).fill('Collection author');
  await member.getByRole('button', { name: 'Enter workshop' }).click();
  await member.request.put('/api/tutorial', { data: { result: 'skipped' } });
  await member.reload();
  await member.goto(`/collections/new?levelId=${referenceLevelId}&versionId=reference-passport-desk-v1`);
  await expect(member.getByRole('heading', { name: 'Set up a collection' })).toBeVisible();
  await member.getByRole('button', { name: /Review and freeze/ }).click();
  await member.getByRole('dialog').getByRole('button', { name: 'Create frozen collection' }).click();
  await expect(member.getByRole('heading', { name: 'One last passenger' })).toBeVisible();
  await memberContext.close();
});
