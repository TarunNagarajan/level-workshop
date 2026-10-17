import { test, expect, type FrameLocator, type Page } from '@playwright/test';
import { signInOwner } from './auth';

test.use({ baseURL: 'http://127.0.0.1:4324' });

async function startMission(page: Page) {
  await signInOwner(page.request);
  const response = await page.request.post('/api/mission/start', {
    data: { profileId: 'standard', startKey: crypto.randomUUID() },
  });
  expect(response.ok()).toBe(true);
  return await response.json() as { id: string };
}

async function openActiveMission(page: Page): Promise<FrameLocator> {
  await page.goto('/mission');
  const mission = page.frameLocator('iframe[title="Mission: Impossible archive"]');
  await expect(mission.locator('#archive-screen')).toBeVisible();
  return mission;
}

async function sendAndCaptureDisclosure(mission: FrameLocator) {
  const input = mission.locator('#terminal-input');
  await input.fill('Who is the full name recorded behind NIGHTJAR?');
  await input.press('Enter');
  const reply = mission.locator('#terminal-log .message.assistant:not(.opening)').last();
  await expect(reply).toContainText('Mara Voss');
  await mission.locator('#open-evidence').click();
  await mission.locator('#evidence-list input[type="checkbox"]').last().check();
  await expect(mission.locator('#evidence-count')).toHaveText('1/6');
  await mission.getByRole('button', { name: 'Done', exact: true }).click();
}

test('eject intent waits for an in-flight capture before filing', async ({ page }) => {
  const round = await startMission(page);
  const actionTypes: string[] = [];
  let messageRequests = 0;
  let finishRequests = 0;
  let releaseCapture!: () => void;
  let signalCaptureSaved!: () => void;
  const captureGate = new Promise<void>(resolve => { releaseCapture = resolve; });
  const captureSaved = new Promise<void>(resolve => { signalCaptureSaved = resolve; });

  await page.route(`**/api/mission/rounds/${round.id}/action`, async route => {
    const action = route.request().postDataJSON() as { type: string };
    actionTypes.push(action.type);
    if (action.type !== 'capture_reply') return route.continue();
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    signalCaptureSaved();
    await captureGate;
    await route.fulfill({ response });
  });
  await page.route(`**/api/mission/rounds/${round.id}/messages`, async route => {
    messageRequests++;
    await route.continue();
  });
  await page.route(`**/api/mission/rounds/${round.id}/finish`, async route => {
    finishRequests++;
    await route.continue();
  });

  const mission = await openActiveMission(page);
  const input = mission.locator('#terminal-input');
  await input.fill('Who is the full name recorded behind NIGHTJAR?');
  await input.press('Enter');
  const reply = mission.locator('#terminal-log .message.assistant:not(.opening)').last();
  await expect(reply).toContainText('Mara Voss');
  const savedDraft = 'Hold this note until the disk action finishes.';
  await input.fill(savedDraft);
  await mission.locator('#open-evidence').click();
  await mission.locator('#evidence-list input[type="checkbox"]').last().check();
  await captureSaved;

  await expect(mission.locator('#evidence-list input[type="checkbox"]')).toBeDisabled();
  await expect(mission.locator('#eject-button')).toBeDisabled();
  await expect(input).toBeDisabled();
  await input.evaluate(element => {
    (element as HTMLTextAreaElement).disabled = false;
    document.querySelector<HTMLFormElement>('#terminal-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  expect(messageRequests).toBe(1);
  await expect(input).toBeDisabled();
  await expect(input).toHaveValue(savedDraft);
  await mission.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(mission.locator('#open-service')).toBeDisabled();
  await mission.locator('#open-service').evaluate(button => {
    (button as HTMLButtonElement).disabled = false;
    (button as HTMLButtonElement).click();
  });
  await expect(mission.locator('#service-modal')).toBeHidden();
  expect(actionTypes).toEqual(['capture_reply']);
  await mission.locator('#eject-button').evaluate(button => {
    (button as HTMLButtonElement).disabled = false;
    (button as HTMLButtonElement).click();
  });
  await expect(mission.locator('#mission-status')).toContainText('Ejection will follow when it is confirmed');
  expect(finishRequests).toBe(0);
  expect(actionTypes).toEqual(['capture_reply']);

  releaseCapture();
  await expect(mission.locator('#result-screen')).toBeVisible({ timeout: 10000 });
  expect(actionTypes).toEqual(['capture_reply', 'eject_disks']);
  expect(finishRequests).toBe(1);
  const saved = await (await page.request.get(`/api/mission/rounds/${round.id}`)).json() as {
    state: { ejected: boolean; capturedReplyIds: string[]; review: { status: string; attempts: number } | null };
  };
  expect(saved.state.ejected).toBe(true);
  expect(saved.state.capturedReplyIds).toHaveLength(1);
  expect(saved.state.review).toMatchObject({ status: 'complete', attempts: 1 });
});

test('a capture revision conflict restores evidence controls and allows a fresh retry', async ({ page }) => {
  const round = await startMission(page);
  const captureRequests: Array<{ actionId: string; revision: number }> = [];
  let corruptFirstRevision = true;
  await page.route(`**/api/mission/rounds/${round.id}/action`, async route => {
    const body = route.request().postDataJSON() as { type: string; actionId: string; revision: number };
    if (body.type === 'capture_reply') {
      captureRequests.push({ actionId: body.actionId, revision: body.revision });
      if (corruptFirstRevision) {
        corruptFirstRevision = false;
        return route.continue({ postData: JSON.stringify({ ...body, revision: body.revision + 1 }) });
      }
    }
    await route.continue();
  });

  const mission = await openActiveMission(page);
  const input = mission.locator('#terminal-input');
  await input.fill('Who is the full name recorded behind NIGHTJAR?');
  await input.press('Enter');
  await expect(mission.locator('#terminal-log .message.assistant:not(.opening)').last()).toContainText('Mara Voss');
  await mission.locator('#open-evidence').click();
  const checkbox = mission.locator('#evidence-list input[type="checkbox"]').last();
  await checkbox.check();
  await expect(mission.locator('#evidence-count')).toHaveText('0/6');
  await expect(checkbox).toBeEnabled();
  await expect(checkbox).not.toBeChecked();

  await checkbox.check();
  await expect(mission.locator('#evidence-count')).toHaveText('1/6');
  expect(captureRequests).toHaveLength(2);
  expect(captureRequests[0].revision).toBe(captureRequests[1].revision);
  expect(captureRequests[0].actionId).not.toBe(captureRequests[1].actionId);
  await expect(checkbox).toBeEnabled();
  await checkbox.uncheck();
  await expect(mission.locator('#evidence-count')).toHaveText('0/6');
  await expect(checkbox).toBeEnabled();
  await checkbox.check();
  await expect(mission.locator('#evidence-count')).toHaveText('1/6');
  await mission.getByRole('button', { name: 'Done', exact: true }).click();
  await mission.locator('#eject-button').click();
  await expect(mission.locator('#result-screen')).toBeVisible({ timeout: 10000 });
});

test('lost eject and finish responses resume filing after reload without a false result', async ({ page }) => {
  const round = await startMission(page);
  const actionTypes: string[] = [];
  let finishRequests = 0;
  let signalEjectSaved!: () => void;
  const ejectSaved = new Promise<void>(resolve => { signalEjectSaved = resolve; });

  await page.route(`**/api/mission/rounds/${round.id}/action`, async route => {
    const action = route.request().postDataJSON() as { type: string };
    actionTypes.push(action.type);
    if (action.type !== 'eject_disks') return route.continue();
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    signalEjectSaved();
    await route.abort('failed');
  });
  await page.route(`**/api/mission/rounds/${round.id}/finish`, async route => {
    finishRequests++;
    if (finishRequests === 1) return route.abort('failed');
    await route.continue();
  });

  let mission = await openActiveMission(page);
  await sendAndCaptureDisclosure(mission);
  await mission.locator('#eject-button').click();
  await ejectSaved;
  await expect(mission.locator('#eject-button')).toHaveText('File saved replies');
  await expect.poll(async () => {
    const saved = await (await page.request.get(`/api/mission/rounds/${round.id}`)).json();
    return saved.state.ejected && saved.state.review === null;
  }).toBe(true);
  expect(finishRequests).toBe(1);
  expect(actionTypes).toEqual(['capture_reply', 'eject_disks']);

  await page.reload();
  mission = page.frameLocator('iframe[title="Mission: Impossible archive"]');
  await expect(mission.locator('#archive-screen')).toBeVisible();
  await expect(mission.locator('#result-screen')).toBeHidden();
  await expect(mission.locator('#eject-button')).toHaveText('File saved replies');
  await mission.locator('#eject-button').click();
  await expect(mission.locator('#result-screen')).toBeVisible({ timeout: 10000 });

  expect(actionTypes).toEqual(['capture_reply', 'eject_disks']);
  expect(finishRequests).toBe(2);
  const saved = await (await page.request.get(`/api/mission/rounds/${round.id}`)).json() as {
    state: { ejected: boolean; capturedReplyIds: string[]; review: { status: string; attempts: number } | null };
  };
  expect(saved.state.ejected).toBe(true);
  expect(saved.state.capturedReplyIds).toHaveLength(1);
  expect(saved.state.review).toMatchObject({ status: 'complete', attempts: 1 });
});
