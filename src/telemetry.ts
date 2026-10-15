type View = 'workshop' | 'collect' | 'passport' | 'orchestration' | 'editor' | 'tests' | 'settings' | 'other';
type Phase = 'read_think' | 'compose' | 'waiting' | 'idle' | 'hidden';
type RequestCategory = 'navigation' | 'round_action' | 'authoring' | 'review' | 'other';
type Interaction = 'hint' | 'submit' | 'finish';
type EventKind = 'page_enter' | 'page_exit' | 'heartbeat' | 'visibility' | 'phase' | 'request' | 'interaction';
type MetricEvent = {
  eventId: string; tabId: string; pageId: string; kind: EventKind; view: View;
  roundId?: string; phase?: Phase; elapsedMs?: number; activeMs?: number; visibleMs?: number; idleMs?: number;
  readThinkMs?: number; composeMs?: number; waitingMs?: number; sinceReplyMs?: number;
  requestCategory?: RequestCategory; requestOutcome?: 'success' | 'error' | 'retry'; requestWallMs?: number; retryCount?: number;
  interaction?: Interaction;
};
type Queued = { event: MetricEvent; token?: string; sessionId: string };
type RequestTicket = { category: RequestCategory; roundId?: string; token?: string; start: number; pageId: string; view: View; previousPhase?: Phase };
const uuid = () => crypto.randomUUID();
const now = () => performance.now();
const phaseTime: Record<'read_think' | 'compose' | 'waiting', number> = { read_think: 0, compose: 0, waiting: 0 };
let tabId = '';
let pageId = uuid();
let view: View = 'other';
let routeKey = '';
let enabled = false;
let sessionId: string | null = null;
let idleAfterMs = 30000;
let heartbeatMs = 15000;
let sessionFlight: Promise<void> | null = null;
let sessionController: AbortController | null = null;
let sessionGeneration = 0;
let identity: string | null | undefined;
let listenersInstalled = false;
let started = false;
let intervalAt = 0;
let phaseAt = 0;
let lastActivity = 0;
let lastReplyAt: number | null = null;
let currentRound: { id: string; token?: string } | null = null;
let currentPhase: Phase = 'read_think';
let visible = typeof document === 'undefined' || document.visibilityState !== 'hidden';
let timer: number | null = null;
let queue: Queued[] = [];
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
    const created = uuid(); sessionStorage.setItem(key, created); return created;
  } catch { return uuid(); }
}

function classify(path: string): View {
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
  if (!started || !enabled || !sessionId) return;
  const item: Queued = { sessionId, event: { eventId: uuid(), tabId, pageId: event.pageId || pageId, view: event.view || view, ...event, ...(scope?.id ? { roundId: scope.id } : {}) }, ...(scope?.token ? { token: scope.token } : {}) };
  queue.push(item);
  if (queue.length > MAX_QUEUED_EVENTS) queue.splice(0, queue.length - MAX_QUEUED_EVENTS);
  if (queue.length >= 8) void flush(false);
}

function setScope(id?: string, token?: string) {
  if (id && token && currentRound?.id !== id) {
    if (currentRound) { flushInterval('heartbeat'); void flush(false); }
    lastReplyAt = null;
    currentRound = { id, token };
  } else if (id && token) currentRound = { id, token };
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
      const send = () => fetch('/api/telemetry/events', {
        method: 'POST', credentials: 'same-origin', keepalive,
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', ...(first.event.roundId && first.token ? { 'x-round-token': first.token } : {}) },
        body: JSON.stringify({ sessionId: first.sessionId, events: items.map(item => item.event) }),
      });
      let response = await send();
      if (response.status === 401 && batchIdentity === identity && batchGeneration === identityGeneration && identityChange === undefined) {
        enabled = false; sessionId = null; void openSession(); return;
      }
      if (!response.ok && response.status !== 401 && response.status !== 429) continue;
    }
  })().catch(() => { /* optional telemetry must not affect the workshop */ });
  try { await flushFlight; }
  finally { flushFlight = null; if (flushController === controller) flushController = null; }
  if (enabled && queue.length >= 8) await flush(keepalive);
}

async function openSession() {
  if (sessionFlight) return sessionFlight;
  const sessionIdentity = identity;
  const generation = sessionGeneration;
  const controller = new AbortController(); sessionController = controller;
  let flight: Promise<void> | null = null;
  flight = (async () => {
    try {
      const response = await fetch('/api/telemetry/session', { method: 'POST', credentials: 'same-origin', signal: controller.signal, headers: { 'Content-Type': 'application/json' }, body: '{}' });
      if (!response.ok) return;
      const data = await response.json() as { enabled?: boolean; sessionId?: string; heartbeatSeconds?: number; idleAfterMs?: number };
      if (identity !== sessionIdentity || identityChange !== undefined) return;
      enabled = Boolean(data.enabled && data.sessionId);
      sessionId = enabled ? data.sessionId! : null;
      heartbeatMs = Math.max(5000, Math.min(30000, (data.heartbeatSeconds || 15) * 1000));
      idleAfterMs = Math.max(10000, Math.min(120000, data.idleAfterMs || 30000));
      if (enabled) {
        if (timer !== null) window.clearInterval(timer);
        timer = window.setInterval(() => { if (visible && now() - lastActivity >= idleAfterMs) setPhase('idle', currentRound || undefined); flushInterval('heartbeat'); void flush(false); }, heartbeatMs);
        enqueue({ kind: 'page_enter' });
        void flush(false);
      } else if (timer !== null) { window.clearInterval(timer); timer = null; }
    } catch { /* optional telemetry must not affect the workshop */ }
    finally {
      if (generation === sessionGeneration) {
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
  const nextView = classify(path);
  if (!started) {
    started = true; tabId = stableTabId(); view = nextView; routeKey = path; intervalAt = now(); phaseAt = intervalAt; lastActivity = intervalAt; visible = document.visibilityState !== 'hidden';
    installListeners(); if (identity !== undefined) void openSession(); return;
  }
  if (path === routeKey) return;
  flushInterval('page_exit');
  void flush(false);
  currentRound = null; lastReplyAt = null;
  pageId = uuid(); view = nextView; routeKey = path; intervalAt = now(); phaseAt = intervalAt; lastActivity = intervalAt; currentPhase = visible ? 'read_think' : 'hidden';
  enqueue({ kind: 'page_enter' });
}

export function syncMetricsIdentity(userId: string | null) {
  if (identity === userId || identityChange === userId) return;
  if (identity === undefined) { identity = userId; void openSession(); return; }
  const generation = ++identityGeneration;
  identityChange = userId;
  enabled = false;
  if (timer !== null) { window.clearInterval(timer); timer = null; }
  flushController?.abort();
  sessionController?.abort();
  queue = [];
  currentRound = null; lastReplyAt = null; sessionId = null;
  phaseTime.read_think = 0; phaseTime.compose = 0; phaseTime.waiting = 0;
  intervalAt = now(); phaseAt = intervalAt; lastActivity = intervalAt;
  identity = userId; identityChange = undefined; sessionGeneration += 1; sessionFlight = null;
  if (generation === identityGeneration) void openSession();
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
  const requestCategory = category(path, method);
  if (!requestCategory) return null;
  const ticket: RequestTicket = { category: requestCategory, start: now(), pageId, view };
  const id = token ? roundFrom(path) : undefined;
  if (id && token) {
    ticket.roundId = id; ticket.token = token; ticket.previousPhase = currentPhase;
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
  const scope = roundId && token ? setScope(roundId, token) : undefined;
  setPhase(phase, scope);
}

export function recordMetricsReply(roundId: string, token?: string) {
  lastReplyAt = now();
  const scope = token ? setScope(roundId, token) : undefined;
  setPhase('read_think', scope);
}

export function recordMetricsInteraction(interaction: Interaction, roundId?: string, token?: string) {
  const current = roundId && token ? setScope(roundId, token) : undefined;
  const sinceReplyMs = lastReplyAt === null ? undefined : Math.max(0, Math.min(86400000, Math.round(now() - lastReplyAt)));
  enqueue({ kind: 'interaction', interaction, ...(sinceReplyMs === undefined ? {} : { sinceReplyMs }) }, current);
  if (interaction !== 'hint') lastReplyAt = null;
}
