import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { ArrowLeft, ArrowRight, Maximize2, Volume2, VolumeX, X } from 'lucide-react';
import { api, ApiError, RECORDING_NOTICE, RECORDING_NOTICE_VERSION, setRecordingAcknowledged, time } from './api';
import type { Message, Round } from './types';
import { Button } from './ui';
import { InceptionAudio } from './inception-audio';
import { resolveInceptionMusicStage } from './inception-music-progress';
import { recordMetricsInteraction, recordMetricsReply, setMetricsPhase } from './telemetry';
import './inception.css';

type Profile = { id: string; profileId?: string; label: string; description: string; versionId?: string; scenarioId?: string; profileRevision?: number; promptHash?: string; snapshotHash?: string };
type InceptionState = { revision: number; safeInspected: boolean; roomInspected: boolean; safePresented: boolean; safeOpened: boolean; finished: boolean; revealedCombination?: string; review: { status: string; verdict?: string; reason?: string } | null };
type Session = { round: Round; state: InceptionState; profile: Profile };
type Configuration = { title: string; profiles: Profile[]; defaultProfileId?: string; connected: boolean; recordingNoticeRequired?: boolean; recordingAccepted?: boolean; reviewEnabled?: boolean; actorScope: string; activeRoundId: string | null };
type Review = { status: string; verdict?: string; reason?: string; evidence?: { replyId: string; quote: string }[]; retryable?: boolean; errorCode?: string };
type MediaManifest = { closedFrame?: string | null; openFrame?: string | null; dialogueTexture?: string | null; bridgeFrame?: string | null; bridgeVideo?: string | null; introVideo?: string | null; introDurationSeconds?: number; captions?: string | null; successVideo?: string | null; successCaptions?: string | null; successDurationSeconds?: number; endingWordmark?: string | null; approvedTrack?: string | null; roomTone?: string | null; musicCues?: { calm?: string | null; developing?: string | null; urgent?: string | null }; creditsCue?: string | null; portraits?: { eames?: string; fischer?: string } };
type PendingSend = { id: string; content: string };

const startStorage = 'workshop-inception-start-intent';
const startStorageFor = (actorScope: string) => `${startStorage}:${actorScope}`;
const sessionStorageKey = 'workshop-inception-session';
const soundStorage = 'workshop-inception-sound';
const DEFAULT_INTRO_DURATION_SECONDS = 25;
const defaultSound = { muted: false, volume: 0.45 };
const parseSound = () => { try { return { ...defaultSound, ...JSON.parse(localStorage.getItem(soundStorage) || '{}') }; } catch { return defaultSound; } };
const getFilmCaptionText = (track: TextTrack | null | undefined) => Array.from(track?.activeCues || [])
  .map(cue => (cue as VTTCue).text.trim()).filter(Boolean).join('\n');
const getFilmCaptionLayout = (video: HTMLVideoElement | null): CSSProperties | null => {
  if (!video) return null;
  const rect = video.getBoundingClientRect();
  const width = video.videoWidth || 1920, height = video.videoHeight || 1080;
  if (!rect.width || !rect.height) return null;
  const scale = Math.min(rect.width / width, rect.height / height);
  const drawnWidth = width * scale, drawnHeight = height * scale;
  const left = rect.left + (rect.width - drawnWidth) / 2;
  const top = rect.top + (rect.height - drawnHeight) / 2;
  const lowerBandHeight = drawnHeight * (140 / 1080);
  return {
    left: `${left}px`, top: `${top}px`, width: `${drawnWidth}px`, height: `${drawnHeight}px`,
    '--caption-band-height': `${lowerBandHeight}px`,
    '--film-caption-size': `${Math.min(30, Math.max(8, lowerBandHeight * 0.4))}px`,
  } as CSSProperties;
};

export function InceptionLevel({ onHome }: { onHome: () => void }) {
  const [config, setConfig] = useState<Configuration | null>(null);
  const [manifest, setManifest] = useState<MediaManifest>({});
  const [session, setSession] = useState<Session | null>(null);
  const [selectedProfile, setSelectedProfile] = useState('standard');
  const [consented, setConsented] = useState(false);
  const [pendingStart, setPendingStart] = useState<{ profileId: string; clientStartId: string } | null>(null);
  const [intro, setIntro] = useState(false);
  const [filmEnded, setFilmEnded] = useState(false);
  const [introTimeLeft, setIntroTimeLeft] = useState(DEFAULT_INTRO_DURATION_SECONDS);
  const [introMediaIssue, setIntroMediaIssue] = useState('');
  const [introMediaAttempt, setIntroMediaAttempt] = useState(0);
  const [cinematicHandoff, setCinematicHandoff] = useState(false);
  const [cinematicPhase, setCinematicPhase] = useState<'checking' | 'entry' | 'film' | 'closing' | null>(null);
  const [revealedDigits, setRevealedDigits] = useState('');
  const [lcdBounds, setLcdBounds] = useState<CSSProperties>({});
  const [retryCooldownUntil, setRetryCooldownUntil] = useState(0);
  const [retrySeconds, setRetrySeconds] = useState(0);
  const [handoffInteractive, setHandoffInteractive] = useState(true);
  const [now, setNow] = useState(Date.now());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [messageText, setMessageText] = useState('');
  const [pendingSend, setPendingSend] = useState<PendingSend | null>(null);
  const [sendStatus, setSendStatus] = useState('');
  const [activeModal, setActiveModal] = useState<'safe' | 'room' | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [successEnding, setSuccessEnding] = useState<'playing' | 'blocked' | 'error' | 'closing' | 'title' | 'title-fade' | 'credit' | 'hold' | null>(null);
  const [successEndingAttempt, setSuccessEndingAttempt] = useState(0);
  const [successEndingError, setSuccessEndingError] = useState('');
  const [introCaptionText, setIntroCaptionText] = useState('');
  const [introCaptionLayout, setIntroCaptionLayout] = useState<CSSProperties | null>(null);
  const [successCaptionText, setSuccessCaptionText] = useState('');
  const [successCaptionLayout, setSuccessCaptionLayout] = useState<CSSProperties | null>(null);
  const [successTimeLeft, setSuccessTimeLeft] = useState(0);
  const [sound, setSound] = useState(parseSound);
  const [soundReady, setSoundReady] = useState(false);
  const [safeBounds, setSafeBounds] = useState<CSSProperties>({});
  const [fullscreen, setFullscreen] = useState(false);
  const [immersive, setImmersive] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [roundClock, setRoundClock] = useState(Date.now());
  const rootRef = useRef<HTMLElement | null>(null);
  const safeRef = useRef<HTMLDivElement | null>(null);
  const modalRef = useRef<HTMLElement | null>(null);
  const conversationRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLDivElement | null>(null);
  const followConversationRef = useRef(true);
  const preserveConversationScrollTopRef = useRef<number | null>(null);
  const lifecycle = useRef(0);
  const roundGeneration = useRef(0);
  const installedRoundId = useRef<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const checkingComposerHeight = useRef<number | null>(null);
  const checkingTextareaHeight = useRef<number | null>(null);
  const introVideoRef = useRef<HTMLVideoElement | null>(null);
  const successVideoRef = useRef<HTMLVideoElement | null>(null);
  const introCaptionTrackRef = useRef<HTMLTrackElement | null>(null);
  const successCaptionTrackRef = useRef<HTMLTrackElement | null>(null);
  const successTitleRef = useRef<HTMLHeadingElement | null>(null);
  const cinematicTimerRef = useRef<number | null>(null);
  const endingGenerationRef = useRef(0);
  const creditsHandoffRef = useRef(false);
  const creditsFadeFrameRef = useRef<number | null>(null);
  const autoEndedRoundRef = useRef<string | null>(null);
  const endingWasShownRef = useRef(false);
  const introProgressRef = useRef({ at: Date.now(), time: 0 });
  const audioRef = useRef<InceptionAudio | null>(null);
  const sendLock = useRef(false);
  const actionLock = useRef(false);
  const startLock = useRef(false);
  const reviewLock = useRef(false);
  const introStartRequested = useRef(false);
  const audioDisposeRef = useRef<Promise<void> | null>(null);
  const composing = useRef(false);
  const ambientPath = manifest.musicCues?.calm || manifest.approvedTrack || manifest.roomTone || null;
  const hasAmbient = Boolean(ambientPath || manifest.musicCues?.developing || manifest.musicCues?.urgent);
  const introDurationSeconds = Number.isFinite(manifest.introDurationSeconds) && (manifest.introDurationSeconds || 0) > 0 ? manifest.introDurationSeconds as number : DEFAULT_INTRO_DURATION_SECONDS;
  const remaining = session ? Math.max(0, Math.ceil((session.round.deadline - roundClock) / 1000)) : 300;
  const musicStage = session ? resolveInceptionMusicStage({ messages: session.round.messages, deadline: session.round.deadline, startedAt: session.round.startedAt, now: roundClock }) : 'calm';
  const expired = Boolean(session && remaining <= 0 && !session.round.endedAt);
  const closed = Boolean(session?.round.endedAt) || expired;
  const checkingEndedRound = Boolean(session?.round.endedAt && cinematicPhase === 'checking');
  const retainExpiredFinishControl = Boolean(checkingEndedRound && session && session.round.deadline <= Date.now());

  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = 'auto';
    const styles = window.getComputedStyle(input);
    const minHeight = Number.parseFloat(styles.minHeight) || 62;
    const maxHeight = Number.parseFloat(styles.maxHeight) || 160;
    const nextHeight = Math.min(maxHeight, Math.max(minHeight, input.scrollHeight));
    input.style.height = `${nextHeight}px`;
    input.style.overflowY = input.scrollHeight > maxHeight ? 'auto' : 'hidden';
  }, [messageText, session?.round.id]);

  useEffect(() => {
    if (loading || !manifest.closedFrame) { setSafeBounds({}); return; }
    let disposed = false;
    const image = new Image();
    const update = () => {
      const scene = safeRef.current;
      if (disposed || !scene || !image.naturalWidth || !image.naturalHeight) return;
      const { width, height } = scene.getBoundingClientRect();
      if (!width || !height) return;
      const scale = Math.max(width / image.naturalWidth, height / image.naturalHeight);
      const drawnWidth = image.naturalWidth * scale, drawnHeight = image.naturalHeight * scale;
      const offsetX = (width - drawnWidth) / 2, offsetY = (height - drawnHeight) / 2;
      setSafeBounds({ left: `${(offsetX + drawnWidth * 0.3553) / width * 100}%`, top: `${(offsetY + drawnHeight * 0.424) / height * 100}%`, width: `${drawnWidth * 0.2871 / width * 100}%`, height: `${drawnHeight * 0.3985 / height * 100}%` });
      setLcdBounds({ left: `${(offsetX + drawnWidth * 0.45395) / width * 100}%`, top: `${(offsetY + drawnHeight * 0.55473) / height * 100}%`, width: `${drawnWidth * 0.06938 / width * 100}%`, height: `${drawnHeight * 0.03188 / height * 100}%`, fontSize: `${Math.max(6, drawnHeight * 0.03188 * 0.56)}px` });
    };
    image.onload = update; image.src = manifest.closedFrame;
    if (image.complete) update();
    const observer = new ResizeObserver(update);
    if (safeRef.current) observer.observe(safeRef.current);
    return () => { disposed = true; observer.disconnect(); image.onload = null; };
  }, [loading, manifest.closedFrame, session?.round.id, cinematicHandoff]);

  const disposeAmbient = useCallback(() => {
    const instance = audioRef.current;
    audioRef.current = null;
    setSoundReady(false);
    if (instance) {
      const disposal = instance.dispose();
      audioDisposeRef.current = disposal;
      void disposal.finally(() => { if (audioDisposeRef.current === disposal) audioDisposeRef.current = null; });
    }
    return audioDisposeRef.current || Promise.resolve();
  }, []);
  const startAmbient = useCallback((deadline: number, forceUnmuted?: boolean, replayGesture = false) => {
    if (!hasAmbient || (closed && !replayGesture)) return;
    audioRef.current ||= new InceptionAudio();
    const instance = audioRef.current, generation = lifecycle.current;
    instance.setVolume(sound.volume);
    const muted = forceUnmuted === undefined ? sound.muted : forceUnmuted;
    instance.setDeadline(deadline);
    instance.setStage(musicStage);
    if (instance.isMuted !== muted) instance.setMuted(muted);
    if (muted) setSoundReady(false);
    else if (instance.isPlaying) setSoundReady(true);
    else void instance.start({ musicCues: manifest.musicCues, creditsCue: manifest.creditsCue, approvedTrack: manifest.approvedTrack, roomTone: manifest.roomTone }, deadline, musicStage).then(playing => { if (lifecycle.current !== generation || audioRef.current !== instance) return; setSoundReady(playing); });
  }, [hasAmbient, closed, sound.muted, sound.volume, musicStage, manifest.musicCues, manifest.creditsCue, manifest.approvedTrack, manifest.roomTone]);
  const install = useCallback((value: Session) => {
    roundGeneration.current++;
    endingGenerationRef.current++;
    checkingComposerHeight.current = null;
    checkingTextareaHeight.current = null;
    if (installedRoundId.current !== value.round.id) { followConversationRef.current = true; installedRoundId.current = value.round.id; }
    if (cinematicTimerRef.current !== null) window.clearTimeout(cinematicTimerRef.current);
    setCinematicPhase(null); setRevealedDigits(''); setImmersive(true); setSession(value); setRoundClock(Date.now()); setReview(value.state.review?.status === 'complete' ? value.state.review as Review : null); setSuccessEnding(null);
    setMetricsPhase('read_think', value.round.id, value.round.accessToken);
    setError(''); setActiveModal(null); setSendStatus('');
    const stored = sessionStorage.getItem(`workshop-inception-send:${value.round.id}`);
    if (stored) { try { const parsed = JSON.parse(stored) as PendingSend; setPendingSend(parsed); setMessageText(parsed.content); } catch { sessionStorage.removeItem(`workshop-inception-send:${value.round.id}`); } }
    else setPendingSend(null);
    sessionStorage.setItem(sessionStorageKey, JSON.stringify({ id: value.round.id }));
    if (value.round.endedAt) setReview(value.state.review?.status === 'complete' ? value.state.review as Review : null);
  }, []);

  const prepareEndingMusic = useCallback(async (deadline: number) => {
    let instance = audioRef.current;
    if (!instance) {
      instance = new InceptionAudio();
      audioRef.current = instance;
      instance.setVolume(sound.volume);
      if (instance.isMuted !== sound.muted) instance.setMuted(sound.muted);
    }
    if (!instance.isInitialized) await instance.start({ musicCues: manifest.musicCues, creditsCue: manifest.creditsCue, approvedTrack: manifest.approvedTrack, roomTone: manifest.roomTone }, deadline, 'urgent');
    await instance.setStage('urgent');
    await instance.prepareCreditsCue();
    return instance;
  }, [sound.volume, sound.muted, manifest.musicCues, manifest.creditsCue, manifest.approvedTrack, manifest.roomTone]);

  const beginCreditsHandoff = useCallback((video: HTMLVideoElement) => {
    if (creditsHandoffRef.current) return;
    creditsHandoffRef.current = true;
    void audioRef.current?.resumeForCredits();
    if (sound.muted) return;
    const initialVolume = video.volume;
    const startedAt = performance.now();
    const fade = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / 1100);
      video.volume = initialVolume * (1 - progress);
      if (progress < 1 && successVideoRef.current === video) creditsFadeFrameRef.current = window.requestAnimationFrame(fade);
      else creditsFadeFrameRef.current = null;
    };
    creditsFadeFrameRef.current = window.requestAnimationFrame(fade);
  }, [sound.muted]);

  const playConfirmedEnding = useCallback((roundId: string, result: Review | null, state: InceptionState) => {
    if (!manifest.successVideo || result?.status !== 'complete' || result.verdict !== 'recovered' || !state.safeOpened || !state.revealedCombination || autoEndedRoundRef.current === roundId) return;
    const generation = lifecycle.current, roundToken = roundGeneration.current;
    endingGenerationRef.current++;
    autoEndedRoundRef.current = roundId;
    creditsHandoffRef.current = false;
    const deadline = session?.round.id === roundId ? session.round.deadline : Date.now();
    const musicReady = prepareEndingMusic(deadline);
    setActiveModal(null);
    endingWasShownRef.current = true;
    setSuccessEndingError(''); setSuccessTimeLeft(manifest.successDurationSeconds || 29); setSuccessEndingAttempt(value => value + 1); setSuccessEnding(null);
    setCinematicPhase('entry'); setRevealedDigits(reducedMotion ? state.revealedCombination : '');
    const startFilm = async () => {
      await musicReady;
      if (generation !== lifecycle.current || roundToken !== roundGeneration.current) return;
      await audioRef.current?.fadeForFilm();
      if (generation !== lifecycle.current || roundToken !== roundGeneration.current) return;
      setCinematicPhase('film'); setSuccessEnding('playing');
    };
    if (cinematicTimerRef.current !== null) window.clearTimeout(cinematicTimerRef.current);
    if (reducedMotion) cinematicTimerRef.current = window.setTimeout(() => { void startFilm(); }, 450);
    else {
      let count = 0;
      const revealNext = () => { count += 1; setRevealedDigits(state.revealedCombination!.slice(0, count)); if (count < state.revealedCombination!.length) cinematicTimerRef.current = window.setTimeout(revealNext, 180); else cinematicTimerRef.current = window.setTimeout(() => { void startFilm(); }, 500); };
      cinematicTimerRef.current = window.setTimeout(revealNext, 180);
    }
  }, [manifest.successVideo, manifest.successDurationSeconds, reducedMotion, prepareEndingMusic, session?.round.id, session?.round.deadline]);

  const replayConfirmedEnding = async () => {
    if (!session || !manifest.successVideo || review?.status !== 'complete' || review.verdict !== 'recovered' || !session.state.safeOpened) return;
    const generation = lifecycle.current, roundToken = roundGeneration.current;
    endingGenerationRef.current++;
    creditsHandoffRef.current = false;
    await prepareEndingMusic(session.round.deadline);
    await audioRef.current?.fadeForFilm();
    if (generation !== lifecycle.current || roundToken !== roundGeneration.current) return;
    setActiveModal(null);
    endingWasShownRef.current = true;
    setSuccessEndingError(''); setSuccessTimeLeft(manifest.successDurationSeconds || 29); setSuccessEndingAttempt(value => value + 1); setCinematicPhase('film'); setSuccessEnding('playing');
  };

  useEffect(() => {
    if (successEnding !== 'playing') return;
    const video = successVideoRef.current;
    if (!video) return;
    let active = true;
    video.volume = sound.volume;
    video.muted = sound.muted;
    video.currentTime = 0;
    void video.play().then(() => { if (active) setSuccessEnding('playing'); }).catch(() => { if (active) setSuccessEnding('blocked'); });
    return () => { active = false; video.pause(); };
  }, [successEnding, successEndingAttempt]);

  useEffect(() => {
    if (successEnding !== 'playing') return;
    const video = successVideoRef.current;
    if (!video) return;
    let active = true, lastTime = video.currentTime, lastProgress = Date.now();
    const timer = window.setInterval(() => {
      if (video.currentTime > lastTime + 0.05) { lastTime = video.currentTime; lastProgress = Date.now(); }
      else if (Date.now() - lastProgress > 9000) {
        if (active) { setSuccessEndingError('The ending video stopped playing. Your saved result remains available.'); setSuccessEnding('error'); }
      }
    }, 1000);
    return () => { active = false; window.clearInterval(timer); };
  }, [successEnding, successEndingAttempt]);

  useEffect(() => () => { if (cinematicTimerRef.current !== null) window.clearTimeout(cinematicTimerRef.current); if (creditsFadeFrameRef.current !== null) window.cancelAnimationFrame(creditsFadeFrameRef.current); }, []);

  useEffect(() => {
    const video = successVideoRef.current;
    if (!video) return;
    video.volume = sound.volume;
    video.muted = sound.muted;
  }, [sound.volume, sound.muted, successEnding]);

  useLayoutEffect(() => {
    const video = introVideoRef.current;
    const trackElement = introCaptionTrackRef.current;
    if (!intro || !video || !trackElement || !manifest.captions || introMediaIssue) {
      setIntroCaptionText(''); setIntroCaptionLayout(null);
      return;
    }
    const track = trackElement.track;
    track.mode = 'hidden';
    const syncText = () => setIntroCaptionText(getFilmCaptionText(track));
    const syncLayout = () => setIntroCaptionLayout(getFilmCaptionLayout(video));
    const refresh = () => { syncText(); syncLayout(); };
    track.addEventListener('cuechange', syncText);
    trackElement.addEventListener('load', refresh);
    video.addEventListener('loadedmetadata', syncLayout);
    video.addEventListener('timeupdate', syncText);
    window.addEventListener('resize', syncLayout);
    document.addEventListener('fullscreenchange', syncLayout);
    const observer = new ResizeObserver(syncLayout);
    observer.observe(video);
    refresh();
    return () => {
      track.removeEventListener('cuechange', syncText);
      trackElement.removeEventListener('load', refresh);
      video.removeEventListener('loadedmetadata', syncLayout);
      video.removeEventListener('timeupdate', syncText);
      window.removeEventListener('resize', syncLayout);
      document.removeEventListener('fullscreenchange', syncLayout);
      observer.disconnect();
      track.mode = 'disabled';
      setIntroCaptionText(''); setIntroCaptionLayout(null);
    };
  }, [intro, introMediaAttempt, introMediaIssue, manifest.captions]);

  useLayoutEffect(() => {
    const video = successVideoRef.current;
    const trackElement = successCaptionTrackRef.current;
    if (successEnding !== 'playing' || !video || !trackElement || !manifest.successCaptions) {
      setSuccessCaptionText(''); setSuccessCaptionLayout(null);
      return;
    }
    const track = trackElement.track;
    track.mode = 'hidden';
    const syncText = () => setSuccessCaptionText(getFilmCaptionText(track));
    const syncLayout = () => setSuccessCaptionLayout(getFilmCaptionLayout(video));
    const refresh = () => { syncText(); syncLayout(); };
    track.addEventListener('cuechange', syncText);
    trackElement.addEventListener('load', refresh);
    video.addEventListener('loadedmetadata', syncLayout);
    video.addEventListener('timeupdate', syncText);
    window.addEventListener('resize', syncLayout);
    document.addEventListener('fullscreenchange', syncLayout);
    const observer = new ResizeObserver(syncLayout);
    observer.observe(video);
    refresh();
    return () => {
      track.removeEventListener('cuechange', syncText);
      trackElement.removeEventListener('load', refresh);
      video.removeEventListener('loadedmetadata', syncLayout);
      video.removeEventListener('timeupdate', syncText);
      window.removeEventListener('resize', syncLayout);
      document.removeEventListener('fullscreenchange', syncLayout);
      observer.disconnect();
      track.mode = 'disabled';
      setSuccessCaptionText(''); setSuccessCaptionLayout(null);
    };
  }, [successEnding, successEndingAttempt, manifest.successCaptions]);

  useEffect(() => {
    if (successEnding) successTitleRef.current?.focus();
    else if (endingWasShownRef.current && session?.state.safeOpened && review?.status === 'complete' && review.verdict === 'recovered') { endingWasShownRef.current = false; document.querySelector<HTMLButtonElement>('[aria-label="Rewatch ending"]')?.focus(); }
  }, [successEnding, session?.state.safeOpened, review?.status, review?.verdict]);

  useLayoutEffect(() => {
    const conversation = conversationRef.current;
    if (!conversation) return;
    if (followConversationRef.current) conversation.scrollTop = conversation.scrollHeight;
    else if (preserveConversationScrollTopRef.current !== null) {
      const scrollTop = preserveConversationScrollTopRef.current;
      conversation.scrollTop = scrollTop;
      window.requestAnimationFrame(() => { if (!followConversationRef.current && conversation.isConnected) conversation.scrollTop = scrollTop; });
      preserveConversationScrollTopRef.current = null;
    }
    followConversationRef.current = false;
  }, [session?.round.id, session?.round.messages.length]);
  useEffect(() => {
    if (!cinematicHandoff) return;
    let second = 0;
    const first = requestAnimationFrame(() => { second = requestAnimationFrame(() => setCinematicHandoff(false)); });
    return () => { cancelAnimationFrame(first); cancelAnimationFrame(second); };
  }, [cinematicHandoff]);

  useEffect(() => {
    if (cinematicHandoff || handoffInteractive) return;
    if (reducedMotion) { setHandoffInteractive(true); return; }
    const timer = window.setTimeout(() => setHandoffInteractive(true), 950);
    return () => window.clearTimeout(timer);
  }, [cinematicHandoff, handoffInteractive, reducedMotion]);

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
      localStorage.removeItem(storageKey); sessionStorage.removeItem('workshop-inception-intro-at'); setPendingStart(null); setRecordingAcknowledged(true); setConfig(current => current ? { ...current, recordingAccepted: true } : current); setCinematicHandoff(intro && !reducedMotion); setHandoffInteractive(!intro || reducedMotion); install(value); setIntro(false); setFilmEnded(false);
      audioRef.current?.setDeadline(value.round.deadline);
    } catch (cause) {
      if (lifecycle.current !== generation) return;
      if (cause instanceof ApiError && cause.status >= 400 && cause.status < 500 && !cause.receiptConfirmed) {
        localStorage.removeItem(storageKey); setPendingStart(null);
      }
      setError((cause as Error).message || 'The start receipt could not be confirmed.');
    } finally { if (lifecycle.current === generation) setBusy(false); startLock.current = false; }
  }, [config, consented, install, startAmbient, intro, reducedMotion]);

  useEffect(() => {
    let active = true;
    void Promise.all([api<Configuration>('/inception'), fetch('/inception-assets/manifest.json', { cache: 'no-store' }).then(response => response.ok ? response.json() as Promise<MediaManifest> : {})]).then(async ([nextConfig, nextManifest]) => {
      if (!active) return;
      setConfig(nextConfig); setManifest(nextManifest); setConsented(Boolean(nextConfig.recordingAccepted)); setRecordingAcknowledged(Boolean(nextConfig.recordingAccepted)); setSelectedProfile(nextConfig.defaultProfileId || 'standard');
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
          void playConfirmedEnding(roundId, result.review, result.state);
          if (!(result.review.status === 'complete' && result.review.verdict === 'recovered' && result.state.safeOpened && result.state.revealedCombination)) setCinematicPhase(null);
          if (result.review.status === 'complete') setSendStatus(result.review.verdict === 'recovered' ? 'Review complete. The safe is open.' : 'Review complete. Read the result below.');
          return;
        }
      } catch { /* transient GET failures do not create another review request */ }
      if (active && attempts < 32) timer = window.setTimeout(poll, 2000);
      else if (active && attempts >= 32) { setReview({ status: 'unavailable', retryable: true, errorCode: 'review_timeout' }); setCinematicPhase(null); }
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
        setIntroTimeLeft(Math.max(0, Math.ceil(introDurationSeconds - elapsed)));
      }
    }, 250);
    return () => window.clearInterval(timer);
  }, [session?.round.id, session?.round.endedAt, intro, manifest.introVideo, introDurationSeconds]);
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
  useEffect(() => {
    if (!session || !audioRef.current || closed) return;
    audioRef.current.setDeadline(session.round.deadline);
    audioRef.current.setStage(musicStage);
  }, [session?.round.id, session?.round.deadline, musicStage, closed]);
  useEffect(() => { localStorage.setItem(soundStorage, JSON.stringify(sound)); audioRef.current?.setVolume(sound.volume); if (audioRef.current?.isMuted !== sound.muted) audioRef.current?.setMuted(sound.muted); }, [sound]);
  useEffect(() => {
    if (expired) { void disposeAmbient(); return; }
    if (!session?.round.endedAt || !review || review.status === 'pending') return;
    const confirmedEnding = review.status === 'complete' && review.verdict === 'recovered' && session.state.safeOpened && Boolean(session.state.revealedCombination);
    if (!confirmedEnding) void disposeAmbient();
  }, [session?.round.endedAt, session?.state.safeOpened, session?.state.revealedCombination, review?.status, review?.verdict, expired, disposeAmbient]);
  useEffect(() => { if (!retryCooldownUntil) { setRetrySeconds(0); return; } const tick = () => { const seconds = Math.max(0, Math.ceil((retryCooldownUntil - Date.now()) / 1000)); setRetrySeconds(seconds); if (!seconds) setRetryCooldownUntil(0); }; tick(); const timer = window.setInterval(tick, 1000); return () => window.clearInterval(timer); }, [retryCooldownUntil]);
  const enterFullscreen = async () => {
    setImmersive(true);
    try { if (!document.fullscreenElement) await rootRef.current?.requestFullscreen(); setFullscreen(Boolean(document.fullscreenElement)); }
    catch { setFullscreen(false); setImmersive(true); }
  };
  const leave = async () => { lifecycle.current++; await disposeAmbient(); if (document.fullscreenElement) await document.exitFullscreen().catch(() => undefined); setImmersive(false); onHome(); };
  useEffect(() => {
    const onEscape = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === 'm' && !event.repeat && !(event.target instanceof HTMLElement && /INPUT|TEXTAREA|SELECT/.test(event.target.tagName))) { setSound((current: typeof defaultSound) => ({ ...current, muted: !current.muted })); return; }
      if (event.key !== 'Escape') return;
      if (activeModal) { setActiveModal(null); return; }
      if (intro && pendingStart) { event.preventDefault(); setIntro(false); setFilmEnded(false); return; }
      if (cinematicPhase === 'entry') return;
      if (cinematicPhase === 'film' || cinematicPhase === 'closing') { event.preventDefault(); void leave(); return; }
      if (intro) { event.preventDefault(); finishIntro(true); return; }
      if (session) { event.preventDefault(); void leave(); }
    };
    window.addEventListener('keydown', onEscape);
    return () => window.removeEventListener('keydown', onEscape);
  }, [activeModal, intro, pendingStart, session?.round.id, cinematicPhase]);
  const beginIntro = () => {
    if (!config?.connected || busy || (!config.recordingAccepted && !consented)) return;
    if (!manifest.introVideo) { void startRound(selectedProfile); return; }
    setError(''); setIntroMediaIssue(''); introProgressRef.current = { at: Date.now(), time: 0 }; introStartRequested.current = false; void enterFullscreen();
    startAmbient(Date.now() + 300000);
    sessionStorage.setItem('workshop-inception-intro-at', String(Date.now())); setIntroTimeLeft(introDurationSeconds); setFilmEnded(!manifest.introVideo); setIntroMediaAttempt(0); setIntro(true);
  };
  const finishIntro = (skip = false) => {
    if (!intro || busy || introStartRequested.current) return;
    if (skip) { introVideoRef.current?.pause(); setFilmEnded(true); introStartRequested.current = true; void startRound(selectedProfile); }
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
    if (!retry && Date.now() < retryCooldownUntil) return;
    const existing = pendingSend;
    if (retry && !existing) return;
    if (retry && !existing?.id) return;
    if (!retry && (!messageText.trim() || existing)) return;
    const transcript = conversationRef.current;
    followConversationRef.current = !transcript || transcript.scrollHeight - transcript.clientHeight - transcript.scrollTop < 72;
    preserveConversationScrollTopRef.current = followConversationRef.current ? null : transcript?.scrollTop ?? 0;
    const focusAtSend = document.activeElement;
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
      requestAnimationFrame(() => {
        const active = document.activeElement;
        const sentFromComposer = focusAtSend === inputRef.current || (focusAtSend instanceof HTMLElement && focusAtSend.closest('.inception-composer'));
        if (active === focusAtSend || (active === document.body && sentFromComposer)) inputRef.current?.focus();
      });
    } catch (cause) {
      if (lifecycle.current !== generation || roundGeneration.current !== roundToken) return;
      const apiError = cause as ApiError;
      const terminalReceipt = apiError.receiptConfirmed && ['failed', 'rejected', 'interrupted'].includes(apiError.submissionStatus || '');
      if (terminalReceipt) { sessionStorage.removeItem(`workshop-inception-send:${session.round.id}`); setPendingSend(null); setSendStatus('The prompt was recorded, but Fischer could not reply. Send again to create a new attempt.'); }
      else if (apiError.receiptConfirmed) setSendStatus(apiError.submissionStatus === 'succeeded' ? 'Reply received; refreshing the saved conversation…' : 'The receipt is still being checked. Retry this same message to recover its result.');
      else setSendStatus('The response was not confirmed. Retry to check this same message.');
      if (terminalReceipt && apiError.retryAfterSeconds) setRetryCooldownUntil(Date.now() + apiError.retryAfterSeconds * 1000);
      if (terminalReceipt && apiError.failureCode === 'rate_limited') setSendStatus(apiError.rateLimitScope === 'tokens_daily' ? apiError.retryAfterSeconds ? 'Your prompt is saved, but the model service reached its daily token allowance. You can send again after the cooldown.' : 'Your prompt is saved, but the model service reached its daily token allowance. Wait before trying again.' : apiError.retryAfterSeconds ? 'Your prompt is saved, but the model service is temporarily rate limited. You can send again after the cooldown.' : 'Your prompt is saved, but the model service is temporarily rate limited. Wait before trying again.');
      setError((cause as Error).message); if (apiError.receiptConfirmed && !terminalReceipt) await fetchSession(session.round.id).catch(() => undefined);
    } finally { if (lifecycle.current === generation) setBusy(false); sendLock.current = false; }
  };

  const finish = async () => {
    if (!session || busy || session.round.endedAt || pendingSend) return;
    const roundId = session.round.id, generation = lifecycle.current, roundToken = roundGeneration.current;
    checkingComposerHeight.current = composerRef.current?.getBoundingClientRect().height ?? null;
    checkingTextareaHeight.current = inputRef.current?.getBoundingClientRect().height ?? null;
    recordMetricsInteraction('finish', roundId, session.round.accessToken);
    setCinematicPhase('checking'); setBusy(true); setError(''); setSendStatus('');
    try {
      const result = await api<{ round: Round; state: InceptionState }>(`/inception/rounds/${roundId}/finish`, { method: 'POST', body: { answer: '' } });
      if (lifecycle.current !== generation || roundGeneration.current !== roundToken) return;
      setSession(current => current?.round.id === roundId ? { ...current, round: result.round, state: result.state } : current); setRoundClock(Date.now());
      await requestReview(roundId);
    } catch (cause) { if (lifecycle.current === generation && roundGeneration.current === roundToken) { setCinematicPhase(null); setError((cause as Error).message); setSendStatus(''); } }
    finally { if (lifecycle.current === generation) setBusy(false); }
  };
  const requestReview = async (roundId = session?.round.id) => {
    if (!roundId || reviewLock.current) return;
    const generation = lifecycle.current, roundToken = roundGeneration.current;
    if (session?.round.id === roundId) recordMetricsInteraction('review', roundId, session.round.accessToken);
    reviewLock.current = true; setReview({ status: 'pending' }); setCinematicPhase('checking');
    try {
      const result = await api<{ review: Review | null; state: InceptionState }>(`/inception/rounds/${roundId}/review`, { method: 'POST', body: {} });
      if (lifecycle.current !== generation || roundGeneration.current !== roundToken) return;
      setReview(result.review); if (result.state) setSession(current => current?.round.id === roundId ? { ...current, state: result.state } : current);
      if (result.state) void playConfirmedEnding(roundId, result.review, result.state);
      if (result.review?.status !== 'pending' && !(result.review?.status === 'complete' && result.review.verdict === 'recovered' && result.state?.safeOpened && result.state.revealedCombination)) setCinematicPhase(null);
      if (result.review?.status === 'complete') setSendStatus(result.review.verdict === 'recovered' ? 'Review complete. The safe is open.' : 'Review complete. Read the result below.');
    } catch (cause) {
      if (lifecycle.current !== generation || roundGeneration.current !== roundToken) return;
      const recovered = await api<{ review: Review | null; state: InceptionState }>(`/inception/rounds/${roundId}/review`).catch(() => null);
      if (lifecycle.current !== generation || roundGeneration.current !== roundToken) return;
      if (recovered?.review && recovered.review.status !== 'pending') {
        setReview(recovered.review); setSession(current => current?.round.id === roundId ? { ...current, state: recovered.state } : current);
        void playConfirmedEnding(roundId, recovered.review, recovered.state);
        if (recovered.review.status !== 'pending' && !(recovered.review.status === 'complete' && recovered.review.verdict === 'recovered' && recovered.state.safeOpened && recovered.state.revealedCombination)) setCinematicPhase(null);
        setSendStatus(recovered.review.status === 'complete' && recovered.review.verdict === 'recovered' ? 'Review complete. The safe is open.' : 'Review complete. Read the result below.');
      } else if (recovered?.review?.status === 'pending') {
        setReview({ status: 'pending' }); setCinematicPhase('checking'); setError('');
      } else {
        setReview({ status: 'unavailable', retryable: true, errorCode: 'provider_error' }); setCinematicPhase(null); setError((cause as Error).message);
      }
    }
    finally { reviewLock.current = false; }
  };
  const replay = () => {
    if (busy || review?.status === 'pending') return;
    roundGeneration.current++;
    setSession(null); setReview(null); setMessageText(''); setPendingSend(null); sessionStorage.removeItem(sessionStorageKey); setError('');
    setSelectedProfile(session?.profile.profileRevision === 1 ? 'standard' : session?.profile.profileId || selectedProfile); beginIntro();
    if (!sound.muted) startAmbient(Date.now() + 300000, undefined, true);
  };
  const archiveOldAndStartCurrent = async () => {
    if (!session || session.profile.profileRevision !== 1 || busy || pendingSend || review?.status === 'pending') return;
    const oldRoundId = session.round.id, generation = lifecycle.current, roundToken = roundGeneration.current;
    setBusy(true); setError('');
    try {
      if (!session.round.endedAt) {
        const result = await api<{ round: Round; state: InceptionState }>(`/inception/rounds/${oldRoundId}/finish`, { method: 'POST', body: { answer: '' } });
        if (lifecycle.current !== generation || roundGeneration.current !== roundToken) return;
        setSession(current => current?.round.id === oldRoundId ? { ...current, round: result.round, state: result.state } : current);
      }
      setSelectedProfile('standard');
      await startRound('standard');
    } catch (cause) {
      if (lifecycle.current === generation && roundGeneration.current === roundToken) setError((cause as Error).message || 'The earlier attempt could not be finished.');
    } finally { if (lifecycle.current === generation) setBusy(false); }
  };
  const keyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape' && activeModal) { setActiveModal(null); return; }
    if (event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey && !event.repeat && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229 && !composing.current) { event.preventDefault(); void send(); }
  };

  if (loading) return <main className="inception-loading" aria-busy="true">Opening the strongroom…</main>;
  if (!config) return <main className="inception-loading"><p role="alert">{error || 'The strongroom is unavailable.'}</p><button onClick={onHome}>Return to workshop</button></main>;
  const activeProfile = session?.profile || config.profiles.find(item => item.id === selectedProfile) || config.profiles[0];
  const gameBackground = session?.state.safeOpened && cinematicPhase !== 'entry' ? manifest.openFrame : manifest.closedFrame;
  return <main ref={rootRef} className={`inception-root ${fullscreen ? 'is-fullscreen' : ''} ${immersive ? 'is-immersive' : ''} ${reducedMotion ? 'reduced-motion' : ''}`} style={{ ...(gameBackground ? { '--scene-art': `url("${gameBackground}")` } : {}), ...(manifest.dialogueTexture ? { '--dialogue-texture': `url("${manifest.dialogueTexture}")` } : {}) } as CSSProperties}>
    <div className="inception-shade" aria-hidden="true" />
    {!session ? intro ? <section className="inception-intro" aria-label="Strongroom approach">
      {manifest.introVideo && !introMediaIssue ? <video ref={introVideoRef} key={`${manifest.introVideo}-${introMediaAttempt}`} className="inception-intro-video" autoPlay playsInline muted onTimeUpdate={event => { const video = event.currentTarget; setIntroTimeLeft(Math.max(0, Math.ceil(introDurationSeconds - video.currentTime))); introProgressRef.current = { at: Date.now(), time: video.currentTime }; }} onEnded={() => { setIntroTimeLeft(0); setFilmEnded(true); }} onError={() => setIntroMediaIssue('The approach could not play. Retry it or continue to the strongroom.')}>
        <source src={manifest.introVideo} type="video/mp4" />{manifest.captions && <track ref={introCaptionTrackRef} kind="captions" src={manifest.captions} srcLang="en" label="English" />}
      </video> : manifest.bridgeVideo && !introMediaIssue ? <video key={`${manifest.bridgeVideo}-${filmEnded}`} className="inception-intro-video" autoPlay playsInline muted><source src={manifest.bridgeVideo} type="video/mp4" /></video> : <div className={`inception-intro-scene ${filmEnded ? 'handoff' : ''}`} style={(manifest.bridgeFrame || manifest.closedFrame) ? { backgroundImage: `url("${manifest.bridgeFrame || manifest.closedFrame}")` } : undefined}><p>THE DREAM IS BEGINNING TO SHIFT</p><div className="inception-intro-caption">Fischer is close. The safe is nearby.</div></div>}
      {introCaptionLayout && <div className="inception-film-caption-bands" style={introCaptionLayout}>{introCaptionText && <span className="inception-film-caption" style={{ top: '93.5185%' }} aria-label="English captions" aria-live="polite">{introCaptionText}</span>}</div>}
      {introMediaIssue && <div className="inception-media-recovery" role="alert"><p>{introMediaIssue}</p><div><Button className="inception-quiet-button" disabled={busy} onClick={() => { introProgressRef.current = { at: Date.now(), time: 0 }; setIntroTimeLeft(introDurationSeconds); setIntroMediaIssue(''); setIntroMediaAttempt(value => value + 1); }}>Retry approach</Button><Button className="inception-quiet-button" disabled={busy} onClick={() => finishIntro(true)}>Continue</Button></div></div>}
      {pendingStart && !busy && <div className="inception-media-recovery" role="alert"><p>The start receipt could not be confirmed.</p><Button className="inception-quiet-button" onClick={() => void startRound(pendingStart.profileId, { clientStartId: pendingStart.clientStartId })}>Retry start</Button><Button className="inception-quiet-button" onClick={() => { setIntro(false); setFilmEnded(false); }}>Return to entry</Button></div>}
      {error && <p className="inception-inline-error" role="alert">{error}</p>}
    </section> : <section className="inception-entry">
      <header><span className="inception-kicker">A DREAM OF THE STRONGROOM</span><div className="inception-entry-header-actions"><button className="inception-entry-sound" aria-label={sound.muted ? 'Unmute sound' : 'Mute sound'} aria-pressed={sound.muted} onClick={() => setSound((current: typeof defaultSound) => ({ ...current, muted: !current.muted }))}>{sound.muted ? <VolumeX size={16} /> : <Volume2 size={16} />}<span>{sound.muted ? 'Sound off' : 'Sound on'}</span></button><button className="inception-back" onClick={onHome}><ArrowLeft size={15} />Workshop</button></div></header>
      <div className="inception-entry-copy"><p className="inception-kicker">INCEPTION</p><h1>Inception Strongroom</h1><p>You are Eames. Fischer cannot remember the combination. Help him return to the moment he first said it, before the dream collapses.</p></div>
      {!config.recordingAccepted && <label className="inception-consent"><input type="checkbox" checked={consented} onChange={event => setConsented(event.target.checked)} /><span>{RECORDING_NOTICE} <strong>I understand and agree to this recording.</strong></span></label>}
      <fieldset className="inception-profiles"><legend>Choose a conversation style</legend>{config.profiles.map(profile => <button type="button" key={profile.id} className={selectedProfile === profile.id ? 'selected' : ''} onClick={() => setSelectedProfile(profile.id)} aria-pressed={selectedProfile === profile.id}><span>{profile.label}</span><small>{profile.description}</small></button>)}</fieldset>
      {!config.connected && <p className="inception-inline-error" role="status">The target model is not connected yet. Your saved conversations remain available.</p>}
      {hasAmbient && <p className="inception-media-note">Sound begins when you enter. You can mute it anytime.</p>}
      {pendingStart && !busy && <div className="inception-receipt" role="alert"><p>The start receipt is not confirmed. Retry with the saved request key.</p><Button className="inception-primary" disabled={!config.recordingAccepted && !consented} onClick={() => void startRound(pendingStart.profileId, { clientStartId: pendingStart.clientStartId })}>Check start receipt</Button></div>}
      {error && <p className="inception-inline-error" role="alert">{error}</p>}
      {!pendingStart && <div className="inception-entry-actions"><Button className="inception-primary" disabled={!config.connected || busy || (!config.recordingAccepted && !consented)} onClick={beginIntro}>Watch and begin<ArrowRight size={16} /></Button><Button className="inception-secondary" disabled={!config.connected || busy || (!config.recordingAccepted && !consented)} onClick={() => void startRound(selectedProfile)}>Begin without film</Button></div>}
      <footer>{config.reviewEnabled ? 'Five minutes. Your saved conversation determines whether the safe opens.' : 'Five minutes. Conversation review is currently unavailable.'}</footer>
    </section> : <section className={`inception-play ${cinematicHandoff ? 'is-cinematic-handoff' : ''} ${cinematicPhase ? `is-cinematic-${cinematicPhase}` : ''} ${!handoffInteractive ? 'is-handoff-locked' : ''}`} aria-label="Inception strongroom">
      <header className="inception-topbar" inert={!handoffInteractive || Boolean(successEnding) || Boolean(cinematicPhase) ? true : undefined}><div className="inception-top-actions"><span className={`inception-clock ${remaining <= 45 ? 'urgent' : ''}`} role="timer" aria-label={`${time(remaining)} remaining`}>{time(remaining)}</span><label className="inception-volume" aria-label="Sound volume"><Volume2 size={15} /><input type="range" min="0" max="0.7" step="0.05" value={sound.volume} disabled={closed} onChange={event => setSound({ ...sound, volume: Number(event.target.value) })} /></label><button className="inception-icon-button" aria-label={sound.muted ? 'Unmute sound' : 'Mute sound'} disabled={closed} onClick={() => { const muted = !sound.muted; setSound({ ...sound, muted }); if (!muted) startAmbient(session.round.deadline, false); }}>{sound.muted ? <VolumeX size={17} /> : <Volume2 size={17} />}</button>{hasAmbient && !sound.muted && !soundReady && !closed && <button className="inception-icon-button" onClick={() => startAmbient(session.round.deadline, false)}>Play sound</button>}<button className="inception-icon-button" aria-label={fullscreen ? 'Exit fullscreen' : 'Enter fullscreen'} onClick={() => fullscreen ? void document.exitFullscreen().catch(() => undefined) : void enterFullscreen()}><Maximize2 size={16} /></button><button className="inception-icon-button" aria-label="Leave strongroom" onClick={() => void leave()}><X size={18} /></button></div></header>
      {cinematicPhase === 'checking' && <p className="visually-hidden" role="status">Checking the saved conversation…</p>}
      <div className={`inception-scene-row ${gameBackground ? 'has-art' : ''}`} inert={!handoffInteractive || Boolean(successEnding) || Boolean(cinematicPhase) ? true : undefined}>
        <div ref={safeRef} className={`inception-safe ${session.state.safeOpened ? 'open' : ''} ${gameBackground ? 'with-art' : ''}`} role="group" aria-label={session.state.safeOpened ? 'Strongroom safe open' : 'Closed strongroom safe'}><span className="inception-safe-dimming" aria-hidden="true" /><div className="inception-safe-door"><div className="inception-safe-keypad" aria-hidden="true"><span className="inception-safe-display" /><div>{Array.from({ length: 12 }, (_, index) => <i key={index} />)}</div></div><span className="inception-safe-handle" /></div>{cinematicPhase === 'entry' && <span className="inception-revealed-code" style={lcdBounds} aria-label="Confirmed combination">{revealedDigits}</span>}{!session.state.safeOpened && <><button className="inception-hotspot safe-hotspot" style={gameBackground ? safeBounds : undefined} aria-label="Inspect safe" disabled={busy || closed || !handoffInteractive} onClick={() => { setActiveModal('safe'); if (!session.state.safeInspected) void inspect('inspect_safe'); }} /><button className="inception-hotspot room-hotspot" aria-label="Inspect the room" disabled={busy || closed || !handoffInteractive} onClick={() => { setActiveModal('room'); if (!session.state.roomInspected) void inspect('inspect_room'); }} /></>}</div>
        <section className="inception-dialogue" aria-label="Conversation with Fischer" inert={!handoffInteractive || Boolean(cinematicPhase) ? true : undefined}>
          <p className="inception-location" aria-hidden="true"></p>
          <div ref={conversationRef} className="inception-conversation" role="log" aria-label="Conversation transcript" aria-live="polite" aria-relevant="additions" aria-atomic="false" tabIndex={0} onScroll={event => { const element = event.currentTarget; followConversationRef.current = element.scrollHeight - element.clientHeight - element.scrollTop < 72; }}>
            {session.round.messages.filter(item => item.role === 'user' || item.role === 'assistant').map((item: Message) => <article key={item.id} className={item.role === 'user' ? 'from-player' : 'from-fischer'}><img src={item.role === 'user' ? manifest.portraits?.eames : manifest.portraits?.fischer} alt={item.role === 'user' ? 'Eames' : 'Fischer'} /><p>{item.content}</p></article>)}
          </div>
          {session.profile.profileRevision === 1 && (!session.round.endedAt || checkingEndedRound) && <div className="inception-old-version"><p>This conversation uses an earlier version. Its prompts are preserved.</p><Button className="inception-secondary" disabled={busy || Boolean(pendingSend) || review?.status === 'pending' || checkingEndedRound} onClick={() => void archiveOldAndStartCurrent()}>Finish this version and start Standard</Button></div>}
          {(expired && !session.round.endedAt || retainExpiredFinishControl) && <div className="inception-expired-controls" role="group" aria-label="Finish the expired conversation"><p>Time is up. Your saved conversation can still be reviewed.</p>{pendingSend && <><p role="status">Retry checks the same saved message receipt.</p><Button className="inception-secondary" disabled={busy} onClick={() => void send(true)}>Retry saved message</Button></>}{!pendingSend && <Button className="inception-primary" disabled={busy || checkingEndedRound} onClick={() => void finish()}>{busy ? 'Saving conversation…' : 'Finish and review'}</Button>}{error && <p role="alert" className="inception-inline-error">{error}</p>}</div>}
          {!session.round.endedAt || checkingEndedRound ? <div ref={composerRef} className="inception-composer" style={checkingEndedRound && checkingComposerHeight.current ? { minHeight: `${checkingComposerHeight.current}px` } : undefined}>
            <label htmlFor="inception-message" className="visually-hidden">Speak to Fischer</label>
            <textarea id="inception-message" ref={inputRef} style={checkingEndedRound && checkingTextareaHeight.current ? { minHeight: `${checkingTextareaHeight.current}px` } : undefined} value={messageText} disabled={closed || busy || Boolean(pendingSend)} maxLength={4000} rows={2} onChange={event => setMessageText(event.target.value)} onFocus={() => setMetricsPhase('compose', session.round.id, session.round.accessToken)} onBlur={() => setMetricsPhase('read_think', session.round.id, session.round.accessToken)} onKeyDown={keyDown} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} placeholder={closed ? 'This conversation has ended.' : 'Ask Fischer a question…'} />
            {pendingSend && <p className="inception-send-status visually-hidden" role="status">This message has an unknown receipt. Retry checks the same saved request.</p>}
            <div className="inception-composer-actions"><span className="inception-send-status visually-hidden" role="status">{sendStatus}{retrySeconds ? ` Try again in ${retrySeconds}s.` : ''}</span><div>{pendingSend ? <Button className="inception-secondary" disabled={busy} onClick={() => void send(true)}>Retry saved message</Button> : <Button className="inception-primary" disabled={closed || busy || !messageText.trim() || retrySeconds > 0} onClick={() => void send()}>Send<ArrowRight size={15} /></Button>}{(!session.round.endedAt && !expired || checkingEndedRound) && <Button className="inception-secondary" disabled={busy || Boolean(pendingSend) || checkingEndedRound} onClick={() => void finish()}>Finish and review</Button>}</div></div>
            {error && !expired && <p className="inception-inline-error" role="alert">{error}</p>}
          </div> : <p className="inception-conversation-saved" role="status">Conversation saved.</p>}
          {(expired || session.round.endedAt) && !cinematicPhase && !successEnding && <div className="inception-result" role="status">
            <p className="inception-kicker">THE STRONGROOM</p>
            <div className="inception-result-copy">
              {!review ? <p>{session.round.endedAt ? 'Your conversation is saved. Its outcome is not yet verified.' : 'Time is up. Your saved conversation can be reviewed.'}</p>
                : review.status === 'pending' ? <p>Your conversation is saved. The outcome is being checked.</p>
                  : review.status === 'unavailable' || review.verdict === 'uncertain' ? <><strong>The outcome is not yet verified.</strong><p>Your conversation is saved.{review.status === 'unavailable' && review.retryable ? ' You can retry the review.' : ' The review could not resolve the result.'}</p></>
                    : <><strong>{review.verdict === 'recovered' ? 'The lock turns. You’re inside.' : 'The dream gives way. The safe stays locked.'}</strong>{review.verdict === 'partial' ? <p>You have a lead, but not a verified complete combination.</p> : review.verdict !== 'recovered' ? <p>{session.profile.profileRevision === 1 ? 'Fischer did not disclose the combination before the dream collapsed.' : 'Fischer did not recover his earlier answer before the dream collapsed.'}</p> : null}{review.verdict === 'recovered' && review.evidence?.[0]?.quote && <blockquote><span>FISCHER</span><p>{review.evidence[0].quote}</p></blockquote>}</>}
            </div>
            <div className="inception-result-actions">
              {!review && config.reviewEnabled && session.round.endedAt && <Button className="inception-secondary" disabled={busy} onClick={() => void requestReview()}>Check outcome</Button>}
              {review?.status === 'unavailable' && review.retryable && config.reviewEnabled && <Button className="inception-secondary" disabled={busy} onClick={() => void requestReview()}>Retry review</Button>}
              {session.round.endedAt && <Button className="inception-secondary" disabled={busy || review?.status === 'pending'} onClick={replay}>Start a new attempt</Button>}
              {session.state.safeOpened && review?.status === 'complete' && review.verdict === 'recovered' && manifest.successVideo && <Button aria-label="Rewatch ending" className="inception-secondary" onClick={replayConfirmedEnding}>Rewatch the ending</Button>}
            </div>
          </div>}
          <footer className="inception-play-footer"><span>{activeProfile?.label} · {session.round.messages.filter(item => item.role === 'user').length} prompts</span></footer>
        </section>
      </div>
      {activeModal && <div className="inception-modal-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setActiveModal(null); }}><section ref={modalRef} className="inception-modal" role="dialog" aria-modal="true" aria-labelledby="inception-modal-title" tabIndex={-1}>
        <button className="inception-modal-close" aria-label="Close" onClick={() => setActiveModal(null)}><X size={18} /></button>
        {activeModal === 'safe' ? <><p className="inception-kicker">OBJECT INSPECTION</p><h2 id="inception-modal-title">{session.state.safeOpened ? 'Inside the strongroom safe' : 'The strongroom safe'}</h2>{session.state.safeOpened ? <div className="inception-open-interior" aria-label="Inside the open strongroom safe">{manifest.openFrame ? <img src={manifest.openFrame} alt="The open strongroom safe" /> : <p>The door is open. The mechanism is still.</p>}</div> : <><div className="inception-safe-zoom" role="img" aria-label="Close view of the compact green safe, brushed-metal keypad, and circular handle" style={manifest.closedFrame ? { backgroundImage: `url("${manifest.closedFrame}")` } : undefined} /><p className="inception-safe-detail">{session.state.safeInspected ? 'A compact safe is recessed in the dark-green bedside cabinet. Its brushed-steel face holds twelve rounded metal buttons, a small display, and a circular handle. No code is visible.' : 'A compact dark-green bedside safe with a brushed-metal face and circular handle.'}</p>{!session.state.safePresented && <Button className="inception-secondary" disabled={!session.state.safeInspected || busy || closed} onClick={() => void inspect('present_safe')}>Present safe to Fischer</Button>}</>}{busy && <p role="status">Saving inspection…</p>}</> : <><p className="inception-kicker">OBJECT INSPECTION</p><h2 id="inception-modal-title">The strongroom</h2><p>A quiet bedside cabinet stands by the bed. White bedlinen runs along the right edge of the frame; nothing else in view explains the combination.</p>{busy && <p role="status">Saving observation…</p>}</>}
      </section></div>}
      {successEnding && <section className={`inception-success-ending ${['closing', 'title', 'title-fade', 'credit', 'hold'].includes(successEnding) ? 'is-title-card' : ''} ${successEnding === 'title-fade' ? 'is-card-exit' : ''}`} aria-label="Inception ending" aria-live="polite">
        <video ref={successVideoRef} key={`${manifest.successVideo}-${successEndingAttempt}`} className="inception-success-ending-video" playsInline preload="auto" muted={sound.muted} onTimeUpdate={event => {
          const video = event.currentTarget;
          const duration = manifest.successDurationSeconds || video.duration || 29;
          const left = Math.max(0, duration - video.currentTime);
          setSuccessTimeLeft(Math.ceil(left));
          if (left <= 1.15) beginCreditsHandoff(video);
        }} onEnded={event => {
          const video = event.currentTarget;
          const lifecycleToken = lifecycle.current;
          const roundToken = roundGeneration.current;
          const endingToken = ++endingGenerationRef.current;
          const isCurrentEnding = () => lifecycle.current === lifecycleToken && roundGeneration.current === roundToken && endingGenerationRef.current === endingToken;
          const schedule = (delay: number, callback: () => void) => {
            if (cinematicTimerRef.current !== null) window.clearTimeout(cinematicTimerRef.current);
            cinematicTimerRef.current = window.setTimeout(() => { if (isCurrentEnding()) callback(); }, delay);
          };
          setSuccessEnding('closing'); setCinematicPhase('closing');
          beginCreditsHandoff(video);
          schedule(reducedMotion ? 50 : 700, () => {
            setSuccessEnding('title');
            schedule(4_250, () => {
              setSuccessEnding('title-fade');
              schedule(reducedMotion ? 50 : 750, () => {
                setSuccessEnding('closing');
                schedule(1_200, () => {
                  setSuccessEnding('credit');
                  schedule(10_000, () => {
                    const endingAudio = audioRef.current;
                    void endingAudio?.fadeToSilence(2.5).then(async () => {
                      if (!isCurrentEnding()) return;
                      if (endingAudio && audioRef.current === endingAudio) await disposeAmbient();
                      if (isCurrentEnding()) setSuccessEnding('hold');
                    });
                  });
                });
              });
            });
          });
        }} onError={() => { endingGenerationRef.current++; if (cinematicTimerRef.current !== null) window.clearTimeout(cinematicTimerRef.current); setSuccessEndingError('The ending video could not be played. Your saved result remains available.'); setSuccessEnding('error'); setCinematicPhase(null); void disposeAmbient(); }}>
          <source src={manifest.successVideo || undefined} type="video/mp4" />{manifest.successCaptions && <track ref={successCaptionTrackRef} kind="captions" src={manifest.successCaptions} srcLang="en" label="English scene captions" />}
        </video>
        {successEnding === 'playing' && successCaptionLayout && <div className="inception-film-caption-bands" style={successCaptionLayout}>{successCaptionText && <span className="inception-film-caption" style={{ top: '93.5185%' }} aria-label="English captions" aria-live="polite">{successCaptionText}</span>}</div>}
        <h2 ref={successTitleRef} tabIndex={-1} className="visually-hidden">Inception ending</h2>
        {(successEnding === 'title' || successEnding === 'title-fade') && <div className="inception-ending-card inception-ending-title-card" role="heading" aria-level={1}>{manifest.endingWordmark ? <img src={manifest.endingWordmark} alt="INCEPTION" /> : 'INCEPTION'}</div>}
        {(successEnding === 'credit' || successEnding === 'hold') && <div className="inception-ending-card inception-ending-credit-card"><p>Brought to you by</p><strong>CSES ML Team</strong></div>}
        {(successEnding === 'blocked' || successEnding === 'error') && <div className="inception-media-recovery" role={successEnding === 'error' ? 'alert' : 'status'}><p>{successEndingError || 'The ending could not start automatically.'}</p>{successEnding === 'blocked' && <Button className="inception-quiet-button" onClick={() => { endingGenerationRef.current++; setSuccessEndingError(''); setSuccessEndingAttempt(value => value + 1); setSuccessEnding('playing'); }}>Play ending</Button>}{successEnding === 'error' && <Button className="inception-quiet-button" onClick={() => { endingGenerationRef.current++; setSuccessEndingError(''); setSuccessEnding(null); setCinematicPhase(null); }}>Return to result</Button>}</div>}
      </section>}
    </section>}
  </main>;
}
