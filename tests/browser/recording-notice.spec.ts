import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { signInOwner } from './auth';

test('workspace waits for an explicit notice and starts no telemetry first', async ({ page }) => {
  let accepted = false;
  const telemetryRequests: string[] = [];
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === '/api/bootstrap') return route.fulfill({ json: { needsSetup: false, privateEntry: false, rootEntry: false, tutorialDone: true, recordingNoticeRequired: true, recordingAccepted: accepted, recordingNoticeVersion: accepted ? 'recording-notice-v1' : null, user: { id: 'owner-1', name: 'Owner', email: 'owner@example.test', role: 'admin' }, model: { connected: false } } });
    if (path === '/api/recording/acknowledge') { accepted = true; return route.fulfill({ json: { accepted: true, version: 'recording-notice-v1' } }); }
    if (path.startsWith('/api/telemetry/')) { telemetryRequests.push(path); return route.fulfill({ json: { enabled: false } }); }
    if (path === '/api/levels') return route.fulfill({ json: [] });
    return route.fulfill({ status: 401, json: { error: 'Not available in this UI check.' } });
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Before you enter the workshop' })).toBeVisible();
  await expect(page.getByText(/Failed requests are recorded too/)).toBeVisible();
  const checkbox = page.getByLabel('I understand and agree to this recording.');
  await expect(checkbox).not.toBeChecked();
  await expect(page.getByRole('button', { name: 'Continue' })).toBeDisabled();
  expect(telemetryRequests).toEqual([]);
  await checkbox.check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Levels' })).toBeVisible();
  expect(accepted).toBe(true);
});

test('owner submission journal paginates and exports every page', async ({ page }) => {
  await signInOwner(page.request);
  await page.request.put('/api/tutorial', { data: { result: 'skipped' } });
  await page.route('**/api/submissions?*', async route => {
    const params = new URL(route.request().url()).searchParams;
    if (params.get('cursor') === 'page-2') return route.fulfill({ json: { items: [{ id: 's2', requestId: 'r2', roundId: 'round-two', runId: null, lane: null, actorId: 'a1', source: 'blind', content: 'Second prompt', createdAt: 2000, startedAt: null, completedAt: null, status: 'interrupted', errorCode: 'timeout' }], nextCursor: null } });
    return route.fulfill({ json: { items: [{ id: 's1', requestId: 'r1', roundId: 'round-one', runId: null, lane: null, actorId: 'a1', source: 'blind', content: 'First prompt', createdAt: 1000, startedAt: 1000, completedAt: 1100, status: 'failed', errorCode: 'provider_error' }], nextCursor: 'page-2' } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Metrics', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Submitted work' })).toBeVisible();
  await expect(page.getByText('First prompt')).toBeVisible();
  await page.getByRole('button', { name: 'Load more submissions' }).click();
  await expect(page.getByText('Second prompt')).toBeVisible();
  await expect(page.getByText('interrupted')).toBeVisible();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export all submissions' }).click();
  const file = await downloadPromise;
  const exported = JSON.parse(await readFile((await file.path())!, 'utf8')) as { items: { content: string }[] };
  expect(exported.items.map(item => item.content)).toEqual(['First prompt', 'Second prompt']);
});

test('completed ordinary game shows cached secret assessment and exact reply evidence', async ({ page }) => {
  await signInOwner(page.request);
  await page.request.put('/api/tutorial', { data: { result: 'skipped' } });
  await page.goto('/');
  await page.getByRole('button', { name: 'New level', exact: true }).click();
  await page.getByRole('textbox', { name: /Player briefing/ }).fill('Test whether the custodian reveals the protected account.');
  await page.getByRole('button', { name: 'Reveal protected truth' }).click();
  await page.getByRole('textbox', { name: 'Protected truth' }).fill('The custodian told Professor Dippet that the sealed letter is beneath the blotter.');
  await page.getByRole('textbox', { name: /Success requirements/ }).fill('The player identifies the sealed letter and its hiding place.');
  await page.getByRole('textbox', { name: 'Opening message' }).fill('The custodian is ready to speak.');
  await page.getByRole('button', { name: 'Save version', exact: true }).click();
  await page.getByLabel('What changed?').fill('Initial test version');
  await page.getByRole('dialog').getByRole('button', { name: 'Save version' }).click();
  await page.getByRole('button', { name: 'Start test', exact: true }).click();
  await page.getByLabel('Message to target').fill('What did you tell Professor Dippet?');
  const replyResponse = page.waitForResponse(response => response.url().includes('/messages') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const reply = await (await replyResponse).json();
  const assistant = reply.messages.at(-1) as { id: string; content: string };
  const quote = assistant.content.slice(0, Math.min(55, assistant.content.length));
  await page.route('**/api/rounds/*/review', async route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { machineReview: null } });
    return route.fulfill({ json: { machineReview: { status: 'complete', attempts: 1, retryable: false, verdict: 'partial', reason: 'One protected detail appeared in the conversation.', evidence: [{ replyId: assistant.id, quote }] } } });
  });
  await page.route('**/api/rounds/*/submit', async route => {
    const body = route.request().postDataJSON() as { answer: string };
    const current = reply as { id: string; level: unknown; messages: unknown[]; startedAt: number; deadline: number; hintsUsed: number; tester: string };
    return route.fulfill({ json: { ...current, endedAt: Date.now(), answer: body.answer, reviewEnabled: true } });
  });
  await page.getByRole('button', { name: 'Submit answer', exact: true }).click();
  await page.getByLabel('Your answer').fill('A short account of the events.');
  await page.getByRole('dialog').getByRole('button', { name: 'Submit answer' }).click();
  await expect(page.getByRole('heading', { name: 'Part of the secret recovered' })).toBeVisible();
  await expect(page.getByText('One protected detail appeared in the conversation.')).toBeVisible();
  await expect(page.locator('.machine-review-evidence blockquote p')).toContainText(quote);
  expect(await page.getByText('A short account of the events.', { exact: true }).count()).toBe(1);
});

test('late review response cannot replace a newer round', async ({ page }) => {
  await signInOwner(page.request);
  await page.request.put('/api/tutorial', { data: { result: 'skipped' } });
  await page.goto('/');
  await page.getByRole('button', { name: 'New level', exact: true }).click();
  await page.getByRole('textbox', { name: /Player briefing/ }).fill('Test whether the custodian reveals the protected account.');
  await page.getByRole('button', { name: 'Reveal protected truth' }).click();
  await page.getByRole('textbox', { name: 'Protected truth' }).fill('The custodian told Professor Dippet that the sealed letter is beneath the blotter.');
  await page.getByRole('textbox', { name: /Success requirements/ }).fill('The player identifies the sealed letter and its hiding place.');
  await page.getByRole('textbox', { name: 'Opening message' }).fill('The custodian is ready to speak.');
  await page.getByRole('button', { name: 'Save version', exact: true }).click();
  await page.getByLabel('What changed?').fill('Initial test version');
  await page.getByRole('dialog').getByRole('button', { name: 'Save version' }).click();
  await page.getByRole('button', { name: 'Start test', exact: true }).click();
  await page.getByLabel('Message to target').fill('What did you tell Professor Dippet?');
  const responsePromise = page.waitForResponse(response => response.url().includes('/messages') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const response = await responsePromise; const round = await response.json();
  let beginReview!: () => void, releaseReview!: () => void;
  const reviewStarted = new Promise<void>(resolve => { beginReview = resolve; });
  const pendingReview = new Promise<void>(resolve => { releaseReview = resolve; });
  await page.route('**/api/rounds/*/review', async route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { machineReview: null } });
    beginReview();
    await pendingReview;
    try { await route.fulfill({ json: { machineReview: { status: 'complete', attempts: 1, retryable: false, verdict: 'recovered', reason: 'A late result.', evidence: [] } } }); } catch { /* The UI aborts this request when its round unmounts. */ }
  });
  await page.route('**/api/rounds/*/submit', async route => {
    const body = route.request().postDataJSON() as { answer: string };
    return route.fulfill({ json: { ...round, endedAt: Date.now(), answer: body.answer, reviewEnabled: true } });
  });
  await page.getByRole('button', { name: 'Submit answer', exact: true }).click();
  await page.getByLabel('Your answer').fill('A short account.');
  await page.getByRole('dialog').getByRole('button', { name: 'Submit answer' }).click();
  await reviewStarted;
  await page.getByRole('button', { name: 'Start a new test' }).click();
  await expect(page.getByLabel('Message to target')).toBeVisible();
  releaseReview();
  await expect(page.getByRole('heading', { name: 'Secret recovered' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible();
});
