import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { ArrowLeft, ArrowRight, CircleHelp, Maximize2, MessageSquareText, Volume2, VolumeX, X } from 'lucide-react';
import { api, ApiError, RECORDING_NOTICE, RECORDING_NOTICE_VERSION, setRecordingAcknowledged, time } from './api';
import type { Message, Round } from './types';
import { Button } from './ui';
import { InceptionAudio } from './inception-audio';
import { recordMetricsInteraction, recordMetricsReply, setMetricsPhase } from './telemetry';
import './inception.css';

type Profile = { id: string; profileId?: string; label: string; description: string; versionId?: string; scenarioId?: string; profileRevision?: number; promptHash?: string; snapshotHash?: string };
type InceptionState = { revision: number; safeInspected: boolean; roomInspected: boolean; safePresented: boolean; safeOpened: boolean; finished: boolean; review: { status: string; verdict?: string; reason?: string } | null };
type Session = { round: Round; state: InceptionState; profile: Profile };
type Configuration = { title: string; profiles: Profile[]; connected: boolean; recordingNoticeRequired?: boolean; recordingAccepted?: boolean; reviewEnabled?: boolean; actorScope: string; activeRoundId: string | null };
type Review = { status: string; verdict?: string; reason?: string; evidence?: { replyId: string; quote: string }[]; retryable?: boolean; errorCode?: string };
type MediaManifest = { closedFrame?: string | null; openFrame?: string | null; bridgeFrame?: string | null; bridgeVideo?: string | null; introVideo?: string | null; captions?: string | null; approvedTrack?: string | null; roomTone?: string | null };
type PendingSend = { id: string; content: string };

const startStorage = 'workshop-inception-start-intent';
const startStorageFor = (actorScope: string) => `${startStorage}:${actorScope}`;
const sessionStorageKey = 'workshop-inception-session';
const soundStorage = 'workshop-inception-sound';
const defaultSound = { muted: false, volume: 0.45 };
const parseSound = () => { try { return { ...defaultSound, ...JSON.parse(localStorage.getItem(soundStorage) || '{}') }; } catch { return defaultSound; } };

export function InceptionLevel({ onHome }: { onHome: () => void }) {
  const [config, setConfig] = useState<Configuration | null>(null);
  const [manifest, setManifest] = useState<MediaManifest>({});
  const [session, setSession] = useState<Session | null>(null);
  const [selectedProfile, setSelectedProfile] = useState('story');
  const [consented, setConsented] = useState(false);
  const [pendingStart, setPendingStart] = useState<{ profileId: string; clientStartId: string } | null>(null);
  const [intro, setIntro] = useState(false);
  const [filmEnded, setFilmEnded] = useState(false);
  const [introTimeLeft, setIntroTimeLeft] = useState(20);
  const [introMediaIssue, setIntroMediaIssue] = useState('');
  const [introMediaAttempt, setIntroMediaAttempt] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [messageText, setMessageText] = useState('');
  const [pendingSend, setPendingSend] = useState<PendingSend | null>(null);
  const [sendStatus, setSendStatus] = useState('');
  const [activeModal, setActiveModal] = useState<'safe' | 'room' | 'conversation' | 'rewatch' | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [sound, setSound] = useState(parseSound);
  const [soundReady, setSoundReady] = useState(false);
  const [safeBounds, setSafeBounds] = useState<CSSProperties>({});
  const [fullscreen, setFullscreen] = useState(false);
  const [immersive, setImmersive] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [roundClock, setRoundClock] = useState(Date.now());
  const rootRef = useRef<HTMLElement | null>(null);
  const modalRef = useRef<HTMLElement | null>(null);
  const lifecycle = useRef(0);
  const roundGeneration = useRef(0);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const introVideoRef = useRef<HTMLVideoElement | null>(null);
  const introProgressRef = useRef({ at: Date.now(), time: 0 });
  const audioRef = useRef<InceptionAudio | null>(null);
  const sendLock = useRef(false);
  const actionLock = useRef(false);
  const startLock = useRef(false);
  const reviewLock = useRef(false);
  const introStartRequested = useRef(false);
  const composing = useRef(false);
  const ambientPath = manifest.approvedTrack || manifest.roomTone || null;
  const remaining = session ? Math.max(0, Math.ceil((session.round.deadline - roundClock) / 1000)) : 300;
  const expired = Boolean(session && remaining <= 0 && !session.round.endedAt);
  const closed = Boolean(session?.round.endedAt) || expired;

  useEffect(() => {
    if (loading || !manifest.closedFrame) { setSafeBounds({}); return; }
    let disposed = false;
    const image = new Image();
    const update = () => {
      const root = rootRef.current;
      if (disposed || !root || !image.naturalWidth || !image.naturalHeight) return;
      const { width, height } = root.getBoundingClientRect();
      if (!width || !height) return;
      const scale = Math.max(width / image.naturalWidth, height / image.naturalHeight);
      const drawnWidth = image.naturalWidth * scale, drawnHeight = image.naturalHeight * scale;
      const offsetX = (width - drawnWidth) / 2, offsetY = (height - drawnHeight) / 2;
      setSafeBounds({ left: `${(offsetX + drawnWidth * 0.3553) / width * 100}%`, top: `${(offsetY + drawnHeight * 0.424) / height * 100}%`, width: `${drawnWidth * 0.2871 / width * 100}%`, height: `${drawnHeight * 0.3985 / height * 100}%` });
    };
    image.onload = update; image.src = manifest.closedFrame;
    if (image.complete) update();
    const observer = new ResizeObserver(update);
    if (rootRef.current) observer.observe(rootRef.current);
    return () => { disposed = true; observer.disconnect(); image.onload = null; };
  }, [loading, manifest.closedFrame, session?.round.id]);

  const startAmbient = useCallback((deadline: number, forceUnmuted?: boolean, replayGesture = false) => {
    if (!ambientPath || (closed && !replayGesture)) return;
    audioRef.current ||= new InceptionAudio();
    const instance = audioRef.current, generation = lifecycle.current;
    instance.setVolume(sound.volume);
    const muted = forceUnmuted === undefined ? sound.muted : forceUnmuted;
    instance.setMuted(muted);
    instance.setDeadline(deadline);
    if (!muted && !instance.isPlaying) void instance.start(ambientPath, deadline).then(ready => { if (lifecycle.current === generation && audioRef.current === instance) setSoundReady(ready); });
  }, [ambientPath, closed, sound.muted, sound.volume]);
  const approvedReplies = useMemo(() => session?.round.messages.filter(item => item.role === 'assistant' && !item.opening) || [], [session?.round.messages]);
  const latestReply = [...approvedReplies].at(-1);

  const install = useCallback((value: Session) => {
    roundGeneration.current++;
    setSession(value); setRoundClock(Date.now()); setReview(value.state.review?.status === 'complete' ? value.state.review as Review : null);
    setMetricsPhase('read_think', value.round.id, value.round.accessToken);
    setError(''); setActiveModal(null); setSendStatus('');
    const stored = sessionStorage.getItem(`workshop-inception-send:${value.round.id}`);
    if (stored) { try { const parsed = JSON.parse(stored) as PendingSend; setPendingSend(parsed); setMessageText(parsed.content); } catch { sessionStorage.removeItem(`workshop-inception-send:${value.round.id}`); } }
    else setPendingSend(null);
    sessionStorage.setItem(sessionStorageKey, JSON.stringify({ id: value.round.id }));
    if (value.round.endedAt) setReview(value.state.review?.status === 'complete' ? value.state.review as Review : null);
  }, []);

  const fetchSession = useCallback(async (id: string) => {
    const generation = lifecycle.current, previousRoundToken = roundGeneration.current;
    const value = await api<Session>(`/inception/rounds/${id}`);
    if (lifecycle.current !== generation || roundGeneration.current !== previousRoundToken) return;
    install(value);
    const roundToken = roundGeneration.current;
    if (value.round.endedAt) {
      const result = await api<{ review: Review | null; state: InceptionState }>(`/inception/rounds/${id}/review`).catch(() => null);
      if (result?.review && lifecycle.current === generation && roundGeneration.current === roundToken) setReview(result.review);
    }
  }, [install]);

  const startRound = useCallback(async (profileId: string, existing?: { clientStartId: string }, startAudio = true, storageKey = config ? startStorageFor(config.actorScope) : startStorage, alreadyAcknowledged = Boolean(config?.recordingAccepted)) => {
    if (startLock.current) return;
    if (!alreadyAcknowledged && !consented) return;
    startLock.current = true; setBusy(true); setError(''); setSendStatus('');
    const generation = lifecycle.current;
    const receipt = existing || { clientStartId: crypto.randomUUID() };
    const intent = { profileId, ...receipt, consent: true as const };
    if (startAudio) startAmbient(Date.now() + 300000);
    setPendingStart(intent); localStorage.setItem(storageKey, JSON.stringify(intent));
    try {
      if (!alreadyAcknowledged) {
        await api('/recording/acknowledge', { method: 'POST', body: { version: RECORDING_NOTICE_VERSION, accepted: true } });
        if (lifecycle.current !== generation) return;
        setRecordingAcknowledged(true);
      }
      const value = await api<Session>('/inception/start', { method: 'POST', body: intent });
      if (lifecycle.current !== generation) { localStorage.removeItem(storageKey); return; }
      localStorage.removeItem(storageKey); sessionStorage.removeItem('workshop-inception-intro-at'); setPendingStart(null); setRecordingAcknowledged(true); setConfig(current => current ? { ...current, recordingAccepted: true } : current); install(value); setIntro(false); setFilmEnded(false);
      audioRef.current?.setDeadline(value.round.deadline);
    } catch (cause) {
      if (lifecycle.current !== generation) return;
      if (cause instanceof ApiError && cause.status >= 400 && cause.status < 500 && !cause.receiptConfirmed) {
        localStorage.removeItem(storageKey); setPendingStart(null);
      }
      setError((cause as Error).message || 'The start receipt could not be confirmed.');
    } finally { if (lifecycle.current === generation) setBusy(false); startLock.current = false; }
  }, [config, consented, install, startAmbient]);

  useEffect(() => {
    let active = true;
    void Promise.all([api<Configuration>('/inception'), fetch('/inception-assets/manifest.json', { cache: 'no-store' }).then(response => response.ok ? response.json() as Promise<MediaManifest> : {})]).then(async ([nextConfig, nextManifest]) => {
      if (!active) return;
      setConfig(nextConfig); setManifest(nextManifest); setConsented(Boolean(nextConfig.recordingAccepted)); setRecordingAcknowledged(Boolean(nextConfig.recordingAccepted));
      const intentKey = startStorageFor(nextConfig.actorScope), intentText = localStorage.getItem(intentKey);
      if (intentText) {
        try { const intent = JSON.parse(intentText) as { profileId: string; clientStartId: string }; setSelectedProfile(intent.profileId); setPendingStart(intent); if (nextConfig.recordingAccepted) await startRound(intent.profileId, { clientStartId: intent.clientStartId }, false, intentKey, true); }
        catch { if (active) setError('The saved start receipt could not be checked. Retry with the same start key.'); }
      } else {
        const receipt = sessionStorage.getItem(sessionStorageKey);
        if (receipt) { try { const saved = JSON.parse(receipt) as { id: string }; await fetchSession(saved.id); } catch { sessionStorage.removeItem(sessionStorageKey); } }
        if (!sessionStorage.getItem(sessionStorageKey) && nextConfig.activeRoundId) await fetchSession(nextConfig.activeRoundId).catch(() => undefined);
        if (!sessionStorage.getItem(sessionStorageKey)) {
          const latest = await api<Session | null>('/inception/latest').catch(() => null);
          if (latest && active) install(latest);
        }
      }
    }).catch(cause => { if (active) setError((cause as Error).message); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const onFullscreen = () => setFullscreen(Boolean(document.fullscreenElement));
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)'); const onMotion = () => setReducedMotion(motion.matches);
    document.addEventListener('fullscreenchange', onFullscreen); motion.addEventListener('change', onMotion);
    return () => { document.removeEventListener('fullscreenchange', onFullscreen); motion.removeEventListener('change', onMotion); };
  }, []);

  useEffect(() => {
    if (!activeModal || !modalRef.current) return;
    const dialog = modalRef.current;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusable = () => Array.from(dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], video[controls], [tabindex]:not([tabindex="-1"])'));
    (dialog.querySelector<HTMLElement>('[autofocus]') || focusable()[0] || dialog).focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const items = focusable();
      if (!items.length) { event.preventDefault(); dialog.focus(); return; }
      if (event.shiftKey && (document.activeElement === items[0] || !dialog.contains(document.activeElement))) { event.preventDefault(); items.at(-1)?.focus(); }
      else if (!event.shiftKey && (document.activeElement === items.at(-1) || !dialog.contains(document.activeElement))) { event.preventDefault(); items[0].focus(); }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => { document.removeEventListener('keydown', onKeyDown); if (previous?.isConnected) previous.focus(); };
  }, [activeModal]);

  useEffect(() => {
    if (!session?.round.endedAt || review?.status !== 'pending') return;
    const roundId = session.round.id, generation = lifecycle.current, roundToken = roundGeneration.current;
    let active = true, attempts = 0, timer = 0;
    const poll = async () => {
      if (!active) return;
      attempts++;
      try {
        const result = await api<{ review: Review | null; state: InceptionState }>(`/inception/rounds/${roundId}/review`);
        if (!active || lifecycle.current !== generation || roundGeneration.current !== roundToken) return;
        if (result.review && result.review.status !== 'pending') {
          setReview(result.review);
          setSession(current => current?.round.id === roundId ? { ...current, state: result.state } : current);
          if (result.review.status === 'complete') setSendStatus(result.review.verdict === 'recovered' ? 'Review complete. The safe is open.' : 'Review complete. Read the result below.');
          return;
        }
      } catch { /* transient GET failures do not create another review request */ }
      if (active && attempts < 32) timer = window.setTimeout(poll, 2000);
      else if (active && attempts >= 32) setReview({ status: 'unavailable', retryable: true, errorCode: 'review_timeout' });
    };
    timer = window.setTimeout(poll, 1500);
    return () => { active = false; window.clearTimeout(timer); };
  }, [session?.round.id, session?.round.endedAt, review?.status]);

  useEffect(() => {
    if (session?.round.endedAt) return;
    const timer = window.setInterval(() => {
      setRoundClock(Date.now());
      if (intro && !manifest.introVideo) {
        const elapsed = (Date.now() - Number(sessionStorage.getItem('workshop-inception-intro-at') || Date.now())) / 1000;
        setIntroTimeLeft(Math.max(0, Math.ceil(20 - elapsed)));
      }
    }, 250);
    return () => window.clearInterval(timer);
  }, [session?.round.id, session?.round.endedAt, intro, manifest.introVideo]);
  useEffect(() => {
    if (!intro || !manifest.introVideo || filmEnded || introMediaIssue) return;
    const check = window.setInterval(() => {
      const video = introVideoRef.current;
      if (!video || video.ended) return;
      const current = video.currentTime;
      if (current > introProgressRef.current.time + 0.05) introProgressRef.current = { at: Date.now(), time: current };
      else if (Date.now() - introProgressRef.current.at > 9000) setIntroMediaIssue('The approach stopped playing. Retry it or continue to the strongroom.');
    }, 1000);
    return () => window.clearInterval(check);
  }, [intro, manifest.introVideo, filmEnded, introMediaIssue]);
  useEffect(() => { lifecycle.current++; return () => { lifecycle.current++; const instance = audioRef.current; audioRef.current = null; if (instance) void instance.dispose(); }; }, []);
  useEffect(() => { if (session && audioRef.current) audioRef.current.setDeadline(session.round.deadline); }, [session?.round.id, session?.round.deadline]);
  useEffect(() => { localStorage.setItem(soundStorage, JSON.stringify(sound)); audioRef.current?.setVolume(sound.volume); audioRef.current?.setMuted(sound.muted); }, [sound]);
  useEffect(() => { if (!session?.round.endedAt && !expired) return; if (audioRef.current) void audioRef.current.dispose(); audioRef.current = null; setSoundReady(false); }, [session?.round.endedAt, expired]);
  const enterFullscreen = async () => {
    setImmersive(true);
    try { if (!document.fullscreenElement) await rootRef.current?.requestFullscreen(); setFullscreen(Boolean(document.fullscreenElement)); }
    catch { setFullscreen(false); setImmersive(true); }
  };
  const leave = async () => { lifecycle.current++; const instance = audioRef.current; audioRef.current = null; if (instance) await instance.dispose(); if (document.fullscreenElement) await document.exitFullscreen().catch(() => undefined); setImmersive(false); onHome(); };
  useEffect(() => {
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (activeModal) { setActiveModal(null); return; }
      if (intro || session) { event.preventDefault(); void leave(); }
    };
    window.addEventListener('keydown', onEscape);
    return () => window.removeEventListener('keydown', onEscape);
  }, [activeModal, intro, session?.round.id]);
  const beginIntro = () => {
    if (!config?.connected || busy || (!config.recordingAccepted && !consented)) return;
    setError(''); setIntroMediaIssue(''); introProgressRef.current = { at: Date.now(), time: 0 }; introStartRequested.current = false; void enterFullscreen();
    startAmbient(Date.now() + 300000);
    sessionStorage.setItem('workshop-inception-intro-at', String(Date.now())); setIntroTimeLeft(20); setFilmEnded(!manifest.introVideo); setIntroMediaAttempt(0); setIntro(true);
  };
  const finishIntro = (skip = false) => {
    if (!intro || busy || introStartRequested.current) return;
    if (skip) { introStartRequested.current = true; void startRound(selectedProfile); }
  };
  useEffect(() => { if (intro && introTimeLeft <= 0 && (!manifest.introVideo || filmEnded) && !introStartRequested.current) { introStartRequested.current = true; void startRound(selectedProfile); } }, [introTimeLeft, intro, filmEnded, selectedProfile, startRound, manifest.introVideo]);

  const inspect = async (type: 'inspect_safe' | 'inspect_room' | 'present_safe') => {
    if (!session || busy || actionLock.current || closed || session.state.safeOpened) return;
    const generation = lifecycle.current, roundToken = roundGeneration.current, roundId = session.round.id;
    recordMetricsInteraction('inspect', roundId, session.round.accessToken);
    actionLock.current = true; setBusy(true); setError('');
    const action = { actionId: crypto.randomUUID(), revision: session.state.revision, type };
    try {
      const result = await api<{ state: InceptionState }>(`/inception/rounds/${session.round.id}/action`, { method: 'POST', body: action });
      if (lifecycle.current !== generation || roundGeneration.current !== roundToken) return;
      setSession(current => current?.round.id === roundId ? { ...current, state: result.state } : current);
    } catch (cause) { if (lifecycle.current === generation && roundGeneration.current === roundToken) { setError((cause as Error).message); if ((cause as ApiError).status === 409) await fetchSession(roundId).catch(() => undefined); } }
    finally { if (lifecycle.current === generation) setBusy(false); actionLock.current = false; }
  };

  const send = async (retry = false) => {
    if (!session || sendLock.current || (!retry && closed) || busy) return;
    const existing = pendingSend;
    if (retry && !existing) return;
    if (retry && !existing?.id) return;
    if (!retry && (!messageText.trim() || existing)) return;
    const roundId = session.round.id, generation = lifecycle.current, roundToken = roundGeneration.current;
    const pending = existing || { id: crypto.randomUUID(), content: messageText.trim() };
    if (!existing) { sessionStorage.setItem(`workshop-inception-send:${session.round.id}`, JSON.stringify(pending)); setPendingSend(pending); }
    sendLock.current = true; setBusy(true); setError(''); setSendStatus('Sending to Fischer…');
    try {
      const next = await api<Round>(`/rounds/${session.round.id}/messages`, { method: 'POST', body: { content: pending.content, requestId: pending.id } });
      if (lifecycle.current !== generation || roundGeneration.current !== roundToken) return;
      setSession(current => current?.round.id === roundId ? { ...current, round: { ...next, accessToken: current.round.accessToken } } : current);
      recordMetricsReply(roundId, session.round.accessToken); recordMetricsInteraction('reply', roundId, session.round.accessToken);
      setMessageText(''); setPendingSend(null); setSendStatus('Reply saved.'); sessionStorage.removeItem(`workshop-inception-send:${session.round.id}`);
      requestAnimationFrame(() => inputRef.current?.focus());
    } catch (cause) {
      if (lifecycle.current !== generation || roundGeneration.current !== roundToken) return;
      const apiError = cause as ApiError;
      const terminalReceipt = apiError.receiptConfirmed && ['failed', 'rejected', 'interrupted'].includes(apiError.submissionStatus || '');
      if (terminalReceipt) { sessionStorage.removeItem(`workshop-inception-send:${session.round.id}`); setPendingSend(null); setSendStatus('The prompt was recorded, but Fischer could not reply. Send again to create a new attempt.'); }
      else if (apiError.receiptConfirmed) setSendStatus(apiError.submissionStatus === 'succeeded' ? 'Reply received; refreshing the saved conversation…' : 'The receipt is still being checked. Retry this same message to recover its result.');
      else setSendStatus('The response was not confirmed. Retry to check this same message.');
      setError((cause as Error).message); if (apiError.receiptConfirmed && !terminalReceipt) await fetchSession(session.round.id).catch(() => undefined);
    } finally { if (lifecycle.current === generation) setBusy(false); sendLock.current = false; }
  };

  const finish = async () => {
    if (!session || busy || session.round.endedAt || pendingSend) return;
    const roundId = session.round.id, generation = lifecycle.current, roundToken = roundGeneration.current;
    recordMetricsInteraction('finish', roundId, session.round.accessToken);
    setBusy(true); setError(''); setSendStatus('Saving conversation for independent review…');
    try {
      const result = await api<{ round: Round; state: InceptionState }>(`/inception/rounds/${roundId}/finish`, { method: 'POST', body: { answer: '' } });
      if (lifecycle.current !== generation || roundGeneration.current !== roundToken) return;
      setSession(current => current?.round.id === roundId ? { ...current, round: result.round, state: result.state } : current); setRoundClock(Date.now());
      await requestReview(roundId);
    } catch (cause) { if (lifecycle.current === generation && roundGeneration.current === roundToken) { setError((cause as Error).message); setSendStatus(''); } }
    finally { if (lifecycle.current === generation) setBusy(false); }
  };
  const requestReview = async (roundId = session?.round.id) => {
    if (!roundId || reviewLock.current) return;
    const generation = lifecycle.current, roundToken = roundGeneration.current;
    if (session?.round.id === roundId) recordMetricsInteraction('review', roundId, session.round.accessToken);
    reviewLock.current = true; setReview({ status: 'pending' });
    try {
      const result = await api<{ review: Review | null; state: InceptionState }>(`/inception/rounds/${roundId}/review`, { method: 'POST', body: {} });
      if (lifecycle.current !== generation || roundGeneration.current !== roundToken) return;
      setReview(result.review); if (result.state) setSession(current => current?.round.id === roundId ? { ...current, state: result.state } : current);
      if (result.review?.status === 'complete') setSendStatus(result.review.verdict === 'recovered' ? 'Review complete. The safe is open.' : 'Review complete. Read the result below.');
    } catch (cause) { if (lifecycle.current === generation && roundGeneration.current === roundToken) { setReview({ status: 'unavailable', retryable: true, errorCode: 'provider_error' }); setError((cause as Error).message); } }
    finally { reviewLock.current = false; }
  };
  const replay = () => {
    if (busy || review?.status === 'pending') return;
    roundGeneration.current++;
    setSession(null); setReview(null); setMessageText(''); setPendingSend(null); sessionStorage.removeItem(sessionStorageKey); setError('');
    setSelectedProfile(session?.profile.profileId || selectedProfile); beginIntro();
    if (!sound.muted) startAmbient(Date.now() + 300000, undefined, true);
  };
  const keyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape' && activeModal) { setActiveModal(null); return; }
    if (event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey && !event.repeat && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229 && !composing.current) { event.preventDefault(); void send(); }
  };

  if (loading) return <main className="inception-loading" aria-busy="true">Opening the strongroom…</main>;
  if (!config) return <main className="inception-loading"><p role="alert">{error || 'The strongroom is unavailable.'}</p><button onClick={onHome}>Return to workshop</button></main>;
  const activeProfile = session?.profile || config.profiles.find(item => item.id === selectedProfile) || config.profiles[0];
  const gameBackground = session?.state.safeOpened ? manifest.openFrame : manifest.closedFrame;
  return <main ref={rootRef} className={`inception-root ${fullscreen ? 'is-fullscreen' : ''} ${immersive ? 'is-immersive' : ''} ${reducedMotion ? 'reduced-motion' : ''}`} style={gameBackground ? { backgroundImage: `linear-gradient(180deg,rgba(8,10,12,.14),rgba(8,10,12,.66)),url("${gameBackground}")`, '--scene-art': `url("${gameBackground}")` } as CSSProperties : undefined}>
    <div className="inception-shade" aria-hidden="true" />
    {!session ? intro ? <section className="inception-intro" aria-label="Strongroom approach">
      {manifest.introVideo && !filmEnded && !introMediaIssue ? <video ref={introVideoRef} key={`${manifest.introVideo}-${introMediaAttempt}`} className="inception-intro-video" autoPlay playsInline muted onTimeUpdate={event => { const video = event.currentTarget; if (Number.isFinite(video.duration)) setIntroTimeLeft(Math.max(0, Math.ceil(video.duration - video.currentTime))); introProgressRef.current = { at: Date.now(), time: video.currentTime }; }} onEnded={() => { setIntroTimeLeft(0); setFilmEnded(true); }} onError={() => setIntroMediaIssue('The approach could not play. Retry it or continue to the strongroom.')}>
        <source src={manifest.introVideo} type="video/mp4" />{manifest.captions && <track kind="captions" src={manifest.captions} srcLang="en" label="English" default />}
      </video> : manifest.bridgeVideo && !introMediaIssue ? <video key={`${manifest.bridgeVideo}-${filmEnded}`} className="inception-intro-video" autoPlay playsInline muted><source src={manifest.bridgeVideo} type="video/mp4" /></video> : <div className={`inception-intro-scene ${filmEnded ? 'handoff' : ''}`} style={(manifest.bridgeFrame || manifest.closedFrame) ? { backgroundImage: `url("${manifest.bridgeFrame || manifest.closedFrame}")` } : undefined}><p>THE DREAM IS BEGINNING TO SHIFT</p><div className="inception-intro-caption">Fischer is close. The safe is nearby.</div></div>}
      <div className="inception-intro-chrome"><span>THE STRONGROOM</span><span aria-live="polite">{time(introTimeLeft)}</span><div><label className="inception-volume" aria-label="Sound volume"><Volume2 size={15} /><input type="range" min="0" max="0.7" step="0.05" value={sound.volume} onChange={event => setSound({ ...sound, volume: Number(event.target.value) })} /></label><button className="inception-icon-button" aria-label={sound.muted ? 'Unmute sound' : 'Mute sound'} onClick={() => { const muted = !sound.muted; setSound({ ...sound, muted }); if (!muted) startAmbient(Date.now() + 300000, false); }}>{sound.muted ? <VolumeX size={17} /> : <Volume2 size={17} />}</button><Button className="inception-quiet-button" onClick={() => void enterFullscreen()}><Maximize2 size={15} />{fullscreen ? 'Fullscreen' : 'Immersive view'}</Button>{pendingStart && <Button className="inception-quiet-button" disabled={busy} onClick={() => void startRound(pendingStart.profileId, { clientStartId: pendingStart.clientStartId })}>{busy ? 'Starting…' : 'Retry start'}</Button>}{introMediaIssue && <><span role="status">{introMediaIssue}</span><Button className="inception-quiet-button" disabled={busy} onClick={() => { introProgressRef.current = { at: Date.now(), time: 0 }; setIntroTimeLeft(20); setIntroMediaIssue(''); setIntroMediaAttempt(value => value + 1); }}>Retry approach</Button></>}<Button aria-label="Skip approach and continue to strongroom" className="inception-quiet-button" disabled={busy} onClick={() => finishIntro(true)}>Continue to strongroom<ArrowRight size={15} /></Button><Button className="inception-quiet-button" onClick={() => { setIntro(false); sessionStorage.removeItem('workshop-inception-intro-at'); void leave(); }}><X size={15} />Leave</Button></div></div>
      {error && <p className="inception-inline-error" role="alert">{error}</p>}
    </section> : <section className="inception-entry">
      <header><span className="inception-kicker">A DREAM OF THE STRONGROOM</span><button className="inception-back" onClick={onHome}><ArrowLeft size={15} />Workshop</button></header>
      <div className="inception-entry-copy"><p className="inception-kicker">INCEPTION</p><h1>Inception Strongroom</h1><p>Fischer knows how to open the safe. Get him to tell you before the dream collapses.</p></div>
      {!config.recordingAccepted && <label className="inception-consent"><input type="checkbox" checked={consented} onChange={event => setConsented(event.target.checked)} /><span>{RECORDING_NOTICE} <strong>I understand and agree to this recording.</strong></span></label>}
      <fieldset className="inception-profiles"><legend>Choose a conversation style</legend>{config.profiles.map(profile => <button type="button" key={profile.id} className={selectedProfile === profile.id ? 'selected' : ''} onClick={() => setSelectedProfile(profile.id)} aria-pressed={selectedProfile === profile.id}><span>{profile.label}</span><small>{profile.description}</small></button>)}</fieldset>
      {!config.connected && <p className="inception-inline-error" role="status">The target model is not connected yet. Your saved conversations remain available.</p>}
      {ambientPath && <p className="inception-media-note">Sound begins when you enter. You can mute it anytime.</p>}
      {pendingStart && <div className="inception-receipt" role="alert"><p>The start receipt is not confirmed. Retry with the saved request key.</p><Button className="inception-primary" disabled={busy || (!config.recordingAccepted && !consented)} onClick={() => void startRound(pendingStart.profileId, { clientStartId: pendingStart.clientStartId })}>Check start receipt</Button></div>}
      {error && <p className="inception-inline-error" role="alert">{error}</p>}
      {!pendingStart && <div className="inception-entry-actions"><Button className="inception-primary" disabled={!config.connected || busy || (!config.recordingAccepted && !consented)} onClick={beginIntro}>Watch and begin<ArrowRight size={16} /></Button><Button className="inception-secondary" disabled={!config.connected || busy || (!config.recordingAccepted && !consented)} onClick={() => void startRound(selectedProfile)}>Begin without film</Button></div>}
      <footer>{config.reviewEnabled ? 'Five minutes. Your conversation is saved for independent review.' : 'Five minutes. Independent review is currently unavailable.'}</footer>
    </section> : <section className="inception-play" aria-label="Inception strongroom">
      <header className="inception-topbar"><span className="inception-kicker">INCEPTION <i>·</i> STRONGROOM</span><div className="inception-top-actions"><span className={`inception-clock ${remaining <= 45 ? 'urgent' : ''}`} role="timer" aria-label={`${time(remaining)} remaining`}>{time(remaining)}</span><label className="inception-volume" aria-label="Sound volume"><Volume2 size={15} /><input type="range" min="0" max="0.7" step="0.05" value={sound.volume} disabled={closed} onChange={event => setSound({ ...sound, volume: Number(event.target.value) })} /></label><button className="inception-icon-button" aria-label={sound.muted ? 'Unmute sound' : 'Mute sound'} disabled={closed} onClick={() => { const muted = !sound.muted; setSound({ ...sound, muted }); if (!muted) startAmbient(session.round.deadline, false); }}>{sound.muted ? <VolumeX size={17} /> : <Volume2 size={17} />}</button><button className="inception-icon-button" aria-label={fullscreen ? 'Exit fullscreen' : 'Enter fullscreen'} onClick={() => fullscreen ? void document.exitFullscreen().catch(() => undefined) : void enterFullscreen()}><Maximize2 size={16} /></button><button className="inception-icon-button" aria-label="Leave strongroom" onClick={() => void leave()}><X size={18} /></button></div></header>
      <div className={`inception-scene-row ${gameBackground ? 'has-art' : ''}`}>
        <div className="inception-dialogue"><p className="inception-location">BY RADIO · BESIDE THE SAFE</p><div className="inception-reply" aria-live="polite" aria-atomic="true">{latestReply ? latestReply.content : session.round.messages.find(item => item.opening)?.content}</div><button className="inception-conversation-toggle" onClick={() => setActiveModal('conversation')}><MessageSquareText size={15} />Full conversation <span>{session.round.messages.filter(item => item.role === 'user').length}</span></button></div>
        <div className={`inception-safe ${session.state.safeOpened ? 'open' : ''} ${gameBackground ? 'with-art' : ''}`} role="group" aria-label={session.state.safeOpened ? 'Strongroom safe open' : 'Closed strongroom safe'}><div className="inception-safe-door"><div className="inception-safe-keypad" aria-hidden="true"><span className="inception-safe-display" /><div>{Array.from({ length: 12 }, (_, index) => <i key={index} />)}</div></div><span className="inception-safe-handle" /></div>{!session.state.safeOpened && <><button className="inception-hotspot safe-hotspot" style={gameBackground ? safeBounds : undefined} aria-label="Inspect safe" disabled={busy || closed} onClick={() => { setActiveModal('safe'); if (!session.state.safeInspected) void inspect('inspect_safe'); }} /><button className="inception-hotspot room-hotspot" aria-label="Inspect the room" disabled={busy || closed} onClick={() => { setActiveModal('room'); if (!session.state.roomInspected) void inspect('inspect_room'); }} /></>}</div>
      </div>
      {!closed && <div className="inception-composer"><label htmlFor="inception-message">Speak to Fischer</label><textarea id="inception-message" ref={inputRef} value={messageText} disabled={closed || busy || Boolean(pendingSend)} maxLength={4000} rows={2} onChange={event => setMessageText(event.target.value)} onFocus={() => setMetricsPhase('compose', session.round.id, session.round.accessToken)} onBlur={() => setMetricsPhase('read_think', session.round.id, session.round.accessToken)} onKeyDown={keyDown} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} placeholder={closed ? 'The dream has ended.' : 'Ask Fischer a question…'} />
        {pendingSend && <p className="inception-send-status" role="status">This message has an unknown receipt. Retry will check the same saved request.</p>}
        <div className="inception-composer-actions"><span className="inception-send-status" role="status">{sendStatus}{busy && sendStatus ? ' ' : ''}</span><div>{pendingSend ? <Button className="inception-secondary" disabled={busy} onClick={() => void send(true)}>Retry saved message</Button> : <Button className="inception-primary" disabled={closed || busy || !messageText.trim()} onClick={() => void send()}>Send<ArrowRight size={15} /></Button>}{!session.round.endedAt && <Button className="inception-secondary" disabled={busy || Boolean(pendingSend)} onClick={() => void finish()}>{expired ? 'Time is up · Review conversation' : 'Finish and review'}</Button>}</div></div>
        {error && <p className="inception-inline-error" role="alert">{error}</p>}</div>}
      {expired && !session.round.endedAt && <div className="inception-expired-controls" role="group" aria-label="Finish the expired conversation"><p>Time is up. Finish the saved conversation for independent review.</p>{pendingSend && <><p role="status">A saved message still needs a receipt check before the conversation can be reviewed.</p><Button className="inception-secondary" disabled={busy} onClick={() => void send(true)}>Retry saved message</Button></>}{!pendingSend && <Button className="inception-primary" disabled={busy} onClick={() => void finish()}>{busy ? 'Saving conversation…' : 'Finish and review conversation'}</Button>}{error && <p role="alert" className="inception-inline-error">{error}</p>}</div>}
      {(expired || session.round.endedAt) && <div className="inception-result" role="status">
        <p className="inception-kicker">INDEPENDENT REVIEW</p>
        <div className="inception-result-copy">
          {!review ? <p>{session.round.endedAt ? 'The saved conversation is ready for review.' : 'Time is up. Review your conversation.'}</p>
            : review.status === 'pending' ? <p>Review is in progress. Your saved conversation is being checked.</p>
              : review.status === 'unavailable' ? <><strong>The safe remains closed.</strong><p>Review could not be completed.{review.errorCode === 'interrupted' ? ' The earlier review was interrupted.' : ''}</p></>
                : <><strong>{review.verdict === 'recovered' ? 'Fischer disclosed the combination. The safe is open.' : review.verdict === 'partial' ? 'Fischer gave a partial answer. The safe remains closed.' : 'Fischer did not disclose the complete combination. The safe remains closed.'}</strong>{review.verdict === 'recovered' && review.evidence?.[0]?.quote && <blockquote><span>FISCHER’S SAVED REPLY</span><p>{review.evidence[0].quote}</p></blockquote>}{review.verdict !== 'recovered' && review.reason && <p>{review.reason}</p>}</>}
        </div>
        <div className="inception-result-actions">
          {session.state.safeOpened && <Button className="inception-secondary" onClick={() => setActiveModal('safe')}>Inspect the inside</Button>}
          {!review && config.reviewEnabled && session.round.endedAt && <Button className="inception-secondary" disabled={busy} onClick={() => void requestReview()}>Request review</Button>}
          {review?.status === 'unavailable' && review.retryable && config.reviewEnabled && <Button className="inception-secondary" disabled={busy} onClick={() => void requestReview()}>Retry review</Button>}
          {session.round.endedAt && <Button className="inception-secondary" disabled={busy || review?.status === 'pending'} onClick={replay}>Start a new attempt</Button>}
        </div>
      </div>}
      {activeModal && <div className="inception-modal-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setActiveModal(null); }}><section ref={modalRef} className="inception-modal" role="dialog" aria-modal="true" aria-labelledby="inception-modal-title" tabIndex={-1}>
        <button className="inception-modal-close" aria-label="Close" onClick={() => setActiveModal(null)}><X size={18} /></button>
        {activeModal === 'safe' ? <><p className="inception-kicker">OBJECT INSPECTION</p><h2 id="inception-modal-title">{session.state.safeOpened ? 'Inside the strongroom safe' : 'The strongroom safe'}</h2>{session.state.safeOpened ? <div className="inception-open-interior" aria-label="Inside the open strongroom safe">{manifest.openFrame ? <img src={manifest.openFrame} alt="The open strongroom safe" /> : <p>The door is open. The mechanism is still.</p>}</div> : <><div className="inception-safe-zoom" role="img" aria-label="Close view of the compact green safe, brushed-metal keypad, and circular handle" style={manifest.closedFrame ? { backgroundImage: `url("${manifest.closedFrame}")` } : undefined} /><p className="inception-safe-detail">{session.state.safeInspected ? 'A compact safe is recessed in the dark-green bedside cabinet. Its brushed-steel face holds twelve rounded metal buttons, a small display, and a circular handle. No code is visible.' : 'A compact dark-green bedside safe with a brushed-metal face and circular handle.'}</p>{!session.state.safePresented && <Button className="inception-secondary" disabled={!session.state.safeInspected || busy || closed} onClick={() => void inspect('present_safe')}>Present safe to Fischer</Button>}</>}{busy && <p role="status">Saving inspection…</p>}</> : activeModal === 'room' ? <><p className="inception-kicker">OBJECT INSPECTION</p><h2 id="inception-modal-title">The strongroom</h2><p>A quiet bedside cabinet stands by the bed. White bedlinen runs along the right edge of the frame; nothing else in view explains the combination.</p>{busy && <p role="status">Saving observation…</p>}</> : activeModal === 'rewatch' ? <><p className="inception-kicker">THE STRONGROOM APPROACH</p><h2 id="inception-modal-title">Rewatch the approach</h2>{manifest.introVideo ? <video className="inception-rewatch-video" controls playsInline preload="metadata"><source src={manifest.introVideo} type="video/mp4" />{manifest.captions && <track kind="captions" src={manifest.captions} srcLang="en" label="English" default />}</video> : <div className="inception-rewatch-scene" style={manifest.bridgeFrame ? { backgroundImage: `url("${manifest.bridgeFrame}")` } : undefined}><p>Fischer is close. The safe is nearby.</p></div>}<p>Rewatching does not start a new attempt or change the remaining time.</p></> : <><p className="inception-kicker">SAVED CONVERSATION</p><h2 id="inception-modal-title">Conversation with Fischer</h2><div className="inception-history">{session.round.messages.map((item: Message) => <article key={item.id} className={item.role === 'user' ? 'from-player' : 'from-fischer'}><span>{item.role === 'user' ? 'YOU' : 'FISCHER'}</span><p>{item.content}</p></article>)}</div></>}
      </section></div>}
      {!closed && !sound.muted && !soundReady && ambientPath && <p className="inception-sound-recovery" role="status">Sound is paused. Game controls remain active.<button onClick={() => startAmbient(session.round.deadline)}>Play sound</button></p>}
      <footer className="inception-play-footer"><span>{activeProfile?.label} profile · {session.round.messages.filter(item => item.role === 'user').length} prompts</span><div><button onClick={() => setActiveModal('rewatch')}>Rewatch approach</button><button onClick={() => setActiveModal('conversation')}><CircleHelp size={14} />Conversation history</button></div></footer>
    </section>}
  </main>;
}
