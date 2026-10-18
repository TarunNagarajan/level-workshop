/*
 * Copyright (C) 2026 Level Workshop contributors.
 * Licensed under GNU GPL version 3 or later. See LICENSE and NOTICE.
 * Complete corresponding source for the separate Mission archive iframe program.
 */

import { createCrtRenderer } from './crt-renderer.js';
const $ = selector => document.querySelector(selector);
const root = $('#mission-root');
const screens = { welcome: $('.welcome-screen'), film: $('#film-screen'), successFilm: $('#success-film-screen'), archive: $('#archive-screen'), success: $('#success-screen'), result: $('#result-screen') };
let actorNamespace = null;
let sessionKey = null;
let profileKey = null;
let startKeyStorage = null;
let startKeyProfileStorage = null;
const draftKey = field => `${sessionKey}:${current?.id || 'new'}:draft:${field}`;
const finishIntentKey = roundId => `${sessionKey}:${roundId}:finish-intent`;
const successPlaybackKey = roundId => `${sessionKey}:${roundId}:success-playback`;
const successFilmPositionKey = roundId => `${sessionKey}:${roundId}:success-film-position`;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
let configuration = null;
let current = null;
let selectedProfile = 'standard';
let startupInFlight = false;
let timerId = 0;
let followLatest = true;
let previousLogScrollTop = 0;
let preserveLatestDuringLayout = false;
let currentRequest = null;
let toastTimer = 0;
let filmControlsTimer = 0;
let successFilmWatchdog = 0;
let replayingBrief = false;
let finishInProgress = false;
let finishPromise = null;
let finishIntentRoundId = null;
let filmTransitionInFlight = false;
let handoffGeneration = 0;
let handoffFrameId = 0;
let handoffRafId = 0;
let handoffTimerId = 0;
let handoffWaitResolve = null;
let handoffAnimation = null;
let handoffTransitionCancel = null;
let handoffStage = 'idle';
let successFilmStarting = false;
let successFilmCompleted = false;
let successFilmGeneration = 0;
let successFilmActiveRoundId = null;
let missionMuted = false;
let metricsSessionId = null;
let metricsTabId = null;
let metricsPageId = randomId();
let metricsPhase = 'read_think';
let metricsPhaseAt = Date.now();
let metricsIntervalAt = Date.now();
let metricsVisible = document.visibilityState !== 'hidden';
let metricsLastActivityAt = Date.now();
let metricDurations = { read_think: 0, compose: 0, waiting: 0, visible: 0, idle: 0 };
let crtRenderer = null;
let readableTranscript = false;
let visualFallback = false;

function randomId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function setupCRTEffect() {
  const canvas = $('.crt-effect');
  const readableLog = $('#terminal-log');
  readableLog.classList.add('visually-hidden');
  crtRenderer = createCrtRenderer(canvas, { onFallback(error) {
    visualFallback = true; canvas.hidden = true; readableLog.classList.remove('visually-hidden');
    $('#readable-toggle').textContent = 'CRT unavailable'; $('#readable-toggle').disabled = true;
    $('#history-older').hidden = true; $('#history-newer').hidden = true;
    $('#terminal-status').textContent = 'READABLE MODE';
    if (error) console.warn('CRT WebGL renderer fell back to the readable transcript.', error);
  } });
  updateHistoryControls();
}
function updateHistoryControls() {
  const state = crtRenderer?.getScrollState?.();
  $('#history-older').disabled = !state || state.offset <= 0;
  $('#history-newer').disabled = !state || state.atEnd;
}
function scrollCrtHistory(lines) {
  if (!crtRenderer?.active || readableTranscript) return;
  crtRenderer.scrollBy(lines);
  const state = crtRenderer.getScrollState();
  followLatest = state.atEnd;
  updateHistoryControls();
}
function trackPhase(next, humanActivity = false) {
  const now = Date.now();
  const elapsed = Math.max(0, now - metricsPhaseAt);
  if (metricsVisible) {
    metricDurations.visible += elapsed;
    if (metricDurations[metricsPhase] !== undefined) metricDurations[metricsPhase] += elapsed;
    else if (metricsPhase === 'idle') metricDurations.idle += elapsed;
  }
  metricsPhase = next; metricsPhaseAt = now;
  if (humanActivity) metricsLastActivityAt = now;
}
async function flushMissionMetrics(kind = 'heartbeat', keepalive = false) {
  if (!metricsSessionId) return;
  const now = Date.now();
  if (metricsVisible && now - metricsLastActivityAt >= 30000 && metricsPhase !== 'idle') trackPhase('idle');
  trackPhase(metricsPhase);
  const elapsedMs = Math.min(now - metricsIntervalAt, 86400000), activeMs = metricDurations.read_think + metricDurations.compose + metricDurations.waiting;
  const event = { eventId: randomId(), tabId: metricsTabId, pageId: metricsPageId, kind, view: 'mission', ...(current?.id ? { roundId: current.id } : {}), elapsedMs, activeMs: Math.min(activeMs, elapsedMs), visibleMs: Math.min(metricDurations.visible, elapsedMs), idleMs: Math.min(metricDurations.idle, elapsedMs), readThinkMs: metricDurations.read_think, composeMs: metricDurations.compose, waitingMs: metricDurations.waiting };
  if (kind === 'phase') event.phase = metricsPhase;
  metricDurations = { read_think: 0, compose: 0, waiting: 0, visible: 0, idle: 0 }; metricsIntervalAt = now; metricsPhaseAt = now;
  try { await fetch('/api/telemetry/events', { method: 'POST', credentials: 'same-origin', keepalive, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: metricsSessionId, ...(current?.id ? { roundId: current.id } : {}), events: [event] }) }); } catch { /* optional metrics never interrupt the archive */ }
}
async function trackInteraction(interaction) {
  if (!metricsSessionId) return;
  try { await fetch('/api/telemetry/events', { method: 'POST', credentials: 'same-origin', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: metricsSessionId, events: [{ eventId: randomId(), tabId: metricsTabId, pageId: metricsPageId, kind: 'interaction', view: 'mission', interaction, ...(current?.id ? { roundId: current.id } : {}) }] }) }); } catch { /* optional metrics never interrupt the archive */ }
}
async function startMissionMetrics() {
  try {
    sessionStorage.setItem(`${sessionKey}:metrics-tab`, metricsTabId);
    const response = await fetch('/api/telemetry/session', { method: 'POST', credentials: 'same-origin' });
    if (!response.ok) return;
    const result = await response.json(); if (!result.enabled || !result.sessionId) return;
    metricsSessionId = result.sessionId;
    await flushMissionMetrics('page_enter');
    setInterval(() => void flushMissionMetrics(), result.heartbeatSeconds * 1000 || 18000);
  } catch { /* optional metrics never interrupt the archive */ }
}
class MissionError extends Error {
  constructor(message, status = 0, details = {}) { super(message); this.status = status; Object.assign(this, details); }
}
async function api(path, { method = 'GET', body, timeout = false } = {}) {
  const controller = timeout ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), 45000) : 0;
  try {
    const response = await fetch(`/api${path}`, {
      method, credentials: 'same-origin', signal: controller?.signal,
      headers: { 'Content-Type': 'application/json', ...(current?.accessToken ? { 'x-round-token': current.accessToken } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    let result = {};
    try { result = await response.json(); } catch { /* status and receipt route give the useful recovery path */ }
    if (!response.ok) throw new MissionError(result.error || `Archive request failed (${response.status}).`, response.status, result);
    return result;
  } catch (error) {
    if (error.name === 'AbortError') throw new MissionError('The archive response timed out. Its saved receipt is being checked.', 0, { unknown: true });
    throw error;
  } finally { if (timer) clearTimeout(timer); }
}
function showScreen(name) {
  for (const [key, node] of Object.entries(screens)) { node.hidden = key !== name; node.classList.remove('cinema-cut'); }
}
function tell(message) {
  const node = $('#toast'); node.textContent = message; node.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { node.hidden = true; }, 5000);
}
function setStatus(message, terminal = false) {
  $('#mission-status').textContent = message;
  if (terminal && !currentRequest) { $('#terminal-receipt').textContent = message; $('#terminal-receipt').hidden = false; }
}
function setReceiptAction(message, label, action) {
  const receipt = $('#terminal-receipt'); receipt.replaceChildren(document.createTextNode(message));
  const button = document.createElement('button'); button.type = 'button'; button.className = 'receipt-action'; button.textContent = label;
  button.addEventListener('click', action); receipt.append(document.createTextNode(' '), button); receipt.hidden = false;
}
function savedTokenFor(roundId, token) {
  if (token) sessionStorage.setItem(`${sessionKey}:${roundId}`, token);
  return token || sessionStorage.getItem(`${sessionKey}:${roundId}`) || null;
}
function attachRound(round) {
  screens.archive.classList.remove('handoff-opening', 'handoff-expanded', 'handoff-connecting');
  screens.archive.style.removeProperty('--launch-x'); screens.archive.style.removeProperty('--launch-y');
  current = { ...round, accessToken: savedTokenFor(round.id, round.accessToken) };
  finishIntentRoundId = sessionStorage.getItem(finishIntentKey(current.id)) === '1' ? current.id : null;
  followLatest = true;
  try { currentRequest = JSON.parse(sessionStorage.getItem(pendingMessageKey()) || 'null'); } catch { currentRequest = null; }
  if (currentRequest?.roundId !== current.id) currentRequest = null;
  sessionStorage.setItem(sessionKey, current.id);
  $('#profile-label').textContent = current.profile?.label || 'Standard';
  $('#terminal-status').textContent = 'ONLINE';
  $('#mission-status').textContent = 'The remote line is open.';
  $('#handoff-retry').hidden = true; setHandoffStage('game');
  $('#terminal-input').value = sessionStorage.getItem(draftKey('terminal')) || '';
  const finalizedReview = current.state?.review?.status === 'complete' || current.state?.review?.status === 'unavailable';
  if (finalizedReview) clearFinishIntent(current.id);
  showScreen(finalizedReview && !verifiedSuccess(current) ? 'result' : 'archive');
  renderMessages();
  renderState();
  if (finalizedReview) showFinalizedRound();
  else startClock();
  if (currentRequest) void recoverPendingMessage();
  if (current.state?.review?.status === 'pending') { preloadSuccessFilm(); setTimeout(() => void reloadCurrent(), 2500); }
  else if (current.state?.closedAt && !finalizedReview) setTimeout(() => void fileConversation(), 100);
  else if (finishIntentRoundId === current.id) setTimeout(() => void fileConversation(), 100);
}
function renderProfiles(items) {
  const host = $('#profiles'); host.replaceChildren();
  for (const profile of items) {
    const label = document.createElement('label'); label.className = 'profile-choice';
    const radio = document.createElement('input'); radio.type = 'radio'; radio.name = 'archive-profile'; radio.value = profile.id; radio.checked = profile.id === selectedProfile;
    radio.addEventListener('change', () => { selectedProfile = profile.id; localStorage.setItem(profileKey, selectedProfile); });
    const copy = document.createElement('span');
    const title = document.createElement('strong'); title.textContent = profile.label;
    const description = document.createElement('small'); description.textContent = profile.description;
    copy.append(title, description); label.append(radio, copy); host.append(label);
  }
  if (!items.some(profile => profile.id === selectedProfile)) selectedProfile = 'standard';
  const radio = host.querySelector(`input[value="${CSS.escape(selectedProfile)}"]`); if (radio) radio.checked = true;
}
function clearStartKey() { sessionStorage.removeItem(startKeyStorage); sessionStorage.removeItem(startKeyProfileStorage); }
function getStartKey(profileId = selectedProfile) {
  if (sessionStorage.getItem(startKeyProfileStorage) !== profileId) clearStartKey();
  let key = sessionStorage.getItem(startKeyStorage);
  if (!key) { key = randomId(); sessionStorage.setItem(startKeyStorage, key); sessionStorage.setItem(startKeyProfileStorage, profileId); }
  return key;
}
async function startMission(generation = null) {
  if (startupInFlight) return false;
  startupInFlight = true; $('#watch-button').disabled = true; $('#begin-no-film').disabled = true;
  const profileId = selectedProfile;
  const key = getStartKey(profileId); $('#terminal-status').textContent = 'CONNECTING'; $('#mission-status').textContent = 'Opening the secure archive link…'; updateControls();
  try {
    const round = await api('/mission/start', { method: 'POST', body: { profileId, startKey: key }, timeout: true });
    if (generation !== null && generation !== handoffGeneration) return false;
    $('#handoff-retry').hidden = true;
    clearStartKey(); attachRound(round); return true;
  } catch (error) {
    if (generation !== null && generation !== handoffGeneration) return false;
    $('#terminal-status').textContent = 'WAITING';
    $('#mission-status').textContent = 'The field link is waiting. Retry the same connection or exit.';
    if (error.status === 409 || error.unknown) tell(`${error.message} The start key is saved, so retrying will resume the same archive session.`);
    else tell(error.message);
    const retry = $('#handoff-retry'); if (retry) retry.hidden = false;
    root.dataset.handoffStage = 'connecting-error';
    $('#watch-button').disabled = !configuration?.connected;
    $('#begin-no-film').disabled = !configuration?.connected;
    updateControls();
    return false;
  } finally {
    startupInFlight = false;
    if (generation === null || generation === handoffGeneration) filmTransitionInFlight = false;
    if (!current && !screens.welcome.hidden) {
      $('#watch-button').disabled = !configuration?.connected;
      $('#begin-no-film').disabled = !configuration?.connected;
    }
  }
}
function cancelHandoff() {
  handoffGeneration++;
  if (handoffAnimation) { handoffAnimation.cancel(); handoffAnimation = null; }
  if (handoffTransitionCancel) { const cancel = handoffTransitionCancel; handoffTransitionCancel = null; cancel(); }
  if (handoffFrameId && $('#mission-film').cancelVideoFrameCallback) $('#mission-film').cancelVideoFrameCallback(handoffFrameId);
  handoffFrameId = 0; cancelAnimationFrame(handoffRafId); handoffRafId = 0; clearTimeout(handoffTimerId); handoffTimerId = 0;
  if (handoffWaitResolve) { const resolve = handoffWaitResolve; handoffWaitResolve = null; resolve(); }
  filmTransitionInFlight = false; handoffStage = 'idle'; root.dataset.handoffStage = 'idle';
  if (!current) {
    $('#watch-button').disabled = startupInFlight || !configuration?.connected;
    $('#begin-no-film').disabled = startupInFlight || !configuration?.connected;
  }
  const stage = $('#film-browser-stage'); stage.hidden = true; stage.setAttribute('aria-hidden', 'true'); stage.classList.remove('is-full', 'is-launching');
  const cursor = $('#file-cursor'); if (cursor) { cursor.hidden = true; cursor.style.transform = ''; cursor.style.opacity = ''; }
  const brief = $('#mission-brief'); if (brief) { brief.hidden = true; brief.classList.remove('is-open'); }
  const openButton = $('#open-archive-ai'); if (openButton) openButton.disabled = false;
  screens.film.classList.remove('brief-open');
  $('#nightjar-row')?.classList.remove('is-pressed');
  $('#file-cursor')?.classList.remove('is-clicking');
  const archive = screens.archive; archive.classList.remove('handoff-opening', 'handoff-expanded', 'handoff-connecting'); archive.style.removeProperty('--launch-x'); archive.style.removeProperty('--launch-y');
}
function setHandoffStage(name) { handoffStage = name; root.dataset.handoffStage = name; }
function waitHandoff(milliseconds) {
  clearTimeout(handoffTimerId);
  return new Promise(resolve => {
    handoffWaitResolve = resolve;
    handoffTimerId = setTimeout(() => { handoffTimerId = 0; handoffWaitResolve = null; resolve(); }, milliseconds);
  });
}
function waitForHandoffTransition(element, propertyName, fallbackMs, generation) {
  return new Promise(resolve => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true; clearTimeout(timeout); element.removeEventListener('transitionend', onEnd);
      if (handoffTransitionCancel === finish) handoffTransitionCancel = null;
      resolve(generation === handoffGeneration);
    };
    const onEnd = event => { if (event.target === element && event.propertyName === propertyName) finish(); };
    const timeout = setTimeout(finish, fallbackMs);
    handoffTransitionCancel = finish;
    element.addEventListener('transitionend', onEnd);
  });
}
function mediaQuadToViewport(point, video) {
  const rect = video.getBoundingClientRect();
  const vw = video.videoWidth || 1920, vh = video.videoHeight || 792;
  const scale = Math.max(rect.width / vw, rect.height / vh);
  const [positionX = '50%', positionY = '50%'] = getComputedStyle(video).objectPosition.split(/\s+/);
  const offsetX = parseFloat(positionX) / 100, offsetY = parseFloat(positionY) / 100;
  const left = rect.left + (rect.width - vw * scale) * offsetX;
  const top = rect.top + (rect.height - vh * scale) * offsetY;
  const encodedX = point[0] * 1.5, encodedY = point[1] * 1.5 - 144;
  return [left + encodedX * scale, top + encodedY * scale];
}
function videoFocalPosition(time = 0) {
  const mobile = innerWidth <= 620;
  if (!mobile) return 0;
  if (reducedMotion) return 0.08;
  const progress = Math.max(0, Math.min(1, (time - 8.65) / 1.15));
  const eased = progress * progress * (3 - 2 * progress);
  return 0.5 + (0.1 - 0.5) * eased;
}
function updateVideoFocalPosition(time = $('#mission-film').currentTime || 0) {
  $('#mission-film').style.objectPosition = `${videoFocalPosition(time) * 100}% 50%`;
}
const monitorTrack = [
  { t: 9.8, p: [[66, 186], [243, 147], [295, 417], [124, 485]] },
  { t: 10.1, p: [[66, 185], [243, 147], [295, 416], [124, 484]] },
  { t: 10.3, p: [[66, 184], [243, 147], [295, 416], [126, 485]] },
  { t: 10.4667, p: [[66, 187], [241, 147], [296, 414], [125, 484]] },
];
function interpolatedMonitorQuad(time) {
  let right = monitorTrack.findIndex(frame => frame.t >= time);
  if (right < 0) return monitorTrack[monitorTrack.length - 1].p;
  if (right <= 0) return monitorTrack[0].p;
  const a = monitorTrack[right - 1], b = monitorTrack[right], ratio = Math.max(0, Math.min(1, (time - a.t) / (b.t - a.t)));
  return a.p.map((point, index) => point.map((value, axis) => value + (b.p[index][axis] - value) * ratio));
}
function solveHomography(points, width, height) {
  const source = [[0, 0], [1, 0], [1, 1], [0, 1]], rows = [];
  source.forEach(([u, v], i) => {
    const [x, y] = points[i];
    rows.push([[u, v, 1, 0, 0, 0, -u * x, -v * x], x]);
    rows.push([[0, 0, 0, u, v, 1, -u * y, -v * y], y]);
  });
  for (let column = 0; column < 8; column++) {
    let pivot = column;
    for (let row = column + 1; row < 8; row++) if (Math.abs(rows[row][0][column]) > Math.abs(rows[pivot][0][column])) pivot = row;
    [rows[column], rows[pivot]] = [rows[pivot], rows[column]];
    const divisor = rows[column][0][column];
    for (let c = column; c < 8; c++) rows[column][0][c] /= divisor;
    rows[column][1] /= divisor;
    for (let row = 0; row < 8; row++) if (row !== column) {
      const factor = rows[row][0][column];
      for (let c = column; c < 8; c++) rows[row][0][c] -= factor * rows[column][0][c];
      rows[row][1] -= factor * rows[column][1];
    }
  }
  const [a, b, c, d, e, f, g, h] = rows.map(row => row[1]);
  return `matrix3d(${a / width},${d / width},0,${g / width},${b / height},${e / height},0,${h / height},0,0,1,0,${c},${f},0,1)`;
}
function desktopRect() {
  const desktop = $('#film-file-desktop'), width = desktop.offsetWidth, height = desktop.offsetHeight;
  return { width, height };
}
function nativeBrowserQuad() {
  const desktop = $('#film-file-desktop'), width = desktop.offsetWidth, height = desktop.offsetHeight;
  const x = (innerWidth - width) / 2, y = (innerHeight - height) / 2;
  return [[x, y], [x + width, y], [x + width, y + height], [x, y + height]];
}
function applyProjectedBrowser(timeOverride = null) {
  const video = $('#mission-film'), desktop = $('#film-file-desktop');
  if (screens.film.hidden || !video.videoWidth || handoffStage !== 'browser-tracking') return;
  const { width, height } = desktopRect(); if (!width || !height) return;
  const time = timeOverride ?? video.currentTime;
  updateVideoFocalPosition(time);
  const measured = interpolatedMonitorQuad(time).map(point => mediaQuadToViewport(point, video));
  const target = nativeBrowserQuad();
  const linear = Math.max(0, Math.min(1, (time - 9.8) / 0.7));
  const amount = linear * linear * (3 - 2 * linear);
  const points = measured.map((point, index) => point.map((value, axis) => value + (target[index][axis] - value) * amount));
  desktop.style.transform = solveHomography(points, width, height);
  $('#film-browser-stage').style.opacity = String(Math.max(0, Math.min(1, (time - 9.78) / 0.12)));
}
function scheduleMonitorTracking() {
  // Reduced motion goes from the moving film directly to the native browser
  // at the cut. Do not animate the tracked quad while the film is playing.
  if (reducedMotion) return;
  const video = $('#mission-film');
  const tick = (_now, metadata = {}) => {
    handoffFrameId = 0; handoffRafId = 0;
    if (screens.film.hidden || !['film', 'browser-tracking'].includes(handoffStage)) return;
    const mediaTime = Number.isFinite(metadata.mediaTime) ? metadata.mediaTime : video.currentTime;
    updateVideoFocalPosition(mediaTime);
    if (mediaTime >= 9.78) {
      if (handoffStage === 'film') {
        const stage = $('#film-browser-stage'); stage.hidden = false; stage.setAttribute('aria-hidden', 'false'); $('#film-caption').hidden = true; $('#file-browser-command').textContent = 'LOCATING NIGHTJAR…'; setHandoffStage('browser-tracking');
      }
      applyProjectedBrowser(mediaTime);
    }
    if (video.requestVideoFrameCallback) handoffFrameId = video.requestVideoFrameCallback(tick);
    else handoffRafId = requestAnimationFrame(tick);
  };
  if (video.requestVideoFrameCallback) handoffFrameId = video.requestVideoFrameCallback(tick);
  else handoffRafId = requestAnimationFrame(tick);
}
function fullBrowserTransform() {
  const desktop = $('#film-file-desktop'), width = desktop.offsetWidth, height = desktop.offsetHeight;
  return solveHomography(nativeBrowserQuad(), width, height);
}
function showFullBrowser({ fromFilm = false } = {}) {
  const stage = $('#film-browser-stage'), desktop = $('#film-file-desktop'), video = $('#mission-film');
  stage.hidden = false; stage.setAttribute('aria-hidden', 'false');
  if (fromFilm && !reducedMotion) {
    if (handoffStage !== 'browser-tracking') setHandoffStage('browser-tracking');
    applyProjectedBrowser(10.5);
    stage.style.opacity = '1'; stage.classList.add('is-full'); video.hidden = true;
  } else {
    updateVideoFocalPosition(video.currentTime || 0);
    desktop.style.transform = fullBrowserTransform(); stage.style.opacity = '1'; stage.classList.add('is-full'); video.hidden = true;
  }
  setHandoffStage('browser-full');
}
function cursorTransform(x, y, scale = 1) { return `translate3d(${x}px,${y}px,0) scale(${scale})`; }
function positionFileCursorAtRow(row, cursor) {
  const box = row.getBoundingClientRect();
  const x = box.left + Math.min(8, box.width * .05), y = box.top + box.height * .48;
  cursor.style.transform = cursorTransform(x, y);
}
async function playNightjarSelection(generation) {
  const row = $('#nightjar-row'), cursor = $('#file-cursor');
  if (!row || !cursor || generation !== handoffGeneration) return false;
  row.classList.remove('selected', 'is-pressed'); row.removeAttribute('aria-current');
  setHandoffStage('selecting-file');
  const targetBox = row.getBoundingClientRect();
  const targetX = targetBox.left + Math.min(8, targetBox.width * .05), targetY = targetBox.top + targetBox.height * .48;
  const startX = Math.max(12, innerWidth * .14), startY = Math.max(28, innerHeight * .78);
  cursor.hidden = false; cursor.style.opacity = '1';
  if (reducedMotion) {
    cursor.style.transform = cursorTransform(targetX, targetY);
    await waitHandoff(800);
  } else {
    cursor.style.transform = cursorTransform(startX, startY);
    await waitHandoff(800);
    if (generation !== handoffGeneration) return false;
    const animation = cursor.animate([
      { transform: cursorTransform(startX, startY) },
      { transform: cursorTransform(targetX, targetY) },
    ], { duration: 920, easing: 'cubic-bezier(.2,.7,.2,1)', fill: 'forwards' });
    handoffAnimation = animation;
    try { await animation.finished; } catch { return false; }
    if (handoffAnimation === animation) handoffAnimation = null;
    positionFileCursorAtRow(row, cursor);
    animation.cancel();
  }
  if (generation !== handoffGeneration) return false;
  $('#file-browser-command').textContent = 'LOCATING NIGHTJAR…';
  for (let click = 0; click < 2; click++) {
    if (generation !== handoffGeneration) return false;
    positionFileCursorAtRow(row, cursor);
    row.classList.add('is-pressed'); cursor.classList.add('is-clicking');
    await waitHandoff(reducedMotion ? 110 : 170);
    if (generation !== handoffGeneration) return false;
    row.classList.remove('is-pressed'); cursor.classList.remove('is-clicking');
    if (click === 0) await waitHandoff(reducedMotion ? 80 : 120);
  }
  row.classList.add('selected'); row.setAttribute('aria-current', 'true');
  $('#file-browser-command').textContent = 'NIGHTJAR SELECTED';
  cursor.style.opacity = '0';
  await waitHandoff(reducedMotion ? 100 : 180);
  cursor.hidden = true;
  return generation === handoffGeneration;
}
async function showMissionBrief(generation) {
  if (generation !== handoffGeneration) return false;
  const brief = $('#mission-brief'), panel = $('#mission-brief-window'), row = $('#nightjar-row');
  const rowBox = row.getBoundingClientRect();
  brief.hidden = false; brief.classList.remove('is-open');
  $('#open-archive-ai').disabled = false;
  const width = panel.offsetWidth, height = panel.offsetHeight;
  panel.style.setProperty('--brief-origin-x', `${Math.max(0, Math.min(width, rowBox.left + rowBox.width / 2 - (innerWidth - width) / 2))}px`);
  panel.style.setProperty('--brief-origin-y', `${Math.max(0, Math.min(height, rowBox.top + rowBox.height / 2 - (innerHeight - height) / 2))}px`);
  $('#file-browser-command').textContent = 'MISSION BRIEFING';
  screens.film.classList.add('brief-open');
  setHandoffStage('brief');
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  if (generation !== handoffGeneration) return false;
  brief.classList.add('is-open');
  if (!reducedMotion) await waitHandoff(520);
  if (generation !== handoffGeneration) return false;
  $('#open-archive-ai').focus({ preventScroll: true });
  return true;
}
async function openArchiveFromBrowser(generation, { resume = false } = {}) {
  if (generation !== handoffGeneration || screens.film.hidden || handoffStage === 'console-opening' || handoffStage === 'connecting' || handoffStage === 'game') return;
  const stage = $('#film-browser-stage'), archive = screens.archive, brief = $('#mission-brief');
  $('#open-archive-ai').disabled = true;
  brief.hidden = true; brief.classList.remove('is-open');
  screens.film.classList.remove('brief-open');
  $('#file-browser-command').textContent = 'OPENING ARCHIVE AI…';
  const box = $('#nightjar-row')?.getBoundingClientRect();
  const x = box ? box.left + box.width / 2 : innerWidth / 2, y = box ? box.top + box.height / 2 : innerHeight / 2;
  archive.style.setProperty('--launch-x', `${x}px`); archive.style.setProperty('--launch-y', `${y}px`);
  archive.hidden = false; archive.classList.add('handoff-opening');
  setHandoffStage('console-opening');
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  if (generation !== handoffGeneration) return;
  archive.classList.add('handoff-expanded');
  const transitionFinished = await waitForHandoffTransition(archive, 'transform', reducedMotion ? 120 : 1260, generation);
  if (!transitionFinished || generation !== handoffGeneration) return;
  stage.hidden = true; stage.setAttribute('aria-hidden', 'true'); $('#mission-film').hidden = true;
  if (resume && current && !current.endedAt) {
    archive.classList.remove('handoff-opening', 'handoff-expanded', 'handoff-connecting');
    screens.archive.hidden = false; showScreen('archive'); renderState(); startClock(); trackPhase('read_think', true);
    filmTransitionInFlight = false; setHandoffStage('game'); return;
  }
  archive.classList.add('handoff-connecting');
  setHandoffStage('connecting');
  void startMission(generation);
}
async function runArchiveHandoff({ filmEnded = false, filmless = false, returnToActive = false } = {}) {
  if (filmTransitionInFlight) return;
  filmTransitionInFlight = true;
  const generation = ++handoffGeneration;
  clearTimeout(filmControlsTimer); clearTimeout($('#mission-film').watchdog); clearTimeout($('#mission-film').bufferWatchdog);
  screens.film.classList.remove('controls-dim');
  const video = $('#mission-film');
  if (!filmEnded) video.pause();
  if (filmEnded) {
    if (handoffFrameId && video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(handoffFrameId);
    handoffFrameId = 0; cancelAnimationFrame(handoffRafId); handoffRafId = 0;
  }
  $('#mission-roomtone').pause(); $('#film-message').hidden = true;
  setHandoffStage(filmEnded ? 'browser-tracking' : 'browser-full');
  showFullBrowser({ fromFilm: filmEnded && !filmless });
  if (!filmEnded) video.hidden = true;
  const selected = await playNightjarSelection(generation);
  if (!selected || generation !== handoffGeneration) return;
  if (returnToActive && current && !current.endedAt) await openArchiveFromBrowser(generation, { resume: true });
  else await showMissionBrief(generation);
}
async function enterFilm() {
  cancelHandoff();
  showScreen('film');
  screens.film.classList.remove('controls-dim');
  const video = $('#mission-film'), roomtone = $('#mission-roomtone');
  $('#film-message').hidden = true; $('#film-caption').hidden = false; video.hidden = false; video.poster = '../mission-assets/mission-intro-v8-poster.webp';
  const stage = $('#film-browser-stage'); stage.hidden = true; stage.setAttribute('aria-hidden', 'true'); stage.classList.remove('is-full', 'is-launching');
  $('#film-file-desktop').style.transform = '';
  updateVideoFocalPosition(0);
  setHandoffStage('film'); scheduleMonitorTracking();
  video.muted = missionMuted; roomtone.muted = missionMuted;
  let fullScreenRequest = Promise.resolve();
  if (document.fullscreenEnabled && !document.fullscreenElement) fullScreenRequest = root.requestFullscreen();
  else if (!document.fullscreenEnabled) root.classList.add('immersive');
  video.currentTime = 0;
  const videoPlay = video.play();
  const audioPlay = roomtone.play().catch(() => false);
  const fullScreenState = await Promise.allSettled([fullScreenRequest, videoPlay, audioPlay]);
  if (fullScreenState[0].status === 'rejected') { root.classList.add('immersive'); $('#film-caption').textContent = 'Fullscreen was unavailable. The film will continue in this window.'; }
  if (fullScreenState[1].status === 'rejected') { showFilmError(); return; }
  clearTimeout(video.watchdog);
  video.watchdog = setTimeout(() => { if (video.readyState < 2 || video.paused) showFilmError(); }, 18000);
  dimFilmControlsSoon();
}
function launchWithoutFilm() {
  cancelHandoff();
  showScreen('film');
  $('#mission-film').hidden = true;
  $('#film-message').hidden = true;
  const stage = $('#film-browser-stage'); stage.hidden = true; stage.setAttribute('aria-hidden', 'true');
  try {
    if (document.fullscreenEnabled && !document.fullscreenElement) void root.requestFullscreen().catch(() => root.classList.add('immersive'));
    else root.classList.add('immersive');
  } catch { root.classList.add('immersive'); }
  void runArchiveHandoff({ filmless: true, returnToActive: Boolean(current && !current.endedAt) });
}
function dimFilmControlsSoon(screen = screens.film) { clearTimeout(filmControlsTimer); filmControlsTimer = setTimeout(() => screen.classList.add('controls-dim'), 3200); }
function revealFilmControls(screen) { screen.classList.remove('controls-dim'); dimFilmControlsSoon(screen); }
function armBufferWatchdog() {
  const video = $('#mission-film'); clearTimeout(video.bufferWatchdog);
  video.bufferWatchdog = setTimeout(showFilmError, 18000);
}
function showFilmError() { $('#film-message').hidden = false; $('#mission-film').pause(); }
async function finishFilm({ natural = false } = {}) {
  if (filmTransitionInFlight) return;
  const video = $('#mission-film');
  if (!natural) { handoffGeneration++; if (handoffFrameId && video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(handoffFrameId); handoffFrameId = 0; cancelAnimationFrame(handoffRafId); handoffRafId = 0; }
  await runArchiveHandoff({ filmEnded: natural, filmless: !natural, returnToActive: Boolean(current && !current.endedAt) });
  if (replayingBrief && current) replayingBrief = false;
}
function syncFilmMuteButtons() {
  const intro = $('#mute-film'), ending = $('#mute-success-film');
  if (intro) { intro.textContent = $('#mission-film').muted ? 'Unmute' : 'Mute'; intro.setAttribute('aria-pressed', String($('#mission-film').muted)); }
  if (ending) { ending.textContent = $('#success-film').muted ? 'Unmute' : 'Mute'; ending.setAttribute('aria-pressed', String($('#success-film').muted)); }
}
function setFilmMuted(muted, persist = true) {
  missionMuted = Boolean(muted);
  $('#mission-film').muted = missionMuted; $('#mission-roomtone').muted = missionMuted; $('#success-film').muted = missionMuted;
  if (persist && actorNamespace) localStorage.setItem(`mission-video-muted:${actorNamespace}`, missionMuted ? '1' : '0');
  syncFilmMuteButtons();
}
function preloadSuccessFilm() {
  const video = $('#success-film');
  if (video.preload !== 'auto') { video.preload = 'auto'; video.load(); }
}
function showSuccessFilmError(message = 'The ending film could not play. You can retry, play it directly, or skip it.') {
  if (screens.successFilm.hidden) return;
  successFilmGeneration++; clearTimeout(successFilmWatchdog); $('#success-film').pause(); successFilmStarting = false; successFilmActiveRoundId = null;
  $('#success-film-error').textContent = message;
  $('#success-film-message').hidden = false;
}
function successAttemptIsCurrent(generation, roundId) {
  return generation === successFilmGeneration && current?.id === roundId && verifiedSuccess();
}
function waitForSuccessCut(generation, roundId) {
  const source = [screens.archive, screens.success, screens.result].find(screen => !screen.hidden);
  if (!source || reducedMotion) return Promise.resolve(successAttemptIsCurrent(generation, roundId));
  source.classList.add('cinema-cut');
  return new Promise(resolve => setTimeout(() => resolve(successAttemptIsCurrent(generation, roundId)), 260));
}
async function playSuccessFilm({ replay = false, resume = false } = {}) {
  if (!verifiedSuccess()) return showResult();
  if (successFilmStarting) return;
  const roundId = current.id, video = $('#success-film');
  if (!replay && successFilmActiveRoundId === roundId && !screens.successFilm.hidden) return;
  if (!replay && sessionStorage.getItem(successPlaybackKey(roundId)) === 'seen') return showSuccessCompletion();
  const generation = ++successFilmGeneration;
  successFilmCompleted = false; successFilmStarting = true;
  successFilmActiveRoundId = roundId;
  clearTimeout(filmControlsTimer); screens.successFilm.classList.remove('controls-dim');
  screens.film.classList.remove('controls-dim');
  $('#mission-film').pause(); $('#mission-roomtone').pause();
  clearTimeout($('#mission-film').watchdog); clearTimeout($('#mission-film').bufferWatchdog);
  if (!await waitForSuccessCut(generation, roundId) || !successAttemptIsCurrent(generation, roundId)) return;
  showScreen('successFilm');
  $('#success-film-message').hidden = true;
  sessionStorage.setItem(successPlaybackKey(roundId), 'playing');
  if (video.error) video.load();
  video.preload = 'auto'; video.muted = missionMuted;
  if (video.readyState === 0) video.load();
  const resumeAt = resume && !replay ? Number(sessionStorage.getItem(successFilmPositionKey(roundId)) || 0) : 0;
  if (!successAttemptIsCurrent(generation, roundId) || screens.successFilm.hidden) return;
  if (video.readyState >= 1) video.currentTime = Math.min(Math.max(0, resumeAt), Math.max(0, Number.isFinite(video.duration) ? video.duration - 0.1 : resumeAt));
  else if (resumeAt > 0) {
    await new Promise(resolve => {
      const done = () => { video.removeEventListener('loadedmetadata', done); video.removeEventListener('error', done); resolve(); };
      video.addEventListener('loadedmetadata', done, { once: true }); video.addEventListener('error', done, { once: true });
      setTimeout(done, 2500);
    });
    if (!successAttemptIsCurrent(generation, roundId) || screens.successFilm.hidden) return;
    if (video.readyState >= 1) video.currentTime = Math.min(resumeAt, Math.max(0, Number.isFinite(video.duration) ? video.duration - 0.1 : resumeAt));
  } else video.currentTime = 0;
  if (!successAttemptIsCurrent(generation, roundId) || screens.successFilm.hidden) return;
  clearTimeout(successFilmWatchdog);
  successFilmWatchdog = setTimeout(() => {
    if (screens.successFilm.hidden) return;
    if (video.readyState < 2 || video.paused) showSuccessFilmError('The ending film is taking too long to start. Retry, use Play, or skip the ending.');
  }, 18000);
  try {
    if (!successAttemptIsCurrent(generation, roundId) || screens.successFilm.hidden) { if (screens.successFilm.hidden) video.pause(); return; }
    await video.play();
    if (!successAttemptIsCurrent(generation, roundId) || screens.successFilm.hidden) { if (screens.successFilm.hidden) video.pause(); return; }
    dimFilmControlsSoon(screens.successFilm);
  } catch (firstError) {
    if (!successAttemptIsCurrent(generation, roundId) || screens.successFilm.hidden) { if (screens.successFilm.hidden) video.pause(); return; }
    if (!missionMuted) {
      video.muted = true; syncFilmMuteButtons();
      try {
        if (!successAttemptIsCurrent(generation, roundId) || screens.successFilm.hidden) { if (screens.successFilm.hidden) video.pause(); return; }
        await video.play();
        if (!successAttemptIsCurrent(generation, roundId) || screens.successFilm.hidden) { if (screens.successFilm.hidden) video.pause(); return; }
        dimFilmControlsSoon(screens.successFilm);
        tell('The ending started muted. Use Unmute if you want sound.');
      } catch { if (!screens.successFilm.hidden && successAttemptIsCurrent(generation, roundId)) showSuccessFilmError(); else if (screens.successFilm.hidden) video.pause(); }
    } else showSuccessFilmError();
  } finally { if (generation === successFilmGeneration) successFilmStarting = false; }
}
function completeSuccessFilm() {
  if (!verifiedSuccess()) return showResult();
  successFilmGeneration++;
  clearTimeout(successFilmWatchdog);
  $('#success-film').pause();
  successFilmActiveRoundId = null;
  successFilmCompleted = true;
  sessionStorage.setItem(successPlaybackKey(current.id), 'seen');
  sessionStorage.removeItem(successFilmPositionKey(current.id));
  showSuccessCompletion();
}
async function replaySuccessFilm() {
  if (!current?.id) return;
  const roundId = current.id;
  try {
    const saved = await api(`/mission/rounds/${roundId}`);
    if (current?.id !== roundId) return;
    updateRound(saved);
    if (!verifiedSuccess()) return showResult();
    void playSuccessFilm({ replay: true });
  } catch (error) { tell(`The saved review could not be checked: ${error.message}`); }
}
function retrySuccessFilm() {
  const video = $('#success-film');
  clearTimeout(successFilmWatchdog); video.pause(); video.preload = 'auto'; video.load();
  void playSuccessFilm({ replay: true });
}
function toggleFilmMute(video) { setFilmMuted(!video.muted); }
function stopMissionMedia() {
  successFilmGeneration++;
  successFilmActiveRoundId = null;
  clearTimeout(filmControlsTimer); clearTimeout(successFilmWatchdog);
  for (const video of [$('#mission-film'), $('#success-film')]) {
    clearTimeout(video.watchdog); clearTimeout(video.bufferWatchdog); video.pause();
  }
  $('#mission-roomtone').pause();
  successFilmStarting = false;
}
function returnToWorkshop() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  root.classList.remove('immersive');
  window.parent.postMessage({ type: 'mission:return' }, location.origin);
}
function enterResult(round) {
  current = round;
  showResult();
}
function roleName(message) { return message.role === 'assistant' ? (message.opening ? 'ARCHIVE SYSTEM' : 'ARCHIVE AI') : message.role === 'user' ? (current?.playerCharacter === 'ethan-hunt' ? 'ETHAN HUNT' : 'LUTHER') : 'SYSTEM'; }
function scrollToLatestMessageStart(log = $('#terminal-log')) {
  if (!followLatest) return;
  const latest = log.querySelector('.message:last-child');
  if (latest) {
    preserveLatestDuringLayout = true;
    log.scrollTop += latest.getBoundingClientRect().top - log.getBoundingClientRect().top;
    requestAnimationFrame(() => { preserveLatestDuringLayout = false; previousLogScrollTop = log.scrollTop; });
  }
}
function renderMessages() {
  if (!current) return;
  const log = $('#terminal-log');
  const fragment = document.createDocumentFragment();
  for (const message of current.messages || []) {
    if (!['assistant', 'user'].includes(message.role)) continue;
    const entry = document.createElement('article'); entry.className = `message ${message.role}${message.opening ? ' opening' : ''}`; entry.dataset.messageId = message.id;
    const label = document.createElement('p'); label.className = 'message-label'; label.textContent = roleName(message);
    const body = document.createElement('div'); body.textContent = message.content;
    entry.append(label, body);
    fragment.append(entry);
  }
  log.replaceChildren(fragment);
  if (followLatest || current.messages?.length <= 1) scrollToLatestMessageStart(log);
  const visualMessages = [...log.querySelectorAll('.message')];
  const visualText = visualMessages.map(item => `${item.querySelector('.message-label')?.textContent || ''}\n${item.lastElementChild?.textContent || ''}`).join('\n\n');
  const latestStartLine = visualMessages.slice(0, -1).reduce((lines, item) => lines + 2 + (item.lastElementChild?.textContent || '').split('\n').length, 0);
  crtRenderer?.setText(visualText, followLatest, latestStartLine);
  updateHistoryControls();
  updateControls();
}
function renderState() {
  if (!current) return;
  const state = current.state || {};
  if (state.review?.status === 'pending') setStatus('Verifying retrieval…', true);
  else if (state.review?.status === 'unavailable') setStatus('The review is unavailable. Your filed transcript is saved.', true);
  else if (state.review?.status === 'complete') setStatus('Verification complete.', true);
  else if (state.closedAt) setStatus('Verifying retrieval…', true);
  updateControls();
}
function updateControls() {
  const active = current && !current.endedAt && !current.state?.closedAt && !current.state?.ejected && current.state?.review?.status !== 'pending' && Date.now() < current.deadline;
  const filing = finishIntentRoundId === current?.id;
  $('#terminal-input').disabled = !active || currentRequest !== null || finishInProgress || filing;
  $('#send-button').disabled = !active || currentRequest !== null || finishInProgress || filing;
  $('#finish-interrogation').disabled = !current || Boolean(currentRequest) || finishInProgress || filing || current.state?.review?.status === 'pending' || ['complete','unavailable'].includes(current.state?.review?.status);
  $('#readable-toggle').disabled = Boolean(visualFallback);
}
function startClock() {
  clearInterval(timerId); updateClock(); timerId = setInterval(updateClock, 1000);
}
function updateClock() {
  if (!current || current.endedAt || current.state?.closedAt || current.state?.review?.status === 'pending') { clearInterval(timerId); return; }
  const seconds = Math.max(0, Math.ceil((current.deadline - Date.now()) / 1000));
  $('#mission-clock').textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  if (seconds === 0) { updateControls(); setStatus('The window has closed. Select Complete mission to verify retrieval.'); }
}
function updateRound(snapshot) {
  if (!current) return;
  current = { ...current, ...snapshot, accessToken: current.accessToken };
  renderMessages(); renderState(); updateClock();
}
function pendingMessageKey() { return `${sessionKey}:${current.id}:pending-message`; }
async function checkReceipt(requestId, roundId = current?.id) {
  try { return await api(`/mission/rounds/${roundId}/receipts/${requestId}`); }
  catch (error) { if (error.status === 404) return { status: 'not_found' }; throw error; }
}
async function sendMessage(content, existingRequest = null, surface = 'terminal') {
  const trimmed = content.trim();
  if (!trimmed) return false;
  if (finishInProgress) {
    const message = 'The conversation is being filed. Your message is still here; send it after filing finishes.';
    setStatus(message, true); tell(message); updateControls();
    return false;
  }
  if (currentRequest && currentRequest.requestId !== existingRequest?.requestId) {
    const message = 'The archive is still processing the previous request. Check its receipt before sending another message.';
    setStatus(message, true); tell(message);
    return false;
  }
  const request = existingRequest || { requestId: randomId(), content: trimmed, surface };
  surface = request.surface || surface;
  const { requestId } = request, key = pendingMessageKey();
  const roundId = current.id;
  currentRequest = { ...request, key, roundId }; sessionStorage.setItem(key, JSON.stringify(currentRequest)); updateControls(); trackPhase('waiting');
  void trackInteraction('reply');
  $('#terminal-receipt').hidden = false; $('#terminal-receipt').textContent = 'Sending to archive…';
  try {
    const snapshot = await api(`/mission/rounds/${roundId}/messages`, { method: 'POST', body: { content: trimmed, requestId, surface }, timeout: true });
    if (current?.id !== roundId) return false;
    sessionStorage.removeItem(key); currentRequest = null; updateRound(snapshot); $('#terminal-receipt').hidden = true; clearSubmittedDraft(trimmed, surface); trackPhase('read_think', true);
    return true;
  } catch (error) {
    if (current?.id !== roundId) return;
    let receipt = null;
    if (error.unknown || error.receiptConfirmed || error.status === 409 || !error.status) {
      try { receipt = await checkReceipt(requestId, roundId); } catch { /* keep unknown state and same request id */ }
      if (current?.id !== roundId) return false;
      if (receipt?.snapshot) {
        sessionStorage.removeItem(key); currentRequest = null; updateRound(receipt.snapshot); $('#terminal-receipt').hidden = true; clearSubmittedDraft(trimmed, surface); trackPhase('read_think', true); return true;
      }
    }
    const knownFailed = ['failed', 'interrupted', 'rejected'].includes(receipt?.status) || ['failed', 'interrupted', 'rejected'].includes(error.submissionStatus);
    const knownNoReceipt = receipt?.status === 'not_found';
    if (knownFailed || knownNoReceipt) { currentRequest = null; sessionStorage.removeItem(key); }
    const receiptMessage = knownFailed
      ? 'The archive recorded the request, but no reply arrived. Select Retry with the same receipt.'
      : knownNoReceipt ? 'No receipt is saved yet. Retry with the same receipt to safely continue.'
      : 'The request status is unknown. Check or retry this same receipt before sending another message.';
    setStatus(error.message);
    setReceiptAction(receiptMessage, knownFailed ? 'Send again' : 'Check or retry this receipt', () => void sendMessage(trimmed, knownFailed ? null : { requestId, content: trimmed, surface }, surface)); updateControls();
    return false;
  }
}
function clearSubmittedDraft(content, surface) {
  const field = 'terminal', input = $('#terminal-input');
  if (input.value.trim() === content) { input.value = ''; input.style.height = ''; sessionStorage.removeItem(draftKey(field)); }
}
async function recoverPendingMessage() {
  const pending = currentRequest;
  if (!pending || !current) return;
  $('#terminal-receipt').hidden = false; $('#terminal-receipt').textContent = 'Checking the saved archive receipt…';
  try {
    const receipt = await checkReceipt(pending.requestId, pending.roundId);
    if (current?.id !== pending.roundId) return;
    if (receipt.snapshot) {
      sessionStorage.removeItem(pendingMessageKey()); currentRequest = null; updateRound(receipt.snapshot);
      $('#terminal-receipt').hidden = true; clearSubmittedDraft(pending.content, pending.surface); return;
    }
    const knownFailed = ['failed', 'interrupted', 'rejected'].includes(receipt.status);
    if (knownFailed) { currentRequest = null; sessionStorage.removeItem(pendingMessageKey()); }
    $('#terminal-receipt').textContent = knownFailed ? 'The archive recorded this message, but no reply arrived. Send it again with a new receipt.' : 'The archive request is still unresolved. Check or retry this same receipt before sending another message.';
    const message = knownFailed ? 'The archive recorded this message, but no reply arrived. Send it again with a new receipt.' : 'The archive request is still unresolved. Check or retry this same receipt before sending another message.';
    setReceiptAction(message, knownFailed ? 'Send again' : 'Check or retry this receipt', () => void sendMessage(pending.content, knownFailed ? null : pending, pending.surface));
  } catch (error) {
    setReceiptAction(`Receipt check failed: ${error.message}. The original message is saved and will not be changed.`, 'Check receipt again', () => void recoverPendingMessage());
  }
  updateControls();
}
async function fileConversation() {
  if (finishInProgress) return finishPromise;
  if (!current || currentRequest) {
    if (currentRequest) { const message = 'Check or retry the pending archive receipt before filing.'; setStatus(message, true); tell(message); }
    return false;
  }
  const filingRoundId = current.id;
  finishIntentRoundId = filingRoundId;
  sessionStorage.setItem(finishIntentKey(filingRoundId), '1');
  finishInProgress = true;
  updateControls();
  setStatus('Verifying retrieval…', true);
  finishPromise = (async () => {
    try {
      if (current?.id !== filingRoundId) return false;
      if (currentRequest) throw new Error('The archive is processing a message. Check its receipt before filing.');
      void trackInteraction('finish');
      preloadSuccessFilm();
      const filed = await api(`/mission/rounds/${filingRoundId}/finish`, { method: 'POST', body: {} });
      if (current?.id !== filingRoundId) return false;
      current = { ...current, ...filed, accessToken: current.accessToken };
      renderState();
      if (filed.state?.review?.status === 'pending') { showScreen('archive'); setStatus('Verifying retrieval…'); setTimeout(() => void reloadCurrent(), 2500); return true; }
      if (filed.state?.review?.status === 'complete' || filed.state?.review?.status === 'unavailable') { clearFinishIntent(filingRoundId); showFinalizedRound(); }
      return true;
    } catch (error) {
      if (current?.id === filingRoundId) {
        try {
          const saved = await api(`/mission/rounds/${filingRoundId}`);
          if (current?.id !== filingRoundId) return false;
          updateRound(saved);
          if (saved.state?.review?.status === 'complete' || saved.state?.review?.status === 'unavailable') { clearFinishIntent(filingRoundId); showFinalizedRound(); return true; }
          if (saved.state?.review?.status === 'pending') { showScreen('archive'); setStatus('Verifying retrieval…'); setTimeout(() => void reloadCurrent(), 2500); return true; }
          if (saved.state?.closedAt) { showScreen('archive'); setStatus('Verifying retrieval…'); setTimeout(() => void fileConversation(), 2000); return true; }
        } catch { /* Keep the filing intent so reload can reconcile the saved round. */ }
        setStatus(`${error.message} The filing request is being checked before the conversation can resume.`, true);
        setReceiptAction('The filing status is not confirmed yet. Keep this conversation open while it is checked.', 'Check filing status', () => void reconcileFinishIntent(filingRoundId));
        tell(error.message);
      }
      return false;
    } finally {
      finishInProgress = false;
      finishPromise = null;
      updateControls();
    }
  })();
  return finishPromise;
}
function clearFinishIntent(roundId) {
  sessionStorage.removeItem(finishIntentKey(roundId));
  if (finishIntentRoundId === roundId) finishIntentRoundId = null;
}
async function reconcileFinishIntent(roundId) {
  if (!current || current.id !== roundId) return;
  try {
    const saved = await api(`/mission/rounds/${roundId}`);
    if (current?.id !== roundId) return;
    updateRound(saved);
    if (saved.state?.review?.status === 'complete' || saved.state?.review?.status === 'unavailable') { clearFinishIntent(roundId); showFinalizedRound(); return; }
    if (saved.state?.review?.status === 'pending' || saved.state?.closedAt) { showScreen('archive'); setStatus('Verifying retrieval…'); setTimeout(() => void reloadCurrent(), 2500); return; }
    void fileConversation();
  } catch (error) {
    setReceiptAction(`Filing status check failed: ${error.message}. The saved conversation remains protected.`, 'Check filing status', () => void reconcileFinishIntent(roundId));
  }
}
async function reloadCurrent() {
  if (!current) return;
  try { const round = await api(`/mission/rounds/${current.id}`); updateRound(round); if (round.state?.review?.status === 'pending') setTimeout(() => void reloadCurrent(), 2500); else if (round.state?.review?.status === 'complete' || round.state?.review?.status === 'unavailable') showFinalizedRound(); else if (round.state?.closedAt) void fileConversation(); }
  catch (error) { tell(error.message); }
}
function verifiedSuccess(round = current) { return round?.state?.review?.status === 'complete' && round.state.review.verdict === 'recovered'; }
function renderSavedTranscript(target) {
  const transcript = $(target); transcript.replaceChildren();
  for (const message of current?.messages || []) {
    const row = document.createElement('div'); row.className = 'transcript-entry';
    const role = document.createElement('strong'); role.textContent = roleName(message);
    const body = document.createElement('span'); body.textContent = message.content;
    row.append(role, body); transcript.append(row);
  }
}
function showFinalizedRound() {
  if (verifiedSuccess()) {
    clearInterval(timerId);
    if (successFilmActiveRoundId === current.id && !screens.successFilm.hidden) return;
    const playback = sessionStorage.getItem(successPlaybackKey(current.id));
    if (playback === 'seen') showSuccessCompletion();
    else void playSuccessFilm({ resume: playback === 'playing' });
    return;
  }
  showResult();
}
function showSuccessCompletion() {
  if (!verifiedSuccess()) return showResult();
  successFilmGeneration++;
  clearInterval(timerId); clearTimeout(successFilmWatchdog);
  const video = $('#success-film'); video.pause();
  sessionStorage.setItem(successPlaybackKey(current.id), 'seen');
  successFilmCompleted = true; successFilmStarting = false; successFilmActiveRoundId = null;
  renderSavedTranscript('#success-transcript');
  showScreen('success');
  $('#success-title').focus({ preventScroll: true });
}
function showResult() {
  if (verifiedSuccess()) return showFinalizedRound();
  clearInterval(timerId); showScreen('result');
  const review = current?.state?.review;
  const labels = { partial: 'Mission incomplete', not_recovered: 'Mission incomplete', uncertain: 'Review inconclusive' };
  $('#result-title').textContent = review?.status === 'complete' ? labels[review.verdict] || 'Mission filed' : 'Mission filed';
  $('#result-outcome').textContent = review?.status === 'complete'
    ? 'The archive session is saved. The source identity was not verified in an eligible AI reply.'
    : 'The archive session is saved, but its review could not finish. You can inspect the transcript or retry the review if available.';
  $('#result-reason').textContent = review?.status === 'complete' ? review.reason : 'The automated review could not complete.';
  const evidence = $('#result-evidence'); evidence.replaceChildren();
  for (const item of review?.evidence || []) {
    const quote = document.createElement('blockquote'); quote.className = 'evidence-quote';
    const source = document.createElement('small'); source.textContent = 'Cited archive reply';
    const body = document.createElement('span'); body.textContent = item.quote;
    quote.append(source, body); evidence.append(quote);
  }
  renderSavedTranscript('#result-transcript');
  const retry = $('#retry-review'); retry.hidden = !(review?.status === 'unavailable' && review.retryable && review.attempts < 3);
}
async function retryReview() {
  $('#retry-review').disabled = true;
  try {
    await api(`/mission/rounds/${current.id}/review/retry`, { method: 'POST', body: {} });
    const result = await api(`/mission/rounds/${current.id}/finish`, { method: 'POST', body: {} });
    current = { ...current, ...result, accessToken: current.accessToken };
    if (result.state?.review?.status === 'pending') { preloadSuccessFilm(); showScreen('archive'); setStatus('Verifying retrieval…'); setTimeout(() => void reloadCurrent(), 2500); }
    else if (result.state?.review?.status === 'complete' || result.state?.review?.status === 'unavailable') showFinalizedRound();
  } catch (error) {
    try {
      const saved = await api(`/mission/rounds/${current.id}`); updateRound(saved);
      if (saved.state?.review?.status === 'pending') { preloadSuccessFilm(); showScreen('archive'); setStatus('Verifying retrieval…'); setTimeout(() => void reloadCurrent(), 2500); }
      else if (saved.state?.review?.status === 'complete' || saved.state?.review?.status === 'unavailable') showFinalizedRound();
      else tell(error.message);
    } catch { tell(error.message); }
  }
  finally { $('#retry-review').disabled = false; }
}
function exitArchive() {
  cancelHandoff();
  clearInterval(timerId); stopMissionMedia();
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  $('#mission-roomtone').pause();
  root.classList.remove('immersive');
  if (current && !current.endedAt) tell('Mission suspended. Your archive session is saved and will resume when you return.');
  showScreen('welcome');
  $('#watch-button').disabled = startupInFlight || !configuration?.connected;
  $('#begin-no-film').disabled = startupInFlight || !configuration?.connected;
}
function prepareNewAttempt() {
  cancelHandoff();
  stopMissionMedia();
  if (current) sessionStorage.removeItem(`${sessionKey}:${current.id}:draft:terminal`);
  currentRequest = null; current = null; clearStartKey(); sessionStorage.removeItem(sessionKey); showScreen('welcome');
  $('#begin-no-film').disabled = !configuration?.connected; $('#watch-button').disabled = !configuration?.connected;
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  root.classList.remove('immersive');
}
async function initialize() {
  try {
    setupCRTEffect();
    const identity = await api('/bootstrap');
    if (!identity.user?.id) throw new Error('Sign in to continue to the archive.');
    actorNamespace = String(identity.user.id).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
    if (!actorNamespace) throw new Error('The signed-in archive identity is unavailable.');
    missionMuted = localStorage.getItem(`mission-video-muted:${actorNamespace}`) === '1'; syncFilmMuteButtons();
    sessionKey = `mission-archive-v1:${actorNamespace}:session`;
    profileKey = `mission-archive-v1:${actorNamespace}:profile`;
    startKeyStorage = `mission-archive-v1:${actorNamespace}:start-key`;
    startKeyProfileStorage = `mission-archive-v1:${actorNamespace}:start-key-profile`;
    selectedProfile = localStorage.getItem(profileKey) || 'standard';
    metricsTabId = sessionStorage.getItem(`${sessionKey}:metrics-tab`) || randomId();
    configuration = await api('/mission'); renderProfiles(configuration.profiles || []);
    void startMissionMetrics();
    const connected = Boolean(configuration.connected);
    $('#watch-button').disabled = !connected; $('#begin-no-film').disabled = !connected;
    $('#connect-note').textContent = connected ? 'Archive target connected.' : 'The workshop target is not connected yet. Ask the workspace owner to connect it.';
    const existing = await api('/mission/active');
    if (existing) attachRound(existing);
    root.dataset.missionReady = 'true';
  } catch (error) { $('#connect-note').textContent = error.message; $('#profiles').textContent = 'Archive profiles are unavailable.'; }
}

$('#watch-button').addEventListener('click', () => void enterFilm());
$('#begin-no-film').addEventListener('click', launchWithoutFilm);
$('#skip-film').addEventListener('click', () => void finishFilm({ natural: false }));
$('#open-archive-ai').addEventListener('click', () => void openArchiveFromBrowser(handoffGeneration, { resume: Boolean(current && !current.endedAt) }));
$('#return-from-brief').addEventListener('click', exitArchive);
$('#mission-brief').addEventListener('keydown', event => {
  if (event.key === 'Escape') { event.preventDefault(); exitArchive(); return; }
  if (event.key !== 'Tab') return;
  const brief = $('#mission-brief');
  const focusable = [...brief.querySelectorAll('button:not(:disabled),a[href],input:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])')].filter(node => node.getClientRects().length);
  if (!focusable.length) return;
  const first = focusable[0], last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
});
$('#mission-film').addEventListener('ended', () => void finishFilm({ natural: true }));
screens.film.addEventListener('pointermove', () => revealFilmControls(screens.film));
screens.film.addEventListener('pointerdown', () => revealFilmControls(screens.film));
screens.film.addEventListener('focusin', () => screens.film.classList.remove('controls-dim'));
screens.film.addEventListener('focusout', () => dimFilmControlsSoon(screens.film));
$('#mission-film').addEventListener('error', showFilmError);
$('#mission-film').addEventListener('loadeddata', () => { const video = $('#mission-film'); if (video.readyState >= 2) clearTimeout(video.watchdog); });
$('#mission-film').addEventListener('waiting', armBufferWatchdog);
$('#mission-film').addEventListener('stalled', armBufferWatchdog);
$('#mission-film').addEventListener('playing', () => { const video = $('#mission-film'); clearTimeout(video.watchdog); clearTimeout(video.bufferWatchdog); });
$('#retry-film').addEventListener('click', () => void enterFilm());
$('#start-filmless').addEventListener('click', launchWithoutFilm);
$('#handoff-retry').addEventListener('click', () => { $('#handoff-retry').hidden = true; setHandoffStage('connecting'); void startMission(handoffGeneration); });
$('#fullscreen-film').addEventListener('click', async () => { try { await root.requestFullscreen(); root.classList.remove('immersive'); } catch { root.classList.add('immersive'); } });
$('#mute-film').addEventListener('click', () => toggleFilmMute($('#mission-film')));
$('#mute-success-film').addEventListener('click', () => toggleFilmMute($('#success-film')));
$('#skip-success-film').addEventListener('click', completeSuccessFilm);
$('#skip-success-film-fallback').addEventListener('click', completeSuccessFilm);
$('#success-film').addEventListener('ended', completeSuccessFilm);
$('#success-film').addEventListener('error', () => showSuccessFilmError());
$('#success-film').addEventListener('waiting', () => {
  clearTimeout(successFilmWatchdog);
  successFilmWatchdog = setTimeout(() => showSuccessFilmError('The ending film stopped buffering. Retry, use Play, or skip the ending.'), 18000);
});
$('#success-film').addEventListener('stalled', () => {
  clearTimeout(successFilmWatchdog);
  successFilmWatchdog = setTimeout(() => showSuccessFilmError('The ending film stopped buffering. Retry, use Play, or skip the ending.'), 18000);
});
$('#success-film').addEventListener('playing', () => clearTimeout(successFilmWatchdog));
$('#success-film').addEventListener('timeupdate', event => {
  const video = event.currentTarget;
  if (verifiedSuccess() && !successFilmCompleted && !video.paused) sessionStorage.setItem(successFilmPositionKey(current.id), String(video.currentTime));
});
$('#success-film').addEventListener('pause', () => { if (screens.successFilm.hidden || successFilmCompleted) return; });
$('#play-success-film').addEventListener('click', () => { $('#success-film-message').hidden = true; void playSuccessFilm({ replay: true }); });
$('#retry-success-film').addEventListener('click', retrySuccessFilm);
$('#fullscreen-success-film').addEventListener('click', async () => { try { await root.requestFullscreen(); root.classList.remove('immersive'); } catch { root.classList.add('immersive'); } });
$('#return-success-film').addEventListener('click', exitArchive);
screens.successFilm.addEventListener('pointermove', () => revealFilmControls(screens.successFilm));
screens.successFilm.addEventListener('pointerdown', () => revealFilmControls(screens.successFilm));
screens.successFilm.addEventListener('focusin', () => screens.successFilm.classList.remove('controls-dim'));
screens.successFilm.addEventListener('focusout', () => dimFilmControlsSoon(screens.successFilm));
document.addEventListener('keydown', event => {
  if (event.key !== 'Tab') return;
  const visibleFilm = [screens.film, screens.successFilm].find(screen => !screen.hidden);
  if (visibleFilm) revealFilmControls(visibleFilm);
}, true);
$('#replay-success-film').addEventListener('click', () => void replaySuccessFilm());
$('#success-new-attempt').addEventListener('click', prepareNewAttempt);
$('#success-return-workshop').addEventListener('click', returnToWorkshop);
$('#return-film').addEventListener('click', exitArchive);
$('#fullscreen-game').addEventListener('click', async () => { try { await root.requestFullscreen(); root.classList.remove('immersive'); } catch { root.classList.add('immersive'); tell('Fullscreen is unavailable. The archive remains open in this window.'); } });
$('#exit-game').addEventListener('click', exitArchive);
$('#finish-interrogation').addEventListener('click', () => void fileConversation());
$('#readable-toggle').addEventListener('click', () => {
  readableTranscript = !readableTranscript;
  const log = $('#terminal-log'), state = crtRenderer?.getScrollState?.();
  if (readableTranscript && state) log.scrollTop = state.max ? (state.offset / state.max) * (log.scrollHeight - log.clientHeight) : 0;
  else if (!readableTranscript && state) {
    const range = Math.max(1, log.scrollHeight - log.clientHeight);
    crtRenderer.setScroll(Math.round((log.scrollTop / range) * state.max));
  }
  $('#terminal-log').classList.toggle('visually-hidden', !readableTranscript);
  $('.crt-effect').hidden = readableTranscript;
  $('#history-older').hidden = readableTranscript; $('#history-newer').hidden = readableTranscript;
  $('#readable-toggle').setAttribute('aria-pressed', String(readableTranscript));
  $('#readable-toggle').textContent = readableTranscript ? 'Return to CRT' : 'Readable transcript';
});
$('#retry-review').addEventListener('click', () => void retryReview());
$('#new-attempt').addEventListener('click', prepareNewAttempt);
window.addEventListener('resize', () => {
  if (!screens.film.hidden) updateVideoFocalPosition();
  if (handoffStage === 'browser-tracking') applyProjectedBrowser();
  else if (['browser-full', 'selecting-file', 'brief'].includes(handoffStage)) $('#film-file-desktop').style.transform = fullBrowserTransform();
  else if (handoffStage === 'console-opening') {
    const box = $('#nightjar-row')?.getBoundingClientRect();
    if (box) { screens.archive.style.setProperty('--launch-x', `${box.left + box.width / 2}px`); screens.archive.style.setProperty('--launch-y', `${box.top + box.height / 2}px`); }
  }
});
$('#return-workshop').addEventListener('click', returnToWorkshop);
$('#history-older').addEventListener('click', () => scrollCrtHistory(-4));
$('#history-newer').addEventListener('click', () => scrollCrtHistory(4));
document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement) root.classList.remove('immersive'); });
window.addEventListener('resize', () => {
  if (followLatest) requestAnimationFrame(() => scrollToLatestMessageStart());
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') { trackPhase('hidden'); metricsVisible = false; }
  else { trackPhase('read_think', true); metricsVisible = true; }
  void flushMissionMetrics('visibility');
});
for (const eventName of ['pointerdown', 'keydown', 'touchstart', 'wheel']) window.addEventListener(eventName, () => {
  metricsLastActivityAt = Date.now();
  if (metricsVisible && metricsPhase === 'idle') trackPhase('read_think', true);
}, { passive: true });
$('#terminal-log').addEventListener('scroll', () => {
  const log = $('#terminal-log'), distanceToEnd = log.scrollHeight - log.scrollTop - log.clientHeight;
  if (preserveLatestDuringLayout) { previousLogScrollTop = log.scrollTop; return; }
  if (distanceToEnd < 45) followLatest = true;
  else if (log.scrollTop < previousLogScrollTop - 2) followLatest = false;
  if (readableTranscript && crtRenderer?.active) {
    const range = Math.max(1, log.scrollHeight - log.clientHeight), state = crtRenderer.getScrollState();
    crtRenderer.setScroll(Math.round((log.scrollTop / range) * state.max)); updateHistoryControls();
  }
  previousLogScrollTop = log.scrollTop;
});
$('#terminal-input').addEventListener('input', event => { sessionStorage.setItem(draftKey('terminal'), event.currentTarget.value); trackPhase('compose'); });
$('#terminal-form').addEventListener('submit', event => { event.preventDefault(); const box = $('#terminal-input'); const value = box.value; if (!value.trim()) return; void sendMessage(value); });
$('#terminal-input').addEventListener('keydown', event => {
  if (event.key !== 'Enter' || event.repeat || event.shiftKey || event.isComposing || event.keyCode === 229 || event.ctrlKey || event.altKey || event.metaKey) return;
  event.preventDefault(); $('#terminal-form').requestSubmit();
});
$('#terminal-input').addEventListener('input', event => { const box = event.currentTarget; box.style.height = 'auto'; box.style.height = `${Math.min(box.scrollHeight, 72)}px`; });
$('.crt-effect').addEventListener('wheel', event => {
  if (!crtRenderer?.active || readableTranscript) return;
  event.preventDefault(); scrollCrtHistory(Math.sign(event.deltaY) * 3);
}, { passive: false });
let touchStartY = null;
$('.crt-effect').addEventListener('touchstart', event => { touchStartY = event.touches[0]?.clientY ?? null; }, { passive: true });
$('.crt-effect').addEventListener('touchmove', event => {
  if (touchStartY === null || !crtRenderer?.active || readableTranscript) return;
  const nextY = event.touches[0]?.clientY;
  if (Number.isFinite(nextY)) {
    const delta = touchStartY - nextY;
    if (Math.abs(delta) >= 24) { scrollCrtHistory(Math.sign(delta) * 3); touchStartY = nextY; event.preventDefault(); }
  }
}, { passive: false });
$('.crt-effect').addEventListener('touchend', () => { touchStartY = null; }, { passive: true });
$('.crt-effect').addEventListener('keydown', event => {
  if (event.key === 'ArrowUp' || event.key === 'PageUp') { event.preventDefault(); scrollCrtHistory(-4); }
  else if (event.key === 'ArrowDown' || event.key === 'PageDown') { event.preventDefault(); scrollCrtHistory(4); }
  else if (event.key === 'Home') { event.preventDefault(); scrollCrtHistory(-Number.MAX_SAFE_INTEGER); }
  else if (event.key === 'End') { event.preventDefault(); scrollCrtHistory(Number.MAX_SAFE_INTEGER); }
});
window.addEventListener('pagehide', () => {
  clearInterval(timerId); void flushMissionMetrics('page_exit', true);
  const intro = $('#mission-film'), ending = $('#success-film');
  if (!screens.successFilm.hidden && verifiedSuccess() && !ending.paused) sessionStorage.setItem(successFilmPositionKey(current.id), String(ending.currentTime));
  intro.pause(); ending.pause(); $('#mission-roomtone').pause();
  clearTimeout(intro.watchdog); clearTimeout(intro.bufferWatchdog); clearTimeout(successFilmWatchdog);
});
window.addEventListener('pageshow', event => {
  if (!event.persisted || screens.successFilm.hidden || !verifiedSuccess()) return;
  if (sessionStorage.getItem(successPlaybackKey(current.id)) === 'playing') void playSuccessFilm({ resume: true });
});
void initialize();
