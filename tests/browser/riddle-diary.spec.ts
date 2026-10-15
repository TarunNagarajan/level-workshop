import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { signInOwner } from './auth';

test.describe('Riddle diary scene', () => {
  test.use({ baseURL: 'http://127.0.0.1:4323' });
  test.beforeAll(async () => { await mkdir('verification', { recursive: true }); });

  test('opens objects, saves a reply, and remains usable on a narrow screen', async ({ page }) => {
    await signInOwner(page.request);
    expect((await (await page.request.get('/api/diary')).json()).reviewEnabled).toBe(true);
    let practiceModelRequests = 0;
    page.on('request', request => { if (request.url().includes('/messages') && request.method() === 'POST') practiceModelRequests++; });
    await page.goto('/diary');
    await expect(page.getByRole('heading', { name: 'A memory in ink.' })).toBeVisible();
    await expect(page.getByText(/Practice example, not sent/)).toBeVisible();
    expect(practiceModelRequests).toBe(0);
    await expect(page.getByRole('main')).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Skip tour' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Begin Story' }).click();
    await page.getByRole('button', { name: 'Open the diary', exact: true }).click();
    await expect(page.getByLabel('Recent diary entries')).toBeVisible();

    await page.getByRole('button', { name: /Aligned memory fragment|Memory fragment/ }).click();
    await page.getByRole('button', { name: /Align the fragments/ }).click();
    await expect(page.getByText(/confidence that the matter would be settled/i)).toBeVisible();
    await expect(page.getByRole('img', { name: /earlier assurance comes first/i })).toBeVisible();
    await page.screenshot({ path: 'verification/riddle-diary-fragment-desktop.png', fullPage: false, animations: 'disabled' });
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Memory fragment' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Memory fragment/ })).toBeFocused();
    await page.getByRole('button', { name: /Dippet's reply/ }).click();
    await page.keyboard.press('Shift+Tab');
    await expect(page.getByRole('button', { name: 'Done' })).toBeFocused();
    await page.getByRole('button', { name: /Unfold the letter/ }).click();
    await expect(page.getByText(/If Hogwarts closes/i)).toBeVisible();
    await page.getByRole('button', { name: 'Done' }).click();

    let sentReplyId = '';
    let reviewPosts = 0;
    let reviewResult: unknown = null;
    await page.route('**/api/rounds/*/review', async route => {
      if (route.request().method() === 'GET') return route.fulfill({ json: { machineReview: reviewResult } });
      reviewPosts++;
      reviewResult = { status: 'complete', attempts: 1, retryable: false, verdict: 'partial', reason: 'Riddle described his planned timing in a saved reply.', evidence: [{ replyId: sentReplyId, quote: 'I expected the matter to be resolved before the night was over.' }] };
      return route.fulfill({ json: { machineReview: reviewResult } });
    });
    const question = '[fixture:rate-limit-once] What did you tell Professor Dippet?';
    await page.getByLabel('Write a question').fill(question);
    await page.getByRole('button', { name: 'Send question' }).click();
    await expect(page.getByRole('alert').filter({ hasText: /confirmed this prompt was saved/ })).toBeVisible();
    await expect(page.getByLabel('Write a question')).toHaveValue(question);
    const replyResponse = page.waitForResponse(response => response.url().includes('/messages') && response.request().method() === 'POST' && response.ok());
    await page.getByRole('button', { name: 'Send question' }).click();
    const replyRound = await (await replyResponse).json();
    sentReplyId = [...replyRound.messages].reverse().find((item: { role: string; opening?: boolean }) => item.role === 'assistant' && !item.opening).id;
    await expect(page.locator('.diary-ink-text').filter({ hasText: /I expected the matter to be resolved before the night was over/i })).toBeVisible();
    await expect(page.locator('.diary-ink-word.is-writing').first()).toBeVisible();
    const inkDelays = await page.locator('.diary-ink-word.is-writing').evaluateAll(elements => elements.map(element => getComputedStyle(element).animationDelay));
    expect(new Set(inkDelays).size).toBeGreaterThan(1);
    await page.getByRole('button', { name: 'Show entire reply' }).click();
    await expect(page.getByRole('button', { name: 'Show entire reply' })).toHaveCount(0);
    await page.screenshot({ path: 'verification/riddle-diary-desktop.png', fullPage: true, animations: 'disabled' });
    await page.setViewportSize({ width: 390, height: 844 });
    const overflow = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, offenders: [...document.querySelectorAll<HTMLElement>('*')].filter(element => element.getBoundingClientRect().right > window.innerWidth + 1).slice(0, 8).map(element => ({ tag: element.tagName, className: element.className.toString().slice(0, 70), right: Math.round(element.getBoundingClientRect().right) })) }));
    expect(overflow.width <= 390, JSON.stringify(overflow)).toBe(true);
    const pageTextWidths = await page.locator('.diary-page.mobile-page-current .diary-entry p[aria-hidden="true"]').evaluateAll(items => items.map(element => { const paragraph = element.getBoundingClientRect(), page = element.closest('.diary-page-scroll')!.getBoundingClientRect(); return { client: element.clientWidth, scroll: element.scrollWidth, paragraphRight: Math.round(paragraph.right), pageRight: Math.round(page.right) }; }));
    expect(pageTextWidths.every(width => width.scroll <= width.client + 2 && width.paragraphRight <= width.pageRight + 2), JSON.stringify(pageTextWidths)).toBe(true);
    await page.getByRole('button', { name: 'Turn to recent entries' }).click();
    await expect(page.getByLabel('Recent diary entries')).toBeVisible();
    await page.screenshot({ path: 'verification/riddle-diary-mobile.png', fullPage: false, animations: 'disabled' });
    const artifactImages = await page.locator('.diary-artifact-image img').evaluateAll(images => images.map(image => ({ width: (image as HTMLImageElement).naturalWidth, height: (image as HTMLImageElement).naturalHeight })));
    expect(artifactImages.length).toBeGreaterThanOrEqual(2);
    expect(artifactImages.every(image => image.width > 0 && image.height > 0), JSON.stringify(artifactImages)).toBe(true);
    await page.getByRole('button', { name: /Dippet's reply/ }).click();
    await expect(page.getByRole('dialog', { name: "Dippet's reply" })).toBeVisible();
    await page.screenshot({ path: 'verification/riddle-diary-letter-mobile.png', fullPage: false, animations: 'disabled' });
    await page.getByRole('button', { name: 'Done' }).click();
    await page.getByRole('button', { name: 'Keep reply as evidence' }).click();
    await page.getByRole('button', { name: 'Write your finding' }).click();
    await page.screenshot({ path: 'verification/riddle-diary-filing-mobile.png', fullPage: false, animations: 'disabled' });
    await page.getByLabel('Your account').fill('Riddle had planned the accusation before the confrontation.');
    await page.getByLabel(/I expected the matter to be resolved/).check();
    const filedResponse = page.waitForResponse(response => response.url().includes('/diary/rounds/') && response.url().endsWith('/file') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'File finding' }).click();
    const filedPayload = await (await filedResponse).json();
    expect(filedPayload.round.endedAt).toBeTruthy();
    await expect(page.getByRole('heading', { name: 'The case is filed.' })).toBeVisible();
    await expect.poll(() => reviewPosts, { timeout: 10000 }).toBe(1);
    await expect(page.getByRole('heading', { name: 'Part of the secret recovered' })).toBeVisible();
    await expect(page.getByText('Riddle described his planned timing in a saved reply.')).toBeVisible();
    expect(reviewPosts).toBe(1);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Part of the secret recovered' })).toBeVisible();
    await expect(page.locator('.machine-review-evidence blockquote')).toContainText('I expected the matter to be resolved before the night was over.');
    await page.locator('.machine-review').scrollIntoViewIfNeeded();
    await page.screenshot({ path: 'verification/riddle-diary-ending-mobile.png', fullPage: false, animations: 'disabled' });
    expect(reviewPosts).toBe(1);
  });

  test('blind link requires a name and consent, resumes its private receipt, and stays isolated by browser', async ({ page, browser }) => {
    await signInOwner(page.request);
    const linkResponse = await page.request.post('/api/diary/links', { data: { profileId: 'story' } });
    expect(linkResponse.ok()).toBe(true);
    const blindPath = (await linkResponse.json()).path as string;
    const blindContext = await browser.newContext({ baseURL: 'http://127.0.0.1:4323' });
    const blind = await blindContext.newPage();
    try {
      await blind.goto(blindPath);
      await expect(blind.getByRole('textbox', { name: /^Your name\b/ })).toHaveValue('');
      const open = blind.getByRole('button', { name: 'Open the diary' });
      await expect(open).toBeDisabled();
      await expect(blind.getByRole('navigation', { name: 'Main navigation' })).toHaveCount(0);
      expect((await blind.request.get('/api/diary/latest')).status()).toBe(401);
      await blind.getByRole('textbox', { name: /^Your name\b/ }).fill('Blind Ink Tester');
      await blind.locator('.diary-recording-consent input').check();
      const startedResponse = blind.waitForResponse(response => response.url().includes('/api/diary/play/') && response.request().method() === 'POST');
      await open.click();
      const started = await (await startedResponse).json();
      const roundId = started.round.id as string;
      await expect(blind.getByRole('region', { name: 'Interactive diary session' })).toBeVisible();
      await blind.getByRole('button', { name: 'Open the diary', exact: true }).click();
      await blind.getByLabel('Write a question').fill('What did you tell Professor Dippet?');
      await blind.getByRole('button', { name: 'Send question' }).click();
      await expect(blind.locator('.diary-entry.from-diary').last()).toContainText('I expected the matter to be resolved');

      const secondContext = await browser.newContext({ baseURL: 'http://127.0.0.1:4323' });
      try {
        const second = await secondContext.newPage();
        await second.goto(blindPath);
        await expect(second.getByRole('heading', { name: 'A memory in ink.' })).toBeVisible();
        await expect(second.getByRole('textbox', { name: /^Your name\b/ })).toHaveValue('');
        await expect(second.getByLabel('Write a question')).toHaveCount(0);
      } finally { await secondContext.close(); }

      const resumed = blind.waitForResponse(response => response.url().endsWith(`/api/diary/rounds/${roundId}`) && response.request().method() === 'GET');
      await blind.reload();
      await resumed;
      await expect(blind.getByLabel('Write a question')).toHaveValue('');
      await expect(blind.locator('.diary-entry.from-reader')).toContainText('What did you tell Professor Dippet?');
      await expect(blind.locator('.diary-entry.from-diary').last()).toContainText('I expected the matter to be resolved');
      expect((await blind.request.get('/api/diary/latest')).status()).toBe(401);
    } finally { await blindContext.close(); }
  });

  test('reduced motion skips word reveal and an uncertain receipt retries its original prompt after expiry', async ({ page }) => {
    await signInOwner(page.request);
    await page.clock.install({ time: new Date() });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const startedResponse = await page.request.post('/api/diary/start', { data: { profileId: 'story' } });
    expect(startedResponse.ok()).toBe(true);
    const started = await startedResponse.json();
    const roundId = started.round.id as string;
    const original = 'What did you tell Professor Dippet?';
    const edited = 'A separate note for after the receipt is checked.';
    let attempts = 0;
    let firstPayload: { content: string; requestId: string } | null = null;
    await page.route(`**/api/rounds/${roundId}/messages`, async route => {
      if (route.request().method() !== 'POST') return route.continue();
      attempts++;
      const payload = route.request().postDataJSON() as { content: string; requestId: string };
      if (!firstPayload) {
        firstPayload = payload;
        const accepted = await route.fetch();
        expect(accepted.ok()).toBe(true);
        return route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: 'Fixture gateway lost the response.' }) });
      }
      expect(payload).toEqual(firstPayload);
      return route.continue();
    });
    await page.goto('/diary');
    await expect(page.getByRole('button', { name: 'Open the diary', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Open the diary', exact: true }).click();
    await page.getByLabel('Write a question').fill(original);
    await page.getByRole('button', { name: 'Send question' }).click();
    await expect(page.getByRole('button', { name: 'Check previous submission' })).toBeVisible();
    await expect(page.getByLabel('Write a question')).toHaveValue(original);
    await page.getByLabel('Write a question').fill(edited);
    await page.clock.fastForward(6 * 60 * 1000);
    await expect(page.getByRole('button', { name: 'Send question' })).toBeDisabled();
    await page.getByRole('button', { name: 'Check previous submission' }).click();
    await expect(page.getByRole('button', { name: 'Check previous submission' })).toHaveCount(0);
    await expect(page.getByLabel('Write a question')).toHaveValue(edited);
    await expect(page.locator('.diary-ink-word.is-writing')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Show entire reply' })).toHaveCount(0);
    expect(attempts).toBe(2);
    expect(firstPayload?.content).toBe(original);
  });
});
