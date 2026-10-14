import { test, expect } from '@playwright/test';
import { signInOwner } from './auth';

const referenceLevelId = 'reference-passport-desk';

test('owner can freeze a reference collection, recover a blind session after pause, review and export it', async ({ page, browser }) => {
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
  await page.getByRole('button', { name: 'Create participant link' }).click();
  const linkField = page.getByLabel('Participant link');
  await expect(linkField).toHaveValue(/\/collect\//);
  const participantUrl = await linkField.inputValue();

  const participantContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const participant = await participantContext.newPage();
  const admissionBodies: unknown[] = [];
  participant.on('request', request => {
    if (request.method() === 'POST' && /\/api\/collect\/[^/]+$/.test(request.url())) {
      try { admissionBodies.push(request.postDataJSON()); } catch { admissionBodies.push(null); }
    }
  });
  await participant.goto(participantUrl);
  await expect(participant.getByRole('heading', { name: /His documents are here/ })).toBeVisible();
  await participant.getByLabel('Your name').fill('Collection participant');
  await participant.getByLabel(/My name, typed questions, replies, actions/).check();
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

  await page.getByRole('button', { name: 'Pause admission' }).click();
  await expect(page.getByText('Paused', { exact: true })).toBeVisible();
  await participant.reload();
  await expect(participant.getByText('INTERVIEW IN PROGRESS', { exact: false })).toBeVisible();
  await expect(participant.getByText('The passport belongs to my brother Elias. I am Noah.', { exact: true })).toBeVisible();
  await expect.poll(() => admissionBodies.length).toBe(2);
  expect(admissionBodies[1]).toEqual(firstBody);
  expect(await participant.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await participant.getByRole('button', { name: 'File finding' }).click();
  await participant.getByLabel('Your finding').fill('The passenger identified the passport as his brother’s.');
  await participant.getByRole('dialog').getByRole('button', { name: 'Stamp and file' }).click();
  await expect(participant.getByText('CASE FILED', { exact: false })).toBeVisible();

  await page.getByRole('tab', { name: 'Attempts' }).click();
  await page.getByRole('button', { name: /Collection participant/ }).click();
  await expect(page.getByText('Participant finding:')).toBeVisible();
  await expect(page.getByText('Inspect passport state and action trail')).toBeVisible();
  await page.getByLabel('Reviewer note').fill('Review the submitted finding against the passenger replies.');
  await page.getByRole('button', { name: 'Save review and labels' }).click();
  await page.getByRole('tab', { name: 'Comparison' }).click();
  await expect(page.getByText('1', { exact: true }).first()).toBeVisible();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download complete JSON' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^collection-.*\.json$/);
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
  await member.getByLabel('Your name').fill('Collection author');
  await member.getByRole('button', { name: 'Enter workshop' }).click();
  const skipTour = member.getByRole('button', { name: 'Skip tour' });
  if (await skipTour.count()) await skipTour.click();
  await member.goto(`/collections/new?levelId=${referenceLevelId}&versionId=reference-passport-desk-v1`);
  await expect(member.getByRole('heading', { name: 'Set up a collection' })).toBeVisible();
  await member.getByRole('button', { name: /Review and freeze/ }).click();
  await member.getByRole('dialog').getByRole('button', { name: 'Create frozen collection' }).click();
  await expect(member.getByRole('heading', { name: 'One last passenger' })).toBeVisible();
  await memberContext.close();
});
