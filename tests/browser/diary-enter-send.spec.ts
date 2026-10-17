import { test, expect } from '@playwright/test';
import { signInOwner } from './auth';

test.describe('diary keyboard submission', () => {
  test.use({ baseURL: 'http://127.0.0.1:4323' });

  test('Enter submits once, Shift+Enter keeps a newline, and unavailable sends stay blocked', async ({ page }) => {
    await signInOwner(page.request);
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
});
