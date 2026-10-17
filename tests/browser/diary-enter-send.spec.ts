import { test, expect } from '@playwright/test';
import { signInOwner } from './auth';

async function signInIsolatedDiaryEditor(request: Parameters<typeof signInOwner>[0], label: string) {
  await signInOwner(request);
  const invitation = await request.post('/api/invites', { data: {} });
  expect(invitation.ok()).toBe(true);
  const { path } = await invitation.json() as { path: string };
  const token = path.split('/').at(-1);
  expect(token).toBeTruthy();
  const joined = await request.post(`/api/invite/${token}`, { data: {
    name: label,
    email: `diary-${crypto.randomUUID()}@example.test`,
    password: 'diary-editor-verification-password',
  } });
  expect(joined.ok()).toBe(true);
  const acknowledged = await request.post('/api/recording/acknowledge', { data: { version: 'recording-notice-v1', accepted: true } });
  expect(acknowledged.ok()).toBe(true);
}

test.describe('diary keyboard submission', () => {
  test.use({ baseURL: 'http://127.0.0.1:4323' });

  test('Enter submits once, Shift+Enter keeps a newline, and unavailable sends stay blocked', async ({ page }) => {
    await signInIsolatedDiaryEditor(page.request, 'Diary keyboard test');
    const start = await page.request.post('/api/diary/start', { data: { profileId: 'story' } });
    expect(start.ok()).toBe(true);
    const { round } = await start.json();
    const question = 'What did you see?\nWhat did you tell Dumbledore?';
    const unknownQuestion = 'Check this uncertain receipt.';
    const payloads: Array<{ content: string; requestId: string }> = [];
    let releaseFirst!: () => void;
    let signalFirst!: () => void;
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    const firstRequestSeen = new Promise<void>(resolve => { signalFirst = resolve; });
    await page.route(`**/api/rounds/${round.id}/messages`, async route => {
      if (route.request().method() !== 'POST') return route.continue();
      const payload = route.request().postDataJSON() as { content: string; requestId: string };
      payloads.push(payload);
      if (payload.content === question) {
        signalFirst();
        await firstGate;
        return route.continue();
      }
      if (payload.content === unknownQuestion) return route.abort('failed');
      return route.continue();
    });

    await page.goto('/diary');
    await page.getByRole('button', { name: 'Open the diary', exact: true }).click();
    const composer = page.getByLabel('Ask the diary');
    await expect(composer).toBeEnabled();
    await composer.press('Enter');
    await expect(composer).toHaveValue('');
    expect(payloads).toHaveLength(0);

    await composer.fill('What did you see?');
    await composer.press('Shift+Enter');
    await composer.type('What did you tell Dumbledore?');
    await expect(composer).toHaveValue(question);
    const keyBehavior = await composer.evaluate(element => {
      const dispatch = (init: KeyboardEventInit) => {
        const event = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true, ...init });
        element.dispatchEvent(event);
        return event.defaultPrevented;
      };
      return {
        composing: dispatch({ isComposing: true }),
        legacyComposing: dispatch({ keyCode: 229 }),
        repeated: dispatch({ repeat: true }),
        modified: [dispatch({ ctrlKey: true }), dispatch({ altKey: true }), dispatch({ metaKey: true })],
      };
    });
    expect(keyBehavior).toEqual({ composing: false, legacyComposing: false, repeated: true, modified: [false, false, false] });
    expect(payloads).toHaveLength(0);

    const savedReply = page.waitForResponse(response => response.url().includes(`/api/rounds/${round.id}/messages`) && response.request().method() === 'POST' && response.ok());
    await composer.press('Enter');
    await firstRequestSeen;
    expect(payloads).toHaveLength(1);
    expect(payloads[0].content).toBe(question);
    await expect(page.getByRole('button', { name: 'Send question' })).toBeDisabled();
    await composer.press('Enter');
    expect(payloads).toHaveLength(1);
    await expect(composer).toHaveValue(question);
    releaseFirst();
    await savedReply;
    await expect(composer).toHaveValue('');

    await composer.fill(unknownQuestion);
    await composer.press('Enter');
    await expect(page.getByRole('button', { name: 'Check previous submission' })).toBeVisible();
    expect(payloads).toHaveLength(2);
    await composer.press('Enter');
    expect(payloads).toHaveLength(2);
    await expect(composer).toHaveValue(unknownQuestion);
  });

  test('a new reply follows from its beginning and manual browsing during a wait offers a return', async ({ page }) => {
    await signInIsolatedDiaryEditor(page.request, 'Diary pagination test');
    const start = await page.request.post('/api/diary/start', { data: { profileId: 'story' } });
    expect(start.ok()).toBe(true);
    const { round } = await start.json();
    const firstPrompt = 'Tell me what you remember.';
    const secondPrompt = 'And what did you say next?';
    const firstReply = `First saved reply. ${'The first account continues in careful, legible sentences across the open pages. '.repeat(90)}`;
    const secondReply = `Second saved reply. ${'The later answer should begin here, while the earlier pages remain available to read. '.repeat(80)}`;
    let requestNumber = 0;
    const replyTextById = new Map<string, string>();
    let releaseSecond!: () => void;
    let signalSecond!: () => void;
    const secondGate = new Promise<void>(resolve => { releaseSecond = resolve; });
    const secondRequestSeen = new Promise<void>(resolve => { signalSecond = resolve; });
    await page.route(`**/api/rounds/${round.id}/messages`, async route => {
      if (route.request().method() !== 'POST') return route.continue();
      const payload = route.request().postDataJSON() as { content: string };
      requestNumber += 1;
      if (payload.content === secondPrompt) { signalSecond(); await secondGate; }
      const response = await route.fetch();
      const body = await response.json() as { messages: Array<{ id: string; role: string; opening?: boolean; content: string }> };
      const assistant = [...body.messages].reverse().find(item => item.role === 'assistant' && !item.opening);
      if (assistant) replyTextById.set(assistant.id, [firstReply, secondReply][requestNumber - 1]);
      for (const item of body.messages) if (replyTextById.has(item.id)) item.content = replyTextById.get(item.id)!;
      await route.fulfill({ response, json: body });
    });

    await page.goto('/diary');
    await page.getByRole('button', { name: 'Open the diary', exact: true }).click();
    const composer = page.getByLabel('Ask the diary');
    await composer.fill(firstPrompt);
    await composer.press('Enter');
    await expect(page.locator('.diary-page [data-message-id]').filter({ hasText: 'First saved reply.' }).first()).toBeVisible();
    const firstReplyId = await page.locator('.diary-page [data-message-id]').filter({ hasText: 'First saved reply.' }).first().getAttribute('data-message-id');
    await expect(page.locator(`.diary-page [data-message-id="${firstReplyId}"][data-offset-start="0"]`).first()).toBeVisible();

    await page.setViewportSize({ width: 390, height: 600 });
    await expect(page.locator(`.diary-page.mobile-page-current [data-message-id="${firstReplyId}"][data-offset-start="0"]`)).toBeVisible();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await expect(page.locator(`.diary-page [data-message-id="${firstReplyId}"][data-offset-start="0"]`).first()).toBeVisible();

    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await composer.fill(secondPrompt);
    const secondSaved = page.waitForResponse(response => response.url().includes(`/api/rounds/${round.id}/messages`) && response.request().method() === 'POST');
    await composer.press('Enter');
    await secondRequestSeen;
    await expect(page.getByText('Sending your question…')).toBeVisible();
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    const browsedPageAnchor = await page.locator('.diary-page-left [data-message-id]').first().getAttribute('data-message-id');
    releaseSecond();
    const secondResponse = await secondSaved;
    expect(secondResponse.status()).toBe(200);
    await expect(page.getByRole('button', { name: 'New reply ready: view reply' })).toBeVisible();
    await expect(page.locator('.diary-page [data-message-id]').filter({ hasText: 'Second saved reply.' })).toHaveCount(0);
    await expect(page.locator(`.diary-page [data-message-id="${browsedPageAnchor}"]`).first()).toBeVisible();
    await page.getByRole('button', { name: 'New reply ready: view reply' }).click();
    const secondSegment = page.locator('.diary-page [data-message-id]').filter({ hasText: 'Second saved reply.' }).first();
    await expect(secondSegment).toBeVisible();
    const secondReplyId = await secondSegment.getAttribute('data-message-id');
    await expect(page.locator(`.diary-page [data-message-id="${secondReplyId}"][data-offset-start="0"]`).first()).toBeVisible();
    await page.setViewportSize({ width: 390, height: 600 });
    await expect(page.locator(`.diary-page.mobile-page-current [data-message-id="${secondReplyId}"][data-offset-start="0"]`)).toBeVisible();
    expect(requestNumber).toBe(2);
  });
});
