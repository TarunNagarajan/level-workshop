import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { signInOwner } from './auth';

async function diaryVerticalSpace(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const box = (selector: string) => {
      const element = document.querySelector(selector)!;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return { top: rect.top, bottom: rect.bottom, height: rect.height, minHeight: style.minHeight, overflowY: style.overflowY, flex: style.flex, position: style.position };
    };
    const bookStyle = getComputedStyle(document.querySelector('.diary-open-book')!);
    return {
      viewport: { width: innerWidth, height: innerHeight },
      book: box('.diary-open-book'), leftPage: box('.diary-page-left'), earlier: box('.diary-page-left .diary-page-scroll'),
      rightPage: box('.diary-page-right'), recent: box('.diary-page-right .diary-page-scroll'), composer: box('.diary-composer-wrap'),
      composerReserve: bookStyle.getPropertyValue('--diary-composer-height').trim(),
    };
  });
}

test.describe('Riddle diary scene', () => {
  test.use({ baseURL: 'http://127.0.0.1:4323' });
  test.beforeAll(async () => { await mkdir('verification', { recursive: true }); });

  test('opens objects, saves a reply, and remains usable on a narrow screen', async ({ page }) => {
    test.setTimeout(60000);
    await signInOwner(page.request);
    expect((await (await page.request.get('/api/diary')).json()).reviewEnabled).toBe(true);
    let practiceModelRequests = 0;
    let starts = 0;
    page.on('request', request => {
      if (request.url().includes('/messages') && request.method() === 'POST') practiceModelRequests++;
      if (request.url().endsWith('/api/diary/start') && request.method() === 'POST') starts++;
    });
    await page.goto('/diary');
    await expect(page.getByRole('heading', { name: 'A memory in ink.' })).toBeVisible();
    await expect(page.getByText(/HOGWARTS, 1943/)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Tom Riddle' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Hagrid' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Professor Dippet' })).toBeVisible();
    const contextCopy = await page.locator('.diary-prologue').innerText();
    expect(contextCopy).not.toMatch(/false accusation|scapegoat|orphanage|edited memory/i);
    expect(starts).toBe(0);
    await page.screenshot({ path: 'verification/riddle-diary-prologue-desktop.png', fullPage: false, animations: 'disabled' });
    expect(practiceModelRequests).toBe(0);
    await expect(page.getByRole('main')).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Skip tour' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Begin Story' }).click();
    expect(starts).toBe(1);
    await page.screenshot({ path: 'verification/riddle-diary-cover-desktop.png', fullPage: false, animations: 'disabled' });
    await page.setViewportSize({ width: 599, height: 844 });
    await page.screenshot({ path: 'verification/riddle-diary-cover-599.png', fullPage: false, animations: 'disabled' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: 'verification/riddle-diary-cover-390.png', fullPage: false, animations: 'disabled' });
    await page.setViewportSize({ width: 599, height: 844 });
    await page.getByRole('button', { name: 'Open the diary', exact: true }).click();
    await page.getByRole('button', { name: 'Story context' }).click();
    await expect(page.getByRole('dialog', { name: 'Story context' })).toBeVisible();
    const storyContrast = await page.getByRole('dialog', { name: 'Story context' }).locator(':scope > .eyebrow, :scope > h2, .diary-prologue-copy, .diary-prologue-copy > span, .diary-character-cards h2, .diary-character-cards p, .diary-paper-button').evaluateAll(elements => {
      const rgb = (color: string) => color.match(/[\d.]+/g)!.slice(0, 3).map(Number);
      const luminance = (color: number[]) => color.map(value => { const channel = value / 255; return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4; }).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
      const dialog = elements[0].closest('[role="dialog"]')!;
      const dialogBackground = rgb(getComputedStyle(dialog).backgroundColor);
      return elements.map(element => {
        let background = dialogBackground;
        for (let ancestor = element as HTMLElement; ancestor && ancestor !== dialog; ancestor = ancestor.parentElement!) {
          const candidate = getComputedStyle(ancestor).backgroundColor;
          if (!candidate.includes('rgba(0, 0, 0, 0)') && !candidate.endsWith(', 0)')) { background = rgb(candidate); break; }
        }
        const foreground = rgb(getComputedStyle(element).color);
        const [a, b] = [luminance(foreground), luminance(background)].sort((x, y) => y - x);
        return { className: (element as HTMLElement).className, contrast: (a + .05) / (b + .05) };
      });
    });
    expect(storyContrast.every(item => item.contrast >= 4.5), JSON.stringify(storyContrast)).toBe(true);
    expect(starts).toBe(1);
    expect(practiceModelRequests).toBe(0);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Story context' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Latest entry', exact: true }).click();
    await expect(page.locator('.diary-page.mobile-page-current')).toBeVisible();
    const mediumPageText = await page.locator('.diary-page.mobile-page-current .diary-entry p[aria-hidden="true"]').evaluateAll(items => items.map(element => { const paragraph = element as HTMLElement, page = element.closest('.diary-page-scroll') as HTMLElement; return { client: paragraph.clientWidth, scroll: paragraph.scrollWidth, paragraphRight: paragraph.getBoundingClientRect().right, textInset: page.getBoundingClientRect().right - paragraph.getBoundingClientRect().right }; }));
    expect(mediumPageText.every(width => width.scroll <= width.client + 2 && width.textInset >= 8), JSON.stringify(mediumPageText)).toBe(true);
    await page.screenshot({ path: 'verification/riddle-diary-open-599.png', fullPage: false, animations: 'disabled' });

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

    const preservedDraft = 'I would like to ask about the order of events.';
    await page.getByLabel('Ask the diary').fill(preservedDraft);
    const previousPage = page.getByRole('button', { name: 'Previous', exact: true });
    if (await previousPage.isEnabled()) await previousPage.click();
    await expect(page.getByLabel('Ask the diary')).toHaveValue(preservedDraft);
    await page.getByRole('button', { name: 'Latest entry', exact: true }).click();
    await expect(page.getByLabel('Ask the diary')).toHaveValue(preservedDraft);

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
    await page.getByLabel('Ask the diary').fill(question);
    await page.getByRole('button', { name: 'Send question' }).click();
    await expect(page.getByRole('alert').filter({ hasText: /confirmed this prompt was saved/ })).toBeVisible();
    await expect(page.getByLabel('Ask the diary')).toHaveValue(question);
    const replyResponse = page.waitForResponse(response => response.url().includes('/messages') && response.request().method() === 'POST' && response.ok());
    await page.getByRole('button', { name: 'Send question' }).click();
    const replyRound = await (await replyResponse).json();
    sentReplyId = [...replyRound.messages].reverse().find((item: { role: string; opening?: boolean }) => item.role === 'assistant' && !item.opening).id;
    await page.setViewportSize({ width: 599, height: 844 });
    await expect(page.locator('.diary-ink-text').filter({ hasText: /I expected the matter to be resolved before the night was over/i })).toBeVisible();
    await expect(page.locator('.diary-ink-word.is-writing').first()).toBeVisible();
    const inkDelays = await page.locator('.diary-ink-word.is-writing').evaluateAll(elements => elements.map(element => getComputedStyle(element).animationDelay));
    expect(new Set(inkDelays).size).toBeGreaterThan(1);
    await page.getByRole('button', { name: 'Show entire reply' }).click();
    await expect(page.getByRole('button', { name: 'Show entire reply' })).toHaveCount(0);

    const secondQuestion = 'What did you tell Hagrid before the school meeting?';
    await page.setViewportSize({ width: 390, height: 600 });
    let releaseDelayedReply!: () => void;
    let signalDelayedRequest!: () => void;
    const delayedGate = new Promise<void>(resolve => { releaseDelayedReply = resolve; });
    const delayedRequestSeen = new Promise<void>(resolve => { signalDelayedRequest = resolve; });
    await page.route('**/api/rounds/*/messages', async route => {
      if (route.request().method() === 'POST' && route.request().postDataJSON()?.content === secondQuestion) {
        signalDelayedRequest();
        await delayedGate;
      }
      await route.continue();
    });
    await page.getByRole('button', { name: 'Latest entry', exact: true }).click();
    await page.getByLabel('Ask the diary').fill(secondQuestion);
    const secondReplyResponse = page.waitForResponse(response => response.url().includes('/messages') && response.request().method() === 'POST' && response.ok());
    await page.getByRole('button', { name: 'Send question' }).click();
    await delayedRequestSeen;
    const navigation = page.getByRole('navigation', { name: 'Book pages' });
    const latestPosition = await navigation.locator('span').innerText();
    await expect(navigation.getByRole('button', { name: 'Previous', exact: true })).toBeEnabled();
    await navigation.getByRole('button', { name: 'Previous', exact: true }).click();
    const chosenOlderAnchor = await page.locator('.diary-page.mobile-page-current .diary-entry').first().evaluate(element => ({ id: element.getAttribute('data-message-id'), offset: element.getAttribute('data-offset-start') }));
    const chosenOlderPosition = await navigation.locator('span').innerText();
    expect(chosenOlderPosition).not.toBe(latestPosition);
    releaseDelayedReply();
    const secondReply = await (await secondReplyResponse).json();
    await expect.poll(() => page.locator('.diary-page.mobile-page-current .diary-entry').first().evaluate(element => ({ id: element.getAttribute('data-message-id'), offset: element.getAttribute('data-offset-start') }))).toEqual(chosenOlderAnchor);
    await page.unroute('**/api/rounds/*/messages');
    expect(secondReply.messages.at(-2).content).toBe(secondQuestion);
    const secondReplyId = secondReply.messages.at(-1).id;
    await expect(page.locator(`.diary-page.mobile-page-current [data-message-id="${secondReplyId}"]`)).toHaveCount(0);
    const postsBeforeRead = practiceModelRequests;
    await page.getByRole('button', { name: 'Full conversation', exact: true }).click();
    const transcript = page.getByRole('dialog', { name: 'Full conversation' });
    await expect(transcript).toContainText(question);
    await expect(transcript).toContainText(secondQuestion);
    await expect(transcript.locator('.diary-transcript-item').last()).toContainText(secondReply.messages.at(-1).content);
    await transcript.locator(`#full-message-${secondReply.messages.at(-2).id}`).getByRole('button', { name: 'Show in book' }).click();
    await expect(page.locator(`.diary-page [data-message-id="${secondReply.messages.at(-2).id}"]`)).toBeVisible();
    expect(practiceModelRequests).toBe(postsBeforeRead);
    await page.getByRole('button', { name: 'Latest entry', exact: true }).click();
    await expect(page.locator(`.diary-page [data-message-id="${secondReplyId}"]`)).toBeVisible();
    await expect(page.locator('.diary-page.mobile-page-current')).toBeVisible();
    const visualAnchor = await page.locator('.diary-page.mobile-page-current .diary-entry').first().evaluate(element => ({ id: element.getAttribute('data-message-id')!, offset: Number(element.getAttribute('data-offset-start')) }));
    await page.getByRole('button', { name: 'Readable text', exact: true }).click();
    await expect(page.locator('.diary-page.mobile-page-current .diary-plain-text').first()).toBeVisible();
    await expect.poll(() => page.locator('.diary-page.mobile-page-current .diary-entry').evaluateAll((entries, anchor) => entries.some(entry => entry.getAttribute('data-message-id') === anchor.id && Number(entry.getAttribute('data-offset-start')) <= anchor.offset && Number(entry.getAttribute('data-offset-end')) >= anchor.offset), visualAnchor)).toBe(true);
    await page.getByRole('button', { name: 'Handwritten view', exact: true }).click();
    await page.getByRole('button', { name: /Memory fragment/ }).first().click();
    await page.getByRole('button', { name: 'Place beside diary' }).click();
    await expect(page.locator('.diary-page.mobile-page-current')).toBeVisible();
    await page.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByLabel('Ask the diary')).toHaveValue('');
    await page.getByLabel('Ask the diary').fill(preservedDraft);
    const firstPage = page.getByRole('button', { name: 'First page', exact: true });
    if (await firstPage.isEnabled()) await firstPage.click();
    await expect(page.getByLabel('Ask the diary')).toHaveValue(preservedDraft);
    const longDraft = 'Could you explain what happened before the letter arrived? '.repeat(70).slice(0, 4000);
    await page.getByLabel('Ask the diary').fill(longDraft);
    await page.setViewportSize({ width: 390, height: 600 });
    await page.evaluate(() => window.scrollTo(0, 0));
    const draftHeight = await page.getByLabel('Ask the diary').evaluate(element => ({ client: element.clientHeight, scroll: element.scrollHeight }));
    expect(draftHeight.scroll).toBeGreaterThan(draftHeight.client);
    await page.getByRole('button', { name: 'Latest entry', exact: true }).click();
    await expect(page.getByLabel('Ask the diary')).toHaveValue(longDraft);
    await page.getByLabel('Ask the diary').fill('A question kept beside the latest reply.');

    for (const [width, height] of [[1440, 1000], [1366, 768], [599, 844], [599, 550], [390, 844], [390, 600]] as const) {
      await page.setViewportSize({ width, height });
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.getByRole('button', { name: 'Latest entry', exact: true }).click();
      await page.evaluate(() => window.scrollTo(0, 0));
      const bounds = await page.evaluate(() => {
        const rect = (selector: string) => { const element = document.querySelector<HTMLElement>(selector); if (!element) return null; const value = element.getBoundingClientRect(); return { left: value.left, right: value.right, top: value.top, bottom: value.bottom }; };
        const visibleReply = [...document.querySelectorAll<HTMLElement>('.diary-page .from-diary .diary-ink-text')].some(element => {
          const page = element.closest('.diary-page')!;
          return getComputedStyle(page).visibility !== 'hidden' && (innerWidth > 640 || page.classList.contains('mobile-page-current')) && element.getBoundingClientRect().height > 0;
        });
        return { book: rect('.diary-open-book'), page: rect('.diary-page-right'), composer: rect('.diary-composer-wrap'), paper: rect('.diary-composer-paper'), input: rect('#diary-question'), send: rect('.diary-composer-paper > button'), transcript: rect('.diary-page-right .diary-page-scroll'), earlierTranscript: rect('.diary-page-left .diary-page-scroll'), view: { width: innerWidth, height: innerHeight }, pageY: document.scrollingElement?.scrollTop || 0, visibleReply };
      });
      expect(bounds.book && bounds.page && bounds.composer && bounds.paper && bounds.input && bounds.send && bounds.transcript && bounds.earlierTranscript, JSON.stringify(bounds)).toBeTruthy();
      expect(bounds.book!.top).toBeGreaterThanOrEqual(-1);
      expect(bounds.book!.bottom).toBeLessThanOrEqual(height + 1);
      expect(bounds.composer!.left).toBeGreaterThanOrEqual(bounds.book!.left + (width <= 640 ? 1 : .52 * (bounds.book!.right - bounds.book!.left)) - 2);
      expect(bounds.composer!.right).toBeLessThanOrEqual(bounds.book!.right + 1);
      expect(bounds.composer!.top).toBeGreaterThan(bounds.book!.top + .56 * (bounds.book!.bottom - bounds.book!.top));
      expect(bounds.paper!.left).toBeGreaterThanOrEqual(bounds.book!.left + (width <= 640 ? 8 : .55 * (bounds.book!.right - bounds.book!.left)) - 2);
      expect(bounds.paper!.right).toBeLessThanOrEqual(bounds.book!.right - (width <= 640 ? 8 : .07 * (bounds.book!.right - bounds.book!.left)) + 1);
      if (width <= 640) {
        expect(bounds.paper!.left).toBeGreaterThanOrEqual(bounds.page!.left - 1);
        expect(bounds.paper!.right).toBeLessThanOrEqual(bounds.page!.right + 1);
        expect(bounds.send!.right).toBeLessThanOrEqual(bounds.page!.right + 1);
        expect(bounds.earlierTranscript!.bottom).toBeLessThanOrEqual(bounds.composer!.top - 8);
      }
      expect(bounds.transcript!.bottom).toBeLessThanOrEqual(bounds.composer!.top - 8);
      expect(bounds.input!.top).toBeGreaterThanOrEqual(0);
      expect(bounds.send!.bottom).toBeLessThanOrEqual(height + 1);
      expect(bounds.composer!.bottom).toBeLessThanOrEqual(height + 1);
      expect(bounds.pageY).toBe(0);
      expect(bounds.visibleReply).toBe(true);
      await page.screenshot({ path: `verification/riddle-diary-active-${width}x${height}.png`, fullPage: false, animations: 'disabled' });
    }
    await page.getByRole('button', { name: 'First page', exact: true }).click();
    await expect(page.getByLabel('Ask the diary')).toBeVisible();
    const earlierViewBounds = await page.evaluate(() => {
      const composer = document.querySelector('.diary-composer-wrap')!.getBoundingClientRect();
      const transcript = document.querySelector('.diary-page-left .diary-page-scroll')!.getBoundingClientRect();
      return { composerTop: composer.top, transcriptBottom: transcript.bottom };
    });
    expect(earlierViewBounds.transcriptBottom).toBeLessThanOrEqual(earlierViewBounds.composerTop - 8);
    await page.getByRole('button', { name: 'Latest entry', exact: true }).click();
    await page.setViewportSize({ width: 599, height: 844 });
    const replyTextWidths599 = await page.locator('.diary-page.mobile-page-current .diary-entry p[aria-hidden="true"]').evaluateAll(items => items.map(element => { const paragraph = element as HTMLElement, page = element.closest('.diary-page-scroll') as HTMLElement; return { client: paragraph.clientWidth, scroll: paragraph.scrollWidth, right: paragraph.getBoundingClientRect().right, textInset: page.getBoundingClientRect().right - paragraph.getBoundingClientRect().right }; }));
    expect(replyTextWidths599.every(width => width.scroll <= width.client + 2 && width.textInset >= 8), JSON.stringify(replyTextWidths599)).toBe(true);
    await page.screenshot({ path: 'verification/riddle-diary-reply-599.png', fullPage: false, animations: 'disabled' });
    await page.screenshot({ path: 'verification/riddle-diary-desktop.png', fullPage: true, animations: 'disabled' });
    await page.setViewportSize({ width: 390, height: 844 });
    const overflow = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, offenders: [...document.querySelectorAll<HTMLElement>('*')].filter(element => element.getBoundingClientRect().right > window.innerWidth + 1).slice(0, 8).map(element => ({ tag: element.tagName, className: element.className.toString().slice(0, 70), right: Math.round(element.getBoundingClientRect().right) })) }));
    expect(overflow.width <= 390, JSON.stringify(overflow)).toBe(true);
    const pageTextWidths = await page.locator('.diary-page.mobile-page-current .diary-entry p[aria-hidden="true"]').evaluateAll(items => items.map(element => { const paragraph = element.getBoundingClientRect(), page = element.closest('.diary-page-scroll')!.getBoundingClientRect(); return { client: element.clientWidth, scroll: element.scrollWidth, paragraphRight: Math.round(paragraph.right), pageRight: Math.round(page.right) }; }));
    expect(pageTextWidths.every(width => width.scroll <= width.client + 2 && width.paragraphRight <= width.pageRight + 2), JSON.stringify(pageTextWidths)).toBe(true);
    await expect(page.locator('.diary-page.mobile-page-current')).toBeVisible();
    await page.screenshot({ path: 'verification/riddle-diary-mobile.png', fullPage: false, animations: 'disabled' });
    const artifactImages = await page.locator('.diary-artifact-image img').evaluateAll(images => images.map(image => ({ width: (image as HTMLImageElement).naturalWidth, height: (image as HTMLImageElement).naturalHeight })));
    expect(artifactImages.length).toBeGreaterThanOrEqual(2);
    expect(artifactImages.every(image => image.width > 0 && image.height > 0), JSON.stringify(artifactImages)).toBe(true);
    await page.getByRole('button', { name: /Dippet's reply/ }).click();
    await expect(page.getByRole('dialog', { name: "Dippet's reply" })).toBeVisible();
    await page.screenshot({ path: 'verification/riddle-diary-letter-mobile.png', fullPage: false, animations: 'disabled' });
    await page.getByRole('button', { name: 'Done' }).click();
    await page.getByRole('button', { name: 'Keep reply as evidence' }).click();
    await page.getByRole('button', { name: 'File the case' }).click();
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
    const postsAtFiling = practiceModelRequests;
    await page.getByRole('button', { name: 'Latest entry', exact: true }).click();
    await expect(page.locator('.diary-page .from-diary .diary-ink-text').filter({ hasText: /I expected the matter to be resolved before the night was over/i })).toBeVisible();
    await page.getByRole('button', { name: 'Full conversation', exact: true }).click();
    const filedTranscript = page.getByRole('dialog', { name: 'Full conversation' });
    await expect(filedTranscript).toContainText(question);
    await expect(filedTranscript).toContainText(secondQuestion);
    expect(practiceModelRequests).toBe(postsAtFiling);
    await filedTranscript.getByRole('button', { name: 'Return to the book' }).click();
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
      await expect(blind.getByText(/HOGWARTS, 1943/)).toBeVisible();
      await expect(blind.getByRole('heading', { name: 'Hagrid' })).toBeVisible();
      await blind.setViewportSize({ width: 390, height: 844 });
      await blind.screenshot({ path: 'verification/riddle-diary-prologue-blind-mobile.png', fullPage: false, animations: 'disabled' });
      let blindStarts = 0;
      blind.on('request', request => { if (request.url().includes('/api/diary/play/') && request.method() === 'POST') blindStarts++; });
      expect(blindStarts).toBe(0);
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
      expect(blindStarts).toBe(1);
      const roundId = started.round.id as string;
      await expect(blind.getByRole('region', { name: 'Interactive diary session' })).toBeVisible();
      await blind.getByRole('button', { name: 'Open the diary', exact: true }).click();
      await blind.getByLabel('Ask the diary').fill('What did you tell Professor Dippet?');
      await blind.getByRole('button', { name: 'Send question' }).click();
      await expect(blind.locator('.diary-entry.from-diary').last()).toContainText('I expected the matter to be resolved');

      const secondContext = await browser.newContext({ baseURL: 'http://127.0.0.1:4323' });
      try {
        const second = await secondContext.newPage();
        await second.goto(blindPath);
        await expect(second.getByRole('heading', { name: 'A memory in ink.' })).toBeVisible();
        await expect(second.getByRole('textbox', { name: /^Your name\b/ })).toHaveValue('');
        await expect(second.getByLabel('Ask the diary')).toHaveCount(0);
      } finally { await secondContext.close(); }

      const resumed = blind.waitForResponse(response => response.url().endsWith(`/api/diary/rounds/${roundId}`) && response.request().method() === 'GET');
      await blind.reload();
      await resumed;
      await expect(blind.getByLabel('Ask the diary')).toHaveValue('');
      await blind.getByRole('button', { name: 'Latest entry', exact: true }).click();
      await expect(blind.locator('.diary-entry.from-diary').last()).toContainText(/understand\./);
      await blind.getByRole('button', { name: 'Previous', exact: true }).click();
      await expect(blind.locator('.diary-page.mobile-page-current .diary-entry.from-reader')).toContainText('What did you tell Professor Dippet?');
      await expect(blind.locator('.diary-entry.from-diary').last()).toContainText('I expected the matter to be resolved');
      expect((await blind.request.get('/api/diary/latest')).status()).toBe(401);
    } finally { await blindContext.close(); }
  });

  test('reduced motion skips word reveal and an uncertain receipt retries its original prompt after expiry', async ({ page }) => {
    await signInOwner(page.request);
    await page.setViewportSize({ width: 390, height: 600 });
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
    await page.getByLabel('Ask the diary').fill(original);
    await page.getByRole('button', { name: 'Send question' }).click();
    await expect(page.getByRole('button', { name: 'Check previous submission' })).toBeVisible();
    await expect(page.getByLabel('Ask the diary')).toHaveValue(original);
    const layoutWithPendingReceipt = await page.evaluate(() => {
      const composer = document.querySelector('.diary-composer-wrap')!.getBoundingClientRect();
      const recent = document.querySelector('.diary-page-right .diary-page-scroll')!.getBoundingClientRect();
      const earlier = document.querySelector('.diary-page-left .diary-page-scroll')!.getBoundingClientRect();
      return { composerTop: composer.top, recentBottom: recent.bottom, earlierBottom: earlier.bottom, reserve: getComputedStyle(document.querySelector('.diary-open-book')!).getPropertyValue('--diary-composer-height'), earlierPageBottom: getComputedStyle(document.querySelector('.diary-page-left')!).bottom };
    });
    expect(layoutWithPendingReceipt.recentBottom).toBeLessThanOrEqual(layoutWithPendingReceipt.composerTop - 8);
    expect(layoutWithPendingReceipt.earlierBottom).toBeLessThanOrEqual(layoutWithPendingReceipt.composerTop - 8);
    await page.getByLabel('Ask the diary').fill(edited);
    await page.clock.fastForward(6 * 60 * 1000);
    await expect(page.getByRole('button', { name: 'Send question' })).toBeDisabled();
    await expect(page.locator('.diary-expired-note')).toBeVisible();
    await expect.poll(async () => {
      const layout = await diaryVerticalSpace(page);
      return Math.max(layout.recent.bottom - layout.composer.top, layout.earlier.bottom - layout.composer.top);
    }).toBeLessThanOrEqual(-8);
    const layoutAfterExpiry = await diaryVerticalSpace(page);
    expect(layoutAfterExpiry.recent.bottom, JSON.stringify(layoutAfterExpiry)).toBeLessThanOrEqual(layoutAfterExpiry.composer.top - 8);
    expect(layoutAfterExpiry.earlier.bottom, JSON.stringify(layoutAfterExpiry)).toBeLessThanOrEqual(layoutAfterExpiry.composer.top - 8);
    await page.getByRole('button', { name: 'Check previous submission' }).click();
    await expect(page.getByRole('button', { name: 'Check previous submission' })).toHaveCount(0);
    await expect(page.getByLabel('Ask the diary')).toHaveValue(edited);
    await expect(page.locator('.diary-ink-word.is-writing')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Show entire reply' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Full conversation', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Full conversation' })).toContainText(/I expected the matter to be resolved before the night was over/i);
    await page.getByRole('button', { name: 'Return to the book' }).click();
    const visibleEntries = await page.locator('.diary-page.mobile-page-current .diary-entry').evaluateAll(entries => entries.map(entry => {
      const entryBounds = entry.getBoundingClientRect();
      const pageBounds = entry.closest('.diary-page-scroll')!.getBoundingClientRect();
      return { bottom: entryBounds.bottom, pageBottom: pageBounds.bottom, left: entryBounds.left, pageLeft: pageBounds.left, right: entryBounds.right, pageRight: pageBounds.right };
    }));
    expect(visibleEntries.length).toBeGreaterThan(0);
    expect(visibleEntries.every(entry => entry.bottom <= entry.pageBottom + 1 && entry.left >= entry.pageLeft - 1 && entry.right <= entry.pageRight + 1), JSON.stringify(visibleEntries)).toBe(true);
    expect(attempts).toBe(2);
    expect(firstPayload?.content).toBe(original);
  });

  test('prints a dense saved conversation exactly once across desktop spreads and mobile pages', async ({ page }) => {
    await signInOwner(page.request);
    const startedResponse = await page.request.post('/api/diary/start', { data: { profileId: 'story' } });
    expect(startedResponse.ok()).toBe(true);
    const session = await startedResponse.json();
    session.state.diaryOpen = true;
    session.round.deadline = Date.now() + 60 * 60 * 1000;
    const original = [session.round.messages[0]];
    for (let index = 1; index <= 6; index++) {
      original.push({
        id: `pagination-question-${index}`, role: 'user',
        content: `Question ${index}: what happened before the letter arrived?\n\n${'I want to keep the sequence precise. '.repeat(5)}café, 校, 𠀀, and e\u0301.`, timestamp: Date.now(),
      });
      original.push({
        id: `pagination-reply-${index}`, role: 'assistant',
        content: `Reply ${index}. The meeting took place before the letter was opened.\n\n${'The account in the diary follows the evidence presented to the school. '.repeat(index === 3 ? 18 : 7)}\n\nA long word must still wrap: ${'校𠀀'.repeat(index === 4 ? 80 : 9)}.\n\nThe final sentence of reply ${index}.`, timestamp: Date.now(),
      });
    }
    session.round.messages = original;
    await page.route('**/api/diary/active', route => route.fulfill({ json: session }));
    let modelRequests = 0;
    const pageErrors: string[] = [];
    page.on('request', request => { if (request.method() === 'POST' && /\/rounds\/[^/]+\/(messages|review)$/.test(new URL(request.url()).pathname)) modelRequests++; });
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.goto('/diary');
    await expect(page.getByLabel('Ask the diary')).toBeVisible();
    await page.getByLabel('Ask the diary').fill('Keep this draft while reading.');

    for (const [width, height] of [[1366, 768], [390, 600]] as const) {
      await page.setViewportSize({ width, height });
      const navigation = page.getByRole('navigation', { name: 'Book pages' });
      await navigation.getByRole('button', { name: 'First page', exact: true }).click();
      await expect(navigation.locator('span')).toHaveText(width <= 640 ? /^Page 1 of / : /^Pages 1[–-]/);
      const collected = new Map(original.map(message => [message.id, [] as Array<{ start: number; end: number; text: string }>]));
      let pageCount = 0;
      let priorMessageIndex = 0;
      for (;;) {
        const visibleSelector = width <= 640 ? '.diary-page.mobile-page-current .diary-entry' : '.diary-page .diary-entry';
        await expect(page.locator(visibleSelector).first()).toBeVisible();
        const segments = await page.locator(visibleSelector).evaluateAll(nodes => nodes.filter(node => {
          const bounds = node.getBoundingClientRect();
          return bounds.width > 0 && bounds.height > 0 && getComputedStyle(node).visibility !== 'hidden';
        }).map(node => {
          const text = node.querySelector<HTMLElement>('p[aria-hidden="true"], p.diary-reader-text, p.diary-ink-text')!;
          const bounds = node.getBoundingClientRect();
          const pageBounds = node.closest('.diary-page-scroll')!.getBoundingClientRect();
          return {
            id: node.getAttribute('data-message-id')!,
            start: Number(node.getAttribute('data-offset-start')),
            end: Number(node.getAttribute('data-offset-end')),
            text: text.textContent ?? '',
            bottom: bounds.bottom,
            pageBottom: pageBounds.bottom,
            right: text.getBoundingClientRect().right,
            pageRight: pageBounds.right,
            scrollWidth: text.scrollWidth,
            width: text.clientWidth,
          };
        }));
        expect(segments.length, `visible content on page ${pageCount + 1} at ${width}x${height}`).toBeGreaterThan(0);
        for (const segment of segments) {
          const source = original.find(message => message.id === segment.id);
          expect(source, `known saved message ${segment.id}`).toBeTruthy();
          const sourceIndex = original.indexOf(source!);
          expect(sourceIndex).toBeGreaterThanOrEqual(priorMessageIndex);
          priorMessageIndex = sourceIndex;
          expect(segment.text).toBe(source!.content.slice(segment.start, segment.end));
          expect(segment.bottom).toBeLessThanOrEqual(segment.pageBottom + 2);
          expect(segment.right).toBeLessThanOrEqual(segment.pageRight + 2);
          expect(segment.scrollWidth).toBeLessThanOrEqual(segment.width + 2);
          collected.get(segment.id)!.push({ start: segment.start, end: segment.end, text: segment.text });
        }
        const next = navigation.getByRole('button', { name: 'Next', exact: true });
        if (await next.isDisabled()) break;
        await next.click();
        expect(++pageCount).toBeLessThan(160);
      }
      for (const message of original) {
        const pieces = collected.get(message.id)!;
        expect(pieces.length, `all of ${message.id} is printed`).toBeGreaterThan(0);
        let nextOffset = 0;
        for (const piece of pieces) {
          expect(piece.start, `continuous offsets for ${message.id}`).toBe(nextOffset);
          nextOffset = piece.end;
        }
        expect(nextOffset).toBe(message.content.length);
        expect(pieces.map(piece => piece.text).join('')).toBe(message.content);
      }
      await expect(page.getByLabel('Ask the diary')).toHaveValue('Keep this draft while reading.');
    }
    expect(modelRequests).toBe(0);
    expect(pageErrors).toEqual([]);
  });
});
