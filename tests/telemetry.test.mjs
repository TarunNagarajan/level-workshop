import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { randomUUID, webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';

let testQueue = Promise.resolve();
function serialTest(name, run) {
  test(name, async () => {
    const previous = testQueue;
    let release;
    testQueue = new Promise(resolve => { release = resolve; });
    await previous;
    try { await run(); } finally { release(); }
  });
}

const source = fileURLToPath(new URL('../src/telemetry.ts', import.meta.url));
async function harness({ holdEvents = false, holdSession = false, sessionStatus = 200, rejectFirstBatch = false, cryptoMode = 'full' } = {}) {
  const result = await build({ entryPoints: [source], bundle: true, format: 'esm', platform: 'browser', write: false });
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}#${randomUUID()}`;
  let clock = 1000;
  const windows = new Map(); const documents = new Map(); const intervals = new Map();
  let intervalId = 0;
  const requests = [];
  let releaseEvents; const releaseSessions = [];
  let sessions = 0; let eventBatches = 0;
  const descriptors = Object.fromEntries(['window', 'document', 'sessionStorage', 'performance', 'crypto', 'fetch'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const cryptoValue = cryptoMode === 'none' ? undefined : cryptoMode === 'fallback'
    ? { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) }
    : webcrypto;
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: cryptoValue });
  Object.defineProperty(globalThis, 'performance', { configurable: true, value: { now: () => clock } });
  globalThis.sessionStorage = new MapStorage();
  globalThis.window = {
    addEventListener: (name, callback) => windows.set(name, callback),
    setInterval: callback => { const id = ++intervalId; intervals.set(id, callback); return id; },
    clearInterval: id => intervals.delete(id),
  };
  globalThis.document = { visibilityState: 'visible', addEventListener: (name, callback) => documents.set(name, callback) };
  globalThis.fetch = async (url, options = {}) => {
    const entry = { url: String(url), options, body: options.body ? JSON.parse(options.body) : null, headers: options.headers || {} };
    requests.push(entry);
    if (String(url).includes('/telemetry/session')) {
      sessions += 1;
      const value = { enabled: true, sessionId: sessions === 1 ? 'b48e8de6-c0ad-4b2d-87f5-5cb0c69bb330' : 'a78f7502-fdb1-4fa3-8757-cc062fed7d38', heartbeatSeconds: 15, idleAfterMs: 30000 };
      if (holdSession) return new Promise(resolve => releaseSessions.push(() => resolve(response(value, sessionStatus))));
      return response(value, sessionStatus);
    }
    eventBatches += 1;
    if (holdEvents) return new Promise(resolve => { releaseEvents = () => resolve(response({ accepted: true })); });
    if (rejectFirstBatch && eventBatches === 1) return response({ error: 'session changed' }, 401);
    return response({ accepted: true });
  };
  const api = await import(moduleUrl);
  api.setMetricsConsent(true);
  const advance = value => { clock = value; };
  const tick = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
  const flushAll = async () => {
    for (let i = 0; i < 10; i++) { const cb = [...intervals.values()][0]; if (cb) cb(); await tick(); }
    windows.get('pagehide')?.(); await tick();
  };
  const restore = () => { for (const [key, descriptor] of Object.entries(descriptors)) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } };
  return { api, requests, windows, documents, intervals, advance, tick, flushAll, restore, releaseEvents: () => releaseEvents?.(), releaseSession: index => releaseSessions[index]?.(), sessionRequests: () => releaseSessions.length, start: path => { api.navigateMetrics(path); api.syncMetricsIdentity(null); }, setVisible: value => { globalThis.document.visibilityState = value; documents.get('visibilitychange')?.(); } };
}
class MapStorage extends Map { getItem(key) { return this.get(key) ?? null; } setItem(key, value) { this.set(key, value); } }
const response = (value, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => value });
const events = h => h.requests.filter(request => request.url.includes('/telemetry/events')).flatMap(request => request.body.events);

serialTest('visible, hidden, idle, and resumed intervals preserve duration invariants', async () => {
  const h = await harness();
  try {
    h.start('/collect/private-token'); await h.tick();
    h.advance(12000); h.setVisible('hidden'); await h.tick();
    h.advance(20000); h.api.recordMetricsInteraction('hint');
    h.setVisible('visible'); await h.tick();
    h.advance(55000); h.windows.get('pointerdown')(); await h.tick();
    h.advance(56000); await h.flushAll();
    const intervals = events(h).filter(event => ['heartbeat', 'visibility', 'page_exit'].includes(event.kind) && event.elapsedMs !== undefined);
    assert.ok(intervals.length >= 3);
    for (const item of intervals) {
      assert.ok(item.activeMs <= item.visibleMs && item.visibleMs <= item.elapsedMs);
      assert.ok((item.readThinkMs || 0) + (item.composeMs || 0) + (item.waitingMs || 0) <= item.activeMs, JSON.stringify(item));
    }
    const hiddenGap = intervals.find(item => item.elapsedMs === 8000);
    assert.ok(hiddenGap); assert.equal(hiddenGap.activeMs, 0); assert.equal(hiddenGap.visibleMs, 0);
    const idleResume = intervals.find(item => item.elapsedMs === 35000);
    assert.ok(idleResume); assert.equal(idleResume.activeMs, 30000); assert.equal(idleResume.idleMs, 5000);
    const allowlist = new Set(['eventId', 'tabId', 'pageId', 'roundId', 'kind', 'view', 'phase', 'elapsedMs', 'activeMs', 'visibleMs', 'idleMs', 'readThinkMs', 'composeMs', 'waitingMs', 'sinceReplyMs', 'requestCategory', 'requestOutcome', 'requestWallMs', 'retryCount', 'interaction']);
    for (const event of events(h)) assert.ok(Object.keys(event).every(key => allowlist.has(key)), `unexpected field ${JSON.stringify(event)}`);
    const hiddenHeartbeats = intervals.filter(event => event.kind === 'heartbeat' && event.phase === 'hidden');
    assert.ok(hiddenHeartbeats.every(event => event.activeMs === 0 && event.visibleMs === 0));
    const bodies = JSON.stringify(h.requests.filter(request => request.url.includes('/telemetry/events')).map(request => request.body));
    assert.equal(bodies.includes('/collect/private-token'), false);
    assert.equal(bodies.includes('private-token'), false);
  } finally { h.restore(); }
});

serialTest('overlapping round requests keep waiting until all finish; capabilities stay in headers', async () => {
  const h = await harness();
  try {
    h.start('/levels/example'); await h.tick();
    const id = 'd4b2f85e-1d43-4d95-b3a6-f1cbabf9bd1b'; const token = 'secret-round-capability';
    const first = h.api.beginMeasuredRequest(`/rounds/${id}/message`, 'POST', token);
    h.advance(2000); const second = h.api.beginMeasuredRequest(`/rounds/${id}/hint`, 'POST', token);
    h.advance(3000); h.api.finishMeasuredRequest(first, 'success');
    h.api.setMetricsPhase('compose', id, token);
    h.api.recordMetricsReply(id, token);
    h.advance(4000); h.api.finishMeasuredRequest(second, 'success');
    h.advance(5000); await h.flushAll();
    const body = JSON.stringify(h.requests.filter(request => request.url.includes('/telemetry/events')).map(request => request.body));
    assert.equal(body.includes(token), false);
    assert.ok(h.requests.some(request => request.headers['x-round-token'] === token));
    assert.ok(h.requests.filter(request => request.url.includes('/telemetry/events')).every(request => request.body.sessionId === 'b48e8de6-c0ad-4b2d-87f5-5cb0c69bb330'));
    const pageEvents = events(h).filter(event => event.roundId === id);
    assert.ok(pageEvents.some(event => event.phase === 'waiting'));
    assert.equal(pageEvents.some(event => event.phase === 'compose'), false);
    assert.ok(pageEvents.some(event => event.requestCategory === 'round_action'));
  } finally { h.restore(); }
});

serialTest('route changes drop round scope and metrics endpoints are excluded from request telemetry', async () => {
  const h = await harness();
  try {
    h.start('/reference/play/first'); await h.tick();
    h.api.setMetricsPhase('compose', 'd4b2f85e-1d43-4d95-b3a6-f1cbabf9bd1b', 'secret');
    h.advance(2000); h.api.navigateMetrics('/collections');
    h.api.finishMeasuredRequest(h.api.beginMeasuredRequest('/metrics/summary', 'GET'), 'success');
    h.api.setMetricsPhase('read_think');
    h.advance(3000); await h.flushAll();
    const all = events(h);
    assert.ok(all.some(event => event.kind === 'page_exit' && event.roundId));
    assert.ok(all.some(event => event.kind === 'page_enter' && event.view === 'workshop' && !event.roundId));
    assert.equal(all.filter(event => event.requestCategory === 'review').length, 0);
    assert.equal(JSON.stringify(all).includes('secret'), false);
    assert.equal(JSON.stringify(all).includes('/reference/play/first'), false);
  } finally { h.restore(); }
});

serialTest('mission iframe owns its timing and the workshop starts a fresh interval on return', async () => {
  const h = await harness();
  try {
    h.start('/collections'); await h.tick();
    h.advance(3000); h.api.navigateMetrics('/mission'); await h.tick();
    const beforeMission = events(h).length;
    h.advance(63000); await h.tick();
    assert.equal(events(h).length, beforeMission);
    assert.equal(h.intervals.size, 0);
    h.api.navigateMetrics('/collections'); await h.tick();
    h.advance(68000); await h.flushAll();
    const all = events(h);
    assert.ok(all.some(event => event.kind === 'page_enter' && event.view === 'workshop' && event.pageId));
    assert.equal(all.some(event => event.view === 'mission'), false);
    assert.ok(all.filter(event => ['heartbeat', 'page_exit'].includes(event.kind) && event.elapsedMs !== undefined).every(event => event.elapsedMs < 30000));
  } finally { h.restore(); }
});

serialTest('round replacement closes old scoped time and resets reply timing; orchestration waits are tracked', async () => {
  const h = await harness();
  try {
    h.start('/orchestration'); await h.tick();
    const firstRound = 'd4b2f85e-1d43-4d95-b3a6-f1cbabf9bd1b';
    const secondRound = '6e56da97-b770-4b70-aa88-5610ea7469ca';
    h.api.setMetricsPhase('compose', firstRound, 'round-capability-one');
    h.advance(2000);
    h.api.setMetricsPhase('read_think', secondRound, 'round-capability-two');
    h.api.recordMetricsInteraction('submit', secondRound, 'round-capability-two');
    const request = h.api.beginMeasuredRequest('/orchestration/runs/private-run-id/messages', 'POST');
    h.advance(5000);
    const heartbeat = [...h.intervals.values()][0]; heartbeat?.(); await h.tick();
    h.api.finishMeasuredRequest(request, 'success');
    h.advance(6000); await h.flushAll();
    const allEvents = events(h);
    const firstRoundEvents = allEvents.filter(event => event.roundId === firstRound);
    assert.ok(firstRoundEvents.some(event => event.kind === 'heartbeat' && event.composeMs > 0));
    const secondSubmit = allEvents.find(event => event.roundId === secondRound && event.kind === 'interaction' && event.interaction === 'submit');
    assert.ok(secondSubmit); assert.equal(secondSubmit.sinceReplyMs, undefined);
    assert.ok(allEvents.some(event => event.kind === 'phase' && event.phase === 'waiting'));
    assert.ok(allEvents.some(event => event.kind === 'request' && event.requestCategory === 'round_action'));
    assert.equal(JSON.stringify(h.requests.filter(row => row.url.includes('/telemetry/events')).map(row => row.body)).includes('private-run-id'), false);
  } finally { h.restore(); }
});

serialTest('event batches stay at fifty entries and queued events have a hard memory cap', async () => {
  const h = await harness({ holdEvents: true });
  try {
    h.start('/'); await h.tick();
    for (let i = 0; i < 700; i++) h.api.recordMetricsInteraction('hint');
    h.releaseEvents();
    await h.tick();
    await h.flushAll();
    const batches = h.requests.filter(request => request.url.includes('/telemetry/events')).map(request => request.body.events.length);
    assert.ok(batches.length > 0);
    assert.ok(batches.every(length => length <= 50));
    assert.ok(events(h).length <= 550);
  } finally { h.restore(); }
});

serialTest('rotated session rejects old batch without retrying it under the new visit', async () => {
  const h = await harness({ rejectFirstBatch: true });
  try {
    h.start('/'); await h.tick();
    for (let i = 0; i < 8; i++) h.api.recordMetricsInteraction('hint');
    for (let i = 0; i < 10; i++) await h.tick();
    const eventRequests = h.requests.filter(request => request.url.includes('/telemetry/events'));
    assert.ok(eventRequests.length >= 1);
    assert.equal(eventRequests[0].body.sessionId, 'b48e8de6-c0ad-4b2d-87f5-5cb0c69bb330');
    assert.equal(h.requests.filter(request => request.url.includes('/telemetry/session')).length, 2);
    const newVisitBatches = eventRequests.filter(request => request.body.sessionId === 'a78f7502-fdb1-4fa3-8757-cc062fed7d38');
    assert.ok(newVisitBatches.every(request => request.body.events.every(event => event.kind === 'page_enter')));
  } finally { h.restore(); }
});

serialTest('authenticated identity change drops unsent events from the previous session', async () => {
  const h = await harness();
  try {
    h.start('/'); await h.tick();
    for (let i = 0; i < 6; i++) h.api.recordMetricsInteraction('hint');
    h.api.syncMetricsIdentity('owner-id'); await h.tick();
    await h.flushAll();
    const eventRequests = h.requests.filter(request => request.url.includes('/telemetry/events'));
    const previousVisitBatches = eventRequests.filter(request => request.body.sessionId === 'b48e8de6-c0ad-4b2d-87f5-5cb0c69bb330');
    assert.ok(previousVisitBatches.every(request => request.body.events.every(event => event.kind === 'page_enter')));
    const newVisitBatches = eventRequests.filter(request => request.body.sessionId === 'a78f7502-fdb1-4fa3-8757-cc062fed7d38');
    assert.ok(newVisitBatches.every(request => request.body.events.every(event => event.kind !== 'interaction')));
  } finally { h.restore(); }
});

serialTest('consented events wait for the initial session and bind only after it succeeds', async () => {
  const h = await harness({ holdSession: true });
  try {
    h.start('/collect/private-token'); await h.tick();
    assert.equal(h.sessionRequests(), 1);
    const roundId = 'd4b2f85e-1d43-4d95-b3a6-f1cbabf9bd1b';
    h.api.setMetricsPhase('compose', roundId, 'secret-round-capability');
    const ticket = h.api.beginMeasuredRequest(`/rounds/${roundId}/messages`, 'POST', 'secret-round-capability');
    h.advance(2500);
    h.api.finishMeasuredRequest(ticket, 'success');
    h.api.recordMetricsInteraction('submit', roundId, 'secret-round-capability');
    h.releaseSession(0); await h.tick(); await h.flushAll();
    const batches = h.requests.filter(request => request.url.includes('/telemetry/events'));
    assert.ok(batches.length);
    assert.ok(batches.every(request => request.body.sessionId === 'b48e8de6-c0ad-4b2d-87f5-5cb0c69bb330'));
    const recorded = events(h).filter(event => event.roundId === roundId);
    assert.ok(recorded.some(event => event.phase === 'compose'));
    assert.ok(recorded.some(event => event.requestCategory === 'round_action' && event.requestOutcome === 'success'));
    assert.ok(recorded.some(event => event.interaction === 'submit'));
    assert.equal(JSON.stringify(batches.map(request => request.body)).includes('secret-round-capability'), false);
    assert.ok(batches.some(request => request.headers['x-round-token'] === 'secret-round-capability'));
  } finally { h.restore(); }
});

serialTest('identity change while session creation is pending discards the previous identity buffer', async () => {
  const h = await harness({ holdSession: true });
  try {
    h.start('/'); await h.tick();
    h.api.recordMetricsInteraction('hint');
    h.api.setMetricsPhase('compose');
    h.api.syncMetricsIdentity('owner-id'); await h.tick();
    assert.equal(h.sessionRequests(), 2);
    h.releaseSession(1); await h.tick();
    h.releaseSession(0); await h.tick();
    await h.flushAll();
    const requests = h.requests.filter(request => request.url.includes('/telemetry/events'));
    const newIdentityEvents = requests.filter(request => request.body.sessionId === 'a78f7502-fdb1-4fa3-8757-cc062fed7d38').flatMap(request => request.body.events);
    assert.ok(newIdentityEvents.length);
    assert.ok(newIdentityEvents.every(event => event.kind === 'page_enter' || ((event.kind === 'heartbeat' || event.kind === 'page_exit') && event.phase === 'read_think')), JSON.stringify(newIdentityEvents));
    assert.equal(newIdentityEvents.some(event => event.kind === 'interaction' || event.phase === 'compose'), false);
  } finally { h.restore(); }
});

serialTest('consent revocation while session creation is pending discards the buffer', async () => {
  const h = await harness({ holdSession: true });
  try {
    h.start('/'); await h.tick();
    h.api.recordMetricsInteraction('hint');
    h.api.setMetricsConsent(false);
    h.releaseSession(0); await h.tick(); await h.flushAll();
    assert.deepEqual(h.requests.filter(request => request.url.includes('/telemetry/events')), []);
  } finally { h.restore(); }
});

serialTest('failed initial session creation discards unbound consented events', async () => {
  const h = await harness({ holdSession: true, sessionStatus: 503 });
  try {
    h.start('/'); await h.tick();
    h.api.recordMetricsInteraction('hint');
    h.releaseSession(0); await h.tick(); await h.flushAll();
    assert.deepEqual(h.requests.filter(request => request.url.includes('/telemetry/events')), []);
  } finally { h.restore(); }
});

serialTest('UUID fallback works without randomUUID on HTTP contexts', async () => {
  const h = await harness({ cryptoMode: 'fallback' });
  try {
    h.start('/'); await h.tick();
    const entered = events(h).find(event => event.kind === 'page_enter');
    assert.ok(entered);
    assert.match(entered.pageId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.match(entered.tabId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  } finally { h.restore(); }
});

serialTest('requests before routed page initialization are not emitted with an empty page ID', async () => {
  const h = await harness();
  try {
    const early = h.api.beginMeasuredRequest('/bootstrap', 'GET');
    assert.equal(early, null);
    h.api.finishMeasuredRequest(early, 'success');
    h.start('/'); await h.tick();
    await h.flushAll();
    const recorded = events(h);
    assert.ok(recorded.some(event => event.kind === 'page_enter'));
    assert.ok(recorded.every(event => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(event.pageId)));
    assert.equal(recorded.some(event => event.kind === 'request' && event.requestCategory === 'navigation'), false);
  } finally { h.restore(); }
});

serialTest('telemetry gracefully disables without crypto and workshop API requests still succeed', async () => {
  const h = await harness({ cryptoMode: 'none' });
  try {
    assert.doesNotThrow(() => h.start('/'));
    assert.doesNotThrow(() => h.api.setMetricsPhase('compose'));
    assert.doesNotThrow(() => h.api.recordMetricsInteraction('submit'));
    assert.doesNotThrow(() => h.api.recordMetricsReply('d4b2f85e-1d43-4d95-b3a6-f1cbabf9bd1b'));

    const result = await build({ entryPoints: [fileURLToPath(new URL('../src/api.ts', import.meta.url))], bundle: true, format: 'esm', platform: 'browser', write: false });
    const moduleUrl = `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}#${randomUUID()}`;
    globalThis.fetch = async (url, options) => {
      h.requests.push({ url: String(url), options, body: options.body ? JSON.parse(options.body) : null, headers: options.headers || {} });
      return response({ available: true });
    };
    const api = await import(moduleUrl);
    assert.deepEqual(await api.api('/bootstrap'), { available: true });
    assert.ok(h.requests.some(request => request.url === '/api/bootstrap'));
    assert.equal(h.requests.some(request => request.url.includes('/telemetry/')), false);
  } finally { h.restore(); }
});
