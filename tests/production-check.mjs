import 'dotenv/config';
import assert from 'node:assert/strict';
import { createInterface } from 'node:readline';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { neon } from '@neondatabase/serverless';

if (process.stdin.isTTY) process.stdin.setRawMode(true);
const lines = createInterface({ input: process.stdin, terminal: false });
const input = await new Promise(resolve => lines.once('line', resolve)); lines.close();
const { ownerPath, sharePath } = JSON.parse(input);
const origin = 'https://level-workshop.vercel.app';
const sql = neon(process.env.DATABASE_URL, { fullResults: true });
const browser = await chromium.launch();
const context = await browser.newContext(); const page = await context.newPage();
const errors = []; page.on('pageerror', error => errors.push(error.message));
let userId, draftId, ownerCookie;
const report = { origin, checks: [] };
const api = async (path, method = 'GET', data, authenticated = false) => {
  const response = await fetch(origin + '/api' + path, { method, headers: { 'Content-Type': 'application/json', Origin: origin, ...(authenticated ? { Cookie: ownerCookie } : {}) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }), signal: AbortSignal.timeout(60000) });
  const body = await response.json();
  if (!response.ok) throw new Error(`API ${method} ${path.replace(/\/(owner|enter)\/.*/, '/$1/[private]')} failed (${response.status}): ${body.error}`);
  return { body, response };
};
try {
  const bootstrap = (await api('/bootstrap')).body;
  assert.equal(bootstrap.needsSetup, false); assert.equal(bootstrap.model.connected, true);
  report.checks.push('Production API and real model configured');
  const root = await fetch(origin); assert.equal(root.status, 200); assert.equal(root.headers.get('referrer-policy'), 'no-referrer');
  const privateLevels = await fetch(origin + '/api/levels'); assert.equal(privateLevels.status, 401);
  report.checks.push('Public entry works; author data requires a session');
  await page.goto(origin + sharePath);
  await page.getByLabel('Your name').fill('Deployment verification');
  await page.getByRole('button', { name: 'Enter workshop' }).click();
  await page.getByRole('heading', { name: 'Find your way around.' }).waitFor();
  userId = (await (await page.request.get(origin + '/api/bootstrap')).json()).user.id;
  await page.getByRole('button', { name: 'Show me around' }).click();
  for (const title of ['Start with a level.', 'Set the scene.', 'Give the target its instructions.', 'Save a version, then test it.', 'Review what happened.', 'Work with your team.']) {
    await page.getByRole('heading', { name: title, exact: true }).waitFor();
    await page.getByTestId('tour-highlight').waitFor();
    await page.getByRole('button', { name: title === 'Work with your team.' ? 'Finish tour' : 'Next', exact: true }).click();
  }
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  await page.reload(); await page.getByRole('heading', { name: /^Levels/ }).waitFor();
  assert.equal(await page.getByRole('dialog').count(), 0);
  const onboard = await (await page.request.get(origin + '/api/bootstrap')).json(); assert.equal(onboard.tutorialDone, true);
  await page.getByRole('button', { name: 'Quick tour', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Show me around' }).click();
  await page.getByRole('heading', { name: 'Start with a level.' }).waitFor();
  mkdirSync('verification', { recursive: true });
  await page.screenshot({ path: 'verification/vercel-tutorial-mobile.png', animations: 'disabled' });
  await page.keyboard.press('Escape'); await page.getByRole('dialog').waitFor({ state: 'detached' });
  report.checks.push('Name-only join, all six tutorial steps, completion persistence, replay, mobile and Escape');
  const entered = await api(ownerPath, 'POST', { name: 'Workspace owner' });
  ownerCookie = entered.response.headers.get('set-cookie').split(';')[0];
  assert.equal(entered.body.user.role, 'admin');
  const rows = (await api('/levels', 'GET', undefined, true)).body; assert.equal(rows.length, 3);
  const source = rows.find(row => row.draft.theme === 'Harry Potter');
  draftId = (await api('/levels', 'POST', { templateId: source.id }, true)).body.id;
  const detail = (await api(`/levels/${draftId}`, 'GET', undefined, true)).body;
  const saved = (await api(`/levels/${draftId}/versions`, 'POST', { revision: detail.revision, note: 'Temporary deployment verification' }, true)).body;
  const round = (await api(`/levels/${draftId}/rounds`, 'POST', { versionId: saved.versionId }, true)).body;
  assert.equal(typeof round.deadline, 'number');
  const start = performance.now();
  const reply = (await api(`/rounds/${round.id}/messages`, 'POST', { content: 'What did Professor Dippet tell you about the possibility of the school closing?' }, true)).body;
  assert.equal(reply.messages.length, 3); assert.equal(reply.messages.at(-1).role, 'assistant');
  report.model = { model: reply.model, requestMs: Math.round(performance.now() - start), providerMs: reply.messages.at(-1).latencyMs, visibleCharacters: reply.messages.at(-1).content.length };
  report.checks.push('Neon version save, persisted round, numeric deadline, real Groq reply and lease release');
  assert.deepEqual(errors, []);
  report.passed = true;
} finally {
  await context.close(); await browser.close();
  // Delete only the IDs created by this verification run. Migrated rows remain.
  const cleanup = [];
  if (draftId) {
    for (const table of ['reviews', 'round_locks']) cleanup.push(sql.query(`DELETE FROM ${table} WHERE round_id IN (SELECT id FROM rounds WHERE level_id = $1)`, [draftId]));
    cleanup.push(sql.query('DELETE FROM rounds WHERE level_id = $1', [draftId]));
    cleanup.push(sql.query('DELETE FROM links WHERE version_id IN (SELECT id FROM versions WHERE level_id = $1)', [draftId]));
    cleanup.push(sql.query('DELETE FROM versions WHERE level_id = $1', [draftId]));
    cleanup.push(sql.query('DELETE FROM comments WHERE level_id = $1', [draftId]));
    cleanup.push(sql.query('DELETE FROM levels WHERE id = $1', [draftId]));
  }
  if (userId) {
    cleanup.push(sql.query('DELETE FROM onboarding WHERE user_id = $1', [userId]));
    cleanup.push(sql.query('DELETE FROM auth WHERE user_id = $1', [userId]));
    cleanup.push(sql.query('DELETE FROM users WHERE id = $1', [userId]));
  }
  if (cleanup.length) await sql.transaction(cleanup);
  if (ownerCookie) await api('/logout', 'POST', {}, true);
  report.temporaryRecordsRemoved = true;
  writeFileSync('verification/vercel-check.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
