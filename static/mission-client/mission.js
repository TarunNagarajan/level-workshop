/*
 * Copyright (C) 2026 Level Workshop contributors.
 * Licensed under GNU GPL version 3 or later. See LICENSE and NOTICE.
 * Complete corresponding source for the separate Mission archive iframe program.
 */

import { createCrtRenderer } from './crt-renderer.js';
const $ = selector => document.querySelector(selector);
const root = $('#mission-root');
const screens = { welcome: $('.welcome-screen'), film: $('#film-screen'), archive: $('#archive-screen'), result: $('#result-screen') };
let actorNamespace = null;
let sessionKey = null;
let profileKey = null;
let startKeyStorage = null;
const draftKey = field => `${sessionKey}:${current?.id || 'new'}:draft:${field}`;
const finishIntentKey = roundId => `${sessionKey}:${roundId}:finish-intent`;
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
let replayingBrief = false;
let finishInProgress = false;
let finishPromise = null;
let finishIntentRoundId = null;
let filmTransitionInFlight = false;
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
  for (const [key, node] of Object.entries(screens)) node.hidden = key !== name;
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
  current = { ...round, accessToken: savedTokenFor(round.id, round.accessToken) };
  finishIntentRoundId = sessionStorage.getItem(finishIntentKey(current.id)) === '1' ? current.id : null;
  followLatest = true;
  try { currentRequest = JSON.parse(sessionStorage.getItem(pendingMessageKey()) || 'null'); } catch { currentRequest = null; }
  if (currentRequest?.roundId !== current.id) currentRequest = null;
  sessionStorage.setItem(sessionKey, current.id);
  $('#profile-label').textContent = current.profile?.label || 'Standard';
  $('#terminal-status').textContent = 'ONLINE';
  $('#terminal-input').value = sessionStorage.getItem(draftKey('terminal')) || '';
  const finalizedReview = current.state?.review?.status === 'complete' || current.state?.review?.status === 'unavailable';
  if (finalizedReview) clearFinishIntent(current.id);
  showScreen(finalizedReview ? 'result' : 'archive');
  renderMessages();
  renderState();
  if (finalizedReview) showResult();
  else startClock();
  if (currentRequest) void recoverPendingMessage();
  if (current.state?.review?.status === 'pending') setTimeout(() => void reloadCurrent(), 2500);
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
function clearStartKey() { sessionStorage.removeItem(startKeyStorage); }
function getStartKey() { let key = sessionStorage.getItem(startKeyStorage); if (!key) { key = randomId(); sessionStorage.setItem(startKeyStorage, key); } return key; }
async function startMission() {
  if (startupInFlight) return false;
  startupInFlight = true; $('#watch-button').disabled = true; $('#begin-no-film').disabled = true;
  const key = getStartKey(); $('#terminal-status').textContent = 'CONNECTING';
  try {
    const round = await api('/mission/start', { method: 'POST', body: { profileId: selectedProfile, startKey: key } });
    clearStartKey(); attachRound(round); return true;
  } catch (error) {
    $('#terminal-status').textContent = 'WAITING';
    if (error.status === 409 || error.unknown) tell(`${error.message} The start key is saved, so retrying will resume the same archive session.`);
    else tell(error.message);
    $('#watch-button').disabled = !configuration?.connected;
    $('#begin-no-film').disabled = !configuration?.connected;
    return false;
  } finally { startupInFlight = false; }
}
async function enterFilm() {
  filmTransitionInFlight = false;
  showScreen('film');
  screens.film.classList.remove('controls-dim');
  const video = $('#mission-film'), roomtone = $('#mission-roomtone');
  $('#film-message').hidden = true;
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
function dimFilmControlsSoon() { clearTimeout(filmControlsTimer); filmControlsTimer = setTimeout(() => screens.film.classList.add('controls-dim'), 3200); }
function armBufferWatchdog() {
  const video = $('#mission-film'); clearTimeout(video.bufferWatchdog);
  video.bufferWatchdog = setTimeout(showFilmError, 18000);
}
function showFilmError() { $('#film-message').hidden = false; $('#mission-film').pause(); }
async function finishFilm() {
  if (filmTransitionInFlight) return;
  filmTransitionInFlight = true;
  clearTimeout(filmControlsTimer);
  screens.film.classList.remove('controls-dim');
  const video = $('#mission-film'); clearTimeout(video.watchdog); clearTimeout(video.bufferWatchdog); video.pause();
  $('#mission-roomtone').pause();
  $('#film-message').hidden = true;
  $('#film-caption').textContent = 'Connecting to Langley…';
  if (video.duration) video.currentTime = Math.max(0, video.duration - 0.08);
  if (replayingBrief && current) { replayingBrief = false; filmTransitionInFlight = false; showScreen('archive'); renderState(); updateClock(); trackPhase('read_think', true); return; }
  if (!await startMission()) {
    filmTransitionInFlight = false;
    $('#film-caption').textContent = 'The field link is waiting. The final film frame will remain on screen.';
    $('#film-message').hidden = false;
  }
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
function roleName(message) { return message.role === 'assistant' ? (message.opening ? 'ARCHIVE SYSTEM' : 'ARCHIVE AI') : message.role === 'user' ? 'LUTHER' : 'SYSTEM'; }
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
  if (state.review?.status === 'pending') setStatus('Archive review is checking the saved replies…', true);
  else if (state.review?.status === 'unavailable') setStatus('The review is unavailable. Your filed transcript is saved.', true);
  else if (state.review?.status === 'complete') setStatus('The archive review is filed.', true);
  else if (state.closedAt) setStatus('The conversation is closed while the review is filed.', true);
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
  if (seconds === 0) { updateControls(); setStatus('Archive time has ended. Finish the interrogation to file the saved replies.'); }
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
  setStatus('Closing the saved conversation and reviewing archive replies…', true);
  finishPromise = (async () => {
    try {
      if (current?.id !== filingRoundId) return false;
      if (currentRequest) throw new Error('The archive is processing a message. Check its receipt before filing.');
      void trackInteraction('finish');
      const filed = await api(`/mission/rounds/${filingRoundId}/finish`, { method: 'POST', body: {} });
      if (current?.id !== filingRoundId) return false;
      current = { ...current, ...filed, accessToken: current.accessToken };
      renderState();
      if (filed.state?.review?.status === 'pending') { showScreen('archive'); setStatus('The saved conversation is under review…'); setTimeout(() => void reloadCurrent(), 2500); return true; }
      if (filed.state?.review?.status === 'complete' || filed.state?.review?.status === 'unavailable') { clearFinishIntent(filingRoundId); showResult(); }
      return true;
    } catch (error) {
      if (current?.id === filingRoundId) {
        try {
          const saved = await api(`/mission/rounds/${filingRoundId}`);
          if (current?.id !== filingRoundId) return false;
          updateRound(saved);
          if (saved.state?.review?.status === 'complete' || saved.state?.review?.status === 'unavailable') { clearFinishIntent(filingRoundId); showResult(); return true; }
          if (saved.state?.review?.status === 'pending') { showScreen('archive'); setStatus('The saved conversation is under review…'); setTimeout(() => void reloadCurrent(), 2500); return true; }
          if (saved.state?.closedAt) { showScreen('archive'); setStatus('The saved conversation is closed. Checking its review status…'); setTimeout(() => void fileConversation(), 2000); return true; }
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
    if (saved.state?.review?.status === 'complete' || saved.state?.review?.status === 'unavailable') { clearFinishIntent(roundId); showResult(); return; }
    if (saved.state?.review?.status === 'pending' || saved.state?.closedAt) { showScreen('archive'); setStatus('The saved conversation is under review…'); setTimeout(() => void reloadCurrent(), 2500); return; }
    void fileConversation();
  } catch (error) {
    setReceiptAction(`Filing status check failed: ${error.message}. The saved conversation remains protected.`, 'Check filing status', () => void reconcileFinishIntent(roundId));
  }
}
async function reloadCurrent() {
  if (!current) return;
  try { const round = await api(`/mission/rounds/${current.id}`); updateRound(round); if (round.state?.review?.status === 'pending') setTimeout(() => void reloadCurrent(), 2500); else if (round.state?.review?.status === 'complete' || round.state?.review?.status === 'unavailable') showResult(); else if (round.state?.closedAt) void fileConversation(); }
  catch (error) { tell(error.message); }
}
function showResult() {
  clearInterval(timerId); showScreen('result');
  const review = current?.state?.review;
  const title = { recovered: 'Identity recovered', partial: 'Partial recovery', not_recovered: 'Identity not recovered', uncertain: 'Recovery uncertain' };
  $('#result-title').textContent = review?.status === 'complete' ? title[review.verdict] || 'Review filed' : 'Review unavailable';
  $('#result-reason').textContent = review?.status === 'complete' ? review.reason : 'The full archive transcript and filed packet are saved. The automated review could not complete.';
  const evidence = $('#result-evidence'); evidence.replaceChildren();
  for (const item of review?.evidence || []) {
    const quote = document.createElement('blockquote'); quote.className = 'evidence-quote';
    const source = document.createElement('small'); source.textContent = 'Cited archive reply';
    const body = document.createElement('span'); body.textContent = item.quote;
    quote.append(source, body); evidence.append(quote);
  }
  const transcript = $('#result-transcript'); transcript.replaceChildren();
  for (const message of current?.messages || []) {
    const row = document.createElement('div'); row.className = 'transcript-entry';
    const role = document.createElement('strong'); role.textContent = roleName(message);
    const body = document.createElement('span'); body.textContent = message.content;
    row.append(role, body); transcript.append(row);
  }
  const retry = $('#retry-review'); retry.hidden = !(review?.status === 'unavailable' && review.retryable && review.attempts < 3);
}
async function retryReview() {
  $('#retry-review').disabled = true;
  try {
    await api(`/mission/rounds/${current.id}/review/retry`, { method: 'POST', body: {} });
    const result = await api(`/mission/rounds/${current.id}/finish`, { method: 'POST', body: {} });
    current = { ...current, ...result, accessToken: current.accessToken };
    if (result.state?.review?.status === 'pending') { showScreen('archive'); setStatus('The saved conversation is under review…'); setTimeout(() => void reloadCurrent(), 2500); }
    else if (result.state?.review?.status === 'complete' || result.state?.review?.status === 'unavailable') showResult();
  } catch (error) { tell(error.message); }
  finally { $('#retry-review').disabled = false; }
}
function exitArchive() {
  clearInterval(timerId); $('#mission-film').pause();
  $('#mission-roomtone').pause();
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  $('#mission-roomtone').pause();
  root.classList.remove('immersive');
  if (current && !current.endedAt) tell('Mission suspended. Your archive session is saved and will resume when you return.');
  showScreen('welcome');
}
function prepareNewAttempt() {
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
    sessionKey = `mission-archive-v1:${actorNamespace}:session`;
    profileKey = `mission-archive-v1:${actorNamespace}:profile`;
    startKeyStorage = `mission-archive-v1:${actorNamespace}:start-key`;
    selectedProfile = localStorage.getItem(profileKey) || 'standard';
    metricsTabId = sessionStorage.getItem(`${sessionKey}:metrics-tab`) || randomId();
    configuration = await api('/mission'); renderProfiles(configuration.profiles || []);
    void startMissionMetrics();
    const connected = Boolean(configuration.connected);
    $('#watch-button').disabled = !connected; $('#begin-no-film').disabled = !connected;
    $('#connect-note').textContent = connected ? 'Archive target connected.' : 'The workshop target is not connected yet. Ask the workspace owner to connect it.';
    const existing = await api('/mission/active');
    if (existing) { attachRound(existing); return; }
  } catch (error) { $('#connect-note').textContent = error.message; $('#profiles').textContent = 'Archive profiles are unavailable.'; }
}

$('#watch-button').addEventListener('click', () => void enterFilm());
$('#begin-no-film').addEventListener('click', () => { try { if (document.fullscreenEnabled && !document.fullscreenElement) void root.requestFullscreen().catch(() => root.classList.add('immersive')); else root.classList.add('immersive'); } catch { root.classList.add('immersive'); } void startMission(); });
$('#skip-film').addEventListener('click', () => void finishFilm());
$('#mission-film').addEventListener('ended', () => void finishFilm());
screens.film.addEventListener('pointermove', () => { screens.film.classList.remove('controls-dim'); dimFilmControlsSoon(); });
$('#mission-film').addEventListener('error', showFilmError);
$('#mission-film').addEventListener('loadeddata', () => { const video = $('#mission-film'); if (video.readyState >= 2) clearTimeout(video.watchdog); });
$('#mission-film').addEventListener('waiting', armBufferWatchdog);
$('#mission-film').addEventListener('stalled', armBufferWatchdog);
$('#mission-film').addEventListener('playing', () => { const video = $('#mission-film'); clearTimeout(video.watchdog); clearTimeout(video.bufferWatchdog); });
$('#retry-film').addEventListener('click', () => void enterFilm());
$('#start-filmless').addEventListener('click', () => void startMission());
$('#fullscreen-film').addEventListener('click', async () => { try { await root.requestFullscreen(); root.classList.remove('immersive'); } catch { root.classList.add('immersive'); } });
$('#mute-film').addEventListener('click', () => { const mute = !$('#mission-film').muted; $('#mission-film').muted = mute; $('#mission-roomtone').muted = mute; $('#mute-film').textContent = mute ? 'Unmute' : 'Mute'; $('#mute-film').setAttribute('aria-pressed', String(mute)); });
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
window.addEventListener('pagehide', () => { clearInterval(timerId); void flushMissionMetrics('page_exit', true); const video = $('#mission-film'); video.pause(); $('#mission-roomtone').pause(); clearTimeout(video.watchdog); clearTimeout(video.bufferWatchdog); });
void initialize();
