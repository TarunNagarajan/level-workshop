import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { signInOwner } from './auth';

async function visitBlindIntro(page: Page) {
  await signInOwner(page.request);
  const response = await page.request.post('/api/diary/links', { data: { profileId: 'story' } });
  expect(response.ok()).toBe(true);
  await page.goto((await response.json()).path);
}

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
    let openActions = 0;
    page.on('request', request => {
      if (request.url().includes('/messages') && request.method() === 'POST') practiceModelRequests++;
      if (request.url().endsWith('/api/diary/start') && request.method() === 'POST') starts++;
      if (request.url().includes('/api/diary/rounds/') && request.url().endsWith('/action') && request.method() === 'POST' && request.postDataJSON()?.type === 'open_diary') openActions++;
    });
    await page.goto('/diary');
    await expect(page.getByRole('heading', { name: "Harry Potter: Riddle's Diary" })).toBeVisible();
    await expect(page.locator('.diary-context-summary')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Watch and begin' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Begin without film' })).toBeVisible();
    await expect(page.locator('.diary-cinema-video')).toHaveCount(1);
    const contextCopy = await page.locator('.diary-context-summary').innerText();
    expect(contextCopy).not.toMatch(/false accusation|scapegoat|orphanage|edited memory|secretly opened the chamber/i);
    expect(starts).toBe(0);
    await page.screenshot({ path: 'verification/riddle-diary-prologue-desktop.png', fullPage: false, animations: 'disabled' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: 'verification/riddle-diary-prologue-390.png', fullPage: false, animations: 'disabled' });
    await page.setViewportSize({ width: 1440, height: 1000 });
    expect(practiceModelRequests).toBe(0);
    await expect(page.getByRole('main')).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Skip tour' })).toHaveCount(0);
    const videoMetadata = page.waitForFunction(() => {
      const video = document.querySelector<HTMLVideoElement>('.diary-cinema-video');
      return Boolean(video && video.readyState >= 1 && video.duration > 0);
    }, { timeout: 30000 });
    await page.getByRole('button', { name: 'Watch and begin' }).click();
    await videoMetadata;
    const videoDuration = await page.locator('.diary-cinema-video').evaluate(element => (element as HTMLVideoElement).duration);
    expect(videoDuration).toBeGreaterThanOrEqual(58);
    expect(videoDuration).toBeLessThanOrEqual(62);
    await page.waitForFunction(() => { const video = document.querySelector<HTMLVideoElement>('.diary-cinema-video'); return Boolean(video && !video.paused && video.currentTime > 0); }, { timeout: 15000 });
    await expect(page.getByRole('button', { name: 'Skip film' })).toBeVisible();
    await page.screenshot({ path: 'verification/riddle-diary-cinema-playing-1440.png', fullPage: false, animations: 'disabled' });
    expect(starts).toBe(0);
    expect(openActions).toBe(0);
    expect(practiceModelRequests).toBe(0);
    await expect.poll(async () => await page.evaluate(() => document.fullscreenElement?.classList.contains('riddle-diary-shell') || false) || await page.locator('.diary-cinema-fullscreen-note').count() > 0).toBe(true);
    const fullscreenRoot = await page.evaluate(() => document.fullscreenElement?.classList.contains('riddle-diary-shell') || false);
    let releaseStart!: () => void;
    let signalStart!: () => void;
    const startGate = new Promise<void>(resolve => { releaseStart = resolve; });
    const startSeen = new Promise<void>(resolve => { signalStart = resolve; });
    await page.route('**/api/diary/start', async route => { signalStart(); await startGate; await route.continue(); });
    await page.getByRole('button', { name: 'Skip film' }).click();
    await startSeen;
    expect(starts).toBe(1);
    const transition = page.locator('.diary-ink-transition');
    await expect(transition).toBeVisible();
    const transitionOpacity = await transition.evaluate(element => getComputedStyle(element).opacity);
    expect(transitionOpacity).toBe('1');
    await page.screenshot({ path: 'verification/riddle-diary-film-to-desk-black.png', fullPage: false, animations: 'disabled' });
    releaseStart();
    await expect(page.getByLabel('Ask the diary')).toBeVisible();
    const firstClock = await page.getByLabel('Time remaining').innerText();
    const firstClockSeconds = firstClock.split(':').map(Number).reduce((minutes, seconds) => minutes * 60 + seconds, 0);
    expect(firstClockSeconds).toBeLessThanOrEqual(300);
    expect(firstClockSeconds).toBeGreaterThanOrEqual(298);
    const exitBounds = await page.getByRole('button', { name: 'Return to workshop' }).boundingBox();
    const clockBounds = await page.getByLabel('Time remaining').boundingBox();
    expect(exitBounds).toBeTruthy();
    expect(clockBounds).toBeTruthy();
    expect(exitBounds!.x + exitBounds!.width).toBeLessThanOrEqual(clockBounds!.x + 1);
    await expect.poll(() => openActions).toBe(1);
    await expect(page.locator('.diary-cinema-video')).toHaveCount(1);
    await expect.poll(() => page.evaluate(() => document.fullscreenElement?.classList.contains('riddle-diary-shell') || false)).toBe(fullscreenRoot);
    const immersiveBounds = await page.locator('.riddle-diary-shell').evaluate(element => { const rect = element.getBoundingClientRect(); return { immersive: element.classList.contains('is-immersive'), left: rect.left, top: rect.top, width: rect.width, height: rect.height, viewportWidth: innerWidth, viewportHeight: innerHeight }; });
    expect(immersiveBounds.immersive).toBe(true);
    expect(immersiveBounds.left).toBe(0);
    expect(immersiveBounds.top).toBe(0);
    expect(immersiveBounds.width).toBe(immersiveBounds.viewportWidth);
    expect(immersiveBounds.height).toBe(immersiveBounds.viewportHeight);
    await page.screenshot({ path: 'verification/riddle-diary-ready-after-cinema.png', fullPage: false, animations: 'disabled' });
    if (fullscreenRoot) {
      await page.evaluate(() => document.exitFullscreen());
      await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
      await expect(page.getByLabel('Ask the diary')).toBeVisible();
    }
    await page.getByRole('button', { name: 'Return to workshop' }).click();
    await expect(page.locator('.riddle-diary-shell')).not.toHaveClass(/is-immersive/);
    await page.setViewportSize({ width: 599, height: 844 });
    await page.screenshot({ path: 'verification/riddle-diary-cover-599.png', fullPage: false, animations: 'disabled' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: 'verification/riddle-diary-cover-390.png', fullPage: false, animations: 'disabled' });
    await page.setViewportSize({ width: 599, height: 844 });
    await page.getByRole('button', { name: 'Story context' }).click();
    await expect(page.getByRole('dialog', { name: 'Story context' })).toBeVisible();
    await expect(page.locator('.diary-story-dialog .diary-context-summary')).toBeVisible();
    const storyContrast = await page.getByRole('dialog', { name: 'Story context' }).locator(':scope > .eyebrow, :scope > h2, .diary-context-summary > p, .diary-film-credit a, .diary-paper-button').evaluateAll(elements => {
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
    const sessionBeforeRewatch = await (await page.request.get('/api/diary/active')).json();
    const draftBeforeRewatch = 'Keep this draft while the film plays again.';
    await page.getByLabel('Ask the diary').fill(draftBeforeRewatch);
    await page.getByRole('button', { name: 'Story context' }).click();
    await page.getByRole('button', { name: 'Watch the opening film again' }).click();
    await expect(page.getByRole('dialog', { name: 'Story context' })).toHaveCount(0);
    await page.waitForFunction(() => { const video = document.querySelector<HTMLVideoElement>('.diary-cinema-video'); return Boolean(video && !video.paused && video.currentTime > 0); }, { timeout: 15000 });
    await expect(page.getByRole('button', { name: 'Finish viewing' })).toBeVisible();
    expect(starts).toBe(1);
    expect(practiceModelRequests).toBe(0);
    await page.getByRole('button', { name: 'Finish viewing' }).click();
    await expect(page.getByRole('dialog', { name: 'Story context' })).toHaveCount(0);
    await expect(page.getByLabel('Ask the diary')).toHaveValue(draftBeforeRewatch);
    const sessionAfterRewatch = await (await page.request.get('/api/diary/active')).json();
    expect(sessionAfterRewatch.round.id).toBe(sessionBeforeRewatch.round.id);
    expect(sessionAfterRewatch.round.deadline).toBe(sessionBeforeRewatch.round.deadline);
    if (await page.evaluate(() => Boolean(document.fullscreenElement))) await page.evaluate(() => document.exitFullscreen());
    if (await page.locator('.diary-immersive-exit').count()) await page.getByRole('button', { name: 'Return to workshop' }).click();
    await expect(page.locator('.riddle-diary-shell')).not.toHaveClass(/is-immersive/);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Story context' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Latest entry', exact: true }).click();
    await expect(page.locator('.diary-page.mobile-page-current')).toBeVisible();
    const mediumPageText = await page.locator('.diary-page.mobile-page-current .diary-entry p[aria-hidden="true"]').evaluateAll(items => items.map(element => { const paragraph = element as HTMLElement, page = element.closest('.diary-page-scroll') as HTMLElement; return { client: paragraph.clientWidth, scroll: paragraph.scrollWidth, paragraphRight: paragraph.getBoundingClientRect().right, textInset: page.getBoundingClientRect().right - paragraph.getBoundingClientRect().right }; }));
    expect(mediumPageText.every(width => width.scroll <= width.client + 2 && width.textInset >= 5), JSON.stringify(mediumPageText)).toBe(true);
    await page.screenshot({ path: 'verification/riddle-diary-open-599.png', fullPage: false, animations: 'disabled' });

    const awardButton = page.getByRole('button', { name: "Inspect Riddle's school award" });
    await expect(awardButton).toBeVisible();
    await awardButton.click();
    await expect(page.getByRole('dialog', { name: "Riddle's school award" })).toBeVisible();
    await expect(page.getByText('Special Services to the School', { exact: true }).last()).toBeVisible();
    const placeContrast = await page.getByRole('button', { name: 'Place beside the diary' }).evaluate(element => {
      const channels = (value: string) => value.match(/[\d.]+/g)!.slice(0, 3).map(Number);
      const luminance = (value: string) => channels(value).map(channel => { const normalized = channel / 255; return normalized <= .04045 ? normalized / 12.92 : ((normalized + .055) / 1.055) ** 2.4; }).reduce((sum, channel, index) => sum + channel * [.2126, .7152, .0722][index], 0);
      const [lighter, darker] = [luminance(getComputedStyle(element).color), luminance('rgb(240, 232, 213)')].sort((a, b) => b - a);
      return (lighter + .05) / (darker + .05);
    });
    expect(placeContrast).toBeGreaterThanOrEqual(4.5);
    await expect(page.getByText('Observation saved to the diary.', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Place beside the diary' })).toBeEnabled();
    await expect(page.getByText(/Ron recognised Riddle's name from an award/)).toBeVisible();
    await page.screenshot({ path: 'verification/riddle-diary-award-desktop.png', fullPage: false, animations: 'disabled' });
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: "Riddle's school award" })).toHaveCount(0);
    await expect(awardButton).toBeFocused();
    await page.getByRole('button', { name: "Inspect Hermione's library clue" }).click();
    await expect(page.getByRole('dialog', { name: "Hermione's library clue" })).toBeVisible();
    await expect(page.getByText(/Hermione identified the creature as a Basilisk/)).toBeVisible();
    await expect(page.getByText('Observation saved to the diary.', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Place beside the diary' })).toBeEnabled();
    await expect(page.getByText(/Harry and Ron found her clue after she had been Petrified/)).toBeVisible();
    await page.screenshot({ path: 'verification/riddle-diary-library-mobile.png', fullPage: false, animations: 'disabled' });
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
      reviewResult = { status: 'complete', attempts: 1, retryable: false, verdict: 'partial', reason: 'Riddle described the school’s recognition after Hagrid was blamed.', evidence: [{ replyId: sentReplyId, quote: 'I was honoured for Special Services to the School after Hagrid was blamed.' }] };
      return route.fulfill({ json: { machineReview: reviewResult } });
    });
    const question = '[fixture:rate-limit-once] What did the award say about how the school saw me?';
    await page.getByLabel('Ask the diary').fill(question);
    await page.getByRole('button', { name: 'Send question' }).click();
    await expect(page.getByRole('alert').filter({ hasText: /confirmed this prompt was saved/ })).toBeVisible();
    await expect(page.getByLabel('Ask the diary')).toHaveValue(question);
    const replyResponse = page.waitForResponse(response => response.url().includes('/messages') && response.request().method() === 'POST' && response.ok());
    await page.getByRole('button', { name: 'Send question' }).click();
    const replyRound = await (await replyResponse).json();
    sentReplyId = [...replyRound.messages].reverse().find((item: { role: string; opening?: boolean }) => item.role === 'assistant' && !item.opening).id;
    await page.setViewportSize({ width: 599, height: 844 });
    await page.getByRole('button', { name: 'Full conversation', exact: true }).click();
    await page.locator(`#full-message-${sentReplyId}`).getByRole('button', { name: 'Show in book' }).click();
    await expect(page.locator(`.diary-page.mobile-page-current .diary-entry[data-message-id="${sentReplyId}"]`)).toBeVisible();
    await expect(page.locator('.diary-ink-word.is-writing').first()).toBeVisible();
    const inkDelays = await page.locator('.diary-ink-word.is-writing').evaluateAll(elements => elements.map(element => getComputedStyle(element).animationDelay));
    expect(new Set(inkDelays).size).toBeGreaterThan(1);
    await page.getByRole('button', { name: 'Show entire reply' }).click();
    await expect(page.getByRole('button', { name: 'Show entire reply' })).toHaveCount(0);

    const secondQuestion = 'Why did you accept recognition after Hagrid was blamed?';
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
    const chosenOlderAnchor = await page.locator('.diary-page.mobile-page-current .diary-entry.from-diary').first().evaluate(element => ({ id: element.getAttribute('data-message-id')!, offset: Number(element.getAttribute('data-offset-start')) }));
    const chosenOlderPosition = await navigation.locator('span').innerText();
    expect(chosenOlderPosition).not.toBe(latestPosition);
    releaseDelayedReply();
    const secondReply = await (await secondReplyResponse).json();
    const anchoredReply = page.locator(`.diary-page.mobile-page-current .diary-entry.from-diary[data-message-id="${chosenOlderAnchor.id}"]`);
    await expect.poll(() => anchoredReply.evaluate(element => ({ start: Number(element.getAttribute('data-offset-start')), end: Number(element.getAttribute('data-offset-end')) })).then(segment => segment.start <= chosenOlderAnchor.offset && chosenOlderAnchor.offset < segment.end || segment.end === chosenOlderAnchor.offset)).toBe(true);
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
    await page.getByRole('button', { name: "Inspect Riddle's school award" }).click();
    await page.getByRole('button', { name: 'Place beside the diary' }).click();
    await expect(page.locator('.diary-page.mobile-page-current')).toBeVisible();
    await page.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByLabel('Ask the diary')).toHaveValue('');
    await page.getByLabel('Ask the diary').fill(preservedDraft);
    const firstPage = page.getByRole('button', { name: 'First page', exact: true });
    if (await firstPage.isEnabled()) await firstPage.click();
    await expect(page.getByLabel('Ask the diary')).toHaveValue(preservedDraft);
    const longDraft = 'Could you explain why the school recognized you after Hagrid was blamed? '.repeat(70).slice(0, 4000);
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
      expect(bounds.paper!.left).toBeGreaterThanOrEqual(bounds.book!.left + (width <= 640 ? 8 : .54 * (bounds.book!.right - bounds.book!.left)) - 2);
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
      const alignedText = await page.evaluate(() => {
        const currentPage = innerWidth <= 640 ? document.querySelector<HTMLElement>('.diary-page.mobile-page-current') : document.querySelector<HTMLElement>('.diary-page-right');
        const heading = currentPage?.querySelector<HTMLElement>('.diary-page-heading > span');
        const entry = currentPage?.querySelector<HTMLElement>('.diary-entry');
        const role = entry?.querySelector<HTMLElement>('.diary-entry-label');
        const prose = entry?.querySelector<HTMLElement>('p[aria-hidden="true"], .diary-reader-text, .diary-ink-text');
        const composer = document.querySelector<HTMLElement>('.diary-composer-wrap');
        const label = composer?.querySelector<HTMLElement>('label');
        const field = document.querySelector<HTMLElement>('.diary-composer-paper');
        const x = (element?: HTMLElement | null) => element?.getBoundingClientRect().left ?? null;
        const edge = (element?: HTMLElement | null) => element?.getBoundingClientRect().right ?? null;
        return { heading: x(heading), role: x(role), prose: x(prose), composerLabel: x(label), fieldLeft: x(field), fieldRight: edge(field), bookRight: edge(document.querySelector<HTMLElement>('.diary-open-book')) };
      });
      expect(alignedText.heading).not.toBeNull();
      expect(alignedText.role).not.toBeNull();
      expect(alignedText.prose).not.toBeNull();
      expect(Math.max(alignedText.heading!, alignedText.role!, alignedText.prose!) - Math.min(alignedText.heading!, alignedText.role!, alignedText.prose!)).toBeLessThanOrEqual(6);
      if (width > 640) expect(Math.abs(alignedText.composerLabel! - alignedText.heading!), `${width}x${height}: composer label and paper heading alignment ${JSON.stringify(alignedText)}`).toBeLessThanOrEqual(8);
      expect(alignedText.fieldRight).toBeLessThanOrEqual(alignedText.bookRight! + 1);
      expect(alignedText.fieldRight! - alignedText.fieldLeft!).toBeGreaterThan(120);
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
    const artifactImages = await page.locator('.diary-desk-prop img').evaluateAll(images => images.map(image => ({ width: (image as HTMLImageElement).naturalWidth, height: (image as HTMLImageElement).naturalHeight })));
    expect(artifactImages.length).toBeGreaterThanOrEqual(2);
    expect(artifactImages.every(image => image.width > 0 && image.height > 0), JSON.stringify(artifactImages)).toBe(true);
    await page.getByRole('button', { name: "Inspect Hermione's library clue" }).click();
    await expect(page.getByRole('dialog', { name: "Hermione's library clue" })).toBeVisible();
    await page.screenshot({ path: 'verification/riddle-diary-library-mobile.png', fullPage: false, animations: 'disabled' });
    await page.getByRole('button', { name: 'Done' }).click();
    await page.getByRole('button', { name: 'Keep reply as evidence' }).click();
    await page.getByRole('button', { name: 'File the case' }).click();
    await page.screenshot({ path: 'verification/riddle-diary-filing-mobile.png', fullPage: false, animations: 'disabled' });
    await page.getByLabel('Your account').fill('Riddle was honoured after Hagrid had been blamed.');
    await page.getByLabel(/I was honoured for Special Services/).check();
    const filedResponse = page.waitForResponse(response => response.url().includes('/diary/rounds/') && response.url().endsWith('/file') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'File finding' }).click();
    const filedPayload = await (await filedResponse).json();
    expect(filedPayload.round.endedAt).toBeTruthy();
    await expect(page.getByRole('heading', { name: 'The case is filed.' })).toBeVisible();
    await expect.poll(() => reviewPosts, { timeout: 10000 }).toBe(1);
    await expect(page.getByRole('heading', { name: 'Part of the secret recovered' })).toBeVisible();
    await expect(page.getByText('Riddle described the school’s recognition after Hagrid was blamed.')).toBeVisible();
    expect(reviewPosts).toBe(1);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Part of the secret recovered' })).toBeVisible();
    await expect(page.locator('.machine-review-evidence blockquote')).toContainText('I was honoured for Special Services to the School after Hagrid was blamed.');
    const postsAtFiling = practiceModelRequests;
    await page.getByRole('button', { name: 'Latest entry', exact: true }).click();
    await expect(page.locator('.diary-page .from-diary .diary-ink-text').filter({ hasText: /I was honoured for Special Services to the School/i })).toBeVisible();
    await page.getByRole('button', { name: 'Full conversation', exact: true }).click();
    const filedTranscript = page.getByRole('dialog', { name: 'Full conversation' });
    await expect(filedTranscript).toContainText(question);
    await expect(filedTranscript).toContainText(secondQuestion);
    expect(practiceModelRequests).toBe(postsAtFiling);
    await filedTranscript.getByRole('button', { name: 'Return to the book' }).click();
    await page.locator('.machine-review').scrollIntoViewIfNeeded();
    await page.screenshot({ path: 'verification/riddle-diary-ending-mobile.png', fullPage: false, animations: 'disabled' });
    expect(reviewPosts).toBe(1);
    const filedRoundId = filedPayload.round.id as string;
    const modelCallsBeforeReplay = practiceModelRequests;
    await page.getByRole('button', { name: 'Play again', exact: true }).click();
    await expect(page.getByRole('radiogroup', { name: 'Prompt profile' }).getByRole('radio', { name: /Story/ })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByRole('button', { name: 'Watch and begin', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Begin without film', exact: true })).toBeVisible();
    expect(practiceModelRequests).toBe(modelCallsBeforeReplay);
    const preservedFiledRound = await (await page.request.get(`/api/diary/rounds/${filedRoundId}`)).json();
    expect(preservedFiledRound.round.endedAt).toBeTruthy();
  });

  test('one local film preloads with captions and byte ranges, then natural end starts exactly once', async ({ page }) => {
    test.setTimeout(60000);
    await signInOwner(page.request);
    await page.clock.install();
    const link = await page.request.post('/api/diary/links', { data: { profileId: 'story' } });
    expect(link.ok()).toBe(true);
    const path = (await link.json()).path as string;
    const thirdPartyRequests: string[] = [];
    const localOrigin = 'http://127.0.0.1:4323';
    page.on('request', request => { if (new URL(request.url()).origin !== localOrigin) thirdPartyRequests.push(request.url()); });
    let starts = 0, opens = 0, modelCalls = 0;
    page.on('request', request => {
      if (request.url().includes('/api/diary/play/') && request.method() === 'POST') starts++;
      if (request.url().includes('/api/diary/rounds/') && request.url().endsWith('/action') && request.postDataJSON()?.type === 'open_diary') opens++;
      if (request.url().includes('/messages') && request.method() === 'POST') modelCalls++;
    });
    const filmResponse = page.waitForResponse(response => response.url().endsWith('/diary-assets/film/riddle-cinematic-r3-v1.mp4'));
    const captionsResponse = page.waitForResponse(response => response.url().endsWith('/diary-assets/film/riddle-cinematic-r3-v1.vtt'));
    await page.goto(path);
    const response = await filmResponse;
    expect([200, 206]).toContain(response.status());
    expect(response.headers()['content-type']).toContain('video/mp4');
    expect((await captionsResponse).status()).toBe(200);
    await expect(page.locator('.diary-cinema-video')).toHaveCount(1);
    const video = page.locator('.diary-cinema-video');
    await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).readyState), { timeout: 20000 }).toBeGreaterThanOrEqual(1);
    await expect(page.getByRole('button', { name: 'Watch and begin' })).toBeDisabled();
    expect(starts).toBe(0);
    expect(modelCalls).toBe(0);
    await page.getByRole('textbox', { name: /^Your name\b/ }).fill('Cinematic Tester');
    await page.locator('.diary-recording-consent input').check();
    await page.getByRole('button', { name: 'Watch and begin' }).click();
    await expect(page.getByRole('button', { name: 'Skip film' })).toBeVisible();
    const filmDialog = page.getByRole('dialog', { name: 'Opening film' });
    await expect(filmDialog).toBeVisible();
    await expect.poll(() => page.evaluate(() => Boolean(document.querySelector('.diary-cinema-stage')?.contains(document.activeElement)))).toBe(true);
    const chromeHeader = page.locator('.diary-cinema-chrome > header');
    const viewport = page.viewportSize()!;
    await page.mouse.move(viewport.width / 2, viewport.height / 2);
    await expect.poll(() => chromeHeader.evaluate(element => getComputedStyle(element).opacity), { timeout: 6000 }).toBe('0');
    await page.mouse.move(viewport.width / 2 + 12, viewport.height / 2 + 12);
    await expect.poll(() => chromeHeader.evaluate(element => getComputedStyle(element).opacity)).toBe('1');
    await page.keyboard.press('Tab');
    await expect.poll(() => page.evaluate(() => Boolean(document.querySelector('.diary-cinema-stage')?.contains(document.activeElement)))).toBe(true);
    await expect(video.locator('track')).toHaveAttribute('label', 'English scene summary');
    await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).textTracks[0]?.mode)).toBe('showing');
    await expect(video).toHaveAttribute('controls', '');
    await expect(video).toHaveAttribute('controlslist', 'nofullscreen');
    const duration = await video.evaluate(element => (element as HTMLVideoElement).duration);
    expect(duration).toBeGreaterThanOrEqual(58);
    expect(duration).toBeLessThanOrEqual(62);
    await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).paused)).toBe(false);
    expect(starts).toBe(0);
    expect(opens).toBe(0);
    expect(modelCalls).toBe(0);
    const heldVideo = await video.elementHandle();
    const range = await page.request.get('/diary-assets/film/riddle-cinematic-r3-v1.mp4', { headers: { Range: 'bytes=0-15' } });
    expect(range.status()).toBe(206);
    expect(range.headers()['content-type']).toContain('video/mp4');
    expect(range.headers()['content-range']).toMatch(/^bytes 0-15\//);
    expect((await range.body()).length).toBe(16);
    await video.evaluate(element => { const media = element as HTMLVideoElement; media.currentTime = media.duration - .1; });
    await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).ended), { timeout: 10000 }).toBe(true);
    await expect(page.getByLabel('Ask the diary')).toBeVisible();
    await expect.poll(() => starts).toBe(1);
    await expect.poll(() => opens).toBe(1);
    expect(modelCalls).toBe(0);
    expect(await heldVideo!.evaluate(element => (element as HTMLVideoElement).paused)).toBe(true);
    expect(thirdPartyRequests).toEqual([]);
  });

  test('blocked playback keeps a no-film start available when fullscreen is rejected', async ({ page }) => {
    test.setTimeout(60000);
    await signInOwner(page.request);
    await page.clock.install();
    await page.addInitScript(() => {
      Element.prototype.requestFullscreen = () => Promise.reject(new DOMException('Fullscreen denied', 'NotAllowedError'));
    });
    const link = await page.request.post('/api/diary/links', { data: { profileId: 'story' } });
    expect(link.ok()).toBe(true);
    await page.route('**/diary-assets/film/riddle-cinematic-r3-v1.mp4', route => route.abort('failed'));
    await page.goto((await link.json()).path);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('textbox', { name: /^Your name\b/ }).fill('No Film Tester');
    await page.locator('.diary-recording-consent input').check();
    await page.getByRole('button', { name: 'Watch and begin' }).click();
    const filmDialog = page.getByRole('dialog', { name: 'Opening film' });
    await page.screenshot({ path: 'verification/riddle-diary-cinema-390-immersive.png', fullPage: false, animations: 'disabled' });
    await expect(page.locator('.diary-cinema-fullscreen-note')).toContainText('Fullscreen was unavailable');
    await page.clock.fastForward(18001);
    await expect(filmDialog.getByRole('alert')).toContainText('could not continue loading');
    await expect(filmDialog.getByRole('button', { name: 'Begin without film' })).toBeVisible();
    await filmDialog.getByRole('button', { name: 'Begin without film' }).click();
    await expect(page.getByLabel('Ask the diary')).toBeVisible();
    const fallbackBounds = await page.locator('.riddle-diary-shell').evaluate(element => {
      const rect = element.getBoundingClientRect();
      return { immersive: element.classList.contains('is-immersive'), left: rect.left, top: rect.top, width: rect.width, height: rect.height, viewportWidth: innerWidth, viewportHeight: innerHeight };
    });
    expect(fallbackBounds.immersive).toBe(true);
    expect(fallbackBounds.left).toBe(0);
    expect(fallbackBounds.top).toBe(0);
    expect(fallbackBounds.width).toBe(fallbackBounds.viewportWidth);
    expect(fallbackBounds.height).toBe(fallbackBounds.viewportHeight);
    await expect(page.getByRole('button', { name: 'Leave immersive view' })).toBeVisible();
    await page.getByRole('button', { name: 'Leave immersive view' }).click();
    await expect(page.locator('.riddle-diary-shell')).not.toHaveClass(/is-immersive/);
  });

  test('stalled film has a bounded retry path without creating a round during playback', async ({ page }) => {
    test.setTimeout(60000);
    await signInOwner(page.request);
    const link = await page.request.post('/api/diary/links', { data: { profileId: 'story' } });
    expect(link.ok()).toBe(true);
    await page.clock.install();
    let hold = true;
    const releases: Array<() => void> = [];
    let requests = 0;
    await page.route('**/diary-assets/film/riddle-cinematic-r3-v1.mp4', async route => {
      requests++;
      if (!hold) return route.continue();
      await new Promise<void>(resolve => releases.push(resolve));
      return route.continue();
    });
    await page.goto((await link.json()).path);
    await page.getByRole('textbox', { name: /^Your name\b/ }).fill('Buffered Tester');
    await page.locator('.diary-recording-consent input').check();
    await page.getByRole('button', { name: 'Watch and begin' }).click();
    await expect.poll(() => requests).toBeGreaterThan(0);
    await page.clock.fastForward(18001);
    await expect(page.getByRole('alert')).toContainText('could not continue loading');
    await expect(page.getByRole('button', { name: 'Retry film' })).toBeVisible();
    let starts = 0;
    page.on('request', request => { if (request.url().includes('/api/diary/play/') && request.method() === 'POST') starts++; });
    hold = false;
    await page.getByRole('button', { name: 'Retry film' }).click();
    for (const release of releases) release();
    await expect.poll(() => page.locator('.diary-cinema-video').evaluate(element => (element as HTMLVideoElement).readyState), { timeout: 15000 }).toBeGreaterThanOrEqual(3);
    expect(starts).toBe(0);
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
      await expect(blind.getByRole('heading', { name: "Harry Potter: Riddle's Diary" })).toBeVisible();
      await expect(blind.getByRole('link', { name: 'View the source video on YouTube' })).toHaveAttribute('href', 'https://www.youtube.com/watch?v=AhefV0t5wSA');
      await blind.setViewportSize({ width: 390, height: 844 });
      await blind.screenshot({ path: 'verification/riddle-diary-prologue-blind-mobile.png', fullPage: false, animations: 'disabled' });
      let blindStarts = 0;
      blind.on('request', request => { if (request.url().includes('/api/diary/play/') && request.method() === 'POST') blindStarts++; });
      expect(blindStarts).toBe(0);
      await expect(blind.getByRole('navigation', { name: 'Main navigation' })).toHaveCount(0);
      expect((await blind.request.get('/api/diary/latest')).status()).toBe(401);
      await expect(blind.getByRole('textbox', { name: /^Your name\b/ })).toHaveValue('');
      const watch = blind.getByRole('button', { name: 'Watch and begin' });
      await expect(watch).toBeDisabled();
      await blind.getByRole('textbox', { name: /^Your name\b/ }).fill('Blind Ink Tester');
      await blind.locator('.diary-recording-consent input').check();
      const startedResponse = blind.waitForResponse(response => response.url().includes('/api/diary/play/') && response.request().method() === 'POST');
      await blind.getByRole('button', { name: 'Begin without film' }).click();
      const started = await (await startedResponse).json();
      expect(blindStarts).toBe(1);
      const roundId = started.round.id as string;
      await expect(blind.getByRole('region', { name: 'Interactive diary session' })).toBeVisible();
      await expect(blind.getByLabel('Ask the diary')).toBeVisible();
      await blind.getByLabel('Ask the diary').fill('What did the school award say?');
      await blind.getByRole('button', { name: 'Send question' }).click();
      await blind.getByRole('button', { name: 'Full conversation' }).click();
      await expect(blind.getByRole('dialog', { name: 'Full conversation' }).locator('.diary-transcript-item').last()).toContainText('Special Services to the School');
      await blind.getByRole('button', { name: 'Close full conversation' }).click();

      const secondContext = await browser.newContext({ baseURL: 'http://127.0.0.1:4323' });
      try {
        const second = await secondContext.newPage();
        await second.goto(blindPath);
        await expect(second.getByRole('heading', { name: "Harry Potter: Riddle's Diary" })).toBeVisible();
        await expect(second.getByRole('textbox', { name: /^Your name\b/ })).toHaveValue('');
        await expect(second.locator('.diary-recording-consent input')).not.toBeChecked();
        await expect(second.getByLabel('Ask the diary')).toHaveCount(0);
      } finally { await secondContext.close(); }

      const resumed = blind.waitForResponse(response => response.url().endsWith(`/api/diary/rounds/${roundId}`) && response.request().method() === 'GET');
      await blind.reload();
      await resumed;
      await expect(blind.getByLabel('Ask the diary')).toHaveValue('');
      await blind.getByRole('button', { name: 'Latest entry', exact: true }).click();
      await expect(blind.locator('.diary-entry.from-diary').last()).toContainText(/whom to trust\./);
      await blind.getByRole('button', { name: 'Previous', exact: true }).click();
      await expect(blind.locator('.diary-page.mobile-page-current .diary-entry.from-reader')).toContainText('What did the school award say?');
      await blind.getByRole('button', { name: 'Latest entry', exact: true }).click();
    await blind.getByRole('button', { name: 'Full conversation' }).click();
    await expect(blind.getByRole('dialog', { name: 'Full conversation' }).locator('.diary-transcript-item').last()).toContainText(/Special Services to the School/);
      expect((await blind.request.get('/api/diary/latest')).status()).toBe(401);
    } finally { await blindContext.close(); }
  });

  test('an earlier frozen blind link is labeled honestly and has no new-start form', async ({ page }) => {
    await signInOwner(page.request);
    const response = await page.request.post('/api/diary/links', { data: { profileId: 'story' } });
    expect(response.ok()).toBeTruthy();
    const blindPath = (await response.json()).path as string;
    await page.route('**/api/diary/play/**', async route => {
      const upstream = await route.fetch();
      const payload = await upstream.json();
      payload.profile.sceneVersion = 1;
      await route.fulfill({ response: upstream, json: payload });
    });
    let starts = 0;
    page.on('request', request => { if (request.url().includes('/api/diary/play/') && request.method() === 'POST') starts++; });
    await page.goto(blindPath);
    await expect(page.getByRole('note')).toContainText('Earlier workshop version. Its authored clues differ from the story.');
    await expect(page.getByRole('heading', { name: "Harry Potter: Riddle's Diary" })).toHaveCount(1);
    await expect(page.getByRole('textbox', { name: /^Your name\b/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Open the diary' })).toHaveCount(0);
    expect(starts).toBe(0);
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
    const original = 'What did the award say about the school?';
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
    await expect(page.getByRole('button', { name: 'Play again', exact: true })).toBeDisabled();
    await expect(page.locator('.diary-expired-note')).toBeVisible();
    await page.screenshot({ path: 'verification/riddle-diary-expiry-390x600.png', fullPage: false, animations: 'disabled' });
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
    await expect(page.getByRole('dialog', { name: 'Full conversation' })).toContainText(/I was honoured for Special Services to the School after Hagrid was blamed/i);
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
    test.setTimeout(90000);
    test.setTimeout(90000);
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
        content: `Question ${index}: what did the school recognize?\n\n${'I want to keep the account precise. '.repeat(5)}café, 校, 𠀀, and e\u0301.`, timestamp: Date.now(),
      });
      original.push({
        id: `pagination-reply-${index}`, role: 'assistant',
        content: `Reply ${index}. The school recognized Riddle after Hagrid was blamed.\n\n${'The account in the diary follows the evidence presented to the school. '.repeat(index === 3 ? 18 : 7)}\n\nA long word must still wrap: ${'校𠀀'.repeat(index === 4 ? 80 : 9)}.\n\nThe final sentence of reply ${index}.`, timestamp: Date.now(),
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
    const focusedComposer = await page.getByLabel('Ask the diary').evaluate(element => {
      const input = getComputedStyle(element);
      const paper = getComputedStyle(element.parentElement!);
      return { focused: document.activeElement === element, outline: input.outlineStyle, shadow: input.boxShadow, borderWidth: input.borderWidth, paperRule: paper.borderBottomWidth };
    });
    expect(focusedComposer).toEqual({ focused: true, outline: 'none', shadow: 'none', borderWidth: '0px', paperRule: '1px' });
    await page.screenshot({ path: 'verification/riddle-diary-composer-focused.png', fullPage: false, animations: 'disabled' });

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
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole('button', { name: 'Readable text', exact: true }).click();
    const reflowStarted = Date.now();
    await page.setViewportSize({ width: 390, height: 600 });
    const navigation = page.getByRole('navigation', { name: 'Book pages' });
    const mobilePageCount = async () => {
      const label = await navigation.locator('span').innerText();
      return Number(label.match(/of (\d+)$/)?.[1] || 0);
    };
    await expect.poll(mobilePageCount, { timeout: 5000 }).toBeGreaterThan(0);
    expect(Date.now() - reflowStarted).toBeLessThan(5000);
    expect(await mobilePageCount()).toBeLessThan(500);
    await navigation.getByRole('button', { name: 'First page', exact: true }).click();
    const readableSegments = new Map(original.map(message => [message.id, [] as Array<{ start: number; end: number; text: string }>]));
    let reflowPageCount = 0;
    let priorReadableMessage = 0;
    for (;;) {
      const visibleEntries = page.locator('.diary-page.mobile-page-current .diary-entry');
      await expect(visibleEntries.first()).toBeVisible();
      const segments = await visibleEntries.evaluateAll(nodes => nodes.map(node => {
        const text = node.querySelector<HTMLElement>('p[aria-hidden="true"], p.diary-reader-text, p.diary-ink-text')!;
        const bounds = node.getBoundingClientRect();
        const paper = node.closest('.diary-page-scroll')!.getBoundingClientRect();
        return { id: node.getAttribute('data-message-id')!, start: Number(node.getAttribute('data-offset-start')), end: Number(node.getAttribute('data-offset-end')), text: text.textContent ?? '', bottom: bounds.bottom, paperBottom: paper.bottom, right: text.getBoundingClientRect().right, paperRight: paper.right, scrollWidth: text.scrollWidth, width: text.clientWidth };
      }));
      for (const segment of segments) {
        const source = original.find(item => item.id === segment.id)!;
        const sourceIndex = original.indexOf(source);
        expect(sourceIndex).toBeGreaterThanOrEqual(priorReadableMessage);
        priorReadableMessage = sourceIndex;
        expect(segment.text).toBe(source.content.slice(segment.start, segment.end));
        expect(segment.bottom).toBeLessThanOrEqual(segment.paperBottom + 2);
        expect(segment.right).toBeLessThanOrEqual(segment.paperRight + 2);
        expect(segment.scrollWidth).toBeLessThanOrEqual(segment.width + 2);
        readableSegments.get(segment.id)!.push({ start: segment.start, end: segment.end, text: segment.text });
      }
      const next = navigation.getByRole('button', { name: 'Next', exact: true });
      if (await next.isDisabled()) break;
      await next.click();
      expect(++reflowPageCount).toBeLessThan(500);
    }
    for (const item of original) {
      const pieces = readableSegments.get(item.id)!;
      let offset = 0;
      for (const piece of pieces) { expect(piece.start).toBe(offset); offset = piece.end; }
      expect(offset).toBe(item.content.length);
      expect(pieces.map(piece => piece.text).join('')).toBe(item.content);
    }
    await expect(page.getByLabel('Ask the diary')).toHaveValue('Keep this draft while reading.');
    await page.screenshot({ path: 'verification/riddle-diary-reflow-390x600-readable.png', fullPage: false, animations: 'disabled' });
    expect(modelRequests).toBe(0);
    expect(pageErrors).toEqual([]);
  });

  test('replay after expiry preserves the selected member profile and blind name and consent', async ({ page, browser }) => {
    test.setTimeout(60000);
    await signInOwner(page.request);
    const firstRoundResponse = await page.request.post('/api/diary/start', { data: { profileId: 'guarded' } });
    expect(firstRoundResponse.ok()).toBe(true);
    const firstRound = await firstRoundResponse.json();
    const originalMemberId = firstRound.round.id as string;
    const originalMemberMessages = firstRound.round.messages;
    await page.route('**/api/diary/active', async route => {
      const response = await route.fetch();
      const active = await response.json();
      if (active?.round?.id === originalMemberId) active.round.deadline = Date.now() - 1000;
      await route.fulfill({ response, json: active });
    });
    let memberStarts = 0, modelRequests = 0;
    page.on('request', request => {
      if (request.url().endsWith('/api/diary/start') && request.method() === 'POST') memberStarts++;
      if (request.url().includes('/messages') && request.method() === 'POST') modelRequests++;
    });
    await page.goto('/diary');
    await expect(page.getByRole('button', { name: 'Play again', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Play again', exact: true }).click();
    await expect(page.getByRole('radio', { name: /Guarded/ })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByRole('button', { name: 'Begin without film', exact: true })).toBeVisible();
    expect(memberStarts).toBe(0);
    await page.reload();
    await expect(page.getByRole('button', { name: 'Begin without film', exact: true })).toBeVisible();
    await expect(page.getByLabel('Ask the diary')).toHaveCount(0);
    expect(memberStarts).toBe(0);
    const nextMemberResponse = page.waitForResponse(response => response.url().endsWith('/api/diary/start') && response.request().method() === 'POST' && response.ok());
    await page.getByRole('button', { name: 'Begin without film', exact: true }).click();
    const nextMember = await (await nextMemberResponse).json();
    const nextMemberId = nextMember.round.id as string;
    expect(nextMemberId).not.toBe(originalMemberId);
    expect(memberStarts).toBe(1);
    expect(nextMember.round.messages).toHaveLength(1);
    expect(nextMember.diary.profileId || nextMember.diary.id).toBe('guarded');
    await expect(page.getByLabel('Ask the diary')).toBeVisible();
    await page.evaluate(({ previousRoundId }) => {
      sessionStorage.setItem('workshop-diary-start-intent:member', JSON.stringify({ previousRoundId, profileId: 'guarded', requestedAt: Date.now() }));
      sessionStorage.setItem('workshop-diary-start-unknown:member', 'unknown');
    }, { previousRoundId: originalMemberId });
    await page.reload();
    await expect(page.getByLabel('Ask the diary')).toBeVisible();
    await expect(page.getByRole('alertdialog', { name: 'Check before continuing' })).toHaveCount(0);
    const stillFiledOrUnchanged = await (await page.request.get(`/api/diary/rounds/${originalMemberId}`)).json();
    expect(stillFiledOrUnchanged.round.id).toBe(originalMemberId);
    expect(stillFiledOrUnchanged.round.messages).toEqual(originalMemberMessages);
    expect(modelRequests).toBe(0);

    // Simulate an expired prior round and a start whose response is lost before it reaches
    // the server. After refresh the still-visible prior round must not be mistaken for B.
    await page.route('**/api/diary/active', async route => {
      const response = await route.fetch();
      const active = await response.json();
      if (active?.round?.id === nextMemberId) active.round.deadline = Date.now() - 1000;
      await route.fulfill({ response, json: active });
    });
    await page.reload();
    await expect(page.getByRole('button', { name: 'Play again', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Play again', exact: true }).click();
    await page.reload();
    await expect(page.getByRole('button', { name: 'Begin without film', exact: true })).toBeVisible();
    await page.route('**/api/diary/start', route => route.abort('failed'));
    await page.getByRole('button', { name: 'Begin without film', exact: true }).click();
    await expect(page.getByRole('alertdialog', { name: 'Check before continuing' })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('alertdialog', { name: 'Check before continuing' })).toBeVisible();
    await expect(page.getByLabel('Ask the diary')).toHaveCount(0);
    expect((await (await page.request.get('/api/diary/active')).json()).round.id).toBe(nextMemberId);

    const linkResponse = await page.request.post('/api/diary/links', { data: { profileId: 'story' } });
    expect(linkResponse.ok()).toBe(true);
    const blindPath = (await linkResponse.json()).path as string;
    const blindContext = await browser.newContext({ baseURL: 'http://127.0.0.1:4323' });
    const blind = await blindContext.newPage();
    try {
      await blind.clock.install({ time: new Date() });
      let blindStarts = 0, blindModelRequests = 0;
      blind.on('request', request => {
        if (request.url().includes('/api/diary/play/') && request.method() === 'POST') blindStarts++;
        if (request.url().includes('/messages') && request.method() === 'POST') blindModelRequests++;
      });
      await blind.goto(blindPath);
      await blind.getByRole('textbox', { name: /^Your name\b/ }).fill('Replay Ink Tester');
      await blind.locator('.diary-recording-consent input').check();
      const firstBlindResponse = blind.waitForResponse(response => response.url().includes('/api/diary/play/') && response.request().method() === 'POST' && response.ok());
      await blind.getByRole('button', { name: 'Begin without film', exact: true }).click();
      const firstBlind = await (await firstBlindResponse).json();
      const originalBlindId = firstBlind.round.id as string;
      const originalBlindToken = firstBlind.round.accessToken as string;
      await blind.clock.fastForward(6 * 60 * 1000);
      await expect(blind.getByRole('button', { name: 'Play again', exact: true })).toBeVisible();
      await blind.getByRole('button', { name: 'Play again', exact: true }).click();
      await expect(blind.getByRole('textbox', { name: /^Your name\b/ })).toHaveValue('Replay Ink Tester');
      await expect(blind.locator('.diary-recording-consent input')).toBeChecked();
      expect(blindStarts).toBe(1);
      await blind.reload();
      await expect(blind.getByRole('textbox', { name: /^Your name\b/ })).toHaveValue('Replay Ink Tester');
      await expect(blind.locator('.diary-recording-consent input')).toBeChecked();
      await expect(blind.getByLabel('Ask the diary')).toHaveCount(0);
      const secondBlindResponse = blind.waitForResponse(response => response.url().includes('/api/diary/play/') && response.request().method() === 'POST' && response.ok());
      await blind.getByRole('button', { name: 'Begin without film', exact: true }).click();
      const secondBlind = await (await secondBlindResponse).json();
      expect(secondBlind.round.id).not.toBe(originalBlindId);
      expect(blindStarts).toBe(2);
      expect(secondBlind.round.messages).toHaveLength(1);
      const oldBlind = await (await blind.request.get(`/api/diary/rounds/${originalBlindId}`, { headers: { 'x-round-token': originalBlindToken } })).json();
      expect(oldBlind.round.id).toBe(originalBlindId);
      expect(oldBlind.round.messages).toEqual(firstBlind.round.messages);
      expect(blindModelRequests).toBe(0);
    } finally { await blindContext.close(); }
  });
});
