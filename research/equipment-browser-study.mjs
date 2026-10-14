import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import express from 'express';
import sharp from 'sharp';
import { chromium, expect } from '@playwright/test';
import { equipmentWorlds } from './dynamic-evidence-fixture.mjs';
import { auditDynamicEvidence } from './dynamic-evidence-audit.mjs';
import { auditTemporalObserverCut } from './temporal-observer-cut.mjs';
import { compareObserverBoundary } from './observer-relative-cut.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const protocol = JSON.parse(readFileSync('research/equipment-browser-protocol.json', 'utf8'));
assert.equal(protocol.status, 'amended-before-complete-browser-capture');
const html = readFileSync('research/equipment-browser-client.html');
const outDir = 'research/browser-equipment';
mkdirSync(outDir, { recursive: true });
const sourceFiles = [
  'research/equipment-browser-protocol.json', 'research/equipment-browser-client.html',
  'research/equipment-browser-study.mjs', 'research/dynamic-evidence-fixture.mjs',
  'research/dynamic-evidence-audit.mjs', 'research/observer-relative-cut.mjs',
  'research/temporal-observer-cut.mjs',
];
const sourceHashes = Object.fromEntries(sourceFiles.map(path => [path, hash(readFileSync(path))]));
const browser = await chromium.launch({ headless: true });

async function runWorld({ condition, options, worldId, path }) {
  const world = equipmentWorlds(options).find(item => item.id === worldId);
  assert.ok(world);
  let state = structuredClone(world.initialState);
  const app = express();
  app.use(express.json());
  const payload = () => ({ observation: world.observe(state), availableActions: world.enabled(state) });
  app.get('/', (_req, res) => res.type('html').send(html));
  app.get('/api/state', (_req, res) => res.json(payload()));
  app.post('/api/action', (req, res) => {
    if (!world.enabled(state).includes(req.body?.action)) return res.status(400).json({ error: 'Unavailable action' });
    state = world.step(state, req.body.action);
    res.json(payload());
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const context = await browser.newContext({ viewport: { width: 1280, height: 920 }, reducedMotion: 'reduce' });
  const name = `${condition}-${worldId}-${path.length ? path.join('-') : 'intro'}`;
  try {
    const beforeProbe = await (await fetch(`${base}/api/state`)).json();
    const rejected = await fetch(`${base}/api/action`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'measureVoltage' }) });
    assert.equal(rejected.status, 400, `${name}: premature voltage request`);
    assert.deepEqual(await (await fetch(`${base}/api/state`)).json(), beforeProbe, `${name}: rejected request changed state`);
    assert.equal('answer' in beforeProbe, false);
    assert.equal('voltage' in beforeProbe, false);
    assert.equal('fuse' in beforeProbe, false);
    const page = await context.newPage();
    const pending = [], network = [], errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => {
      if (!response.url().startsWith(base) || response.request().method() !== 'GET') return;
      pending.push((async () => {
        const bytes = await response.body();
        network.push({ path: new URL(response.url()).pathname, status: response.status(),
          contentType: response.headers()['content-type'] || '', hash: hash(bytes) });
      })());
    });
    const trace = [], parity = [];
    async function capture(action, actionPayload = null) {
      await page.waitForLoadState('networkidle');
      await page.evaluate(() => document.fonts.ready);
      await Promise.all(pending);
      const png = await page.screenshot({ path: `${outDir}/${name}-${action}.png`, fullPage: true, animations: 'disabled' });
      trace.push({ action, capture: {
        textHash: hash(await page.locator('body').innerText()),
        accessibilityHash: hash(await page.locator('body').ariaSnapshot()),
        screenshotPixelHash: hash(await sharp(png).ensureAlpha().raw().toBuffer()),
        coverPixelHash: null, exifHash: null,
        actionPayloadHash: actionPayload ? hash(JSON.stringify(actionPayload)) : null,
        actionPayload,
        network: network.splice(0).sort((a, b) => a.path.localeCompare(b.path)),
      }, screenshotHash: hash(png) });
    }
    await page.goto(base, { waitUntil: 'networkidle' });
    await expect(page.getByRole('heading', { name: 'Check the unit.' })).toBeVisible();
    await expect(page.getByRole('button').first()).toBeVisible();
    await capture('intro');
    for (const action of path) {
      assert.ok(world.enabled(state).includes(action), `${name}: ${action} unavailable`);
      const replyPromise = page.waitForResponse(response => response.url().endsWith('/api/action')
        && response.request().postDataJSON()?.action === action);
      await page.locator(`button[data-action="${action}"]`).click();
      const reply = await replyPromise;
      assert.equal(reply.status(), 200);
      state = world.step(state, action);
      const body = await reply.json();
      assert.deepEqual(body, { observation: world.observe(state), availableActions: world.enabled(state) });
      await expect(page.locator('#voltage')).toHaveText(body.observation.voltage ?? 'Unknown');
      await expect(page.locator('#fuse')).toHaveText(body.observation.fuse ?? 'Unknown');
      await expect(page.locator('#controls button')).toHaveCount(body.availableActions.length);
      parity.push({ action, apiMatchesReducer: true, controlsMatchApi: true });
      await capture(action, body);
    }
    assert.deepEqual(errors, []);
    return { condition, worldId, path, name, trace, parity };
  } finally {
    await context.close();
    await new Promise(resolve => server.close(resolve));
  }
}

try {
  const baselineGraph = auditDynamicEvidence({ worlds: equipmentWorlds() });
  assert.equal(baselineGraph.status, 'analyzed');
  assert.equal(baselineGraph.initialPartitions.length, 1);
  const rows = [], verdicts = [];
  for (const pair of protocol.baselinePairs) for (const path of pair.paths) {
    const left = await runWorld({ condition: 'baseline', options: {}, worldId: pair.left, path });
    const right = await runWorld({ condition: 'baseline', options: {}, worldId: pair.right, path });
    rows.push(left, right);
    for (const channel of protocol.channels) {
      const verdict = auditTemporalObserverCut(left.trace, right.trace, { requiredAction: pair.event, channel });
      const expected = channel === 'downloadedBytes' ? 'unrevealed' : 'revealed-at-event';
      assert.equal(verdict.status, expected, `${pair.factor} ${path.join('→')} ${channel}`);
      verdicts.push({ condition: 'baseline', factor: pair.factor, path, ...verdict });
    }
  }
  for (const control of protocol.injectedControls) {
    const path = control.path ?? [];
    const left = await runWorld({ condition: control.name, options: control.options, worldId: control.pair[0], path });
    const right = await runWorld({ condition: control.name, options: control.options, worldId: control.pair[1], path });
    rows.push(left, right);
    if (!path.length) {
      const comparison = compareObserverBoundary(left.trace[0].capture, right.trace[0].capture);
      for (const channel of ['domText', 'accessibility', 'renderedPixels']) assert.equal(comparison.channels[channel], false, `${control.name} ${channel}`);
      assert.equal(comparison.channels.downloadedBytes, false, `${control.name} GET payload`);
      verdicts.push({ condition: control.name, firstDifferentStage: 'intro', channels: comparison.channels,
        differingResources: comparison.differingResources });
    } else {
      const before = compareObserverBoundary(left.trace[0].capture, right.trace[0].capture);
      const after = compareObserverBoundary(left.trace[1].capture, right.trace[1].capture);
      for (const channel of ['domText', 'accessibility', 'renderedPixels', 'actionPayload']) {
        assert.equal(before.channels[channel], true, `${control.name} ${channel} intro`);
        assert.equal(after.channels[channel], false, `${control.name} ${channel} prefix`);
      }
      assert.equal(after.channels.downloadedBytes, true);
      assert.equal(control.expectedFirstDifferentStage, path[0]);
      verdicts.push({ condition: control.name, firstDifferentStage: path[0], status: 'exposed-before-event',
        omittedEvent: control.event, channels: after.channels });
    }
  }
  const report = { status: 'passed', browser: browser.version(), sourceHashes,
    scope: protocol.boundary, graph: { status: baselineGraph.status, beliefStates: baselineGraph.exploredBeliefStates,
      transitionEdges: baselineGraph.transitionEdges, adaptiveWorstCaseActions: baselineGraph.initialPartitions[0].adaptiveWorstCaseActions },
    rows, verdicts };
  writeFileSync('research/equipment-browser-study.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, browserFixtures: rows.length, baselinePaths: protocol.baselinePairs.flatMap(pair => pair.paths).length,
    beliefStates: report.graph.beliefStates, earlyLeaksCaught: verdicts.filter(row => row.status === 'exposed-before-event' || row.firstDifferentStage === 'intro').length }));
  if (process.argv.includes('--all-first-use')) {
    const orderProtocol = JSON.parse(readFileSync('research/equipment-first-use-protocol.json', 'utf8'));
    assert.equal(orderProtocol.status, 'locked-before-first-use-browser-capture');
    function legalFullOrders(world) {
      const paths = [];
      function visit(state, actions) {
        if (actions.length === orderProtocol.actionSet.length) {
          paths.push(actions);
          return;
        }
        for (const action of world.enabled(state)) {
          assert.ok(orderProtocol.actionSet.includes(action));
          visit(world.step(state, action), [...actions, action]);
        }
      }
      visit(world.initialState, []);
      assert.equal(new Set(paths.map(path => path.join(','))).size, paths.length);
      return paths;
    }
    const orderRows = [], orderVerdicts = [], pathsByFactor = {};
    for (const factor of orderProtocol.factors) {
      const pair = equipmentWorlds().filter(world => [factor.left, factor.right].includes(world.id));
      assert.equal(pair.length, 2);
      const leftPaths = legalFullOrders(pair.find(world => world.id === factor.left));
      const rightPaths = legalFullOrders(pair.find(world => world.id === factor.right));
      assert.deepEqual(leftPaths, rightPaths, `${factor.name}: action availability differs in clean twins`);
      assert.equal(leftPaths.length, orderProtocol.expectedLegalFullOrdersPerPair);
      pathsByFactor[factor.name] = leftPaths;
      for (const path of leftPaths) {
        const left = await runWorld({ condition: `orders-${factor.name}`, options: {}, worldId: factor.left, path });
        const right = await runWorld({ condition: `orders-${factor.name}`, options: {}, worldId: factor.right, path });
        orderRows.push(left, right);
        for (const channel of orderProtocol.channels) {
          const result = auditTemporalObserverCut(left.trace, right.trace, { requiredAction: factor.event, channel });
          assert.equal(result.status, channel === 'downloadedBytes' ? 'unrevealed' : 'revealed-at-event',
            `${factor.name} ${path.join('→')} ${channel}`);
          orderVerdicts.push({ factor: factor.name, path, ...result });
        }
      }
    }
    const orderReport = { status: 'passed', browser: browser.version(),
      sourceHashes: { ...sourceHashes, 'research/equipment-first-use-protocol.json': hash(readFileSync('research/equipment-first-use-protocol.json')) },
      scope: orderProtocol.scope, pathsByFactor, rows: orderRows, verdicts: orderVerdicts };
    writeFileSync('research/equipment-first-use-study.json', JSON.stringify(orderReport, null, 2));
    console.log(JSON.stringify({ status: orderReport.status, fullOrders: Object.values(pathsByFactor).reduce((total, paths) => total + paths.length, 0),
      browserFixtures: orderRows.length, channelVerdicts: orderVerdicts.length }));
  }
} finally { await browser.close(); }
