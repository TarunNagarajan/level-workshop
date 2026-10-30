import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CSSProperties } from 'react';
import { ArrowRight, Maximize2, Volume2, VolumeX, X } from 'lucide-react';
import { api, ApiError, RECORDING_NOTICE, RECORDING_NOTICE_VERSION, setInceptionRecordingAuthorization, setRecordingAcknowledged, time } from './api';
import type { Message, Round } from './types';
import { Button } from './ui';
import { InceptionAudio } from './inception-audio';
import { recordMetricsInteraction, recordMetricsReply, setMetricsPhase } from './telemetry';
import { resolveNewInceptionProfileId } from './inception-profile';
import './inception.css';

type Profile = { id: string; profileId?: string; label: string; description: string; versionId?: string; scenarioId?: string; profileRevision?: number; promptHash?: string; snapshotHash?: string };
type InceptionState = { revision: number; safeInspected: boolean; roomInspected: boolean; safePresented: boolean; safeOpened: boolean; finished: boolean; revealedCombination?: string; review: { status: string; verdict?: string; reason?: string } | null };
type Session = { round: Round; state: InceptionState; profile: Profile };
type Configuration = { title: string; profiles: Profile[]; defaultProfileId?: string; connected: boolean; recordingNoticeRequired?: boolean; recordingAccepted?: boolean; recordingAuthorized?: boolean; entryPolicy?: string; reviewEnabled?: boolean; actorScope: string; activeRoundId: string | null };
type Review = { status: string; verdict?: string; reason?: string; evidence?: { replyId: string; quote: string }[]; retryable?: boolean; errorCode?: string };
type MediaManifest = { closedFrame?: string | null; openFrame?: string | null; dialogueTexture?: string | null; bridgeFrame?: string | null; bridgeVideo?: string | null; introVideo?: string | null; introDurationSeconds?: number; captions?: string | null; successVideo?: string | null; successCaptions?: string | null; successFilmDurationSeconds?: number; successDurationSeconds?: number; successTitleFadeInStartSeconds?: number; successTitleFadeInEndSeconds?: number; successTitleFadeStartSeconds?: number; successTitleFadeEndSeconds?: number; successLogoStartSeconds?: number; successLogoFadeInEndSeconds?: number; successLogoFadeStartSeconds?: number; successLogoFadeEndSeconds?: number; successFinalBlackDurationSeconds?: number; successReturnFadeSeconds?: number; endingWordmark?: string | null; endingLogo?: string | null; entryPoster?: string | null; entryWordmark?: string | null; gameplayLoop?: string | null; roomTone?: string | null; creditsCue?: string | null; creditsDurationSeconds?: number; portraits?: { eames?: string; fischer?: string } };
type PendingSend = { id: string; content: string };
type SendPhase = 'idle' | 'sending' | 'checking';

const startStorage = 'workshop-inception-start-intent';
const startStorageFor = (actorScope: string) => `${startStorage}:${actorScope}`;
const completedRoundStorage = 'workshop-inception-completed-round';
const completedRoundStorageFor = (actorScope: string) => `${completedRoundStorage}:${actorScope}`;
const sendCooldownStorageFor = (roundId: string) => `workshop-inception-send-cooldown:${roundId}`;
const sendFailureStorageFor = (roundId: string) => `workshop-inception-send-failure:${roundId}`;
const hasPersistedProviderFailure = (roundId: string) => {
  try {
    const value = JSON.parse(sessionStorage.getItem(sendFailureStorageFor(roundId)) || 'null') as { at?: number } | null;
    return Boolean(value && Number.isFinite(value.at) && value.at! <= Date.now() && value.at! >= Date.now() - 24 * 60 * 60 * 1000);
  } catch { return false; }
};
const readSendCooldown = (roundId: string) => {
  try {
    const value = Number(sessionStorage.getItem(sendCooldownStorageFor(roundId)));
    const now = Date.now();
    return Number.isFinite(value) && value > now && value <= now + 7 * 24 * 60 * 60 * 1000 ? value : 0;
  } catch { return 0; }
};
const sessionStorageKey = 'workshop-inception-session';
const nextAttemptDraftStorageFor = (actorScope: string) => `workshop-inception-next-attempt-draft:${actorScope}`;
const sendDraftStorageFor = (roundId: string) => `workshop-inception-send-draft:${roundId}`;
const soundStorage = 'workshop-inception-sound';
const DEFAULT_INTRO_DURATION_SECONDS = 25;
const defaultSound = { muted: false, volume: 0.45 };
type CompletedRoundAcknowledgement = { roundId: string; profileId: string; outcome?: 'failed' };
const readCompletedRoundAcknowledgement = (actorScope: string): CompletedRoundAcknowledgement | null => {
  try {
    const value = JSON.parse(localStorage.getItem(completedRoundStorageFor(actorScope)) || 'null') as CompletedRoundAcknowledgement | null;
    return value && typeof value.roundId === 'string' && typeof value.profileId === 'string' ? value : null;
  } catch { return null; }
};
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
const getEndingCardPhase = (currentTime: number, manifest: MediaManifest, duration: number): 'black' | 'title-in' | 'title' | 'title-fade' | 'logo-black' | 'logo-in' | 'logo' | 'logo-fade' | 'final-black' | null => {
  if (currentTime >= duration) return 'final-black';
  const filmEnd = manifest.successFilmDurationSeconds || 29.166667;
  const titleFadeInStart = manifest.successTitleFadeInStartSeconds || filmEnd + 0.641083;
  const titleFadeInEnd = manifest.successTitleFadeInEndSeconds || titleFadeInStart + 0.3;
  const titleFadeStart = manifest.successTitleFadeStartSeconds || filmEnd + 4.241083;
  const titleFadeEnd = manifest.successTitleFadeEndSeconds || titleFadeStart + 0.75;
  const logoStart = manifest.successLogoStartSeconds || titleFadeEnd + 0.77;
  const logoFadeInEnd = manifest.successLogoFadeInEndSeconds || logoStart + 0.35;
  const logoFadeStart = manifest.successLogoFadeStartSeconds || duration - 3.25;
  const logoFadeEnd = manifest.successLogoFadeEndSeconds || duration - 0.25;
  if (currentTime >= logoFadeEnd) return 'final-black';
  if (currentTime >= logoFadeStart) return 'logo-fade';
  if (currentTime >= logoFadeInEnd) return 'logo';
  if (currentTime >= logoStart) return 'logo-in';
  if (currentTime >= titleFadeEnd) return 'logo-black';
  if (currentTime >= titleFadeStart) return 'title-fade';
  if (currentTime >= titleFadeInEnd) return 'title';
  if (currentTime >= titleFadeInStart) return 'title-in';
  if (currentTime >= filmEnd) return 'black';
  return null;
};

export function InceptionLevel({ directEntry = false }: { directEntry?: boolean } = {}) {
  const [config, setConfig] = useState<Configuration | null>(null);
  const actorScopeRef = useRef<string | null>(null);
  const [manifest, setManifest] = useState<MediaManifest>({});
  const [session, setSession] = useState<Session | null>(null);
  const [selectedProfile, setSelectedProfile] = useState('story');
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
  const [sendPhase, setSendPhase] = useState<SendPhase>('idle');
  const [failureNeedsNewAttempt, setFailureNeedsNewAttempt] = useState(false);
  const [activeModal, setActiveModal] = useState<'safe' | 'room' | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [successEnding, setSuccessEnding] = useState<'playing' | 'blocked' | 'error' | null>(null);
  const [endingCardPhase, setEndingCardPhase] = useState<'black' | 'title-in' | 'title' | 'title-fade' | 'logo-black' | 'logo-in' | 'logo' | 'logo-fade' | 'final-black' | null>(null);
  const [successEndingAttempt, setSuccessEndingAttempt] = useState(0);
  const [entryTransition, setEntryTransition] = useState(false);
  const [entryVisible, setEntryVisible] = useState(true);
  const [entryReturning, setEntryReturning] = useState(false);
  const [cinematicCover, setCinematicCover] = useState<null | 'entry-black' | 'entry-reveal' | 'return-black' | 'return-reveal' | 'ending-skip'>(null);
  const [entryPrompt, setEntryPrompt] = useState<'begin' | 'continue'>(directEntry ? 'continue' : 'begin');
  const [successEndingError, setSuccessEndingError] = useState('');
  const [introCaptionText, setIntroCaptionText] = useState('');
  const [introCaptionLayout, setIntroCaptionLayout] = useState<CSSProperties | null>(null);
  const [successCaptionText, setSuccessCaptionText] = useState('');
  const [successCaptionLayout, setSuccessCaptionLayout] = useState<CSSProperties | null>(null);
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
  const composerFocusIntent = useRef<{ roundId: string; generation: number; roundToken: number; focusAtSend: Element | null; sentFromComposer: boolean } | null>(null);
  const checkingComposerHeight = useRef<number | null>(null);
  const checkingTextareaHeight = useRef<number | null>(null);
  const introVideoRef = useRef<HTMLVideoElement | null>(null);
  const successVideoRef = useRef<HTMLVideoElement | null>(null);
  const introCaptionTrackRef = useRef<HTMLTrackElement | null>(null);
  const successCaptionTrackRef = useRef<HTMLTrackElement | null>(null);
  const successTitleRef = useRef<HTMLHeadingElement | null>(null);
  const cinematicTimerRef = useRef<number | null>(null);
  const entryTransitionTimerRef = useRef<number | null>(null);
  const entryTransitionGenerationRef = useRef(0);
  const endingGenerationRef = useRef(0);
  const endingMediaDisposalRef = useRef(false);
  const endingFinalizationRef = useRef(false);
  const endingSkipAnimationRef = useRef<number | null>(null);
  const entryPosterRef = useRef<HTMLButtonElement | null>(null);
  const leaveRef = useRef<(archiveToMenu?: boolean) => Promise<void>>(async () => undefined);
  const leaveLockRef = useRef(false);
  const entryTransitionLockRef = useRef(false);
  const autoEndedRoundRef = useRef<string | null>(null);
  const endingWasShownRef = useRef(false);
  const introProgressRef = useRef({ at: Date.now(), time: 0 });
  const audioRef = useRef<InceptionAudio | null>(null);
  const sendOperation = useRef<object | null>(null);
  const actionOperation = useRef<object | null>(null);
  const startOperation = useRef<object | null>(null);
  const reviewOperation = useRef<object | null>(null);
  const introStartRequested = useRef(false);
  const audioDisposeRef = useRef<Promise<void> | null>(null);
  const composing = useRef(false);
  const ambientPath = manifest.gameplayLoop || manifest.roomTone || null;
  const hasAmbient = Boolean(ambientPath);
  const introDurationSeconds = Number.isFinite(manifest.introDurationSeconds) && (manifest.introDurationSeconds || 0) > 0 ? manifest.introDurationSeconds as number : DEFAULT_INTRO_DURATION_SECONDS;
  const remaining = session ? Math.max(0, Math.ceil((session.round.deadline - roundClock) / 1000)) : 300;
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
    const intent = composerFocusIntent.current;
    if (!intent) return;
    if (intent.generation !== lifecycle.current || intent.roundToken !== roundGeneration.current || session?.round.id !== intent.roundId) {
      composerFocusIntent.current = null;
      return;
    }
    if (closed || activeModal || cinematicPhase || successEnding || entryTransition || entryVisible || !handoffInteractive) {
      composerFocusIntent.current = null;
      return;
    }
    const input = inputRef.current;
    if (busy || pendingSend || !input?.isConnected || input.disabled) return;
    const active = document.activeElement;
    if (active === intent.focusAtSend || (active === document.body && intent.sentFromComposer)) input.focus();
    composerFocusIntent.current = null;
  }, [session?.round.id, session?.round.endedAt, busy, pendingSend, closed, activeModal, cinematicPhase, successEnding, entryTransition, entryVisible, handoffInteractive]);

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
  const startAmbient = useCallback((forceUnmuted?: boolean, replayGesture = false) => {
    if (!hasAmbient || (closed && !replayGesture)) return;
    audioRef.current ||= new InceptionAudio();
    const instance = audioRef.current, generation = lifecycle.current;
    instance.setVolume(sound.volume);
    const muted = forceUnmuted === undefined ? sound.muted : forceUnmuted;
    if (instance.isMuted !== muted) instance.setMuted(muted);
    if (muted) setSoundReady(false);
    else if (instance.isPlaying) setSoundReady(true);
    else void instance.start({ gameplayLoop: manifest.gameplayLoop, creditsCue: manifest.creditsCue, roomTone: manifest.roomTone }).then(playing => { if (lifecycle.current !== generation || audioRef.current !== instance) return; setSoundReady(playing); });
  }, [hasAmbient, closed, sound.muted, sound.volume, manifest.gameplayLoop, manifest.creditsCue, manifest.roomTone]);
  const install = useCallback((value: Session) => {
    composerFocusIntent.current = null;
    roundGeneration.current++;
    sendOperation.current = null;
    actionOperation.current = null; startOperation.current = null; reviewOperation.current = null;
    endingGenerationRef.current++;
    checkingComposerHeight.current = null;
    checkingTextareaHeight.current = null;
    if (installedRoundId.current !== value.round.id) { followConversationRef.current = true; installedRoundId.current = value.round.id; }
    if (cinematicTimerRef.current !== null) window.clearTimeout(cinematicTimerRef.current);
    setCinematicPhase(null); setEndingCardPhase(null); setRevealedDigits(''); setImmersive(true); setEntryVisible(false); setSession(value); setRoundClock(Date.now()); setReview(value.state.review?.status === 'complete' ? value.state.review as Review : null); setSuccessEnding(null);
    setBusy(false); setSendPhase('idle'); setFailureNeedsNewAttempt(hasPersistedProviderFailure(value.round.id));
    setMetricsPhase('read_think', value.round.id, value.round.accessToken);
    setError(''); setActiveModal(null); setSendStatus(''); setSendPhase('idle');
    setRetryCooldownUntil(readSendCooldown(value.round.id));
    const stored = sessionStorage.getItem(`workshop-inception-send:${value.round.id}`);
    if (stored) { try { const parsed = JSON.parse(stored) as PendingSend; setPendingSend(parsed); setMessageText(parsed.content); } catch { sessionStorage.removeItem(`workshop-inception-send:${value.round.id}`); setPendingSend(null); } }
    else {
      setPendingSend(null);
      const actorScope = actorScopeRef.current;
      const nextDraftKey = actorScope ? nextAttemptDraftStorageFor(actorScope) : null;
      let nextDraft: string | null = null;
      if (nextDraftKey) {
        try {
          const saved = JSON.parse(sessionStorage.getItem(nextDraftKey) || 'null') as { actorScope?: string; draft?: unknown; savedAt?: number } | null;
          if (saved?.actorScope === actorScope && typeof saved.draft === 'string' && saved.draft.length <= 4000 && Number.isFinite(saved.savedAt) && saved.savedAt! <= Date.now() && saved.savedAt! >= Date.now() - 24 * 60 * 60 * 1000) nextDraft = saved.draft;
          else sessionStorage.removeItem(nextDraftKey);
        } catch { sessionStorage.removeItem(nextDraftKey); }
      }
      const savedDraft = sessionStorage.getItem(sendDraftStorageFor(value.round.id));
      setMessageText(nextDraft ?? savedDraft ?? '');
      if (nextDraft !== null) { sessionStorage.setItem(sendDraftStorageFor(value.round.id), nextDraft); if (nextDraftKey) sessionStorage.removeItem(nextDraftKey); }
    }
    sessionStorage.setItem(sessionStorageKey, JSON.stringify({ id: value.round.id }));
    if (value.round.endedAt) setReview(value.state.review?.status === 'complete' ? value.state.review as Review : null);
  }, []);

  const playConfirmedEnding = useCallback((roundId: string, result: Review | null, state: InceptionState) => {
    if (entryVisible || !manifest.successVideo || result?.status !== 'complete' || result.verdict !== 'recovered' || !state.safeOpened || !state.revealedCombination || autoEndedRoundRef.current === roundId) return;
    const generation = lifecycle.current, roundToken = roundGeneration.current;
    endingGenerationRef.current++;
    endingFinalizationRef.current = false;
    autoEndedRoundRef.current = roundId;
    setActiveModal(null);
    endingWasShownRef.current = true;
    setSuccessEndingError(''); setSuccessEndingAttempt(value => value + 1); setEndingCardPhase(null); setSuccessEnding(null);
    setCinematicPhase('entry'); setRevealedDigits(reducedMotion ? state.revealedCombination : '');
    const startFilm = async () => {
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
  }, [entryVisible, manifest.successVideo, manifest.successDurationSeconds, reducedMotion]);

  const replayConfirmedEnding = async () => {
    if (!session || !manifest.successVideo || review?.status !== 'complete' || review.verdict !== 'recovered' || !session.state.safeOpened) return;
    const generation = lifecycle.current, roundToken = roundGeneration.current;
    endingGenerationRef.current++;
    endingFinalizationRef.current = false;
    await audioRef.current?.fadeForFilm();
    if (generation !== lifecycle.current || roundToken !== roundGeneration.current) return;
    setActiveModal(null);
    endingWasShownRef.current = true;
    setSuccessEndingError(''); setEndingCardPhase(null); setSuccessEndingAttempt(value => value + 1); setCinematicPhase('film'); setSuccessEnding('playing');
  };

  useEffect(() => {
    if (successEnding !== 'playing') return;
    const video = successVideoRef.current;
    if (!video) return;
    endingMediaDisposalRef.current = false;
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
    let frame = 0, active = true;
    const sync = () => {
      if (!active || endingFinalizationRef.current) return;
      if (video.ended) { setEndingCardPhase(current => current === 'final-black' ? current : 'final-black'); return; }
      const duration = manifest.successDurationSeconds || video.duration || 52;
      const next = getEndingCardPhase(video.currentTime, manifest, duration);
      setEndingCardPhase(current => current === next ? current : next);
      frame = window.requestAnimationFrame(sync);
    };
    const onTimeUpdate = () => {
      if (endingFinalizationRef.current) return;
      const duration = manifest.successDurationSeconds || video.duration || 52;
      const next = getEndingCardPhase(video.currentTime, manifest, duration);
      setEndingCardPhase(current => current === next ? current : next);
    };
    video.addEventListener('timeupdate', onTimeUpdate);
    video.addEventListener('seeked', onTimeUpdate);
    sync();
    return () => { active = false; window.cancelAnimationFrame(frame); video.removeEventListener('timeupdate', onTimeUpdate); video.removeEventListener('seeked', onTimeUpdate); };
  }, [successEnding, successEndingAttempt, manifest.successDurationSeconds, manifest.successFilmDurationSeconds, manifest.successTitleFadeInStartSeconds, manifest.successTitleFadeInEndSeconds, manifest.successTitleFadeStartSeconds, manifest.successTitleFadeEndSeconds, manifest.successLogoStartSeconds, manifest.successLogoFadeInEndSeconds, manifest.successLogoFadeStartSeconds, manifest.successLogoFadeEndSeconds]);

  useEffect(() => {
    if (successEnding !== 'playing') return;
    const video = successVideoRef.current;
    if (!video) return;
    let active = true, lastTime = video.currentTime, lastProgress = Date.now();
    const timer = window.setInterval(() => {
      if (video.currentTime > lastTime + 0.05) { lastTime = video.currentTime; lastProgress = Date.now(); }
      else if (!endingFinalizationRef.current && Date.now() - lastProgress > 9000) {
        if (active) { setSuccessEndingError('The ending video stopped playing. Your saved result remains available.'); setSuccessEnding('error'); }
      }
    }, 1000);
    return () => { active = false; window.clearInterval(timer); };
  }, [successEnding, successEndingAttempt]);

  useEffect(() => {
    for (const source of [manifest.endingLogo, manifest.entryPoster, manifest.entryWordmark]) {
      if (!source) continue;
      const image = new Image();
      image.src = source;
      void image.decode().catch(() => undefined);
    }
  }, [manifest.endingLogo, manifest.entryPoster, manifest.entryWordmark]);

  useEffect(() => () => {
    entryTransitionGenerationRef.current++;
    if (cinematicTimerRef.current !== null) window.clearTimeout(cinematicTimerRef.current);
    if (entryTransitionTimerRef.current !== null) window.clearTimeout(entryTransitionTimerRef.current);
    if (endingSkipAnimationRef.current !== null) window.cancelAnimationFrame(endingSkipAnimationRef.current);
    endingSkipAnimationRef.current = null;
  }, []);

  useEffect(() => {
    const video = successVideoRef.current;
    if (!video) return;
    if (successEnding === 'playing') {
      video.volume = sound.volume;
      video.muted = sound.muted;
    } else {
      video.volume = 0;
      video.muted = true;
    }
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
  useEffect(() => {
    if (!entryVisible || entryTransition || entryReturning || cinematicCover || successEnding) return;
    const frame = window.requestAnimationFrame(() => {
      if (!cinematicCover && !entryTransitionLockRef.current) entryPosterRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [entryVisible, entryTransition, entryReturning, cinematicCover, successEnding]);

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

  const preferredNewProfile = () => config
    ? resolveNewInceptionProfileId(new URLSearchParams(window.location.search).get('profile'), config.defaultProfileId, config.profiles)
    : 'story';

  const fetchSession = useCallback(async (id: string, acknowledgement?: CompletedRoundAcknowledgement | null, parkAtEntry = false) => {
    const generation = lifecycle.current, previousRoundToken = roundGeneration.current;
    const value = await api<Session>(`/inception/rounds/${id}`, { timeoutMs: 5000 });
    if (lifecycle.current !== generation || roundGeneration.current !== previousRoundToken) return;
    if (acknowledgement?.roundId === value.round.id && value.round.endedAt) {
      if (JSON.parse(sessionStorage.getItem(sessionStorageKey) || 'null')?.id === value.round.id) sessionStorage.removeItem(sessionStorageKey);
      sessionStorage.removeItem(`workshop-inception-send:${value.round.id}`);
      return;
    }
    install(value);
    if (parkAtEntry) {
      setEntryVisible(true);
      if (!value.round.endedAt) {
        setEntryPrompt('continue');
        setSelectedProfile(value.profile.profileRevision === 1 ? 'standard' : value.profile.profileId || 'standard');
      }
    }
    const roundToken = roundGeneration.current;
    if (value.round.endedAt) {
      const result = await api<{ review: Review | null; state: InceptionState }>(`/inception/rounds/${id}/review`, { timeoutMs: 5000 }).catch(() => null);
      if (result?.review && lifecycle.current === generation && roundGeneration.current === roundToken) setReview(result.review);
    }
  }, [install]);

  const recordingAuthorized = config?.recordingAuthorized ?? (config?.recordingNoticeRequired !== true || Boolean(config?.recordingAccepted));
  const startRound = useCallback(async (profileId: string, existing?: { clientStartId: string }, startAudio = true, storageKey = config ? startStorageFor(config.actorScope) : startStorage, alreadyAcknowledged = recordingAuthorized) => {
    if (startOperation.current) return;
    if (!recordingAuthorized && !alreadyAcknowledged && !consented) return;
    const operation = {};
    startOperation.current = operation;
    setBusy(true); setEntryVisible(false); setError(''); setSendStatus('');
    const generation = lifecycle.current;
    const receipt = existing || { clientStartId: crypto.randomUUID() };
    const intent = { profileId, ...receipt, ...(config?.entryPolicy ? {} : { consent: true as const }) };
    if (startAudio) startAmbient();
    setPendingStart(intent); localStorage.setItem(storageKey, JSON.stringify(intent));
    try {
      if (!alreadyAcknowledged && !config?.entryPolicy) {
        await api('/recording/acknowledge', { method: 'POST', body: { version: RECORDING_NOTICE_VERSION, accepted: true }, timeoutMs: 10_000 });
        if (lifecycle.current !== generation) return;
        setRecordingAcknowledged(true);
      }
      const value = await api<Session>('/inception/start', { method: 'POST', body: intent, timeoutMs: 30_000 });
      if (lifecycle.current !== generation) return;
      localStorage.removeItem(storageKey); sessionStorage.removeItem('workshop-inception-intro-at'); setPendingStart(null); if (!config?.entryPolicy) { setRecordingAcknowledged(true); setConfig(current => current ? { ...current, recordingAccepted: true, recordingAuthorized: true } : current); } setCinematicHandoff(intro && !reducedMotion); setHandoffInteractive(!intro || reducedMotion); install(value); setIntro(false); setFilmEnded(false);
    } catch (cause) {
      if (lifecycle.current !== generation) return;
      if (cause instanceof ApiError && cause.status >= 400 && cause.status < 500 && !cause.receiptConfirmed) {
        localStorage.removeItem(storageKey); setPendingStart(null);
        if (intro) { setIntro(false); setFilmEnded(false); setEntryVisible(true); }
      }
      setError((cause as Error).message || 'The start receipt could not be confirmed.');
    } finally { if (startOperation.current === operation) { startOperation.current = null; if (lifecycle.current === generation) setBusy(false); } }
  }, [config, consented, install, startAmbient, intro, filmEnded, reducedMotion, recordingAuthorized]);

  useEffect(() => {
    let active = true;
    void Promise.all([api<Configuration>('/inception', { timeoutMs: 10_000 }), fetch('/inception-assets/manifest.json', { cache: 'no-store', signal: AbortSignal.timeout(10_000) }).then(response => response.ok ? response.json() as Promise<MediaManifest> : {})]).then(async ([nextConfig, nextManifest]) => {
      if (!active) return;
      actorScopeRef.current = nextConfig.actorScope;
      setConfig(nextConfig); setManifest(nextManifest); setConsented(Boolean(nextConfig.recordingAuthorized));
      if (directEntry) { setRecordingAcknowledged(false); setInceptionRecordingAuthorization(nextConfig.recordingAuthorized === true); }
      else { setInceptionRecordingAuthorization(false); setRecordingAcknowledged(Boolean(nextConfig.recordingAccepted)); }
      const linkedProfile = new URLSearchParams(window.location.search).get('profile');
      const preferredNewProfile = resolveNewInceptionProfileId(linkedProfile, nextConfig.defaultProfileId, nextConfig.profiles);
      setSelectedProfile(preferredNewProfile);
      const intentKey = startStorageFor(nextConfig.actorScope), intentText = localStorage.getItem(intentKey);
      const completedAcknowledgement = readCompletedRoundAcknowledgement(nextConfig.actorScope);
      if (completedAcknowledgement?.outcome === 'failed') setEntryPrompt('continue');
      if (intentText) {
        try { const intent = JSON.parse(intentText) as { profileId: string; clientStartId: string }; setSelectedProfile(intent.profileId); setPendingStart(intent); setEntryPrompt('continue'); }
        catch { if (active) setError('The saved start receipt could not be checked. Retry with the same start key.'); }
      } else {
        const receipt = sessionStorage.getItem(sessionStorageKey);
        if (receipt) { try { const saved = JSON.parse(receipt) as { id: string }; await fetchSession(saved.id, completedAcknowledgement, true); } catch { sessionStorage.removeItem(sessionStorageKey); } }
        if (!sessionStorage.getItem(sessionStorageKey) && nextConfig.activeRoundId) await fetchSession(nextConfig.activeRoundId, completedAcknowledgement, true).catch(() => undefined);
        if (!sessionStorage.getItem(sessionStorageKey)) {
          const latest = await api<Session | null>('/inception/latest', { timeoutMs: 5_000 }).catch(() => null);
          if (latest && active) {
            if (completedAcknowledgement?.roundId === latest.round.id && latest.round.endedAt) {
              sessionStorage.removeItem(sessionStorageKey);
              sessionStorage.removeItem(`workshop-inception-send:${latest.round.id}`);
            } else { install(latest); setEntryVisible(true); if (!latest.round.endedAt) setEntryPrompt('continue'); }
          }
        }
      }
    }).catch(cause => { if (active) setError((cause as Error).message); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [directEntry]);

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
    if (!session?.round.endedAt || review?.status !== 'pending' || entryVisible) return;
    const roundId = session.round.id, generation = lifecycle.current, roundToken = roundGeneration.current;
    let active = true, attempts = 0, timer = 0;
    const poll = async () => {
      if (!active) return;
      attempts++;
      try {
        const result = await api<{ review: Review | null; state: InceptionState }>(`/inception/rounds/${roundId}/review`, { timeoutMs: 5_000 });
        if (!active || lifecycle.current !== generation || roundGeneration.current !== roundToken) return;
        if (result.review && result.review.status !== 'pending') {
          setReview(result.review);
          setSession(current => current?.round.id === roundId ? { ...current, state: result.state } : current);
          if (!entryVisible) void playConfirmedEnding(roundId, result.review, result.state);
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
  }, [session?.round.id, session?.round.endedAt, review?.status, entryVisible, playConfirmedEnding]);

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
  useEffect(() => { lifecycle.current++; return () => { lifecycle.current++; composerFocusIntent.current = null; const instance = audioRef.current; audioRef.current = null; if (instance) void instance.dispose(); }; }, []);
  useEffect(() => { localStorage.setItem(soundStorage, JSON.stringify(sound)); audioRef.current?.setVolume(sound.volume); if (audioRef.current?.isMuted !== sound.muted) audioRef.current?.setMuted(sound.muted); }, [sound]);
  useEffect(() => {
    if (expired) { void disposeAmbient(); return; }
    if (!session?.round.endedAt || !review || review.status === 'pending') return;
    const confirmedEnding = review.status === 'complete' && review.verdict === 'recovered' && session.state.safeOpened && Boolean(session.state.revealedCombination);
    if (!confirmedEnding) void disposeAmbient();
  }, [session?.round.endedAt, session?.state.safeOpened, session?.state.revealedCombination, review?.status, review?.verdict, expired, disposeAmbient]);
  useEffect(() => {
    if (!retryCooldownUntil) { setRetrySeconds(0); return; }
    const tick = () => {
      const seconds = Math.max(0, Math.ceil((retryCooldownUntil - Date.now()) / 1000));
      setRetrySeconds(seconds);
      if (!seconds) {
        if (session) sessionStorage.removeItem(sendCooldownStorageFor(session.round.id));
        setRetryCooldownUntil(0);
      }
    };
    const onVisible = () => { if (document.visibilityState === 'visible') tick(); };
    tick(); window.addEventListener('focus', tick); document.addEventListener('visibilitychange', onVisible);
    const timer = window.setInterval(tick, 1000);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', tick); document.removeEventListener('visibilitychange', onVisible); };
  }, [retryCooldownUntil, session?.round.id]);
  const enterFullscreen = async () => {
    setImmersive(true);
    try { if (!document.fullscreenElement) await document.documentElement.requestFullscreen(); setFullscreen(Boolean(document.fullscreenElement)); }
    catch { setFullscreen(false); setImmersive(true); }
  };
  const leave = async (archiveToMenu = false) => {
    if (leaveLockRef.current) return;
    leaveLockRef.current = true;
    const wasCompleted = archiveToMenu || Boolean(session?.round.endedAt && review?.status === 'complete');
    const confirmedFailure = Boolean(wasCompleted && (review?.verdict === 'not_recovered' || review?.verdict === 'partial'));
    const sessionProfileId = session ? (session.profile.profileRevision === 1 ? 'standard' : session.profile.profileId || selectedProfile) : null;
    if (wasCompleted && session && config) {
      const profileId = sessionProfileId || selectedProfile;
      localStorage.setItem(completedRoundStorageFor(config.actorScope), JSON.stringify({ roundId: session.round.id, profileId, ...(confirmedFailure ? { outcome: 'failed' as const } : {}) } satisfies CompletedRoundAcknowledgement));
      sessionStorage.removeItem(sessionStorageKey);
      sessionStorage.removeItem(`workshop-inception-send:${session.round.id}`);
    }
    lifecycle.current++; endingGenerationRef.current++; endingFinalizationRef.current = true;
    composerFocusIntent.current = null;
    sendOperation.current = null; actionOperation.current = null; startOperation.current = null; reviewOperation.current = null;
    if (endingSkipAnimationRef.current !== null) window.cancelAnimationFrame(endingSkipAnimationRef.current);
    endingSkipAnimationRef.current = null;
    const returnGeneration = ++entryTransitionGenerationRef.current;
    setCinematicCover('return-black');
    setEntryVisible(false);
    entryTransitionLockRef.current = true;
    if (cinematicTimerRef.current !== null) { window.clearTimeout(cinematicTimerRef.current); cinematicTimerRef.current = null; }
    if (entryTransitionTimerRef.current !== null) { window.clearTimeout(entryTransitionTimerRef.current); entryTransitionTimerRef.current = null; }
    successVideoRef.current?.pause();
    introVideoRef.current?.pause();
    await disposeAmbient();
    if (document.fullscreenElement) await document.exitFullscreen().catch(() => undefined);
    if (manifest.entryPoster) {
      const poster = new Image();
      poster.src = manifest.entryPoster;
      await poster.decode().catch(() => undefined);
    }
    setBusy(false);
    setImmersive(false); setEntryTransition(false); setEntryReturning(false); setEntryPrompt(archiveToMenu ? 'begin' : directEntry || confirmedFailure || Boolean(pendingStart) || Boolean(session && !session.round.endedAt) ? 'continue' : 'begin'); setSelectedProfile(session && !wasCompleted ? sessionProfileId || preferredNewProfile() : pendingStart?.profileId || preferredNewProfile()); setIntro(false); setFilmEnded(false); setCinematicPhase(null); setEndingCardPhase(null); setSuccessEnding(null); setActiveModal(null);
    if (wasCompleted) { setSession(null); setReview(null); setMessageText(''); setPendingSend(null); setSendStatus(''); }
    else if (session?.round.id) setEntryPrompt('continue');
    setEntryVisible(true);
    const waitFrame = () => new Promise<void>(resolve => window.requestAnimationFrame(() => resolve()));
    await waitFrame(); await waitFrame();
    if (entryTransitionGenerationRef.current !== returnGeneration) { leaveLockRef.current = false; return; }
    setCinematicCover('return-reveal');
    entryTransitionTimerRef.current = window.setTimeout(() => {
      if (entryTransitionGenerationRef.current !== returnGeneration) return;
      setCinematicCover(null); entryTransitionTimerRef.current = null; entryTransitionLockRef.current = false; leaveLockRef.current = false;
    }, reducedMotion ? 80 : 750);
  };
  leaveRef.current = leave;
  useEffect(() => {
    const onEscape = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === 'm' && !event.repeat && !(event.target instanceof HTMLElement && /INPUT|TEXTAREA|SELECT/.test(event.target.tagName))) { setSound((current: typeof defaultSound) => ({ ...current, muted: !current.muted })); return; }
      if (event.key !== 'Escape') return;
      if (entryTransition || cinematicCover === 'entry-black' || cinematicCover === 'entry-reveal') { event.preventDefault(); void leaveRef.current(); return; }
      if (activeModal) { setActiveModal(null); return; }
      if (intro) { event.preventDefault(); void leaveRef.current(); return; }
      if (cinematicPhase === 'entry') return;
      if (cinematicPhase === 'film' || cinematicPhase === 'closing') { event.preventDefault(); void leaveRef.current(); return; }
      if (session) { event.preventDefault(); void leaveRef.current(); }
    };
    window.addEventListener('keydown', onEscape);
    return () => window.removeEventListener('keydown', onEscape);
  }, [activeModal, intro, pendingStart, session?.round.id, cinematicPhase, entryTransition, cinematicCover]);
  const beginIntro = (forceNew = false) => {
    if (!config || busy || entryTransitionLockRef.current || (config.recordingNoticeRequired === true && !config.recordingAccepted && !consented)) return;
    entryTransitionLockRef.current = true;
    const transitionGeneration = ++entryTransitionGenerationRef.current;
    const schedule = (delay: number, callback: () => void) => {
      if (entryTransitionTimerRef.current !== null) window.clearTimeout(entryTransitionTimerRef.current);
      entryTransitionTimerRef.current = window.setTimeout(() => {
        entryTransitionTimerRef.current = null;
        if (entryTransitionGenerationRef.current === transitionGeneration) callback();
      }, delay);
    };
    const startAfterBlack = () => {
      if (session && !forceNew) {
        setImmersive(true); setError('');
        if (!session.round.endedAt) startAmbient();
      } else if (!manifest.introVideo) {
        setError('');
        void startRound(pendingStart?.profileId || preferredNewProfile(), pendingStart ? { clientStartId: pendingStart.clientStartId } : undefined);
      } else {
        setError(''); setIntroMediaIssue(''); introProgressRef.current = { at: Date.now(), time: 0 }; introStartRequested.current = false;
        sessionStorage.setItem('workshop-inception-intro-at', String(Date.now()));
        setIntroTimeLeft(introDurationSeconds); setFilmEnded(false); setIntroMediaAttempt(0); setIntro(true);
        startAmbient();
      }
      setCinematicCover('entry-reveal');
      schedule(reducedMotion ? 100 : 1000, () => { setCinematicCover(null); entryTransitionLockRef.current = false; });
    };
    setError(''); setCinematicCover('entry-black'); setEntryTransition(true); void enterFullscreen();
    schedule(reducedMotion ? 150 : 600, () => {
      setEntryVisible(false); setEntryTransition(false);
      schedule(reducedMotion ? 350 : 900, startAfterBlack);
    });
  };
  const finishIntro = (skip = false) => {
    if (!intro || busy || introStartRequested.current) return;
    if (skip) {
      introStartRequested.current = true;
      introVideoRef.current?.pause();
      setFilmEnded(true);
      void startRound(pendingStart?.profileId || preferredNewProfile(), pendingStart ? { clientStartId: pendingStart.clientStartId } : undefined);
    }
  };

  const finishSuccessCoda = useCallback(async (video: HTMLVideoElement, isCurrentEnding: () => boolean) => {
    if (!isCurrentEnding()) return;
    const returnGeneration = ++entryTransitionGenerationRef.current;
    setCinematicCover('return-black');
    await disposeAmbient();
    if (!isCurrentEnding()) return;
    video.pause();
    endingMediaDisposalRef.current = true;
    video.removeAttribute('src');
    video.querySelectorAll('source').forEach(source => source.removeAttribute('src'));
    video.load();
    const completedRoundId = session?.round.id;
    if (completedRoundId && config) {
      const profileId = session.profile.profileRevision === 1 ? 'standard' : session.profile.profileId || preferredNewProfile();
      localStorage.setItem(completedRoundStorageFor(config.actorScope), JSON.stringify({ roundId: completedRoundId, profileId } satisfies CompletedRoundAcknowledgement));
      sessionStorage.removeItem(sessionStorageKey);
      sessionStorage.removeItem(`workshop-inception-send:${completedRoundId}`);
    }
    sessionStorage.removeItem('workshop-inception-intro-at');
    endingWasShownRef.current = false;
    setSelectedProfile(preferredNewProfile());
    setEntryPrompt(directEntry ? 'continue' : 'begin'); setEntryReturning(false);
    setActiveModal(null); setIntro(false); setFilmEnded(false); setCinematicHandoff(false); setHandoffInteractive(true); setCinematicPhase(null); setEndingCardPhase(null);
    if (document.fullscreenElement) await document.exitFullscreen().catch(() => undefined);
    if (!isCurrentEnding()) return;
    const poster = new Image();
    poster.src = manifest.entryPoster || '';
    await poster.decode().catch(() => undefined);
    if (!isCurrentEnding()) return;
    setImmersive(false); setEntryTransition(false); setEntryVisible(true); setSession(null); setReview(null); setMessageText(''); setPendingSend(null); setSendStatus(''); setError(''); setSuccessEnding(null);
    const waitFrame = () => new Promise<void>(resolve => window.requestAnimationFrame(() => resolve()));
    await waitFrame(); await waitFrame();
    if (!isCurrentEnding() || entryTransitionGenerationRef.current !== returnGeneration) return;
    setCinematicCover('return-reveal');
    const returnTimer = window.setTimeout(() => {
      if (isCurrentEnding() && entryTransitionGenerationRef.current === returnGeneration) { setCinematicCover(null); cinematicTimerRef.current = null; }
    }, reducedMotion ? 80 : (manifest.successReturnFadeSeconds || 0.75) * 1000);
    cinematicTimerRef.current = returnTimer;
  }, [config, directEntry, disposeAmbient, manifest.entryPoster, manifest.successReturnFadeSeconds, selectedProfile, session, reducedMotion]);

  const finalizeSuccessEnding = useCallback((skip = false) => {
    const video = successVideoRef.current;
    if (!video || successEnding !== 'playing' || endingFinalizationRef.current) return;
    endingFinalizationRef.current = true;
    const lifecycleToken = lifecycle.current, roundToken = roundGeneration.current, endingToken = endingGenerationRef.current;
    const isCurrentEnding = () => lifecycle.current === lifecycleToken && roundGeneration.current === roundToken && endingGenerationRef.current === endingToken;
    if (!isCurrentEnding()) return;

    if (!skip) {
      setEndingCardPhase('final-black');
      const blackHoldTimer = window.setTimeout(() => {
        if (cinematicTimerRef.current === blackHoldTimer) cinematicTimerRef.current = null;
        if (isCurrentEnding()) void finishSuccessCoda(video, isCurrentEnding);
      }, reducedMotion ? 80 : (manifest.successFinalBlackDurationSeconds || 0.25) * 1000);
      cinematicTimerRef.current = blackHoldTimer;
      return;
    }

    setCinematicCover('ending-skip');
    const duration = reducedMotion ? 80 : 150;
    const startingVolume = video.volume;
    let startedAt: number | null = null;
    const fade = (timestamp: number) => {
      if (!isCurrentEnding()) { endingSkipAnimationRef.current = null; return; }
      if (startedAt === null) startedAt = timestamp;
      const progress = Math.min(1, (timestamp - startedAt) / duration);
      video.volume = startingVolume * (1 - progress);
      if (progress < 1) endingSkipAnimationRef.current = window.requestAnimationFrame(fade);
      else {
        endingSkipAnimationRef.current = null;
        video.volume = 0;
        setEndingCardPhase('final-black');
        void finishSuccessCoda(video, isCurrentEnding);
      }
    };
    endingSkipAnimationRef.current = window.requestAnimationFrame(fade);
  }, [finishSuccessCoda, manifest.successFinalBlackDurationSeconds, reducedMotion, successEnding]);

  useEffect(() => { if (intro && introTimeLeft <= 0 && (!manifest.introVideo || filmEnded) && !introStartRequested.current) { introStartRequested.current = true; void startRound(pendingStart?.profileId || preferredNewProfile(), pendingStart ? { clientStartId: pendingStart.clientStartId } : undefined); } }, [introTimeLeft, intro, filmEnded, selectedProfile, pendingStart, startRound, manifest.introVideo]);

  const inspect = async (type: 'inspect_safe' | 'inspect_room' | 'present_safe') => {
    if (!session || busy || actionOperation.current || closed || session.state.safeOpened) return;
    const generation = lifecycle.current, roundToken = roundGeneration.current, roundId = session.round.id;
    recordMetricsInteraction('inspect', roundId, session.round.accessToken);
    const operation = {};
    actionOperation.current = operation; setBusy(true); setError('');
    const action = { actionId: crypto.randomUUID(), revision: session.state.revision, type };
    try {
      const result = await api<{ state: InceptionState }>(`/inception/rounds/${session.round.id}/action`, { method: 'POST', body: action, timeoutMs: 15_000 });
      if (lifecycle.current !== generation || roundGeneration.current !== roundToken) return;
      setSession(current => current?.round.id === roundId ? { ...current, state: result.state } : current);
    } catch (cause) { if (lifecycle.current === generation && roundGeneration.current === roundToken) { setError((cause as Error).message); if ((cause as ApiError).status === 409) await fetchSession(roundId).catch(() => undefined); } }
    finally { if (actionOperation.current === operation) { actionOperation.current = null; if (lifecycle.current === generation && roundGeneration.current === roundToken) setBusy(false); } }
  };

  const send = async (retry = false) => {
    if (!session || sendOperation.current || (!retry && closed) || busy) return;
    if (!retry && Date.now() < retryCooldownUntil) return;
    const existing = pendingSend;
    if (retry && !existing) return;
    if (retry && !existing?.id) return;
    if (!retry && (!messageText.trim() || existing)) return;
    const transcript = conversationRef.current;
    followConversationRef.current = !transcript || transcript.scrollHeight - transcript.clientHeight - transcript.scrollTop < 72;
    preserveConversationScrollTopRef.current = followConversationRef.current ? null : transcript?.scrollTop ?? 0;
    const focusAtSend = document.activeElement;
    const sentFromComposer = Boolean(focusAtSend === inputRef.current || (focusAtSend instanceof HTMLElement && focusAtSend.closest('.inception-composer')));
    const roundId = session.round.id, generation = lifecycle.current, roundToken = roundGeneration.current;
    const pending = existing || { id: crypto.randomUUID(), content: messageText.trim() };
    if (!existing) { sessionStorage.setItem(`workshop-inception-send:${session.round.id}`, JSON.stringify(pending)); setPendingSend(pending); }
    const operation = {};
    composerFocusIntent.current = null;
    sendOperation.current = operation;
    setBusy(true); setError(''); setSendStatus(''); setSendPhase(retry ? 'checking' : 'sending');
    try {
      const next = await api<Round>(`/rounds/${session.round.id}/messages`, { method: 'POST', body: { content: pending.content, requestId: pending.id } });
      if (lifecycle.current !== generation || roundGeneration.current !== roundToken) return;
      if (sentFromComposer) composerFocusIntent.current = { roundId, generation, roundToken, focusAtSend, sentFromComposer };
      setSession(current => current?.round.id === roundId ? { ...current, round: { ...next, accessToken: current.round.accessToken } } : current);
      recordMetricsReply(roundId, session.round.accessToken); recordMetricsInteraction('reply', roundId, session.round.accessToken);
      setMessageText(''); setPendingSend(null); setSendStatus('Reply saved.'); setSendPhase('idle'); setFailureNeedsNewAttempt(false); sessionStorage.removeItem(sendFailureStorageFor(session.round.id)); sessionStorage.removeItem(`workshop-inception-send:${session.round.id}`); sessionStorage.removeItem(sendDraftStorageFor(session.round.id));
    } catch (cause) {
      if (lifecycle.current !== generation || roundGeneration.current !== roundToken) return;
      const apiError = cause as ApiError;
      const terminalReceipt = apiError.receiptConfirmed && ['failed', 'rejected', 'interrupted'].includes(apiError.submissionStatus || '');
      if (terminalReceipt) {
        sessionStorage.removeItem(`workshop-inception-send:${session.round.id}`); setPendingSend(null); setSendPhase('idle');
        sessionStorage.setItem(sendDraftStorageFor(session.round.id), pending.content);
        const capacityFailure = apiError.failureCode === 'rate_limited' || ['provider_auth', 'provider_unavailable', 'timeout', 'empty_response', 'provider_rejected'].includes(apiError.failureCode || '');
        setFailureNeedsNewAttempt(capacityFailure);
        if (capacityFailure) sessionStorage.setItem(sendFailureStorageFor(session.round.id), JSON.stringify({ at: Date.now() }));
        else sessionStorage.removeItem(sendFailureStorageFor(session.round.id));
        setSendStatus(capacityFailure ? 'This provider could not complete the prompt. Start a new attempt to check available capacity.' : 'The prompt was recorded, but Fischer could not reply. You can send it again as a new message.');
      } else {
        setSendStatus(apiError.receiptConfirmed ? apiError.submissionStatus === 'succeeded' ? 'Checking the saved reply…' : 'Checking this message receipt…' : 'The response was not confirmed. Retry checks this same message.');
        setSendPhase('checking');
      }
      if (terminalReceipt && apiError.retryAfterSeconds) {
        const until = Date.now() + Math.min(7 * 24 * 60 * 60, Math.max(1, apiError.retryAfterSeconds)) * 1000;
        sessionStorage.setItem(sendCooldownStorageFor(session.round.id), String(until));
        setRetryCooldownUntil(until);
      }
      setError((cause as Error).message);
      if (apiError.receiptConfirmed && !terminalReceipt) {
        try {
          const recovered = await api<Session>(`/inception/rounds/${roundId}`, { timeoutMs: 5000 });
          if (lifecycle.current !== generation || roundGeneration.current !== roundToken || sendOperation.current !== operation || recovered.round.id !== roundId) return;
          setSession(current => current?.round.id === roundId ? { ...current, round: { ...recovered.round, accessToken: current.round.accessToken }, state: recovered.state } : current);
        } catch { /* The receipt stays pending and can be checked again with the same request ID. */ }
      }
    } finally {
      if (sendOperation.current === operation) {
        sendOperation.current = null;
        if (lifecycle.current === generation && roundGeneration.current === roundToken) { setBusy(false); setSendPhase('idle'); }
      }
    }
  };

  const startNewAttemptAfterProviderFailure = async () => {
    if (!session || busy || pendingSend || !failureNeedsNewAttempt) return;
    const oldRoundId = session.round.id, generation = lifecycle.current, roundToken = roundGeneration.current;
    setBusy(true); setError('');
    try {
      await api<{ round: Round; state: InceptionState }>(`/inception/rounds/${oldRoundId}/finish`, { method: 'POST', body: { answer: '' }, timeoutMs: 10_000 });
      if (lifecycle.current !== generation || roundGeneration.current !== roundToken) return;
      const actorScope = config?.actorScope;
      if (actorScope) sessionStorage.setItem(nextAttemptDraftStorageFor(actorScope), JSON.stringify({ actorScope, draft: messageText.slice(0, 4000), savedAt: Date.now() }));
      sessionStorage.removeItem(sendFailureStorageFor(oldRoundId));
      setPendingSend(null); setSendPhase('idle'); setFailureNeedsNewAttempt(false);
      await leaveRef.current(true);
    } catch (cause) {
      if (lifecycle.current === generation && roundGeneration.current === roundToken) setError((cause as Error).message || 'The earlier attempt could not be finished.');
    } finally { if (lifecycle.current === generation && roundGeneration.current === roundToken) setBusy(false); }
  };

  const finish = async () => {
    if (!session || busy || session.round.endedAt || pendingSend) return;
    const roundId = session.round.id, generation = lifecycle.current, roundToken = roundGeneration.current;
    checkingComposerHeight.current = composerRef.current?.getBoundingClientRect().height ?? null;
    checkingTextareaHeight.current = inputRef.current?.getBoundingClientRect().height ?? null;
    recordMetricsInteraction('finish', roundId, session.round.accessToken);
    setCinematicPhase('checking'); setBusy(true); setError(''); setSendStatus('');
    try {
      const result = await api<{ round: Round; state: InceptionState }>(`/inception/rounds/${roundId}/finish`, { method: 'POST', body: { answer: '' }, timeoutMs: 10_000 });
      if (lifecycle.current !== generation || roundGeneration.current !== roundToken) return;
      setSession(current => current?.round.id === roundId ? { ...current, round: result.round, state: result.state } : current); setRoundClock(Date.now());
      await requestReview(roundId);
    } catch (cause) { if (lifecycle.current === generation && roundGeneration.current === roundToken) { setCinematicPhase(null); setError((cause as Error).message); setSendStatus(''); } }
    finally { if (lifecycle.current === generation && roundGeneration.current === roundToken) setBusy(false); }
  };
  const requestReview = async (roundId = session?.round.id) => {
    if (!roundId || reviewOperation.current) return;
    const generation = lifecycle.current, roundToken = roundGeneration.current;
    if (session?.round.id === roundId) recordMetricsInteraction('review', roundId, session.round.accessToken);
    const operation = {};
    reviewOperation.current = operation; setReview({ status: 'pending' }); setCinematicPhase('checking');
    try {
      const result = await api<{ review: Review | null; state: InceptionState }>(`/inception/rounds/${roundId}/review`, { method: 'POST', body: {}, timeoutMs: 35_000 });
      if (lifecycle.current !== generation || roundGeneration.current !== roundToken) return;
      setReview(result.review); if (result.state) setSession(current => current?.round.id === roundId ? { ...current, state: result.state } : current);
      if (result.state) void playConfirmedEnding(roundId, result.review, result.state);
      if (result.review?.status !== 'pending' && !(result.review?.status === 'complete' && result.review.verdict === 'recovered' && result.state?.safeOpened && result.state.revealedCombination)) setCinematicPhase(null);
      if (result.review?.status === 'complete') setSendStatus(result.review.verdict === 'recovered' ? 'Review complete. The safe is open.' : 'Review complete. Read the result below.');
    } catch (cause) {
      if (lifecycle.current !== generation || roundGeneration.current !== roundToken) return;
      const recovered = await api<{ review: Review | null; state: InceptionState }>(`/inception/rounds/${roundId}/review`, { timeoutMs: 5_000 }).catch(() => null);
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
    finally { if (reviewOperation.current === operation) reviewOperation.current = null; }
  };
  const replay = () => {
    if (busy || review?.status === 'pending') return;
    composerFocusIntent.current = null;
    roundGeneration.current++;
    setSession(null); setReview(null); setMessageText(''); setPendingSend(null); sessionStorage.removeItem(sessionStorageKey); setError('');
    setSelectedProfile(preferredNewProfile()); beginIntro(true);
    if (!sound.muted) startAmbient(undefined, true);
  };
  const archiveOldAndStartCurrent = async () => {
    if (!session || session.profile.profileRevision !== 1 || busy || pendingSend || review?.status === 'pending') return;
    const oldRoundId = session.round.id, generation = lifecycle.current, roundToken = roundGeneration.current;
    setBusy(true); setError('');
    try {
      if (!session.round.endedAt) {
        const result = await api<{ round: Round; state: InceptionState }>(`/inception/rounds/${oldRoundId}/finish`, { method: 'POST', body: { answer: '' }, timeoutMs: 10_000 });
        if (lifecycle.current !== generation || roundGeneration.current !== roundToken) return;
        setSession(current => current?.round.id === oldRoundId ? { ...current, round: result.round, state: result.state } : current);
      }
      const profileId = preferredNewProfile();
      setSelectedProfile(profileId);
      await startRound(profileId);
    } catch (cause) {
      if (lifecycle.current === generation && roundGeneration.current === roundToken) setError((cause as Error).message || 'The earlier attempt could not be finished.');
    } finally { if (lifecycle.current === generation && roundGeneration.current === roundToken) setBusy(false); }
  };
  const keyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape' && activeModal) { setActiveModal(null); return; }
    if (event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey && !event.repeat && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229 && !composing.current) { event.preventDefault(); void send(); }
  };

  if (loading) return <main className="inception-loading" aria-busy="true">Opening the strongroom…</main>;
  if (!config) return <main className="inception-loading"><p role="alert">{error || 'The strongroom is unavailable.'}</p><button onClick={() => window.location.reload()}>Retry</button></main>;
  const activeProfile = session?.profile || config.profiles.find(item => item.id === selectedProfile) || config.profiles[0];
  const entryAction = entryPrompt === 'continue' ? 'Click to continue' : 'Click anywhere to begin';
  const hasConfirmedFailure = Boolean(session?.round.endedAt && review?.status === 'complete' && (review.verdict === 'not_recovered' || review.verdict === 'partial'));
  const entryPoster = <button ref={entryPosterRef} type="button" className={`inception-entry-poster ${entryTransition ? 'is-transitioning' : ''} ${entryReturning ? 'is-returning' : ''}`} style={entryTransition && reducedMotion ? { animationDuration: '150ms' } : undefined} aria-label={entryAction} aria-hidden={Boolean(successEnding) || undefined} disabled={busy || Boolean(successEnding) || Boolean(cinematicCover) || entryTransition || entryReturning || (config.recordingNoticeRequired === true && !config.recordingAccepted && !consented)} onClick={() => beginIntro()}>
    {manifest.entryPoster && <img className="inception-entry-poster-image" src={manifest.entryPoster} alt="" aria-hidden="true" />}
    <span className="inception-entry-poster-shade" aria-hidden="true" />
    {manifest.entryWordmark && <img className="inception-entry-wordmark" src={manifest.entryWordmark} alt="" aria-hidden="true" />}
    <span className="inception-entry-prompt">{entryAction}</span>
    {error && <span className="inception-entry-error" role="alert">{error}</span>}
  </button>;
  const gameBackground = session?.state.safeOpened && cinematicPhase !== 'entry' ? manifest.openFrame : manifest.closedFrame;
  return <main ref={rootRef} inert={entryVisible || entryTransition || Boolean(cinematicCover) ? true : undefined} className={`inception-root ${fullscreen ? 'is-fullscreen' : ''} ${immersive ? 'is-immersive' : ''} ${reducedMotion ? 'reduced-motion' : ''}`} style={{ ...(gameBackground ? { '--scene-art': `url("${gameBackground}")` } : {}), ...(manifest.dialogueTexture ? { '--dialogue-texture': `url("${manifest.dialogueTexture}")` } : {}) } as CSSProperties}>
    <div className="inception-shade" aria-hidden="true" />
    {!session ? intro ? <section className="inception-intro" aria-label="Strongroom approach" onDoubleClick={event => {
      if (event.target instanceof Element && event.target.closest('button')) return;
      event.preventDefault();
      finishIntro(true);
    }}>
      {manifest.introVideo && !introMediaIssue ? <video ref={introVideoRef} key={`${manifest.introVideo}-${introMediaAttempt}`} className="inception-intro-video" autoPlay playsInline muted onTimeUpdate={event => { const video = event.currentTarget; setIntroTimeLeft(Math.max(0, Math.ceil(introDurationSeconds - video.currentTime))); introProgressRef.current = { at: Date.now(), time: video.currentTime }; }} onEnded={() => { setIntroTimeLeft(0); setFilmEnded(true); }} onError={() => setIntroMediaIssue('The approach could not play. Retry it or continue to the strongroom.')}>
        <source src={manifest.introVideo} type="video/mp4" />{manifest.captions && <track ref={introCaptionTrackRef} kind="captions" src={manifest.captions} srcLang="en" label="English" />}
      </video> : manifest.bridgeVideo && !introMediaIssue ? <video key={`${manifest.bridgeVideo}-${filmEnded}`} className="inception-intro-video" autoPlay playsInline muted><source src={manifest.bridgeVideo} type="video/mp4" /></video> : <div className={`inception-intro-scene ${filmEnded ? 'handoff' : ''}`} style={(manifest.bridgeFrame || manifest.closedFrame) ? { backgroundImage: `url("${manifest.bridgeFrame || manifest.closedFrame}")` } : undefined}><p>THE DREAM IS BEGINNING TO SHIFT</p><div className="inception-intro-caption">Fischer is close. The safe is nearby.</div></div>}
      {introCaptionLayout && <div className="inception-film-caption-bands" style={introCaptionLayout}>{introCaptionText && <span className="inception-film-caption" style={{ top: '93.5185%' }} aria-label="English captions" aria-live="polite">{introCaptionText}</span>}</div>}
      {introMediaIssue && <div className="inception-media-recovery" role="alert"><p>{introMediaIssue}</p><div><Button className="inception-quiet-button" disabled={busy} onClick={() => { introProgressRef.current = { at: Date.now(), time: 0 }; setIntroTimeLeft(introDurationSeconds); setIntroMediaIssue(''); setIntroMediaAttempt(value => value + 1); }}>Retry approach</Button><Button className="inception-quiet-button" disabled={busy} onClick={() => finishIntro(true)}>Continue</Button></div></div>}
      {pendingStart && !busy && <div className="inception-media-recovery" role="alert"><p>The start receipt could not be confirmed.</p><Button className="inception-quiet-button" onClick={() => void startRound(pendingStart.profileId, { clientStartId: pendingStart.clientStartId })}>Retry start</Button><Button className="inception-quiet-button" onClick={() => { setIntro(false); setFilmEnded(false); setEntryVisible(true); }}>Return to entry</Button></div>}
      {error && <p className="inception-inline-error" role="alert">{error}</p>}
    </section> : pendingStart && !entryVisible ? <section className="inception-entry-recovery" role="alert">
      <p>{busy ? 'Checking the saved start request…' : error || 'The start request is not confirmed yet.'}</p>
      {!busy && <Button className="inception-primary" disabled={config.recordingNoticeRequired === true && !config.recordingAccepted && !consented} onClick={() => void startRound(pendingStart.profileId, { clientStartId: pendingStart.clientStartId })}>Check start receipt</Button>}
      {!busy && <Button className="inception-secondary" onClick={() => setEntryVisible(true)}>Return to poster</Button>}
    </section> : null : <section className={'inception-play ' + (cinematicHandoff ? 'is-cinematic-handoff ' : '') + (cinematicPhase ? 'is-cinematic-' + cinematicPhase + ' ' : '') + (!handoffInteractive ? 'is-handoff-locked' : '')} aria-label="Inception strongroom">
      <header className="inception-topbar" inert={!handoffInteractive || Boolean(successEnding) || Boolean(cinematicPhase) ? true : undefined}><div className="inception-top-actions"><span className={`inception-clock ${remaining <= 45 ? 'urgent' : ''}`} role="timer" aria-label={`${time(remaining)} remaining`}>{time(remaining)}</span><label className="inception-volume" aria-label="Sound volume"><Volume2 size={15} /><input type="range" min="0" max="0.7" step="0.05" value={sound.volume} disabled={closed} onChange={event => setSound({ ...sound, volume: Number(event.target.value) })} /></label><button className="inception-icon-button" aria-label={sound.muted ? 'Unmute sound' : 'Mute sound'} disabled={closed} onClick={() => { const muted = !sound.muted; setSound({ ...sound, muted }); if (!muted) startAmbient(false); }}>{sound.muted ? <VolumeX size={17} /> : <Volume2 size={17} />}</button>{hasAmbient && !sound.muted && !soundReady && !closed && <button className="inception-icon-button" onClick={() => startAmbient(false)}>Play sound</button>}<button className="inception-icon-button" aria-label={fullscreen ? 'Exit fullscreen' : 'Enter fullscreen'} onClick={() => fullscreen ? void document.exitFullscreen().catch(() => undefined) : void enterFullscreen()}><Maximize2 size={16} /></button><button className="inception-icon-button" aria-label="Leave strongroom" onClick={() => void leave()}><X size={18} /></button></div></header>
      {cinematicPhase === 'checking' && <p className="visually-hidden" role="status">Checking the saved conversation…</p>}
      <div className={`inception-scene-row ${gameBackground ? 'has-art' : ''}`} inert={!handoffInteractive || Boolean(successEnding) || Boolean(cinematicPhase) ? true : undefined}>
        <div ref={safeRef} className={`inception-safe ${session.state.safeOpened ? 'open' : ''} ${gameBackground ? 'with-art' : ''}`} role="group" aria-label={session.state.safeOpened ? 'Strongroom safe open' : 'Closed strongroom safe'}><span className="inception-safe-dimming" aria-hidden="true" /><div className="inception-safe-door"><div className="inception-safe-keypad" aria-hidden="true"><span className="inception-safe-display" /><div>{Array.from({ length: 12 }, (_, index) => <i key={index} />)}</div></div><span className="inception-safe-handle" /></div>{cinematicPhase === 'entry' && <span className="inception-revealed-code" style={lcdBounds} aria-label="Confirmed combination">{revealedDigits}</span>}{!session.state.safeOpened && <><button className="inception-hotspot safe-hotspot" style={gameBackground ? safeBounds : undefined} aria-label="Inspect safe" disabled={busy || closed || !handoffInteractive} onClick={() => { setActiveModal('safe'); if (!session.state.safeInspected) void inspect('inspect_safe'); }} /><button className="inception-hotspot room-hotspot" aria-label="Inspect the room" disabled={busy || closed || !handoffInteractive} onClick={() => { setActiveModal('room'); if (!session.state.roomInspected) void inspect('inspect_room'); }} /></>}</div>
        <section className="inception-dialogue" aria-label="Conversation with Fischer" inert={!handoffInteractive || Boolean(cinematicPhase) ? true : undefined}>
          <p className="inception-location" aria-hidden="true"></p>
          <div ref={conversationRef} className="inception-conversation" role="log" aria-label="Conversation transcript" aria-live="polite" aria-relevant="additions" aria-atomic="false" tabIndex={0} onScroll={event => { const element = event.currentTarget; followConversationRef.current = element.scrollHeight - element.clientHeight - element.scrollTop < 72; }}>
            {session.round.messages.filter(item => item.role === 'user' || item.role === 'assistant').map((item: Message) => <article key={item.id} className={item.role === 'user' ? 'from-player' : 'from-fischer'}><img src={item.role === 'user' ? manifest.portraits?.eames : manifest.portraits?.fischer} alt={item.role === 'user' ? 'Eames' : 'Fischer'} /><p>{item.content}</p></article>)}
          </div>
          {session.profile.profileRevision === 1 && (!session.round.endedAt || checkingEndedRound) && <div className="inception-old-version"><p>This conversation uses an earlier version. Its prompts are preserved.</p><Button className="inception-secondary" disabled={busy || Boolean(pendingSend) || review?.status === 'pending' || checkingEndedRound} onClick={() => void archiveOldAndStartCurrent()}>Finish this version and start {config.profiles.find(profile => profile.id === preferredNewProfile())?.label || 'Warm-up'}</Button></div>}
          {(expired && !session.round.endedAt || retainExpiredFinishControl) && <div className="inception-expired-controls" role="group" aria-label="Finish the expired conversation"><p>Time is up. Your saved conversation can still be reviewed.</p>{pendingSend && <><p role="status">Retry checks the same saved message receipt.</p><Button className="inception-secondary" disabled={busy} onClick={() => void send(true)}>Retry saved message</Button></>}{!pendingSend && <Button className="inception-primary" disabled={busy || checkingEndedRound} onClick={() => void finish()}>{busy ? 'Saving conversation…' : 'Finish and review'}</Button>}{error && <p role="alert" className="inception-inline-error">{error}</p>}</div>}
          {!session.round.endedAt || checkingEndedRound ? <div ref={composerRef} className="inception-composer" style={checkingEndedRound && checkingComposerHeight.current ? { minHeight: `${checkingComposerHeight.current}px` } : undefined}>
            <label htmlFor="inception-message" className="visually-hidden">Speak to Fischer</label>
            <textarea id="inception-message" ref={inputRef} style={checkingEndedRound && checkingTextareaHeight.current ? { minHeight: `${checkingTextareaHeight.current}px` } : undefined} value={messageText} disabled={closed || busy || Boolean(pendingSend)} maxLength={4000} rows={2} onChange={event => { setMessageText(event.target.value); sessionStorage.setItem(sendDraftStorageFor(session.round.id), event.target.value); }} onFocus={() => setMetricsPhase('compose', session.round.id, session.round.accessToken)} onBlur={() => setMetricsPhase('read_think', session.round.id, session.round.accessToken)} onKeyDown={keyDown} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} placeholder={closed ? 'This conversation has ended.' : 'Ask Fischer a question…'} />
            <div className="inception-composer-actions"><div>{pendingSend ? <Button className="inception-secondary inception-send-action" aria-live="polite" aria-label={busy ? sendPhase === 'checking' ? 'Checking message receipt' : 'Sending to Fischer' : 'Retry saved message'} disabled={busy} onClick={() => void send(true)}>{busy ? sendPhase === 'checking' ? 'Checking…' : 'Sending…' : 'Retry saved message'}</Button> : <Button className="inception-primary inception-send-action" aria-live="polite" aria-label={busy && sendPhase !== 'idle' ? sendPhase === 'checking' ? 'Checking message receipt' : 'Sending to Fischer' : retrySeconds > 0 ? `Retry in ${time(retrySeconds)}` : 'Send'} disabled={closed || busy || !messageText.trim() || retrySeconds > 0} onClick={() => void send()}>{busy && sendPhase !== 'idle' ? sendPhase === 'checking' ? 'Checking…' : 'Sending…' : retrySeconds > 0 ? `Retry in ${time(retrySeconds)}` : <>Send<ArrowRight size={15} /></>}</Button>}{failureNeedsNewAttempt && <Button className="inception-secondary inception-send-action" disabled={busy} onClick={() => void startNewAttemptAfterProviderFailure()}>Start a new attempt</Button>}{(!session.round.endedAt && !expired || checkingEndedRound) && <Button className="inception-secondary" disabled={busy || Boolean(pendingSend) || checkingEndedRound} onClick={() => void finish()}>{busy && cinematicPhase === 'checking' ? 'Saving conversation…' : 'Finish and review'}</Button>}</div></div>
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
              {session.round.endedAt && hasConfirmedFailure && <Button className="inception-secondary" disabled={busy} onClick={() => void leave()}>Return to main menu</Button>}
              {session.round.endedAt && !hasConfirmedFailure && <Button className="inception-secondary" disabled={busy || review?.status === 'pending'} onClick={replay}>Start a new attempt</Button>}
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
      {successEnding && createPortal(<section className={`inception-success-ending ${endingCardPhase ? 'is-title-card' : ''} ${endingCardPhase === 'title-fade' || endingCardPhase === 'logo-fade' ? 'is-card-exit' : ''}`} style={{ '--ending-card-exit-duration': endingCardPhase === 'logo-fade' && manifest.successLogoFadeEndSeconds && manifest.successLogoFadeStartSeconds ? `${manifest.successLogoFadeEndSeconds - manifest.successLogoFadeStartSeconds}s` : '750ms' } as CSSProperties} aria-label="Inception ending" aria-live="polite" onDoubleClick={event => {
        event.preventDefault(); event.stopPropagation();
        finalizeSuccessEnding(true);
      }}>
        <video ref={successVideoRef} key={`${manifest.successVideo}-${successEndingAttempt}`} className="inception-success-ending-video" playsInline preload="auto" muted={sound.muted} onEnded={() => finalizeSuccessEnding(false)} onError={() => {
          if (endingMediaDisposalRef.current || endingFinalizationRef.current) return;
          endingGenerationRef.current++;
          if (cinematicTimerRef.current !== null) { window.clearTimeout(cinematicTimerRef.current); cinematicTimerRef.current = null; }
          setSuccessEndingError('The ending video could not be played. Your saved result remains available.'); setSuccessEnding('error'); setCinematicPhase(null); setEndingCardPhase(null); void disposeAmbient();
        }}>
          <source src={manifest.successVideo || undefined} type="video/mp4" />{manifest.successCaptions && <track ref={successCaptionTrackRef} kind="captions" src={manifest.successCaptions} srcLang="en" label="English scene captions" />}
        </video>
        {successEnding === 'playing' && endingCardPhase === null && successCaptionLayout && <div className="inception-film-caption-bands" style={successCaptionLayout}>{successCaptionText && <span className="inception-film-caption" style={{ top: '93.5185%' }} aria-label="English captions" aria-live="polite">{successCaptionText}</span>}</div>}
        <h2 ref={successTitleRef} tabIndex={-1} className="visually-hidden">Inception ending</h2>
        {(endingCardPhase === 'title-in' || endingCardPhase === 'title' || endingCardPhase === 'title-fade') && <div className="inception-ending-card inception-ending-title-card" role="heading" aria-level={1}>{manifest.endingWordmark ? <img src={manifest.endingWordmark} alt="INCEPTION" /> : 'INCEPTION'}</div>}
        {(endingCardPhase === 'logo-in' || endingCardPhase === 'logo' || endingCardPhase === 'logo-fade') && manifest.endingLogo && <div className="inception-ending-card inception-ending-logo-card"><img src={manifest.endingLogo} alt="CSES" style={{ '--device-pixel-ratio': String(window.devicePixelRatio || 1) } as CSSProperties} /></div>}
        {(successEnding === 'blocked' || successEnding === 'error') && <div className="inception-media-recovery" role={successEnding === 'error' ? 'alert' : 'status'}><p>{successEndingError || 'The ending could not start automatically.'}</p>{successEnding === 'blocked' && <Button className="inception-quiet-button" onClick={() => { endingGenerationRef.current++; setSuccessEndingError(''); setSuccessEndingAttempt(value => value + 1); setEndingCardPhase(null); setSuccessEnding('playing'); }}>Play ending</Button>}{successEnding === 'error' && <Button className="inception-quiet-button" onClick={() => { endingGenerationRef.current++; setSuccessEndingError(''); setSuccessEnding(null); setCinematicPhase(null); }}>Return to result</Button>}</div>}
      </section>, document.body)}
    </section>}
    {(entryVisible || entryTransition) && createPortal(entryPoster, document.body)}
    {cinematicCover && createPortal(<div className={`inception-cinematic-cover ${cinematicCover} ${reducedMotion ? 'reduced-motion' : ''}`} aria-hidden="true" style={cinematicCover === 'ending-skip' ? { animationDuration: reducedMotion ? '80ms' : '150ms' } : undefined} />, document.body)}
  </main>;
}
