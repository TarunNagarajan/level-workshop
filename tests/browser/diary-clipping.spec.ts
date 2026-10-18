import { test, expect } from '@playwright/test';
import { signInOwner } from './auth';

test('diary page segments reflow within the paper and continue from the saved offset', async ({ page }) => {
  test.setTimeout(90000);
  await signInOwner(page.request);
  const started = await page.request.post('/api/diary/start', { data: { profileId: 'story' } });
  expect(started.ok()).toBeTruthy();
  const session = await started.json();
  session.state.diaryOpen = true;
  session.round.deadline = Date.now() + 60 * 60 * 1000;
  const opening = session.round.messages;
  const question = {
    id: 'clipping-question', role: 'user', opening: false,
    content: `Could you explain every detail in the account? ${'The school gave a reason for its decision, and I want the whole account. '.repeat(26)}\n\nQuestion closes here.`, timestamp: Date.now(),
  };
  const original = {
    id: 'clipping-reply', role: 'assistant', opening: false,
    content: `${'The diary describes what happened when the school blamed Hagrid. '.repeat(28)}\n\nA long token must wrap without losing any characters: ${'校𠀀'.repeat(45)}.\n\nA specially crafted final sentence should remain complete across the page turn.`, timestamp: Date.now(),
  };
  const messages = [...opening, question, original];
  session.round.messages = messages;
  await page.route('**/api/diary/active', route => route.fulfill({ json: session }));
  const replyPosts: string[] = [];
  page.on('request', request => {
    if (request.method() === 'POST' && /\/rounds\/[^/]+\/messages$/.test(new URL(request.url()).pathname)) replyPosts.push(request.url());
  });
  await page.goto('/diary');
  await expect(page.getByLabel('Ask the diary')).toBeVisible();
  await page.getByLabel('Ask the diary').fill('Keep this draft while reading.');

  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 1920, height: 1080 },
    { width: 1024, height: 768 },
    { width: 390, height: 844 },
    { width: 390, height: 600 },
    { width: 844, height: 390 },
    { width: 844, height: 530 },
  ]) {
    console.log(`Checking ${viewport.width}×${viewport.height}`);
    await page.setViewportSize(viewport);
    const navigation = page.getByRole('navigation', { name: 'Book pages' });
    const firstPage = navigation.getByRole('button', { name: 'First page', exact: true });
    if (!(await firstPage.isDisabled())) await firstPage.click();
    const mobile = viewport.width <= 640;
    const activeHeading = page.locator(mobile ? '.diary-page.mobile-page-current .diary-page-heading' : '.diary-page-left .diary-page-heading');
    await activeHeading.scrollIntoViewIfNeeded();
    if (viewport.width === 844) {
      await page.locator('.diary-page-left .diary-page-heading').scrollIntoViewIfNeeded();
      const onBookNext = page.getByRole('navigation', { name: 'Turn diary spreads' }).getByRole('button', { name: 'Next spread', exact: true });
      const bounds = await onBookNext.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.y).toBeGreaterThanOrEqual(0);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height);
      if (!(await onBookNext.isDisabled())) {
        await onBookNext.click();
        await expect(navigation.locator('span')).toHaveText(/^Pages 3[–-]4/);
      }
      if (!(await navigation.getByRole('button', { name: 'First page', exact: true }).isDisabled())) await navigation.getByRole('button', { name: 'First page', exact: true }).click();
    }
    if (viewport.width === 390 && viewport.height === 600 || viewport.width === 844 || viewport.width === 1440) {
      const activePage = mobile ? '.diary-page.mobile-page-current' : '.diary-page-left';
      const layout = await page.locator(activePage).evaluate(node => {
        const heading = node.querySelector<HTMLElement>('.diary-page-heading')!;
        const nav = heading.querySelector<HTMLElement>('.diary-on-book-turns')!;
        const labels = [...heading.children].filter(child => child !== nav).map(child => child.getBoundingClientRect());
        const buttons = [...nav.querySelectorAll('button')].map(button => button.getBoundingClientRect());
        const firstEntry = [...node.querySelectorAll<HTMLElement>('.diary-entry')].find(entry => entry.getBoundingClientRect().height > 0)!;
        const firstInk = firstEntry.querySelector<HTMLElement>('.diary-ink-text, .diary-reader-text')!.getBoundingClientRect();
        return { labels: labels.map(rect => ({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom })), buttons: buttons.map(rect => ({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom })), firstInkTop: firstInk.top };
      });
      const headingHeights = await page.locator('.diary-page-heading').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().height));
      expect(Math.max(...headingHeights) - Math.min(...headingHeights)).toBeLessThanOrEqual(1);
      expect(layout.buttons).toHaveLength(2);
      for (const button of layout.buttons) {
        for (const label of layout.labels) expect(button.right <= label.left || button.left >= label.right || button.bottom <= label.top || button.top >= label.bottom).toBeTruthy();
        expect(button.bottom).toBeLessThanOrEqual(layout.firstInkTop + 1);
      }
    }
    const selector = mobile ? '.diary-page.mobile-page-current .diary-entry' : '.diary-page .diary-entry';
    const all = new Map(messages.map(message => [message.id, [] as Array<{ start: number; end: number; text: string }> ]));
    let turns = 0;
    for (;;) {
      await expect(page.locator(selector).first()).toBeVisible();
      const measurements = await page.locator(selector).evaluateAll(nodes => nodes.filter(node => node.closest('.diary-page-scroll') && getComputedStyle(node).visibility !== 'hidden').map(node => {
        const paper = node.closest('.diary-page-scroll')!;
        const bounds = node.getBoundingClientRect();
        const paperBounds = paper.getBoundingClientRect();
        const text = node.querySelector<HTMLElement>('p[aria-hidden="true"], p.diary-reader-text, p.diary-ink-text')!;
        return {
          id: node.getAttribute('data-message-id')!,
          start: Number(node.getAttribute('data-offset-start')),
          end: Number(node.getAttribute('data-offset-end')),
          text: text.textContent ?? '',
          top: bounds.top,
          bottom: bounds.bottom,
          paperTop: paperBounds.top,
          paperBottom: paperBounds.bottom,
          textRight: text.getBoundingClientRect().right,
          paperRight: paperBounds.right,
          scrollWidth: text.scrollWidth,
          textWidth: text.clientWidth,
        };
      }));
      expect(measurements.length, `visible entries at ${viewport.width}×${viewport.height}`).toBeGreaterThan(0);
      for (const segment of measurements) {
        const message = messages.find(candidate => candidate.id === segment.id)!;
        expect(segment.text).toBe(message.content.slice(segment.start, segment.end));
        expect(segment.top).toBeGreaterThanOrEqual(segment.paperTop - 2);
        expect(segment.bottom, `entry exceeds page at ${viewport.width}×${viewport.height}: ${JSON.stringify(segment)}`).toBeLessThanOrEqual(segment.paperBottom + 2);
        expect(segment.textRight).toBeLessThanOrEqual(segment.paperRight + 2);
        expect(segment.scrollWidth).toBeLessThanOrEqual(segment.textWidth + 2);
        all.get(message.id)!.push({ start: segment.start, end: segment.end, text: segment.text });
      }
      const next = navigation.getByRole('button', { name: 'Next', exact: true });
      if (await next.isDisabled()) break;
      await next.click();
      expect(++turns).toBeLessThan(300);
    }
    for (const message of messages) {
      const pieces = all.get(message.id)!;
      expect(pieces.length).toBeGreaterThan(0);
      let offset = 0;
      for (const piece of pieces) { expect(piece.start).toBe(offset); offset = piece.end; }
      expect(offset).toBe(message.content.length);
      expect(pieces.map(piece => piece.text).join('')).toBe(message.content);
    }
    if (viewport.width === 844) {
      const bookWidth = await page.locator('.diary-open-book').evaluate(node => node.getBoundingClientRect().width);
      expect(bookWidth).toBeGreaterThan(600);
      await page.screenshot({ path: `verification/diary-clipping-${viewport.width}x${viewport.height}.png`, fullPage: false, animations: 'disabled' });
    }
    await expect(page.getByLabel('Ask the diary')).toHaveValue('Keep this draft while reading.');
  }

  await page.setViewportSize({ width: 390, height: 600 });
  const navigation = page.getByRole('navigation', { name: 'Book pages' });
  await page.getByRole('button', { name: 'Readable text', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Handwritten view', exact: true })).toBeVisible();
  await navigation.getByRole('button', { name: 'First page', exact: true }).click();
  const readable = new Map(messages.map(message => [message.id, [] as Array<{ start: number; end: number; text: string }> ]));
  let readableTurns = 0;
  for (;;) {
    const entries = page.locator('.diary-page.mobile-page-current .diary-entry');
    const segments = await entries.evaluateAll(nodes => nodes.map(node => {
      const paper = node.closest('.diary-page-scroll')!;
      const bounds = node.getBoundingClientRect();
      const paperBounds = paper.getBoundingClientRect();
      const text = node.querySelector<HTMLElement>('p[aria-hidden="true"], p.diary-reader-text, p.diary-ink-text')!;
      return { id: node.getAttribute('data-message-id')!, start: Number(node.getAttribute('data-offset-start')), end: Number(node.getAttribute('data-offset-end')), text: text.textContent ?? '', bottom: bounds.bottom, paperBottom: paperBounds.bottom, right: text.getBoundingClientRect().right, paperRight: paperBounds.right, scrollWidth: text.scrollWidth, textWidth: text.clientWidth };
    }));
    for (const segment of segments) {
      const source = messages.find(message => message.id === segment.id)!;
      expect(segment.text).toBe(source.content.slice(segment.start, segment.end));
      expect(segment.bottom).toBeLessThanOrEqual(segment.paperBottom + 2);
      expect(segment.right).toBeLessThanOrEqual(segment.paperRight + 2);
      expect(segment.scrollWidth).toBeLessThanOrEqual(segment.textWidth + 2);
      readable.get(source.id)!.push({ start: segment.start, end: segment.end, text: segment.text });
    }
    const next = navigation.getByRole('button', { name: 'Next', exact: true });
    if (await next.isDisabled()) break;
    await next.click();
    expect(++readableTurns).toBeLessThan(300);
  }
  for (const message of messages) {
    const pieces = readable.get(message.id)!;
    let offset = 0;
    for (const piece of pieces) { expect(piece.start).toBe(offset); offset = piece.end; }
    expect(offset).toBe(message.content.length);
    expect(pieces.map(piece => piece.text).join('')).toBe(message.content);
  }
  await expect(page.getByLabel('Ask the diary')).toHaveValue('Keep this draft while reading.');

  for (const item of [question, original]) {
    await navigation.getByRole('button', { name: 'First page', exact: true }).click();
    let segment = page.locator(`.diary-page.mobile-page-current [data-message-id="${item.id}"]`).first();
    for (let turn = 0; !(await segment.getByRole('button', { name: new RegExp(`Continue ${item.role === 'assistant' ? 'reply' : 'question'} on page`) }).count()); turn += 1) {
      expect(turn).toBeLessThan(80);
      await navigation.getByRole('button', { name: 'Next', exact: true }).click();
      segment = page.locator(`.diary-page.mobile-page-current [data-message-id="${item.id}"]`).first();
    }
    const firstEnd = Number(await segment.getAttribute('data-offset-end'));
    expect(firstEnd).toBeLessThan(item.content.length);
    const actionName = new RegExp(`Continue ${item.role === 'assistant' ? 'reply' : 'question'} on page`);
    const cue = segment.getByRole('button', { name: actionName });
    expect(await cue.getAttribute('aria-label')).toMatch(/page \d+$/);
    await cue.focus();
    await page.keyboard.press('Enter');
    const continuation = page.locator(`.diary-page.mobile-page-current [data-message-id="${item.id}"][data-offset-start="${firstEnd}"]`);
    await expect(continuation).toBeVisible();
    await expect.poll(() => page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.offsetStart)).toBe(String(firstEnd));
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await navigation.getByRole('button', { name: 'First page', exact: true }).click();
  let facingPageCue = page.locator('.diary-page-left .diary-entry-continuation-link').first();
  for (let turn = 0; !(await facingPageCue.count()); turn += 1) {
    expect(turn).toBeLessThan(80);
    await navigation.getByRole('button', { name: 'Next', exact: true }).click();
    facingPageCue = page.locator('.diary-page-left .diary-entry-continuation-link').first();
  }
  const sourceEntry = facingPageCue.locator('xpath=ancestor::article');
  const sourceId = await sourceEntry.getAttribute('data-message-id');
  const nextOffset = Number(await sourceEntry.getAttribute('data-offset-end'));
  const sourcePage = Number((await facingPageCue.evaluate(element => element.closest('.diary-page')?.getAttribute('aria-label')) || '').match(/(\d+)$/)?.[1]);
  const destinationPage = Number((await facingPageCue.getAttribute('aria-label') || '').match(/page (\d+)$/)?.[1]);
  expect(destinationPage).toBe(sourcePage + 1);
  await facingPageCue.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator(`.diary-page-right [data-message-id="${sourceId}"][data-offset-start="${nextOffset}"]`)).toBeVisible();
  await expect.poll(() => page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.offsetStart)).toBe(String(nextOffset));
  await expect(page.getByLabel('Ask the diary')).toHaveValue('Keep this draft while reading.');
  expect(replyPosts).toEqual([]);

  await page.getByRole('button', { name: 'Handwritten view', exact: true }).click();
  await page.getByRole('button', { name: 'Quick', exact: true }).click();
  const animatedReply = {
    id: 'clipping-animated-reply', role: 'assistant', opening: false,
    content: `${'The handwriting remains inside the page while the diary reveals each part. '.repeat(48)}\n\nThe reply ends with a complete sentence.`, timestamp: Date.now(),
  };
  const submittedQuestion = { id: 'clipping-animated-question', role: 'user', opening: false, content: '[local mocked reply]', timestamp: Date.now() };
  const mockedRound = { ...session.round, messages: [...messages, submittedQuestion, animatedReply] };
  await page.route(url => url.pathname.endsWith('/messages'), route => route.fulfill({ status: 200, json: mockedRound }));
  const mockedResponse = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/messages'));
  await page.getByLabel('Ask the diary').fill('[local mocked reply]');
  await page.getByLabel('Ask the diary').press('Enter');
  await mockedResponse;
  await expect(page.locator(`[data-message-id="${animatedReply.id}"] .is-writing`).first()).toBeVisible();
  const skipReply = page.getByRole('button', { name: 'Show entire reply', exact: true });
  await expect(skipReply).toHaveCount(1);
  const animatedSegments = await page.locator(`.diary-page [data-message-id="${animatedReply.id}"]`).evaluateAll(nodes => nodes.filter(node => {
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && getComputedStyle(node.closest('.diary-page')!).visibility !== 'hidden';
  }).map(node => {
    const entry = node.getBoundingClientRect();
    const paper = node.closest('.diary-page-scroll')!.getBoundingClientRect();
    return { start: Number(node.getAttribute('data-offset-start')), end: Number(node.getAttribute('data-offset-end')), text: node.querySelector('.diary-ink-text')?.textContent ?? '', top: entry.top, bottom: entry.bottom, paperTop: paper.top, paperBottom: paper.bottom, hasCue: Boolean(node.querySelector('.diary-entry-continuation-link')) };
  }));
  expect(animatedSegments.length).toBeGreaterThan(0);
  for (const segment of animatedSegments) {
    expect(segment.text).toBe(animatedReply.content.slice(segment.start, segment.end));
    expect(segment.top).toBeGreaterThanOrEqual(segment.paperTop - 2);
    expect(segment.bottom).toBeLessThanOrEqual(segment.paperBottom + 2);
  }
  expect(animatedSegments.some(segment => segment.hasCue)).toBeTruthy();
  await expect(skipReply).toHaveCount(0, { timeout: 8000 });
  await expect(page.locator(`[data-message-id="${animatedReply.id}"] .diary-entry-continuation-link`).first()).toBeVisible();
  expect(replyPosts).toEqual([`http://127.0.0.1:4398/api/rounds/${session.round.id}/messages`]);
});
