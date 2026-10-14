import 'dotenv/config';
import assert from 'node:assert/strict';
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { neon } from '@neondatabase/serverless';

if (process.stdin.isTTY) process.stdin.setRawMode(true);
const lines = createInterface({ input: process.stdin, terminal: false });
const input = await new Promise(resolve => lines.once('line', resolve)); lines.close();
const { ownerPath } = JSON.parse(input);
const origin = 'https://level-workshop.vercel.app';
const sql = neon(process.env.DATABASE_URL, { fullResults: true });
const browser = await chromium.launch();
const owner = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const peer = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await peer.newPage(); const errors = [];
page.on('pageerror', error => errors.push(error.message));
const report = { origin, checkedAt: new Date().toISOString(), checks: [] };
let ownerId, onboarding, changedOnboarding = false, linkId, roundId;
const api = async (context, path, method = 'GET', data) => {
  const response = await context.request.fetch(origin + '/api' + path, { method, ...(data === undefined ? {} : { data }) });
  const body = await response.json();
  if (!response.ok()) throw new Error(`${method} ${path.replace(/\/(owner|enter)\/.*/, '/$1/[private]')} failed (${response.status()}): ${body.error}`);
  return body;
};
try {
  assert.equal((await peer.request.get(origin + '/api/reference/design')).status(), 401);
  const entered = await api(owner, ownerPath, 'POST', { name: 'Workspace owner' }); ownerId = entered.user.id;
  onboarding = (await sql.query('SELECT * FROM onboarding WHERE user_id = $1', [ownerId])).rows[0];
  const bootstrap = await api(owner, '/bootstrap'); assert.equal(bootstrap.model.connected, true);
  if (!bootstrap.tutorialDone) { await api(owner, '/tutorial', 'PUT', { result: 'skipped' }); changedOnboarding = true; }
  const beforeThemes = (await api(owner, '/levels')).filter(row => row.id !== 'reference-passport-desk').map(row => ({ id: row.id, draft: row.draft, versions: row.versions }));
  const link = await api(owner, '/reference/links', 'POST', {}); linkId = link.id;
  const raw = link.path.split('/').at(-1);
  const config = await api(peer, `/reference/play/${raw}`);
  assert.equal(config.level.secret, undefined); assert.equal(config.level.systemPrompt, undefined);
  assert.equal(JSON.stringify(config).includes('Noah'), false);
  for (const name of ['background', 'passport-cover', 'open-book', 'stamp']) {
    const response = await peer.request.get(origin + `/reference-assets/${name}.webp`);
    assert.equal(response.status(), 200); assert.equal(response.headers()['content-type'].includes('image/webp'), true);
    assert.equal((await response.body()).subarray(0, 4).toString(), 'RIFF');
  }
  await page.goto(origin + link.path);
  await page.getByLabel('Your name').fill('Temporary passport verification');
  await page.getByRole('button', { name: 'Open the counter' }).click();
  await page.getByRole('button', { name: 'Inspect passport', exact: true }).waitFor();
  const saved = await page.evaluate(raw => JSON.parse(sessionStorage.getItem('passport-reference:' + raw)), raw);
  roundId = saved.id;
  await page.getByRole('button', { name: 'Inspect passport', exact: true }).click();
  await page.getByRole('dialog').getByText('RV 481 726', { exact: true }).waitFor();
  await page.getByRole('dialog').getByRole('button', { name: 'Turn page', exact: true }).click();
  await page.getByRole('dialog').getByText('14 MAR 2024', { exact: true }).waitFor();
  await page.getByRole('dialog').getByRole('button', { name: 'Inspect under UV' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Warm light' }).waitFor();
  await page.getByRole('dialog').getByRole('button', { name: 'Present to passenger' }).click();
  await page.getByRole('button', { name: 'Request arrival card' }).click();
  await page.getByRole('button', { name: 'Compare signatures', exact: true }).click();
  await page.getByRole('button', { name: 'Question him about the signatures' }).click();
  await page.getByLabel('Question the passenger', { exact: true }).fill('Whose passport is this?');
  const responsePromise = page.waitForResponse(response => response.url().endsWith(`/reference/rounds/${roundId}/messages`));
  await page.getByRole('button', { name: 'Send question' }).click();
  const response = await responsePromise; const replied = await response.json();
  assert.equal(response.status(), 200); assert.equal(replied.round.messages.length, 3);
  const reply = replied.round.messages.at(-1);
  report.model = { model: reply.model, providerMs: reply.latencyMs, visibleCharacters: reply.content.length, reply: reply.content };
  await page.getByRole('button', { name: 'Keep reply as evidence' }).click();
  await page.reload();
  await page.getByRole('button', { name: 'Remove reply from evidence' }).waitFor();
  await page.screenshot({ path: 'verification/passport-production-desktop.png', fullPage: true, animations: 'disabled' });
  const current = await api(owner, `/reference/rounds/${roundId}/context`);
  assert.equal(current.observations.includes('UV thread'), true); assert.equal(current.observations.includes('passport, arrival card'), true);
  assert.equal(current.system.includes('The passenger is Noah Vale.'), true);
  assert.equal((await peer.request.get(origin + `/api/reference/rounds/${roundId}/context`, { headers: { 'x-round-token': saved.token } })).status(), 401);
  assert.equal((await peer.request.get(origin + `/api/attempts/${roundId}`)).status(), 401);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Inspect passport', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Enlarge document' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Fit document' }).waitFor();
  await page.screenshot({ path: 'verification/passport-production-mobile-inspection.png', fullPage: true, animations: 'disabled' });
  await page.getByLabel('Close dialog').click();
  await page.getByRole('button', { name: 'Stamp and file the case' }).click();
  await page.getByLabel('Your finding', { exact: false }).fill('One smoke-test question was saved. No final judgement is made in this verification.');
  await page.getByRole('dialog').getByRole('button', { name: 'Stamp and file', exact: true }).click();
  await page.getByText('Case filed.', { exact: true }).waitFor();
  const attempt = await api(owner, `/attempts/${roundId}`);
  assert.deepEqual(attempt.desk.evidence, [reply.id]); assert.equal(attempt.review, null); assert.equal(typeof attempt.endedAt, 'number');
  const prompt = await api(owner, `/attempts/${roundId}/prompt`);
  assert.equal(prompt.system.endsWith(replied.round.messages.at(-2).deskContext), true);
  const design = await api(owner, '/reference/design'); assert.equal(design.storyboard.length, 6);
  const authorPage = await owner.newPage();
  await authorPage.goto(origin + '/reference');
  authorPage.once('dialog', dialog => dialog.accept());
  await authorPage.getByRole('button', { name: 'Explore the design' }).click();
  await authorPage.getByRole('tab', { name: 'Build your own' }).click();
  await authorPage.getByRole('button', { name: /Test, review and hand over/ }).click();
  await authorPage.getByRole('button', { name: 'Create my editable prompt draft' }).waitFor();
  await authorPage.screenshot({ path: 'verification/passport-production-guide.png', fullPage: true, animations: 'disabled' });
  const scripts = await authorPage.locator('script[src]').evaluateAll(nodes => nodes.map(node => node.src));
  for (const script of scripts) { const text = await (await peer.request.get(script)).text(); assert.equal(text.includes('Noah Vale'), false); assert.equal(text.includes('brother’s passport'), false); }
  const afterThemes = (await api(owner, '/levels')).filter(row => row.id !== 'reference-passport-desk').map(row => ({ id: row.id, draft: row.draft, versions: row.versions }));
  assert.deepEqual(afterThemes, beforeThemes);
  await api(owner, `/reference/links/${linkId}`, 'DELETE');
  assert.equal((await peer.request.get(origin + `/api/reference/play/${raw}`)).status(), 404);
  assert.deepEqual(errors, []);
  report.checks = ['Four generated assets served as WebP', 'Blind name-only start and private author boundary', 'Passport pages, UV, arrival card and signature comparison', 'Real Groq reply with saved inspected context', 'Scene and reply-evidence refresh persistence', 'Phone enlargement and case filing', 'Manual review evidence and exact request inspection', 'Six-beat storyboard and interactive build guide', 'Client bundle contains no protected answer', 'Original team drafts unchanged', 'Link revocation stops new starts'];
  report.passed = true;
} finally {
  const cleanup = [];
  if (roundId) {
    for (const table of ['reviews', 'round_locks', 'passport_sessions']) cleanup.push(sql.query(`DELETE FROM ${table} WHERE round_id = $1`, [roundId]));
    cleanup.push(sql.query('DELETE FROM rounds WHERE id = $1 AND version_id = $2', [roundId, 'reference-passport-desk-v1']));
  }
  if (linkId) cleanup.push(sql.query('DELETE FROM links WHERE id = $1 AND version_id = $2', [linkId, 'reference-passport-desk-v1']));
  if (changedOnboarding) {
    if (onboarding) cleanup.push(sql.query('UPDATE onboarding SET version=$1, result=$2, completed_at=$3 WHERE user_id=$4', [onboarding.version, onboarding.result, onboarding.completed_at, ownerId]));
    else cleanup.push(sql.query('DELETE FROM onboarding WHERE user_id = $1', [ownerId]));
  }
  if (cleanup.length) await sql.transaction(cleanup);
  if (ownerId) await api(owner, '/logout', 'POST', {});
  await owner.close(); await peer.close(); await browser.close();
  report.temporaryRecordsRemoved = true;
  writeFileSync('verification/passport-production-check.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
