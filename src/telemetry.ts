type View = 'workshop' | 'collect' | 'passport' | 'orchestration' | 'editor' | 'tests' | 'settings' | 'diary' | 'mission' | 'other';
type Phase = 'read_think' | 'compose' | 'waiting' | 'idle' | 'hidden';
type RequestCategory = 'navigation' | 'round_action' | 'authoring' | 'review' | 'other';
type Interaction = 'hint' | 'submit' | 'finish' | 'inspect';
type EventKind = 'page_enter' | 'page_exit' | 'heartbeat' | 'visibility' | 'phase' | 'request' | 'interaction';
type MetricEvent = {
  eventId: string; tabId: string; pageId: string; kind: EventKind; view: View;
  roundId?: string; phase?: Phase; elapsedMs?: number; activeMs?: number; visibleMs?: number; idleMs?: number;
  readThinkMs?: number; composeMs?: number; waitingMs?: number; sinceReplyMs?: number;
  requestCategory?: RequestCategory; requestOutcome?: 'success' | 'error' | 'retry'; requestWallMs?: number; retryCount?: number;
  interaction?: Interaction;
};
type Queued = { event: MetricEvent; token?: string; sessionId: string };
type PendingSessionEvent = { event: MetricEvent; token?: string; sessionGeneration: number; identityGeneration: number; identity: string | null };
type RequestTicket = { category: RequestCategory; roundId?: string; token?: string; start: number; pageId: string; view: View; previousPhase?: Phase };
function uuid(): string | null {
  try {
    const source = globalThis.crypto;
    if (typeof source?.randomUUID === 'function') return source.randomUUID();
    if (typeof source?.getRandomValues === 'function') {
      const bytes = source.getRandomValues(new Uint8Array(16));
      bytes[6] = (bytes[6] & 0x0f) | 0x40; bytes[8] = (bytes[8] & 0x3f) | 0x80;
      const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }
  } catch { /* telemetry is optional on older or restricted clients */ }
  return null;
}
const now = () => performance.now();
const phaseTime: Record<'read_think' | 'compose' | 'waiting', number> = { read_think: 0, compose: 0, waiting: 0 };
let tabId = '';
let pageId = '';
let view: View = 'other';
let routeKey = '';
let enabled = false;
let sessionId: string | null = null;
let idleAfterMs = 30000;
let heartbeatMs = 15000;
let sessionFlight: Promise<void> | null = null;
let sessionController: AbortController | null = null;
let sessionGeneration = 0;
let pendingSessionGeneration: number | null = null;
let identity: string | null | undefined;
let listenersInstalled = false;
let started = false;
let missionEmbedded = false;
let recordingConsent = false;
let pendingRoute: string | null = null;
let intervalAt = 0;
let phaseAt = 0;
let lastActivity = 0;
let lastReplyAt: number | null = null;
let currentRound: { id: string; token?: string } | null = null;
let currentPhase: Phase = 'read_think';
let visible = typeof document === 'undefined' || document.visibilityState !== 'hidden';
let timer: number | null = null;
let queue: Queued[] = [];
let pendingSessionQueue: PendingSessionEvent[] = [];
let flushFlight: Promise<void> | null = null;
let flushController: AbortController | null = null;
let identityChange: string | null | undefined;
let identityGeneration = 0;
const pendingRoundRequests = new Map<string, { count: number; previous: Phase }>();
const MAX_QUEUED_EVENTS = 500;

function stableTabId() {
  try {
    const key = 'workshop-metrics-tab';
    const saved = sessionStorage.getItem(key);
    if (saved && /^[0-9a-f-]{36}$/i.test(saved)) return saved;
    const created = uuid(); if (created) sessionStorage.setItem(key, created); return created;
  } catch { return uuid(); }
}

function classify(path: string): View {
  if (path.startsWith('/diary')) return 'diary';
  if (path.startsWith('/mission')) return 'mission';
  if (path.startsWith('/collect/')) return 'collect';
  if (path.startsWith('/reference/play/') || path.startsWith('/reference')) return 'passport';
  if (path.startsWith('/orchestration')) return 'orchestration';
  if (path.startsWith('/levels/')) return 'editor';
  if (path.startsWith('/attempts')) return 'tests';
  if (path.startsWith('/settings') || path.startsWith('/team')) return 'settings';
  if (path === '/' || path.startsWith('/collections')) return 'workshop';
  return 'other';
}

function enqueue(event: Omit<MetricEvent, 'eventId' | 'tabId' | 'pageId' | 'view'> & { pageId?: string; view?: View }, scope?: { id: string; token?: string }) {
  if (!started || !recordingConsent || missionEmbedded) return;
  const eventId = uuid();
  if (!eventId) { enabled = false; sessionId = null; if (timer !== null) { window.clearInterval(timer); timer = null; } return; }
  const measured: MetricEvent = { eventId, tabId, pageId: event.pageId || pageId, view: event.view || view, ...event, ...(scope?.id ? { roundId: scope.id } : {}) };
  if (!enabled || !sessionId) {
    // Consent may be granted while the server is still opening the session.
    // Keep only anonymous event metadata during that request; never block the
    // player or retain unsubmitted text, and discard on identity/consent change.
    if (pendingSessionGeneration === sessionGeneration && sessionFlight && sessionController && identity !== undefined && identityChange === undefined) {
      pendingSessionQueue.push({ event: measured, ...(scope?.token ? { token: scope.token } : {}), sessionGeneration, identityGeneration, identity });
      if (pendingSessionQueue.length > MAX_QUEUED_EVENTS) pendingSessionQueue.splice(0, pendingSessionQueue.length - MAX_QUEUED_EVENTS);
    }
    return;
  }
  const item: Queued = { sessionId, event: measured, ...(scope?.token ? { token: scope.token } : {}) };
  queue.push(item);
  if (queue.length > MAX_QUEUED_EVENTS) queue.splice(0, queue.length - MAX_QUEUED_EVENTS);
  if (queue.length >= 8) void flush(false);
}

function setScope(id?: string, token?: string) {
  if (id && currentRound?.id !== id) {
    if (currentRound) { flushInterval('heartbeat'); void flush(false); }
    lastReplyAt = null;
    currentRound = { id, token };
  } else if (id) currentRound = { id, token: token || currentRound?.token };
  return currentRound || undefined;
}

function setPhase(next: Phase, scope?: { id: string; token?: string }) {
  if (!visible && currentPhase === 'hidden' && next !== 'hidden') return;
  const pending = pendingRoundRequests.get(pageId);
  if (visible && pending?.count && (next === 'read_think' || next === 'compose')) next = 'waiting';
  if (next === currentPhase) return;
  const current = now();
  const key = currentPhase === 'read_think' || currentPhase === 'compose' || currentPhase === 'waiting' ? currentPhase : null;
  if (visible && key) {
    const from = Math.max(intervalAt, phaseAt);
    const to = Math.min(current, lastActivity + idleAfterMs);
    if (to > from) phaseTime[key] += to - from;
  }
  currentPhase = next;
  phaseAt = current;
  enqueue({ kind: 'phase', phase: next }, scope);
}

function flushInterval(kind: 'heartbeat' | 'page_exit' | 'visibility') {
  if (missionEmbedded) { intervalAt = now(); phaseAt = intervalAt; return; }
  if (!started || !enabled) { intervalAt = now(); phaseAt = intervalAt; return; }
  const end = now();
  const elapsedMs = Math.max(0, Math.min(86400000, Math.round(end - intervalAt)));
  const visibleMs = visible ? elapsedMs : 0;
  const activeEnd = Math.min(end, lastActivity + idleAfterMs);
  const activeMs = visible ? Math.max(0, Math.min(visibleMs, Math.round(activeEnd - intervalAt))) : 0;
  const idleMs = Math.max(0, visibleMs - activeMs);
  const phaseKey = currentPhase === 'read_think' || currentPhase === 'compose' || currentPhase === 'waiting' ? currentPhase : null;
  if (visible && phaseKey) {
    const from = Math.max(intervalAt, phaseAt);
    const to = Math.min(end, lastActivity + idleAfterMs);
    if (to > from) phaseTime[phaseKey] += to - from;
  }
  const phaseMs = { readThinkMs: Math.floor(phaseTime.read_think), composeMs: Math.floor(phaseTime.compose), waitingMs: Math.floor(phaseTime.waiting) };
  let excess = Math.max(0, phaseMs.readThinkMs + phaseMs.composeMs + phaseMs.waitingMs - activeMs);
  for (const key of (['readThinkMs', 'composeMs', 'waitingMs'] as const).slice().sort((a, b) => phaseMs[b] - phaseMs[a])) {
    const reduction = Math.min(excess, phaseMs[key]); phaseMs[key] -= reduction; excess -= reduction;
  }
  phaseTime.read_think = 0; phaseTime.compose = 0; phaseTime.waiting = 0;
  const phase: Phase = currentPhase;
  enqueue({ kind, phase, elapsedMs, activeMs, visibleMs, idleMs, ...phaseMs }, currentRound || undefined);
  intervalAt = end;
  phaseAt = end;
}

async function flush(keepalive: boolean) {
  if (flushFlight) { await flushFlight; if (enabled && queue.length) await flush(keepalive); return; }
  if (!enabled || !queue.length) return;
  queue = queue.filter(item => item.sessionId === sessionId);
  const batch = queue.splice(0, 50);
  const batchIdentity = identity;
  const batchGeneration = identityGeneration;
  const groups = new Map<string, Queued[]>();
  for (const item of batch) {
    const key = `${item.sessionId}:${item.event.roundId || ''}`;
    groups.set(key, [...(groups.get(key) || []), item]);
  }
  const controller = new AbortController(); flushController = controller;
  flushFlight = (async () => {
    for (const items of groups.values()) {
      if (batchGeneration !== identityGeneration || controller.signal.aborted) return;
      const first = items[0];
      const roundToken = items.find(item => item.token)?.token;
      const send = () => fetch('/api/telemetry/events', {
        method: 'POST', credentials: 'same-origin', keepalive,
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', ...(first.event.roundId && roundToken ? { 'x-round-token': roundToken } : {}) },
        body: JSON.stringify({ sessionId: first.sessionId, events: items.map(item => item.event) }),
      });
      let response = await send();
      if (response.status === 401 && batchIdentity === identity && batchGeneration === identityGeneration && identityChange === undefined) {
        enabled = false; sessionId = null; pendingSessionGeneration = null; void openSession(); return;
      }
      if (!response.ok && response.status !== 401 && response.status !== 429) continue;
    }
  })().catch(() => { /* optional telemetry must not affect the workshop */ });
  try { await flushFlight; }
  finally { flushFlight = null; if (flushController === controller) flushController = null; }
  if (enabled && queue.length >= 8) await flush(keepalive);
}

async function openSession() {
  if (!started || missionEmbedded || !pageId || !tabId || identity === undefined || !recordingConsent || identityChange !== undefined) return;
  if (sessionFlight) return sessionFlight;
  const sessionIdentity = identity;
  const generation = sessionGeneration;
  const controller = new AbortController(); sessionController = controller;
  let flight: Promise<void> | null = null;
  flight = (async () => {
    let established = false;
    try {
      const response = await fetch('/api/telemetry/session', { method: 'POST', credentials: 'same-origin', signal: controller.signal, headers: { 'Content-Type': 'application/json' }, body: '{}' });
      if (!response.ok) return;
      const data = await response.json() as { enabled?: boolean; sessionId?: string; heartbeatSeconds?: number; idleAfterMs?: number };
      if (generation !== sessionGeneration || identity !== sessionIdentity || identityChange !== undefined || !recordingConsent) return;
      enabled = Boolean(data.enabled && data.sessionId);
      sessionId = enabled ? data.sessionId! : null;
      established = true;
      if (pendingSessionGeneration === generation) pendingSessionGeneration = null;
      heartbeatMs = Math.max(5000, Math.min(30000, (data.heartbeatSeconds || 15) * 1000));
      idleAfterMs = Math.max(10000, Math.min(120000, data.idleAfterMs || 30000));
      if (enabled) {
        const buffered = pendingSessionQueue.filter(item => item.sessionGeneration === generation && item.identityGeneration === identityGeneration && item.identity === sessionIdentity);
        pendingSessionQueue = [];
        queue.push(...buffered.map(item => ({ sessionId: sessionId!, event: item.event, ...(item.token ? { token: item.token } : {}) })));
        if (queue.length > MAX_QUEUED_EVENTS) queue.splice(0, queue.length - MAX_QUEUED_EVENTS);
        if (timer !== null) window.clearInterval(timer);
        timer = window.setInterval(() => { if (visible && now() - lastActivity >= idleAfterMs) setPhase('idle', currentRound || undefined); flushInterval('heartbeat'); void flush(false); }, heartbeatMs);
        enqueue({ kind: 'page_enter' });
        void flush(false);
      } else {
        pendingSessionQueue = pendingSessionQueue.filter(item => item.sessionGeneration !== generation);
        if (timer !== null) { window.clearInterval(timer); timer = null; }
      }
    } catch { /* optional telemetry must not affect the workshop */ }
    finally {
      if (generation === sessionGeneration) {
        if (!established) {
          pendingSessionQueue = pendingSessionQueue.filter(item => item.sessionGeneration !== generation);
          if (pendingSessionGeneration === generation) pendingSessionGeneration = null;
        }
        if (sessionFlight === flight) { sessionFlight = null; if (sessionController === controller) sessionController = null; }
        if (identity !== sessionIdentity && identityChange === undefined) void openSession();
      }
    }
  })();
  sessionFlight = flight;
  return flight!;
}

function installListeners() {
  if (listenersInstalled || typeof window === 'undefined') return;
  listenersInstalled = true;
  const activity = () => {
    const current = now();
    const wasIdle = current - lastActivity >= idleAfterMs;
    if (visible && wasIdle) { setPhase('idle', currentRound || undefined); flushInterval('heartbeat'); void flush(false); }
    lastActivity = current;
    if (visible && wasIdle && currentPhase === 'idle') setPhase('read_think', currentRound || undefined);
  };
  for (const name of ['pointerdown', 'keydown', 'touchstart', 'wheel']) window.addEventListener(name, activity, { passive: true });
  document.addEventListener('visibilitychange', () => {
    const nextVisible = document.visibilityState !== 'hidden';
    flushInterval('visibility');
    enqueue({ kind: 'visibility', phase: nextVisible ? 'read_think' : 'hidden', elapsedMs: 0, activeMs: 0, visibleMs: 0, idleMs: 0 }, currentRound || undefined);
    visible = nextVisible;
    if (nextVisible) { lastActivity = now(); currentPhase = pendingRoundRequests.get(pageId)?.count ? 'waiting' : 'read_think'; phaseAt = lastActivity; }
    else { currentPhase = 'hidden'; phaseAt = now(); }
    void flush(false);
  });
  window.addEventListener('pagehide', () => { flushInterval('page_exit'); visible = false; currentPhase = 'hidden'; phaseAt = now(); void flush(true); });
}

export function navigateMetrics(path: string) {
  if (!recordingConsent) { pendingRoute = path; return; }
  const nextView = classify(path);
  if (!started) {
    const nextTab = stableTabId(); const nextPage = uuid();
    if (!nextTab || !nextPage) { enabled = false; return; }
    started = true; tabId = nextTab; pageId = nextPage; view = nextView; routeKey = path; intervalAt = now(); phaseAt = intervalAt; lastActivity = intervalAt; visible = document.visibilityState !== 'hidden';
    missionEmbedded = nextView === 'mission';
    installListeners(); if (!missionEmbedded && identity !== undefined) void openSession(); return;
  }
  if (path === routeKey) return;
  if (!missionEmbedded) { flushInterval('page_exit'); void flush(false); }
  if (nextView === 'mission') {
    if (timer !== null) { window.clearInterval(timer); timer = null; }
    currentRound = null; lastReplyAt = null;
    const nextPage = uuid();
    if (!nextPage) { enabled = false; sessionId = null; return; }
    pageId = nextPage; view = nextView; routeKey = path; missionEmbedded = true; intervalAt = now(); phaseAt = intervalAt;
    return;
  }
  currentRound = null; lastReplyAt = null;
  const nextPage = uuid();
  if (!nextPage) { enabled = false; sessionId = null; return; }
  pageId = nextPage; view = nextView; routeKey = path; missionEmbedded = false; intervalAt = now(); phaseAt = intervalAt; lastActivity = now(); currentPhase = visible ? 'read_think' : 'hidden';
  if (!enabled && identity !== undefined) void openSession();
  else if (enabled) {
    if (timer !== null) window.clearInterval(timer);
    timer = window.setInterval(() => { if (visible && now() - lastActivity >= idleAfterMs) setPhase('idle', currentRound || undefined); flushInterval('heartbeat'); void flush(false); }, heartbeatMs);
  }
  enqueue({ kind: 'page_enter' });
}

export function syncMetricsIdentity(userId: string | null) {
  if (identity === userId || identityChange === userId) return;
  if (identity === undefined) { identity = userId; if (recordingConsent) { pendingSessionGeneration = sessionGeneration; void openSession(); } return; }
  const generation = ++identityGeneration;
  identityChange = userId;
  enabled = false;
  if (timer !== null) { window.clearInterval(timer); timer = null; }
  flushController?.abort();
  sessionController?.abort();
  queue = [];
  pendingSessionQueue = [];
  currentRound = null; lastReplyAt = null; sessionId = null;
  phaseTime.read_think = 0; phaseTime.compose = 0; phaseTime.waiting = 0;
  currentPhase = visible ? 'read_think' : 'hidden';
  intervalAt = now(); phaseAt = intervalAt; lastActivity = intervalAt;
  identity = userId; identityChange = undefined; sessionGeneration += 1; sessionFlight = null;
  pendingSessionGeneration = recordingConsent ? sessionGeneration : null;
  if (generation === identityGeneration && recordingConsent) void openSession();
}

export function setMetricsConsent(accepted: boolean) {
  if (recordingConsent === accepted) return;
  recordingConsent = accepted;
  if (!accepted) {
    enabled = false; if (timer !== null) { window.clearInterval(timer); timer = null; }
    flushController?.abort(); sessionController?.abort(); queue = []; pendingSessionQueue = []; sessionId = null;
    sessionGeneration += 1; pendingSessionGeneration = null; sessionFlight = null;
    phaseTime.read_think = 0; phaseTime.compose = 0; phaseTime.waiting = 0;
    intervalAt = now(); phaseAt = intervalAt; lastActivity = intervalAt;
    return;
  }
  pendingSessionGeneration = sessionGeneration;
  // Consent can arrive before bootstrap has resolved the account. Keep the
  // route pending, then open a session only after syncMetricsIdentity supplies
  // either the member ID or an explicit anonymous identity (null).
  if (identity !== undefined && identityChange === undefined) void openSession();
  if (pendingRoute !== null) { const route = pendingRoute; pendingRoute = null; navigateMetrics(route); }
}

function roundFrom(path: string): string | undefined {
  const match = path.match(/\/(?:reference\/)?rounds\/([0-9a-f-]{36})(?:\/|$)/i);
  return match?.[1];
}

function category(path: string, method: string): RequestCategory | null {
  if (/^\/(?:metrics|telemetry)(?:\/|$)/.test(path)) return null;
  if (/^\/orchestration\/runs\/[^/]+\/messages(?:\/|$)/.test(path)) return 'round_action';
  if (/\/rounds?\/|\/play\/|\/collect\/|\/reference\/start|\/reference\/rounds\/|\/previews/.test(path)) return 'round_action';
  if (/\/metrics\/|\/attempts\/|\/collections\/.*\/(?:summary|attempts|review|export)/.test(path)) return 'review';
  if (/\/(?:levels|versions|comments|workshop-links|reference\/design|orchestration)/.test(path) && method !== 'GET') return 'authoring';
  if (method === 'GET' || /\/bootstrap|\/login|\/logout|\/setup|\/entry/.test(path)) return 'navigation';
  return 'other';
}

export function beginMeasuredRequest(path: string, method: string, token?: string): RequestTicket | null {
  // App bootstrap can run before the first routed view has a UUID-backed page scope.
  // Skip that early request instead of emitting an invalid pageId into the collector.
  if (!started || !pageId) return null;
  const requestCategory = category(path, method);
  if (!requestCategory) return null;
  const ticket: RequestTicket = { category: requestCategory, start: now(), pageId, view };
  const id = roundFrom(path);
  if (id) {
    ticket.roundId = id;
    if (token) ticket.token = token;
    ticket.previousPhase = currentPhase;
    setScope(id, token);
  }
  if (ticket.category === 'round_action') {
    const pending = pendingRoundRequests.get(ticket.pageId);
    ticket.previousPhase = pending?.previous || currentPhase;
    pendingRoundRequests.set(ticket.pageId, { count: (pending?.count || 0) + 1, previous: ticket.previousPhase });
    if (ticket.pageId === pageId && !pending) setPhase('waiting', ticket.roundId ? { id: ticket.roundId, token: ticket.token } : undefined);
  }
  return ticket;
}

export function finishMeasuredRequest(ticket: RequestTicket | null, outcome: 'success' | 'error') {
  if (!ticket) return;
  const wall = Math.max(0, Math.min(600000, Math.round(now() - ticket.start)));
  enqueue({ kind: 'request', pageId: ticket.pageId, view: ticket.view, requestCategory: ticket.category, requestOutcome: outcome, requestWallMs: wall }, ticket.roundId ? { id: ticket.roundId, token: ticket.token } : undefined);
  if (ticket.category === 'round_action') {
    const pending = pendingRoundRequests.get(ticket.pageId);
    if (pending && pending.count > 1) pendingRoundRequests.set(ticket.pageId, { ...pending, count: pending.count - 1 });
    else pendingRoundRequests.delete(ticket.pageId);
    if (ticket.pageId === pageId && (!pending || pending.count <= 1)) setPhase(outcome === 'success' ? 'read_think' : pending?.previous || ticket.previousPhase || 'read_think', ticket.roundId ? { id: ticket.roundId, token: ticket.token } : undefined);
  }
}

export function setMetricsPhase(phase: 'read_think' | 'compose', roundId?: string, token?: string) {
  const scope = roundId ? setScope(roundId, token) : undefined;
  setPhase(phase, scope);
}

export function recordMetricsReply(roundId: string, token?: string) {
  lastReplyAt = now();
  const scope = setScope(roundId, token);
  setPhase('read_think', scope);
}

export function recordMetricsInteraction(interaction: Interaction, roundId?: string, token?: string) {
  const current = roundId ? setScope(roundId, token) : undefined;
  const sinceReplyMs = lastReplyAt === null ? undefined : Math.max(0, Math.min(86400000, Math.round(now() - lastReplyAt)));
  enqueue({ kind: 'interaction', interaction, ...(sinceReplyMs === undefined ? {} : { sinceReplyMs }) }, current);
  if (interaction !== 'hint') lastReplyAt = null;
}
