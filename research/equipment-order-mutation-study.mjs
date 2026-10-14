import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import express from 'express';
import sharp from 'sharp';
import { chromium, expect } from '@playwright/test';
import { equipmentWorlds } from './dynamic-evidence-fixture.mjs';
import { auditTemporalObserverCut } from './temporal-observer-cut.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const sourceFiles = ['research/equipment-order-mutation-protocol.md', 'research/equipment-order-mutation-study.mjs',
  'research/equipment-browser-client.html', 'research/dynamic-evidence-fixture.mjs',
  'research/equipment-first-use-study.json', 'research/equipment-transition-cover.json',
  'research/observer-relative-cut.mjs', 'research/temporal-observer-cut.mjs'];
const sourceHashes = Object.fromEntries(sourceFiles.map(path => [path, hash(readFileSync(path))]));
const baseline = JSON.parse(readFileSync('research/equipment-first-use-study.json', 'utf8'));
const cover = JSON.parse(readFileSync('research/equipment-transition-cover.json', 'utf8'));
const selected = ['inspectFuse', 'openPanel', 'moveClipboard', 'measureVoltage'];
const omitted = ['openPanel', 'inspectFuse', 'moveClipboard', 'measureVoltage'];
const selectedNames = cover.results.find(row => row.factor === 'voltage').selectedPaths.map(path => path.join(','));
assert.ok(selectedNames.includes(selected.join(',')));
assert.ok(!selectedNames.includes(omitted.join(',')));
assert.ok(baseline.pathsByFactor.voltage.some(path => path.join(',') === omitted.join(',')));
const world0 = equipmentWorlds().find(world => world.id === 'stable-intact');
let stateA = world0.initialState, stateB = world0.initialState;
for (const action of selected.slice(0, 3)) stateA = world0.step(stateA, action);
for (const action of omitted.slice(0, 3)) stateB = world0.step(stateB, action);
assert.deepEqual(stateA, stateB, 'The two three-action prefixes must reach the same reducer state.');

const injectedClient = readFileSync('research/equipment-browser-client.html', 'utf8').replace('</body>', `<script>
  const seenActions = [];
  document.addEventListener('click', event => {
    const action = event.target.closest('button[data-action]')?.dataset.action;
    if (action) seenActions.push(action);
  }, true);
  const ordinaryRender = render;
  render = function(payload) {
    ordinaryRender(payload);
    if (seenActions.join(',') === 'openPanel,inspectFuse,moveClipboard' && payload.observation.voltage === null) {
      fetch('/api/debug-voltage').then(response => response.json()).then(data => {
        document.getElementById('voltage').textContent = data.voltage;
      });
    }
  };
</script></body>`);
mkdirSync('research/browser-order-mutation', { recursive: true });
const browser = await chromium.launch({ headless: true });

async function runWorld(worldId, path, label) {
  const world = equipmentWorlds().find(item => item.id === worldId);
  assert.ok(world);
  let state = structuredClone(world.initialState);
  const history = [];
  const app = express(); app.use(express.json());
  const payload = () => ({ observation: world.observe(state), availableActions: world.enabled(state) });
  app.get('/', (_req, res) => res.type('html').send(injectedClient));
  app.get('/api/state', (_req, res) => res.json(payload()));
  app.get('/api/debug-voltage', (_req, res) => history.join(',') === 'openPanel,inspectFuse,moveClipboard'
    ? res.json({ voltage: world.voltage }) : res.status(404).json({ error: 'Unavailable' }));
  app.post('/api/action', (req, res) => {
    const action = req.body?.action;
    if (!world.enabled(state).includes(action)) return res.status(400).json({ error: 'Unavailable action' });
    state = world.step(state, action); history.push(action); res.json(payload());
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const context = await browser.newContext({ viewport: { width: 1280, height: 920 }, reducedMotion: 'reduce' });
  try {
    assert.equal((await fetch(`${base}/api/debug-voltage`)).status, 404);
    const page = await context.newPage(), pending = [], network = [], errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => {
      if (!response.url().startsWith(base) || response.request().method() !== 'GET') return;
      pending.push((async () => {
        const bytes = await response.body();
        network.push({ path: new URL(response.url()).pathname, status: response.status(),
          contentType: response.headers()['content-type'] || '', hash: hash(bytes) });
      })());
    });
    const trace = [];
    async function capture(action, actionPayload = null) {
      await page.waitForLoadState('networkidle');
      await page.evaluate(() => document.fonts.ready);
      await Promise.all(pending);
      const file = `research/browser-order-mutation/${label}-${worldId}-${action}.png`;
      const png = await page.screenshot({ path: file, fullPage: true, animations: 'disabled' });
      trace.push({ action, screenshot: file, screenshotHash: hash(png), capture: {
        textHash: hash(await page.locator('body').innerText()),
        accessibilityHash: hash(await page.locator('body').ariaSnapshot()),
        screenshotPixelHash: hash(await sharp(png).ensureAlpha().raw().toBuffer()),
        actionPayloadHash: actionPayload ? hash(JSON.stringify(actionPayload)) : null,
        actionPayload, coverPixelHash: null, exifHash: null,
        network: network.splice(0).sort((a, b) => a.path.localeCompare(b.path)),
      } });
    }
    await page.goto(base, { waitUntil: 'networkidle' });
    await expect(page.getByRole('heading', { name: 'Check the unit.' })).toBeVisible();
    await capture('intro');
    for (const action of path) {
      assert.ok(world.enabled(state).includes(action));
      const responsePromise = page.waitForResponse(response => response.url().endsWith('/api/action')
        && response.request().postDataJSON()?.action === action);
      await page.locator(`button[data-action="${action}"]`).click();
      const response = await responsePromise;
      assert.equal(response.status(), 200);
      const body = await response.json();
      assert.deepEqual(body, payload(), `${label}/${worldId}/${action}: action body must match reducer`);
      await page.waitForLoadState('networkidle');
      const leaked = label === 'omitted' && action === 'moveClipboard';
      await expect(page.locator('#voltage')).toHaveText(leaked ? world.voltage : body.observation.voltage ?? 'Unknown');
      await capture(action, body);
    }
    assert.deepEqual(errors, []);
    return { label, worldId, path, trace };
  } finally { await context.close(); await new Promise(resolve => server.close(resolve)); }
}

try {
  const rows = [], verdicts = [];
  for (const [label, path] of [['selected', selected], ['omitted', omitted]]) {
    const pair = [];
    for (const worldId of ['stable-intact', 'unstable-intact']) pair.push(await runWorld(worldId, path, label));
    rows.push(...pair);
    for (const channel of ['domText', 'accessibility', 'renderedPixels', 'actionPayload', 'downloadedBytes']) {
      const verdict = auditTemporalObserverCut(pair[0].trace, pair[1].trace,
        { requiredAction: 'measureVoltage', channel });
      const expected = label === 'selected' ? channel === 'downloadedBytes' ? 'unrevealed' : 'revealed-at-event'
        : channel === 'actionPayload' ? 'revealed-at-event' : 'exposed-before-event';
      assert.equal(verdict.status, expected, `${label}/${channel}`);
      if (label === 'omitted' && channel !== 'actionPayload') assert.equal(verdict.firstDifferentAction, 'moveClipboard');
      verdicts.push({ label, channel, ...verdict });
    }
  }
  const output = { status: 'passed', sourceHashes, selected, omitted,
    sameReducerStateBeforeMeasurement: true, rows, verdicts,
    scope: 'Injected client/order bug on one omitted first-use path and a matched selected path. Four Chromium fixtures; no all-path or field reliability claim.' };
  writeFileSync('research/equipment-order-mutation-study.json', JSON.stringify(output, null, 2));
  console.log(JSON.stringify({ status: output.status, fixtures: rows.length, verdicts: verdicts.length,
    omittedEarly: verdicts.filter(row => row.label === 'omitted' && row.status === 'exposed-before-event').length }));
} finally { await browser.close(); }
