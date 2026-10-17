import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MutableRefObject } from 'react';
import { createPortal } from 'react-dom';
import '@fontsource-variable/caveat/wght.css';
import './riddle-diary.css';
import { ArrowLeft, ArrowRight, BookOpen, Check, ChevronLeft, ChevronRight, Clock3, Download, Eye, Feather, FileText, Loader2, PenLine, RotateCcw, Send, X } from 'lucide-react';
import { api, ApiError, RECORDING_NOTICE, RECORDING_NOTICE_VERSION, setRecordingAcknowledged, time } from './api';
import type { MachineReview, Message, Round } from './types';
import { Button, Field, Mark } from './ui';
import { MachineReviewPanel } from './MachineReviewPanel';
import { recordMetricsInteraction, recordMetricsReply, setMetricsPhase } from './telemetry';

type DiaryProfile = { id: string; label: string; description: string; versionId?: string; scenarioId?: string; profileId?: string; profileRevision?: number; sceneVersion?: number; promptHash?: string; snapshotHash?: string };
type DiaryState = { revision: number; sceneVersion?: number; page: 'memory' | 'response'; diaryOpen: boolean; fragmentAligned?: boolean; letterOpen?: boolean; awardInspected?: boolean; libraryInspected?: boolean; presentedObjects: string[]; keptReplyIds: string[]; observations: string[]; filed: boolean; filedEvidenceIds: string[] };
type DiaryRound = Round & { diary?: DiaryProfile; accessToken?: string; reviewEnabled?: boolean; machineReview?: MachineReview | null };
type DiarySession = { round: DiaryRound; state: DiaryState; diary: DiaryProfile };
type DiaryConfig = { title: string; scenarioId: string; profiles: DiaryProfile[]; connected: boolean; recordingNoticeRequired?: boolean; reviewEnabled?: boolean; profile?: DiaryProfile; activeRoundId?: string | null };
type DiaryAction = { type: 'open_diary' | 'turn_page' | 'align_fragment' | 'open_letter' | 'inspect_award' | 'inspect_library' } | { type: 'present_object' | 'remove_object'; objectId: 'diary' | 'award' | 'library' | 'fragment' | 'letter' } | { type: 'keep_reply' | 'remove_kept_reply'; replyId: string };
type PendingAction = { id: string; action: DiaryAction };
type BlindReceipt = { id: string; accessToken: string; tester: string; replayFrom?: string; recordingVersion?: string };
type Artifact = 'diary' | 'award' | 'library';
type DiaryPageSegment = { message: Message; text: string; start: number; end: number; continued: boolean };
const ASSETS = '/diary-assets';

export function RiddleDiary({ blindToken, canShare = false, onHome }: { blindToken?: string; canShare?: boolean; onHome?: () => void }) {
  const blind = Boolean(blindToken);
  const receiptKey = `workshop-diary-play:${blindToken || ''}`;
  const memberReplayKey = 'workshop-diary-replay';
  const [config, setConfig] = useState<DiaryConfig | null>(null);
  const [session, setSession] = useState<DiarySession | null>(null);
  const [pendingRound, setPendingRound] = useState<DiarySession | null>(null);
  const [bookPages, setBookPages] = useState<DiaryPageSegment[][]>([[]]);
  const [bookPageIndex, setBookPageIndex] = useState(0);
  const bookPageIndexRef = useRef(bookPageIndex);
  bookPageIndexRef.current = bookPageIndex;
  const [mobileBook, setMobileBook] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 640px)').matches);
  const [showConversation, setShowConversation] = useState(false);
  const readingAnchor = useRef<{ messageId: string; offset: number } | null>(null);
  const manualPageSelection = useRef(false);
  const bringLatestAfterUpdate = useRef(true);
  const lastPaginatedMessages = useRef<Message[] | null>(null);
  const [selectedProfile, setSelectedProfile] = useState('story');
  const [name, setName] = useState('');
  const [consented, setConsented] = useState(false);
  const [message, setMessage] = useState('');
  const [answer, setAnswer] = useState('');
  const [selectedEvidence, setSelectedEvidence] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [sending, setSending] = useState(false);
  const [pendingSubmission, setPendingSubmission] = useState<{ id: string; content: string } | null>(null);
  const [filing, setFiling] = useState(false);
  const [activeArtifact, setActiveArtifact] = useState<Artifact | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [showAnswer, setShowAnswer] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [writingSpeed, setWritingSpeed] = useState<'steady' | 'quick'>('steady');
  const [plainText, setPlainText] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(() => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [instantReplies, setInstantReplies] = useState<string[]>([]);
  const [animatingReplyId, setAnimatingReplyId] = useState<string | null>(null);
  const [showShare, setShowShare] = useState(false);
  const [showContext, setShowContext] = useState(false);
  const [introStep, setIntroStep] = useState(0);
  const [contextIntroStep, setContextIntroStep] = useState(0);
  const [sharePath, setSharePath] = useState('');
  const [copied, setCopied] = useState(false);
  const requestId = useRef('');
  const sendGeneration = useRef(0);
  const fileGeneration = useRef(0);
  const sceneRef = useRef<DiarySession | null>(session);
  sceneRef.current = session;
  const scrollRef = useRef<HTMLDivElement>(null);
  const rightScrollRef = useRef<HTMLDivElement>(null);
  const filingDialogRef = useRef<HTMLElement | null>(null);
  const shareDialogRef = useRef<HTMLElement | null>(null);
  const contextDialogRef = useRef<HTMLElement | null>(null);
  const conversationDialogRef = useRef<HTMLElement | null>(null);
  const bookRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLDivElement | null>(null);
  useDialogControls(filingDialogRef, showAnswer, () => setShowAnswer(false));
  useDialogControls(shareDialogRef, showShare, () => setShowShare(false));
  useDialogControls(contextDialogRef, showContext, () => setShowContext(false));
  useDialogControls(conversationDialogRef, showConversation, () => setShowConversation(false));
  useLayoutEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReducedMotion(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 640px)');
    const update = () => setMobileBook(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  const installSession = (value: DiarySession, animateLatest = false) => {
    setSession(value); setPendingRound(null); setBookPageIndex(0); setBookPages([[]]); manualPageSelection.current = false; bringLatestAfterUpdate.current = true; lastPaginatedMessages.current = null; readingAnchor.current = null; setMessage(''); setAnswer(''); setSelectedEvidence(value.state.filedEvidenceIds || []); setError(''); requestId.current = ''; setPendingSubmission(null);
    setAnimatingReplyId(animateLatest ? [...value.round.messages].reverse().find(item => item.role === 'assistant' && !item.opening)?.id || null : null);
    setInstantReplies(animateLatest ? [] : value.round.messages.map(item => item.id));
  };

  useEffect(() => {
    let active = true;
    setLoading(true); setError('');
    (async () => {
      try {
        if (blindToken) {
          const nextConfig = await api<DiaryConfig>(`/diary/play/${blindToken}`);
          if (!active) return;
          setConfig(nextConfig);
          const saved = readBlindReceipt(receiptKey);
          if (saved) {
            setName(saved.tester);
            if (saved.replayFrom === saved.id) {
              const recording = await api<{ accepted: boolean; version?: string }>(`/rounds/${saved.id}/recording`, { token: saved.accessToken });
              if (!active) return;
              const accepted = recording.accepted && recording.version === RECORDING_NOTICE_VERSION;
              setConsented(accepted);
              setRecordingAcknowledged(accepted);
              return;
            }
            const value = await api<DiarySession>(`/diary/rounds/${saved.id}`, { token: saved.accessToken });
            const recording = await api<{ accepted: boolean; version?: string }>(`/rounds/${saved.id}/recording`, { token: saved.accessToken });
            if (!active) return;
            const restored = { ...value, round: { ...value.round, accessToken: saved.accessToken } };
            if (recording.accepted && recording.version === RECORDING_NOTICE_VERSION) { setRecordingAcknowledged(true); installSession(restored); }
            else setPendingRound(restored);
          }
        } else {
          const nextConfig = await api<DiaryConfig>('/diary');
          if (!active) return;
          setConfig(nextConfig);
          const replayFrom = window.sessionStorage.getItem(memberReplayKey);
          const current = nextConfig.activeRoundId ? await api<DiarySession | null>('/diary/active') : null;
          if (active && current && replayFrom === current.round.id) {
            const replayProfile = current.diary.profileId || current.diary.id;
            if (nextConfig.profiles.some(item => item.id === replayProfile)) setSelectedProfile(replayProfile);
          } else if (active && current) {
            window.sessionStorage.removeItem(memberReplayKey);
            installSession(current);
          } else if (active && replayFrom) {
            // A replay choice survives refresh; do not restore the expired or filed round.
          } else {
            const latest = await api<DiarySession | null>('/diary/latest');
            if (active && latest) installSession(latest);
          }
        }
      } catch (cause) { if (active) setError((cause as Error).message); }
      finally { if (active) setLoading(false); }
    })();
    return () => { active = false; sendGeneration.current += 1; fileGeneration.current += 1; };
  }, [blindToken, receiptKey]);

  useEffect(() => {
    if (!session || session.round.endedAt) return;
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [session?.round.id, session?.round.endedAt]);
  useEffect(() => { if (session) setMetricsPhase('read_think', session.round.id, session.round.accessToken); }, [session?.round.id, session?.round.accessToken]);
  useEffect(() => { sendGeneration.current += 1; requestId.current = ''; setSending(false); }, [session?.round.id]);
  const profiles = useMemo(() => config?.profiles || [], [config?.profiles]);
  const profile = session?.diary || config?.profile || profiles.find(item => item.id === selectedProfile) || profiles[0];
  const profileKey = profile?.profileId || profile?.id || selectedProfile;
  const remaining = session ? Math.max(0, Math.ceil((session.round.deadline - now) / 1000)) : 300;
  const expired = Boolean(session && !session.round.endedAt && remaining <= 0);
  const latestMessages = session?.round.messages || [];
  const spreadStart = mobileBook ? bookPageIndex : Math.floor(bookPageIndex / 2) * 2;
  const leftPhysicalPage = mobileBook ? bookPageIndex : spreadStart;
  const rightPhysicalPage = mobileBook ? bookPageIndex : spreadStart + 1;
  const leftSegments = mobileBook ? bookPageIndex % 2 === 0 ? (bookPages[bookPageIndex] || []) : [] : (bookPages[leftPhysicalPage] || []);
  const rightSegments = mobileBook ? bookPageIndex % 2 === 1 ? (bookPages[bookPageIndex] || []) : [] : (bookPages[rightPhysicalPage] || []);
  const displayedMobilePage = mobileBook ? bookPageIndex % 2 === 0 ? 'left' : 'right' : '';
  useLayoutEffect(() => {
    const book = bookRef.current, left = scrollRef.current, right = rightScrollRef.current;
    if (!session?.state.diaryOpen || !book || !left || !right) { setBookPages([[]]); return; }
    let active = true;
    const paginate = () => {
      if (!active) return;
      const activeScroll = mobileBook && bookPageIndexRef.current % 2 === 0 ? left : mobileBook ? right : left;
      const width = Math.max(80, activeScroll.clientWidth - horizontalPadding(activeScroll));
      const height = Math.max(0, activeScroll.clientHeight - verticalPadding(activeScroll));
      const next = paginateDiaryMessages(latestMessages, width, height, plainText);
      // Resize and breakpoint changes can briefly collapse the flex scroll area. Keep the
      // last measured book until a real page can fit content instead of printing one glyph
      // per zero-height page while layout settles.
      if (!next) return;
      setBookPages(current => sameBookPages(current, next) ? current : next);
      const anchor = readingAnchor.current;
      const messagesChanged = lastPaginatedMessages.current !== latestMessages;
      if (messagesChanged) lastPaginatedMessages.current = latestMessages;
      let target = -1;
      if (bringLatestAfterUpdate.current && messagesChanged && !manualPageSelection.current) target = next.length - 1;
      else if (anchor) target = next.findIndex(page => page.some(segment => segment.message.id === anchor.messageId && anchorFitsSegment(segment, anchor.offset)));
      if (target < 0) target = Math.min(bookPageIndexRef.current, next.length - 1);
      if (mobileBook) setBookPageIndex(Math.max(0, target));
      else setBookPageIndex(Math.floor(Math.max(0, target) / 2) * 2);
      if (bringLatestAfterUpdate.current && messagesChanged && !manualPageSelection.current) bringLatestAfterUpdate.current = false;
    };
    const syncComposerReserve = () => {
      if (composerRef.current) book.style.setProperty('--diary-composer-height', `${Math.ceil(composerRef.current.getBoundingClientRect().height)}px`);
      else book.style.setProperty('--diary-composer-height', '0px');
      paginate();
    };
    const observer = new ResizeObserver(syncComposerReserve);
    observer.observe(book); observer.observe(left); observer.observe(right);
    if (composerRef.current) observer.observe(composerRef.current);
    window.addEventListener('resize', paginate);
    void document.fonts.ready.then(paginate);
    syncComposerReserve();
    return () => { active = false; observer.disconnect(); window.removeEventListener('resize', paginate); };
  }, [session?.round.id, session?.round.messages, session?.round.endedAt, session?.state.diaryOpen, plainText, expired, pendingSubmission, sending, mobileBook]);

  useEffect(() => {
    const currentPage = bookPages[bookPageIndex];
    if (currentPage?.length) {
      const anchor = readingAnchor.current;
      if (manualPageSelection.current) return;
      if (anchor && bookPages.some(page => page.some(segment => segment.message.id === anchor.messageId && anchorFitsSegment(segment, anchor.offset)))) return;
      if (!anchor || !currentPage.some(segment => segment.message.id === anchor.messageId && anchorFitsSegment(segment, anchor.offset))) {
        readingAnchor.current = { messageId: currentPage[0].message.id, offset: currentPage[0].start };
      }
    }
  }, [bookPageIndex, bookPages]);

  function goToBookPage(target: number) {
    const last = mobileBook ? bookPages.length - 1 : Math.floor((bookPages.length - 1) / 2) * 2;
    const next = Math.max(0, Math.min(last, target));
    manualPageSelection.current = true;
    bringLatestAfterUpdate.current = false;
    const segment = bookPages[next]?.[0] || bookPages[next + 1]?.[0];
    readingAnchor.current = segment ? { messageId: segment.message.id, offset: segment.start } : null;
    setBookPageIndex(mobileBook ? next : Math.floor(next / 2) * 2);
    scrollRef.current?.scrollTo({ top: 0 }); rightScrollRef.current?.scrollTo({ top: 0 });
  }

  function latestBookPage() {
    manualPageSelection.current = false; bringLatestAfterUpdate.current = false;
    const latestId = latestMessages.at(-1)?.id;
    let target = -1;
    for (let index = bookPages.length - 1; index >= 0; index -= 1) if (bookPages[index].some(segment => segment.message.id === latestId)) { target = index; break; }
    target = Math.max(0, target);
    goToBookPage(target);
    readingAnchor.current = latestId ? { messageId: latestId, offset: latestMessages.at(-1)?.content.length || 0 } : null;
    manualPageSelection.current = false;
  }

  function openMessageInBook(messageId: string) {
    const target = Math.max(0, bookPages.findIndex(page => page.some(segment => segment.message.id === messageId)));
    const segment = bookPages[target]?.find(item => item.message.id === messageId);
    readingAnchor.current = segment ? { messageId, offset: segment.start } : { messageId, offset: 0 };
    manualPageSelection.current = true; bringLatestAfterUpdate.current = false;
    setBookPageIndex(mobileBook ? target : Math.floor(target / 2) * 2);
    setShowConversation(false);
  }

  async function startMember(profileId = selectedProfile) {
    if (starting || !config?.connected) return;
    setStarting(true); setError('');
    try {
      const value = await api<DiarySession>('/diary/start', { method: 'POST', body: { profileId } });
      window.sessionStorage.removeItem(memberReplayKey);
      installSession(value);
      setSelectedProfile(profileId);
    } catch (cause) { setError((cause as Error).message); }
    finally { setStarting(false); }
  }

  async function startBlind() {
    if (!blindToken || starting || !name.trim() || !consented) return;
    setStarting(true); setError('');
    try {
      const value = await api<DiarySession>(`/diary/play/${blindToken}`, { method: 'POST', body: { tester: name.trim(), consent: true } });
      const accessToken = value.round.accessToken || '';
      setRecordingAcknowledged(true);
      window.sessionStorage.setItem(receiptKey, JSON.stringify({ id: value.round.id, accessToken, tester: name.trim(), recordingVersion: RECORDING_NOTICE_VERSION } satisfies BlindReceipt));
      installSession({ ...value, round: { ...value.round, accessToken } });
    } catch (cause) { setError((cause as Error).message); }
    finally { setStarting(false); }
  }

  async function acknowledgeResume() {
    if (!blindToken || !pendingRound || !consented || starting) return;
    setStarting(true); setError('');
    try {
      await api(`/rounds/${pendingRound.round.id}/recording`, { method: 'POST', token: pendingRound.round.accessToken, body: { version: RECORDING_NOTICE_VERSION, accepted: true } });
      setRecordingAcknowledged(true); installSession(pendingRound);
    } catch (cause) { setError((cause as Error).message); }
    finally { setStarting(false); }
  }

  const replayBlocked = Boolean(starting || sending || filing || actionBusy || pendingAction || pendingSubmission);
  const canReplay = Boolean(session && (session.round.endedAt || expired));
  const legacyBlindScene = Boolean(blind && config?.profile?.sceneVersion !== 2);
  const legacyBlindSession = Boolean(blind && session && session.state.sceneVersion !== 2);
  const legacySession = Boolean(session && session.state.sceneVersion !== 2);

  function replayDiary() {
    if (!session || !canReplay || replayBlocked || legacyBlindSession) return;
    if (blind) {
      const saved = readBlindReceipt(receiptKey);
      if (saved?.id === session.round.id) window.sessionStorage.setItem(receiptKey, JSON.stringify({ ...saved, replayFrom: saved.id } satisfies BlindReceipt));
      setName(saved?.tester || name);
      const accepted = Boolean(saved?.id === session.round.id && saved.recordingVersion === RECORDING_NOTICE_VERSION);
      setConsented(accepted);
      setRecordingAcknowledged(accepted);
    } else {
      window.sessionStorage.setItem(memberReplayKey, session.round.id);
      const selected = profile?.profileId || profile?.id;
      if (selected && profiles.some(item => item.id === selected)) setSelectedProfile(selected);
    }
    setError('');
    setSession(null);
    setSelectedEvidence([]);
  }

  async function runAction(action: DiaryAction, retry?: PendingAction) {
    if (!session || actionBusy) return;
    const roundId = session.round.id;
    const pending = retry || { id: crypto.randomUUID(), action };
    if (['open_diary', 'align_fragment', 'open_letter', 'inspect_award', 'inspect_library'].includes(action.type)) recordMetricsInteraction('inspect', roundId, session.round.accessToken);
    setActionBusy(true); setError('');
    try {
      const result = await api<{ state: DiaryState }>(`/diary/rounds/${roundId}/action`, { method: 'POST', token: session.round.accessToken, body: { ...pending.action, actionId: pending.id, revision: sceneRef.current?.state.revision ?? session.state.revision } });
      if (sceneRef.current?.round.id !== roundId) return;
      setSession(current => current?.round.id === roundId ? { ...current, state: result.state } : current);
      setPendingAction(null);
    } catch (cause) {
      if (sceneRef.current?.round.id !== roundId) return;
      if (cause instanceof ApiError && cause.status === 409) {
        try { const current = await api<DiarySession>(`/diary/rounds/${roundId}`, { token: session.round.accessToken }); if (sceneRef.current?.round.id === roundId) setSession({ ...current, round: { ...current.round, accessToken: session.round.accessToken } }); } catch { /* keep the latest known page state */ }
        setPendingAction(null); setError('The diary changed before that action was saved. Its current state is shown.');
      } else if (!(cause instanceof ApiError) || cause.status >= 500) {
        setPendingAction(pending); setError(`${(cause as Error).message} The action receipt is unknown. Retry this same action safely.`);
      } else { setPendingAction(null); setError((cause as Error).message); }
    } finally { if (sceneRef.current?.round.id === roundId) setActionBusy(false); }
  }

  async function send(retryPending = false) {
    if (!session || sending || ((!retryPending || !pendingSubmission) && (expired || session.round.endedAt)) || (pendingSubmission && !retryPending)) return;
    const prior = retryPending ? pendingSubmission : null;
    const sentText = prior?.content || message;
    if (!sentText.trim()) return;
    if (!prior && !manualPageSelection.current) bringLatestAfterUpdate.current = true;
    const roundId = session.round.id, generation = sendGeneration.current;
    if (!prior) recordMetricsInteraction('submit', roundId, session.round.accessToken);
    setSending(true); setError('');
    const id = prior?.id || requestId.current || crypto.randomUUID(); requestId.current = id;
    if (!prior) setPendingSubmission({ id, content: sentText });
    try {
      const next = await api<DiaryRound>(`/rounds/${roundId}/messages`, { method: 'POST', token: session.round.accessToken, body: { content: sentText, requestId: id } });
      if (generation !== sendGeneration.current || sceneRef.current?.round.id !== roundId) return;
      const assistant = [...next.messages].reverse().find(item => item.role === 'assistant' && !item.opening);
      setSession(current => current?.round.id === roundId ? { ...current, round: { ...next, accessToken: current.round.accessToken } } : current);
      setAnimatingReplyId(assistant?.id || null);
      recordMetricsReply(roundId, session.round.accessToken);
      setMessage(current => current === sentText ? '' : current);
      requestId.current = ''; setPendingSubmission(null);
    } catch (cause) {
      if (generation !== sendGeneration.current || sceneRef.current?.round.id !== roundId) return;
      if (cause instanceof ApiError && cause.submissionId) {
        if (['failed', 'rejected', 'interrupted'].includes(cause.submissionStatus || '')) { requestId.current = ''; setPendingSubmission(null); }
        setError(`${cause.message} The server confirmed this prompt was saved (status: ${cause.submissionStatus || 'unknown'}).${['failed', 'rejected', 'interrupted'].includes(cause.submissionStatus || '') ? ' Retry to create a new attempt.' : ' Retrying uses the same request ID and cannot invoke the model twice.'}`);
      } else if (cause instanceof ApiError && cause.status >= 400 && cause.status < 500) { requestId.current = ''; setPendingSubmission(null); setError(cause.message); }
      else if (cause instanceof ApiError) setError(`${cause.message} The receipt is not confirmed. Check the previous question using the same request ID.`);
      else setError('The server receipt is unknown because the connection ended. Your text remains here. Retry the previous question to check its receipt safely.');
    } finally { if (generation === sendGeneration.current && sceneRef.current?.round.id === roundId) setSending(false); }
  }

  async function fileCase() {
    if (!session || (!answer.trim() && !session.state.filed) || filing) return;
    const roundId = session.round.id, generation = fileGeneration.current;
    recordMetricsInteraction('finish', roundId, session.round.accessToken);
    setFiling(true); setError('');
    try {
      const result = await api<{ round: DiaryRound; state: DiaryState }>(`/diary/rounds/${roundId}/file`, { method: 'POST', token: session.round.accessToken, body: { answer: answer.trim() || 'Finish saving the stored finding.', evidenceIds: selectedEvidence, revision: session.state.revision } });
      if (generation !== fileGeneration.current || sceneRef.current?.round.id !== roundId) return;
      setSession(current => current?.round.id === roundId ? { ...current, round: { ...result.round, accessToken: current.round.accessToken }, state: result.state } : current);
      if (result.round.endedAt) setShowAnswer(false);
      else setError(result.state.filed ? 'Your finding is saved, but the case is still finishing. Keep this form open and choose “Finish saving finding” to retry safely.' : 'The case has not confirmed that your finding is filed. Your answer remains here; retry when the service is ready.');
    } catch (cause) {
      if (generation !== fileGeneration.current || sceneRef.current?.round.id !== roundId) return;
      if (cause instanceof ApiError && cause.status === 409) {
        try {
          const latest = await api<DiarySession>(`/diary/rounds/${roundId}`, { token: session.round.accessToken });
          if (generation !== fileGeneration.current || sceneRef.current?.round.id !== roundId) return;
          setSession(current => current?.round.id === roundId ? { ...latest, round: { ...latest.round, accessToken: current.round.accessToken } } : current);
          setError(latest.state.filed && !latest.round.endedAt ? 'Your finding was recorded, but final filing did not finish. Your answer remains here. Choose “Finish saving finding” to safely complete it.' : 'The diary changed before filing. Your answer remains here; review the current evidence and try again.');
        } catch { setError('The case has not confirmed filing. Your answer remains here; try again when the service is ready.'); }
      } else setError((cause as Error).message);
    } finally { if (generation === fileGeneration.current && sceneRef.current?.round.id === roundId) setFiling(false); }
  }

  function toggleEvidence(replyId: string, checked: boolean) {
    setSelectedEvidence(current => {
      if (checked) {
        if (current.includes(replyId)) return current;
        if (current.length >= 6) { setError('Choose up to six saved replies as evidence.'); return current; }
        setError(''); return [...current, replyId];
      }
      setError(''); return current.filter(value => value !== replyId);
    });
  }

  async function createShare() {
    if (!profileKey) return;
    setError('');
    try { const link = await api<{ path: string }>('/diary/links', { method: 'POST', body: { profileId: profileKey } }); setSharePath(`${window.location.origin}${link.path}`); setShowShare(true); }
    catch (cause) { setError((cause as Error).message); }
  }

  function displayReply(reply: Message) {
    const isWriting = !plainText && !reducedMotion && !instantReplies.includes(reply.id) && animatingReplyId === reply.id;
    const duration = writingSpeed === 'quick' ? 2500 : 5500;
    const tokens = reply.content.match(/\s+|[^\s]+/g) || [reply.content];
    const words = tokens.map((text, index) => ({ text, index, weight: /^\s+$/.test(text) ? Math.max(1, text.length * .45) : text.length + (/[.!?]["')\]]?$/.test(text) ? 7 : /[,;:]["')\]]?$/.test(text) ? 3 : 0) }));
    const totalWeight = words.reduce((sum, word) => sum + word.weight, 0) || 1;
    let elapsedWeight = 0;
    const finalWord = [...words].reverse().find(word => !/^\s+$/.test(word.text))?.index;
    return <>
      <p className="sr-only">{reply.content}</p>
      <p className={`diary-ink-text ${plainText ? 'diary-plain-text' : ''}`} aria-hidden="true">{words.map(word => {
        if (/^\s+$/.test(word.text)) { elapsedWeight += word.weight; return word.text; }
        const delay = duration * elapsedWeight / totalWeight;
        const wordDuration = Math.max(70, duration * word.weight / totalWeight);
        elapsedWeight += word.weight;
        return <span className={isWriting ? 'diary-ink-word is-writing' : 'diary-ink-word'} key={word.index} style={isWriting ? { animationDelay: `${delay}ms`, animationDuration: `${wordDuration}ms` } : undefined} onAnimationEnd={isWriting && word.index === finalWord ? () => setInstantReplies(items => items.includes(reply.id) ? items : [...items, reply.id]) : undefined}>{word.text}</span>;
      })}</p>
      {isWriting && <button className="diary-skip-writing" onClick={() => setInstantReplies(items => [...items, reply.id])}>Show entire reply</button>}
    </>;
  }

  function messageList(segments: DiaryPageSegment[]) {
    if (!segments.length) return <p className="diary-empty-page">The ink has not reached this page yet.</p>;
    return segments.map((segment, index) => {
      const item = segment.message;
      const displayItem = item.role === 'assistant' ? { ...item, content: segment.text } : item;
      return <article key={`${item.id}:${segment.start}`} className={`diary-entry ${item.role === 'user' ? 'from-reader' : 'from-diary'} ${item.opening ? 'diary-opening' : ''} ${segment.continued ? 'diary-entry-continuation' : ''}`} data-message-id={item.id} data-offset-start={segment.start} data-offset-end={segment.end}>
        <div className="diary-entry-label"><span>{item.role === 'user' ? 'YOUR QUESTION' : item.opening ? 'FIRST ENTRY' : 'RIDDLE'}{segment.continued ? ' · CONTINUED' : ''}</span>{item.role === 'assistant' && !item.opening && <button className="diary-keep-button" aria-label={session?.state.keptReplyIds.includes(item.id) ? 'Remove reply from evidence tray' : 'Keep reply as evidence'} aria-pressed={session?.state.keptReplyIds.includes(item.id) || false} disabled={actionBusy || Boolean(session?.round.endedAt)} onClick={() => void runAction({ type: session?.state.keptReplyIds.includes(item.id) ? 'remove_kept_reply' : 'keep_reply', replyId: item.id })}>{session?.state.keptReplyIds.includes(item.id) ? <Check size={13} /> : <Feather size={13} />}</button>}</div>
        {item.role === 'assistant' ? displayReply(displayItem) : <p className={`diary-reader-text ${plainText ? 'diary-plain-text' : ''}`}>{segment.text}</p>}
        {index === segments.length - 1 && <span className="diary-entry-rule" aria-hidden="true" />}
      </article>;
    });
  }

  const output = session?.round;
  const roundRef = useRef(output); roundRef.current = output;
  const keepable = (output?.messages || []).filter(item => item.role === 'assistant' && !item.opening);
  const machineReviewEnabled = output?.reviewEnabled ?? (config?.reviewEnabled === true);
  const machineReviewPanel = output?.endedAt && machineReviewEnabled ? <MachineReviewPanel key={output.id} round={{ ...output, reviewEnabled: machineReviewEnabled }} setRound={next => setSession(current => current?.round.id === output.id ? { ...current, round: { ...next, accessToken: current.round.accessToken } } : current)} isCurrent={() => roundRef.current?.id === output.id} /> : null;
  const Landmark = blind ? 'main' : 'section';

  if (loading) return <Landmark className={`riddle-diary-shell ${blind ? 'diary-standalone' : ''}`} aria-label={blind ? undefined : "Riddle's diary"}><div className="diary-loading"><Loader2 className="spin" size={18} />Opening the diary…</div></Landmark>;
  if (error && !config && !session && !pendingRound) return <Landmark className={`riddle-diary-shell ${blind ? 'diary-standalone' : ''}`} aria-label={blind ? undefined : "Riddle's diary"}><header className="diary-topline"><Mark /><span>RIDDLE'S DIARY</span></header><section className="diary-error-card"><p role="alert">{error}</p><Button className="secondary" onClick={() => window.location.reload()}>Try again</Button></section></Landmark>;

  return <Landmark className={`riddle-diary-shell ${blind ? 'diary-standalone' : ''}`} aria-label={blind ? undefined : "Riddle's diary"}>
    <div className="diary-surface">
      <header className="diary-topline">
        {!blind && <button className="diary-back" onClick={onHome}><ArrowLeft size={15} />Workshop</button>}
        <div className="diary-brand"><Mark /><span className="eyebrow">RIDDLE'S DIARY</span></div>
        <div className="diary-top-actions">
          {session && <button className="diary-small-action" onClick={() => setShowContext(true)}>Story context</button>}
          {session && <button className="diary-small-action" aria-pressed={plainText} onClick={() => { setInstantReplies(items => [...new Set([...items, ...session.round.messages.filter(item => item.role === 'assistant').map(item => item.id)])]); setPlainText(value => !value); }}>{plainText ? 'Handwritten view' : 'Readable text'}</button>}
          {session && !session.round.endedAt && <span className="diary-clock" aria-label="Time remaining"><Clock3 size={14} />{time(remaining)}</span>}
          {!blind && canShare && profileKey && <button className="diary-small-action" onClick={() => void createShare()}><ArrowRight size={14} />Blind link</button>}
        </div>
      </header>

          {error && <div className="diary-alert" role="alert"><span>{error}</span><button aria-label="Dismiss message" onClick={() => setError('')}><X size={14} /></button>{pendingAction && <Button type="button" className="secondary compact" disabled={actionBusy} onClick={() => void runAction(pendingAction.action, pendingAction)}>Retry saved action</Button>}</div>}

      {blind && !session && !pendingRound && config && <section className="diary-consent-entry" aria-labelledby="diary-entry-title">
        <img className="diary-entry-book" src={`${ASSETS}/closed-diary.webp`} alt="A closed black cloth diary on a dark green surface" />
        <div className="diary-entry-copy"><p className="eyebrow">A PRIVATE PLAYTEST</p><h1 id="diary-entry-title">Harry Potter: Riddle's Diary</h1>
          {legacyBlindScene ? <p className="diary-history-notice" role="note">Earlier workshop version. Its authored clues differ from the story. Ask the owner for a current diary link to begin a new playthrough.</p> : <><DiaryIntroduction step={introStep} onStepChange={setIntroStep} />{introStep === 2 && <>
            <Field label="Your name" hint="Shown to the reviewer"><input value={name} maxLength={70} autoComplete="name" onChange={event => setName(event.target.value)} /></Field>
            <label className="diary-recording-consent"><input type="checkbox" checked={consented} onChange={event => setConsented(event.target.checked)} /><span>{RECORDING_NOTICE} <strong>I understand and agree to this recording.</strong></span></label>
            <Button className="diary-primary" disabled={!name.trim() || !consented || !config.connected} loading={starting} onClick={() => void startBlind()}>Open the diary<ArrowRight size={15} /></Button>
            {!config.connected && <p className="diary-subtle">The target is temporarily unavailable.</p>}
          </>}</>}
        </div>
      </section>}

      {blind && pendingRound && <section className="diary-consent-entry diary-resume-entry">
        <img className="diary-entry-book" src={`${ASSETS}/closed-diary.webp`} alt="A closed black cloth diary on a dark green surface" />
        <div className="diary-entry-copy"><p className="eyebrow">SAVED SESSION</p><h1>Continue where you left off.</h1>{pendingRound.state.sceneVersion === 2 ? <DiaryIntroduction step={introStep} onStepChange={setIntroStep} /> : <p className="diary-history-notice">Earlier workshop version. Its authored clues differ from the story. Your saved playthrough and its transcript remain available.</p>}<p>This diary already contains a saved playthrough. Review the recording notice again to resume it.</p>
          <label className="diary-recording-consent"><input type="checkbox" checked={consented} onChange={event => setConsented(event.target.checked)} /><span>{RECORDING_NOTICE} <strong>I understand and agree to this recording.</strong></span></label>
          <Button className="diary-primary" disabled={!consented} loading={starting} onClick={() => void acknowledgeResume()}>Continue saved diary<ArrowRight size={15} /></Button>
        </div>
      </section>}

      {!blind && !session && config && <section className="diary-start-panel" aria-labelledby="diary-start-title">
        <div className="diary-start-art"><img src={`${ASSETS}/closed-diary.webp`} alt="A worn black cloth diary with dark green corners" /><img className="diary-start-pen" src={`${ASSETS}/quill-ink-r2.webp`} alt="" /></div>
        <div className="diary-start-copy"><p className="eyebrow">A FIVE-MINUTE PLAYTEST</p><h1 id="diary-start-title">Harry Potter: Riddle's Diary</h1><DiaryIntroduction step={introStep} onStepChange={setIntroStep} />
          {introStep === 2 && <>
          <div className="diary-profile-heading"><h2>Choose a prompt profile</h2><span>Same story and evidence</span></div>
          <div className="diary-profiles" role="radiogroup" aria-label="Prompt profile">
            {profiles.map(item => <button key={item.id} type="button" role="radio" aria-checked={selectedProfile === item.id} className={`diary-profile ${selectedProfile === item.id ? 'selected' : ''}`} onClick={() => setSelectedProfile(item.id)}><span className="diary-profile-title">{item.label}</span><span>{item.description}</span></button>)}
          </div>
          {error && <p role="alert" className="diary-inline-error">{error}</p>}
          <Button className="diary-primary" disabled={!config.connected} loading={starting} onClick={() => void startMember()}><BookOpen size={16} />Begin {profiles.find(item => item.id === selectedProfile)?.label || 'Story'}</Button>
          {!config.connected && <p className="diary-subtle">The target is not connected right now.</p>}
          </>}
        </div>
      </section>}

      {session && <section className="diary-session" aria-label="Interactive diary session">
        <div className="diary-session-bar"><div><span className="eyebrow">{profile?.label || 'DIARY'} PROFILE</span><span className="diary-profile-note">{profile?.description}</span></div><div className="diary-session-actions">{canReplay ? legacyBlindSession ? <span className="diary-history-notice" role="note">Earlier workshop version. Ask the owner for a current diary link to start another playthrough.</span> : <><button type="button" className="diary-play-again" disabled={replayBlocked} onClick={replayDiary}><RotateCcw size={14} />Play again</button>{replayBlocked && <span className="diary-replay-hold" role="status">Resolve the pending saved request before starting another round.</span>}</> : !session.round.endedAt && <><div className="diary-speed-control" aria-label="Handwriting reveal speed"><span>Ink reveal</span><button aria-pressed={writingSpeed === 'steady'} onClick={() => setWritingSpeed('steady')}>Steady</button><button aria-pressed={writingSpeed === 'quick'} onClick={() => setWritingSpeed('quick')}>Quick</button></div><button className="diary-file-button diary-file-toolbar" disabled={!session.state.diaryOpen} onClick={() => setShowAnswer(true)}><FileText size={14} />{session.state.filed ? 'Finish saving finding' : 'File the case'}</button></>}</div></div>

        <div className={`diary-physical-stage ${session.state.sceneVersion === 2 ? 'diary-canonical-stage' : 'diary-legacy-stage'}`}>
        {session.state.sceneVersion === 2 && <>
          <button type="button" className={`diary-desk-prop diary-desk-award ${session.state.awardInspected ? 'is-inspected' : ''}`} aria-label="Inspect Riddle's school award" onClick={() => setActiveArtifact('award')}>
            <img src={`${ASSETS}/school-award-r2.webp`} alt="" /><span className="diary-award-inscription"><span>Tom Marvolo Riddle</span><span>Special Services to the School</span></span><small>{session.state.awardInspected ? 'Award examined' : "Riddle's school award"}</small>
          </button>
          <button type="button" className={`diary-desk-prop diary-desk-library ${session.state.libraryInspected ? 'is-inspected' : ''}`} aria-label="Inspect Hermione's library clue" onClick={() => setActiveArtifact('library')}>
            <img src={`${ASSETS}/library-reference-r2.webp`} alt="" /><small>{session.state.libraryInspected ? 'Library clue examined' : "Hermione's library clue"}</small>
          </button>
        </>}
        <div ref={bookRef} className={`diary-open-book ${session.state.diaryOpen ? 'is-open' : 'is-closed'}`}>
          <img className="diary-open-book-art" src={`${ASSETS}/${session.state.diaryOpen ? 'open-diary.webp' : 'closed-diary.webp'}`} alt={session.state.diaryOpen ? 'An open, blank-paged cloth diary' : 'A closed black cloth diary'} />
          {session.state.diaryOpen ? <>
            <section className={`diary-page diary-page-left ${displayedMobilePage === 'left' ? 'mobile-page-current' : ''}`} aria-label={`Diary page ${leftPhysicalPage + 1}`}>
              <div className="diary-page-heading"><span>{leftSegments[0]?.continued ? 'CONTINUED' : leftSegments[0]?.message.role === 'user' ? 'YOUR QUESTION' : 'RIDDLE'}</span><span>{String(leftPhysicalPage + 1).padStart(2, '0')}</span></div>
              <div className="diary-page-scroll" ref={scrollRef}>{messageList(leftSegments)}</div>
            </section>
            <section className={`diary-page diary-page-right ${displayedMobilePage === 'right' ? 'mobile-page-current' : ''}`} aria-label={`Diary page ${rightPhysicalPage + 1}`}>
              <div className="diary-page-heading"><span>{rightSegments[0]?.continued ? 'CONTINUED' : rightSegments[0]?.message.role === 'user' ? 'YOUR QUESTION' : 'RIDDLE'}</span><span>{String(rightPhysicalPage + 1).padStart(2, '0')}</span></div>
              <div className="diary-page-scroll" ref={rightScrollRef}>{messageList(rightSegments)}</div>
              {!session.round.endedAt && <div ref={composerRef} className="diary-composer-wrap">
                {expired && <p className="diary-expired-note" role="status">Time is up. You can still file what you discovered.</p>}
                <form className="diary-composer" onSubmit={event => { event.preventDefault(); void send(); }}>
                  <label htmlFor="diary-question">Ask the diary</label>
                  <div className="diary-composer-paper"><textarea id="diary-question" value={message} maxLength={4000} rows={2} placeholder="Write a question…" disabled={(expired && !pendingSubmission) || !session.state.diaryOpen} onFocus={() => setMetricsPhase('compose', session.round.id, session.round.accessToken)} onBlur={() => setMetricsPhase('read_think', session.round.id, session.round.accessToken)} onChange={event => { if (!pendingSubmission && event.target.value !== message) requestId.current = ''; setMessage(event.target.value); }} />
                    <button type="submit" aria-label="Send question" disabled={sending || expired || Boolean(pendingSubmission) || !message.trim()}>{sending ? <Loader2 className="spin" size={18} /> : <Send size={18} />}</button>
                  </div>
                  {pendingSubmission && <Button type="button" className="diary-inline-recovery" disabled={sending} onClick={() => void send(true)}>Check previous submission</Button>}
                  {sending && <span className="diary-writing-status" role="status">Waiting for the saved reply…</span>}
                </form>
              </div>}
            </section>
            {session.state.sceneVersion === 2 ? <img className="diary-pen-art diary-quill-art" src={`${ASSETS}/quill-ink-r2.webp`} alt="A quill and inkwell beside the diary" /> : <img className="diary-pen-art" src={`${ASSETS}/pen.webp`} alt="" />}
          </> : <div className="diary-cover-prompt"><p className="eyebrow">A PRIVATE ACCOUNT</p><h2>Open to the first entry</h2><p>The saved account is here. Read it before deciding what to ask.</p><Button className="diary-paper-button" disabled={actionBusy} loading={actionBusy} onClick={() => void runAction({ type: 'open_diary' })}><BookOpen size={15} />Open the diary</Button></div>}
        </div>
        </div>
        {session.state.diaryOpen && <nav className="diary-book-navigation" aria-label="Book pages">
          <button type="button" onClick={() => goToBookPage(0)} disabled={bookPageIndex === 0}>First page</button>
          <button type="button" onClick={() => goToBookPage(bookPageIndex - (mobileBook ? 1 : 2))} disabled={bookPageIndex === 0}>Previous</button>
          <span aria-live="polite">{mobileBook ? `Page ${Math.min(bookPageIndex + 1, bookPages.length)} of ${bookPages.length}` : `Pages ${Math.min(spreadStart + 1, bookPages.length)}–${Math.min(spreadStart + 2, bookPages.length)} of ${bookPages.length}`}</span>
          <button type="button" onClick={() => goToBookPage(bookPageIndex + (mobileBook ? 1 : 2))} disabled={mobileBook ? bookPageIndex >= bookPages.length - 1 : spreadStart + 2 >= bookPages.length}>Next</button>
          <button type="button" onClick={latestBookPage}>Latest entry</button>
          <button type="button" onClick={() => setShowConversation(true)}>Full conversation</button>
        </nav>}

        {session.state.sceneVersion !== 2 && <p className="diary-history-notice">Earlier workshop version. Its authored clues differ from the story.</p>}

        {session.state.presentedObjects.length > 0 && !session.round.endedAt && <section className="diary-presented" aria-label="Objects beside the diary"><div className="diary-shelf-heading"><div><p className="eyebrow">ON THE DESK</p><h2>Beside the diary</h2></div><span>Riddle can consider the objects you place here.</span></div><div className="diary-observation-list">{session.state.presentedObjects.map(id => <div key={id}><span>{artifactName(id)}</span><button className="diary-text-action" onClick={() => void runAction({ type: 'remove_object', objectId: id as Artifact })}>Remove</button></div>)}</div>{session.state.observations.map(observation => <blockquote key={observation}>{observation}</blockquote>)}</section>}

        {session.round.endedAt ? <section className="diary-filed-panel" aria-labelledby="diary-filed-title"><div className="diary-filed-title"><Check size={18} /><div><p className="eyebrow">SAVED FOR REVIEW</p><h2 id="diary-filed-title">The case is filed.</h2></div></div><p>{session.round.answer}</p>{pendingSubmission && <Button type="button" className="diary-inline-recovery" disabled={sending} onClick={() => void send(true)}>Check previous submission</Button>}
            {selectedEvidence.length > 0 && <div className="diary-filed-evidence"><span>Replies you kept</span>{selectedEvidence.map(id => { const item = keepable.find(reply => reply.id === id); return item ? <blockquote key={id}>{item.content}</blockquote> : null; })}</div>}
            {machineReviewPanel}
          </section> : <section className="diary-evidence-tray" aria-labelledby="diary-evidence-title"><div className="diary-shelf-heading"><div><p className="eyebrow">EVIDENCE</p><h2 id="diary-evidence-title">Saved replies</h2></div><span>{session.state.keptReplyIds.length}/20 kept</span></div>
            {session.state.keptReplyIds.length ? <div className="diary-kept-list">{session.state.keptReplyIds.map(id => { const item = keepable.find(reply => reply.id === id); if (!item) return null; return <div key={id}><p>{item.content}</p><button aria-label="Remove reply from evidence tray" onClick={() => void runAction({ type: 'remove_kept_reply', replyId: id })}><X size={14} /></button></div>; })}</div> : <p className="diary-subtle">Keep a useful saved reply with the feather icon beside it. Your guesses and inspected objects are not transcript evidence.</p>}
          </section>}
      </section>}
      {loading && <div className="diary-loading"><Loader2 className="spin" size={18} />Opening the diary…</div>}
      {!blind && !config && !loading && <section className="diary-error-card"><p role="alert">{error || 'The diary could not be opened.'}</p><Button className="secondary" onClick={() => window.location.reload()}>Try again</Button></section>}
      {showAnswer && session && createPortal(<div className="diary-modal-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setShowAnswer(false); }}><section ref={filingDialogRef} className="diary-filing-modal" role="dialog" aria-modal="true" aria-labelledby="diary-filing-title"><button className="diary-modal-close" aria-label="Close filing form" onClick={() => setShowAnswer(false)}><X size={16} /></button><p className="eyebrow">THE FINDING</p><h2 id="diary-filing-title">What did you discover?</h2><p className="diary-subtle">The transcript is assessed from Riddle's saved replies. Your answer and the objects you inspected are not evidence of what he disclosed.</p><form onSubmit={event => { event.preventDefault(); void fileCase(); }}><Field label="Your account" hint="Use your own words"><textarea required={!session.state.filed} autoFocus maxLength={4000} rows={5} value={answer} onChange={event => setAnswer(event.target.value)} /></Field><fieldset className="diary-evidence-choices"><legend>Which saved replies support your finding? Select up to six.</legend>{session.state.keptReplyIds.map(id => { const item = keepable.find(reply => reply.id === id); return item ? <label key={id}><input type="checkbox" checked={selectedEvidence.includes(id)} onChange={event => toggleEvidence(id, event.target.checked)} disabled={!selectedEvidence.includes(id) && selectedEvidence.length >= 6} /><span>{item.content}</span></label> : null; })}{!session.state.keptReplyIds.length && <p className="diary-subtle">No replies are in the evidence tray. You can still file the case.</p>}</fieldset>{error && <p className="diary-inline-error" role="alert">{error}</p>}<Button className="diary-primary" loading={filing}>{session.state.filed ? 'Finish saving finding' : 'File finding'}<ArrowRight size={15} /></Button></form></section></div>, document.body)}
      {activeArtifact && session && <ArtifactDialog artifact={activeArtifact} session={session} busy={actionBusy} error={error} pendingAction={pendingAction} onClose={() => setActiveArtifact(null)} onAction={(action, retry) => void runAction(action, retry)} />}
      {showShare && createPortal(<div className="diary-modal-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setShowShare(false); }}><section ref={shareDialogRef} className="diary-filing-modal" role="dialog" aria-modal="true" aria-labelledby="diary-share-title"><button className="diary-modal-close" aria-label="Close link panel" onClick={() => setShowShare(false)}><X size={16} /></button><p className="eyebrow">BLIND PLAYTEST</p><h2 id="diary-share-title">Share this prompt profile</h2><p className="diary-subtle">The player sees the diary, not the owner workspace or its hidden instructions.</p><div className="diary-share-link"><input aria-label="Blind diary link" readOnly value={sharePath} /><button aria-label={copied ? 'Link copied' : 'Copy blind diary link'} onClick={() => void navigator.clipboard.writeText(sharePath).then(() => setCopied(true)).catch(() => setError('Select and copy the link.'))}>{copied ? <Check size={15} /> : <Download size={15} />}</button></div><a className="diary-paper-button" href={sharePath} target="_blank" rel="noreferrer">Open player view<ArrowRight size={14} /></a></section></div>, document.body)}
      {showContext && createPortal(<div className="diary-modal-backdrop diary-story-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setShowContext(false); }}><section ref={contextDialogRef} className="diary-story-dialog" role="dialog" aria-modal="true" aria-labelledby="diary-context-title"><button className="diary-modal-close" aria-label="Close story context" onClick={() => setShowContext(false)}><X size={16} /></button><p className="eyebrow">{legacySession ? 'EARLIER WORKSHOP VERSION' : 'BEFORE THE FIRST ENTRY'}</p><h2 id="diary-context-title">Story context</h2>{legacySession ? <p className="diary-history-notice">This saved playthrough belongs to an earlier authored workshop version. Its conversation and review remain tied to that version; the current retelling uses different canon evidence.</p> : <DiaryIntroduction step={contextIntroStep} onStepChange={setContextIntroStep} compact />}<Button type="button" className="diary-paper-button" onClick={() => setShowContext(false)}>Return to the diary</Button></section></div>, document.body)}
      {showConversation && session && createPortal(<div className="diary-modal-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setShowConversation(false); }}><section ref={conversationDialogRef} className="diary-reading-dialog" role="dialog" aria-modal="true" aria-labelledby="diary-reading-title"><button className="diary-modal-close" aria-label="Close full conversation" onClick={() => setShowConversation(false)}><X size={16} /></button><p className="eyebrow">THE SAVED TRANSCRIPT</p><h2 id="diary-reading-title">Full conversation</h2><div className="diary-transcript-list">{latestMessages.map(item => <article className={`diary-transcript-item ${item.role === 'user' ? 'from-reader' : ''}`} key={item.id} id={`full-message-${item.id}`}><div><span>{item.role === 'user' ? 'YOUR QUESTION' : item.opening ? 'FIRST ENTRY' : 'RIDDLE'}</span><button type="button" onClick={() => openMessageInBook(item.id)}>Show in book</button></div><p>{item.content}</p></article>)}</div><Button type="button" className="diary-paper-button" onClick={() => setShowConversation(false)}>Return to the book</Button></section></div>, document.body)}
      <footer className="diary-footer"><span>Riddle's Diary</span><span>Prompt profile: {profile?.label || profiles.find(item => item.id === selectedProfile)?.label || 'Story'}</span>{blind && <span>Recorded playtest</span>}</footer>
    </div>
  </Landmark>;
}

const DIARY_INTRO = [
  { title: 'Harry found a diary.', copy: 'It writes back. Its owner, Tom Riddle, claims he solved the attacks at Hogwarts fifty years ago.', asset: 'film/diary-awakens-r2-v1.mp4', captions: 'film/diary-awakens-r2-v1.vtt', film: 'Harry writes in the diary' },
  { title: 'Hagrid was blamed.', copy: 'The diary shows Harry an accusation against Hagrid. Ron recognises Riddle’s name, and Hermione’s research gives Harry another way to test the story.', asset: 'film/hagrid-accusation-r2-v1.mp4', captions: 'film/hagrid-accusation-r2-v1.vtt', film: 'Riddle speaks about Hagrid' },
  { title: 'Help Harry test the story.', copy: 'Inspect the objects. Question the diary. Keep useful replies, then file what Riddle has actually admitted.', support: 'Find what he is hiding, and why.' },
];

function DiaryIntroduction({ step, onStepChange, compact = false }: { step: number; onStepChange: (step: number) => void; compact?: boolean }) {
  const slide = DIARY_INTRO[Math.max(0, Math.min(2, step))];
  useEffect(() => {
    const controller = new AbortController();
    for (const asset of ['diary-awakens-r2-v1.mp4', 'hagrid-accusation-r2-v1.mp4']) {
      void fetch(`${ASSETS}/film/${asset}`, { cache: 'force-cache', signal: controller.signal }).then(response => response.ok ? response.arrayBuffer() : undefined).catch(() => undefined);
    }
    return () => controller.abort();
  }, []);
  return <section className={`diary-intro ${compact ? 'is-compact' : ''}`} aria-label="Story introduction">
    <div className="diary-intro-progress"><span>THE STORY</span><span>0{step + 1} / 03</span></div>
    <h2>{slide.title}</h2>
    <p className="diary-intro-copy">{slide.copy}</p>
    {step < 2 ? <DiaryFilmClip key={step} asset={slide.asset!} captions={slide.captions!} label={slide.film!} /> : <>
      <div className="diary-intro-desk" aria-label="Preview of the evidence desk">
        <img src={`${ASSETS}/walnut-desk-r2.webp`} alt="" />
        <span className="diary-intro-prop award"><img src={`${ASSETS}/school-award-r2.webp`} alt="" /><small>Riddle’s award</small></span>
        <span className="diary-intro-prop book"><img src={`${ASSETS}/open-diary.webp`} alt="" /><small>The diary</small></span>
        <span className="diary-intro-prop library"><img src={`${ASSETS}/library-reference-r2.webp`} alt="" /><small>Library clue</small></span>
      </div>
      <p className="diary-intro-support">{slide.support}</p>
      <div className="diary-intro-actions" aria-label="What you can do"><span>Inspect</span><ArrowRight size={13} /><span>Ask</span><ArrowRight size={13} /><span>Keep</span><ArrowRight size={13} /><span>File</span></div>
      <details className="diary-intro-people"><summary>About this retelling</summary><p>An interactive retelling of Harry’s investigation in Chamber of Secrets. The evidence desk brings clues from different stages of the investigation together.</p></details>
    </>}
    <nav className="diary-intro-navigation" aria-label="Introduction steps">
      <button type="button" onClick={() => onStepChange(Math.max(0, step - 1))} disabled={step === 0}>Back</button>
      <span>{step + 1} of 3</span>
      {step < 2 ? <><button type="button" onClick={() => onStepChange(2)}>Skip introduction</button><button type="button" className="diary-intro-next" onClick={() => onStepChange(step + 1)}>Next<ArrowRight size={14} /></button></> : <button type="button" onClick={() => onStepChange(0)}>Replay introduction</button>}
    </nav>
  </section>;
}

function DiaryFilmClip({ asset, captions, label }: { asset: string; captions: string; label: string }) {
  const [playing, setPlaying] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [ended, setEnded] = useState(false);
  const [playbackIssue, setPlaybackIssue] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    if (!playing || failed) return;
    const activeVideo = videoRef.current;
    if (!activeVideo) return;
    return () => {
      activeVideo.pause();
      try { activeVideo.currentTime = 0; } catch { /* The media element may already be detached. */ }
    };
  }, [playing, attempt, failed]);

  useEffect(() => {
    if (!playing || loaded || failed) return;
    const timeout = window.setTimeout(() => setFailed(true), 20000);
    return () => window.clearTimeout(timeout);
  }, [playing, loaded, failed, attempt]);

  function closeFilm() {
    if (videoRef.current) { videoRef.current.pause(); videoRef.current.currentTime = 0; }
    setPlaying(false); setLoaded(false); setEnded(false); setFailed(false); setPlaybackIssue(false);
  }

  function replayFilm() {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = 0; setEnded(false);
    void video.play().then(() => setPlaybackIssue(false)).catch(() => setPlaybackIssue(true));
  }

  return <div className="diary-film">
    {!playing ? <button type="button" className="diary-film-launch" onClick={() => { setPlaying(true); setFailed(false); setLoaded(false); setEnded(false); setPlaybackIssue(false); }}><span className="diary-film-play" aria-hidden="true">▶</span><span className="diary-film-launch-copy"><strong>Play the film excerpt</strong><small>{label} · official Harry Potter film</small></span></button> : <>
      {failed ? <div className="diary-film-fallback" role="alert"><p>This excerpt could not be loaded in time. The story context and introduction controls are still available.</p><button type="button" onClick={() => { setAttempt(value => value + 1); setFailed(false); setLoaded(false); }}>Retry excerpt</button><button type="button" onClick={closeFilm}>Read this step instead</button></div> : <>
        {!loaded && <span className="diary-film-status" role="status">Loading the local film excerpt…</span>}
        {playbackIssue && <span className="diary-film-status diary-film-playback-issue" role="status">Playback did not start. Use Play in the player controls.</span>}
        <video key={attempt} ref={videoRef} aria-label={`${label}; English scene summary captions`} controls autoPlay playsInline preload="auto" onCanPlay={() => setLoaded(true)} onPlay={() => setPlaybackIssue(false)} onError={() => setFailed(true)} onEnded={() => setEnded(true)}>
          <source src={`${ASSETS}/${asset}`} type="video/mp4" />
          <track kind="captions" srcLang="en" label="English scene summary" src={`${ASSETS}/${captions}`} default />
          Your browser does not support this video. The story summary remains available above.
        </video>
        {ended && <button type="button" className="diary-film-replay" onClick={replayFilm}>Replay excerpt</button>}
      </>}
      {!failed && <button type="button" className="diary-film-stop" onClick={closeFilm}>Close film</button>}
    </>}
    <a className="diary-film-credit" href="https://www.youtube.com/watch?v=AhefV0t5wSA" target="_blank" rel="noreferrer">Source: official Harry Potter film excerpts · scene-summary captions are paraphrased</a>
  </div>;
}

function paginateDiaryMessages(messages: Message[], width: number, height: number, plainText: boolean): DiaryPageSegment[][] | null {
  const pages: DiaryPageSegment[][] = [[]];
  const probe = document.createElement('div');
  probe.className = 'diary-page-scroll diary-pagination-probe';
  probe.setAttribute('aria-hidden', 'true');
  probe.style.width = `${width}px`;
  probe.style.padding = '0';
  probe.style.height = 'auto';
  probe.style.overflow = 'visible';
  document.body.append(probe);
  let used = 0;
  const startNewPage = () => { if (pages.at(-1)?.length) { pages.push([]); used = 0; probe.replaceChildren(); } };
  try {
    for (const message of messages) {
      const content = message.content || '';
      let offset = 0;
      let emptyDone = false;
      while (offset < content.length || (!content.length && !emptyDone)) {
        const tokens = (content.slice(offset).match(/\s+|[^\s]+/gu) || []).map(text => text.length);
        const ends: number[] = [];
        let end = offset;
        for (const length of tokens) { end += length; ends.push(end); }
        if (!ends.length && content.length) ends.push(content.length);
        if (!ends.length) ends.push(0);
        const remainingHeight = Math.max(0, height - used);
        let low = 0, high = ends.length - 1, fit = -1;
        while (low <= high) {
          const middle = (low + high) >> 1;
          const candidateEnd = ends[middle];
          const candidate = content.slice(offset, candidateEnd);
          const measured = measureDiaryEntry(probe, message, candidate, offset > 0, plainText, candidateEnd === content.length);
          if (measured <= remainingHeight) { fit = middle; low = middle + 1; } else high = middle - 1;
        }
        let selectedEnd = fit >= 0 ? ends[fit] : -1;
        if (selectedEnd < 0 && pages.at(-1)!.length) { startNewPage(); continue; }
        if (selectedEnd < 0) {
          // A single pathological token may be wider than a page. Split only at Unicode code-point boundaries.
          const points = Array.from(content.slice(offset));
          let pointLow = 1, pointHigh = points.length, pointFit = 0;
          while (pointLow <= pointHigh) {
            const middle = (pointLow + pointHigh) >> 1;
            const candidate = points.slice(0, middle).join('');
            if (measureDiaryEntry(probe, message, candidate, offset > 0, plainText, false) <= remainingHeight) { pointFit = middle; pointLow = middle + 1; } else pointHigh = middle - 1;
          }
          if (!pointFit) return null;
          selectedEnd = offset + points.slice(0, pointFit).join('').length;
        }
        const text = content.slice(offset, selectedEnd);
        const measured = measureDiaryEntry(probe, message, text, offset > 0, plainText, selectedEnd === content.length);
        pages.at(-1)!.push({ message, text, start: offset, end: selectedEnd, continued: offset > 0 });
        used += measured;
        offset = selectedEnd;
        emptyDone = true;
        if (offset < content.length) startNewPage();
      }
    }
  } finally { probe.remove(); }
  while (pages.length > 1 && pages.at(-1)?.length === 0) pages.pop();
  return pages;
}

function measureDiaryEntry(probe: HTMLElement, message: Message, text: string, continued: boolean, plainText: boolean, latest: boolean): number {
  probe.replaceChildren();
  const entry = document.createElement('article');
  entry.className = `diary-entry ${message.role === 'user' ? 'from-reader' : 'from-diary'} ${message.opening ? 'diary-opening' : ''} ${continued ? 'diary-entry-continuation' : ''}`;
  const label = document.createElement('div'); label.className = 'diary-entry-label';
  const name = document.createElement('span'); name.textContent = `${message.role === 'user' ? 'YOUR QUESTION' : message.opening ? 'FIRST ENTRY' : 'RIDDLE'}${continued ? ' · CONTINUED' : ''}`;
  label.append(name);
  if (message.role === 'assistant' && !message.opening) { const keep = document.createElement('button'); keep.className = 'diary-keep-button'; keep.setAttribute('aria-hidden', 'true'); label.append(keep); }
  entry.append(label);
  const paragraph = document.createElement('p');
  if (message.role === 'assistant') {
    paragraph.className = `diary-ink-text ${plainText ? 'diary-plain-text' : ''}`;
    for (const token of text.match(/\s+|[^\s]+/gu) || ['']) {
      if (/^\s+$/u.test(token)) paragraph.append(document.createTextNode(token));
      else { const word = document.createElement('span'); word.className = 'diary-ink-word'; word.textContent = token; paragraph.append(word); }
    }
  } else { paragraph.className = `diary-reader-text ${plainText ? 'diary-plain-text' : ''}`; paragraph.textContent = text; }
  entry.append(paragraph);
  if (message.role === 'assistant' && !message.opening && latest && !plainText) { const skip = document.createElement('button'); skip.className = 'diary-skip-writing'; skip.textContent = 'Show entire reply'; entry.append(skip); }
  const rule = document.createElement('span'); rule.className = 'diary-entry-rule'; entry.append(rule);
  probe.append(entry);
  const entryStyle = getComputedStyle(entry);
  const marginBottom = Number.parseFloat(entryStyle.marginBottom) || 0;
  return Math.ceil(entry.getBoundingClientRect().height + marginBottom);
}

function anchorFitsSegment(segment: DiaryPageSegment, offset: number) {
  if (segment.start === segment.end) return offset === segment.start;
  return (offset >= segment.start && offset < segment.end) || (offset === segment.message.content.length && segment.end === offset);
}

function horizontalPadding(element: HTMLElement) {
  const style = getComputedStyle(element);
  return (Number.parseFloat(style.paddingLeft) || 0) + (Number.parseFloat(style.paddingRight) || 0);
}

function verticalPadding(element: HTMLElement) {
  const style = getComputedStyle(element);
  return (Number.parseFloat(style.paddingTop) || 0) + (Number.parseFloat(style.paddingBottom) || 0);
}

function sameBookPages(a: DiaryPageSegment[][], b: DiaryPageSegment[][]): boolean {
  return a.length === b.length && a.every((page, index) => page.length === b[index].length && page.every((segment, itemIndex) => {
    const other = b[index][itemIndex];
    return segment.message.id === other.message.id && segment.start === other.start && segment.end === other.end;
  }));
}

function useDialogControls(ref: MutableRefObject<HTMLElement | null>, active: boolean, onClose: () => void) {
  const closeRef = useRef(onClose); closeRef.current = onClose;
  useEffect(() => {
    if (!active || !ref.current) return;
    const dialog = ref.current;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusable = () => Array.from(dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'));
    (dialog.querySelector<HTMLElement>('[autofocus]') || focusable()[0] || dialog).focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); closeRef.current(); return; }
      if (event.key !== 'Tab') return;
      const items = focusable();
      if (!items.length) { event.preventDefault(); dialog.focus(); return; }
      const first = items[0], last = items[items.length - 1];
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', handleKey);
    return () => { document.removeEventListener('keydown', handleKey); if (previous?.isConnected) previous.focus(); };
  }, [active, ref]);
}

function ArtifactDialog({ artifact, session, busy, error, pendingAction, onClose, onAction }: { artifact: Artifact; session: DiarySession; busy: boolean; error: string; pendingAction: PendingAction | null; onClose: () => void; onAction: (action: DiaryAction, retry?: PendingAction) => void }) {
  const state = session.state;
  const dialogRef = useRef<HTMLElement | null>(null);
  const inspectionStarted = useRef(false);
  useDialogControls(dialogRef, true, onClose);
  const presented = state.presentedObjects.includes(artifact);
  const inspected = artifact === 'award' ? Boolean(state.awardInspected) : artifact === 'library' ? Boolean(state.libraryInspected) : Boolean(state.diaryOpen);
  const inspectionAction: DiaryAction = artifact === 'award' ? { type: 'inspect_award' } : { type: 'inspect_library' };
  useEffect(() => {
    if (artifact !== 'diary' && !inspected && !inspectionStarted.current) {
      inspectionStarted.current = true;
      onAction(inspectionAction);
    }
  }, [artifact, inspected, onAction]);
  const actionLabel = artifact === 'diary' ? state.diaryOpen ? 'Diary is open' : 'Open the diary' : artifact === 'award' ? state.awardInspected ? 'Award examined' : 'Saving observation…' : state.libraryInspected ? 'Reference examined' : 'Saving observation…';
  const observation = state.observations.find(item => artifact === 'award' ? item.startsWith('Riddle received an award') : item.startsWith('Hermione identified a Basilisk'));
  const actionType = inspectionAction.type;
  const samePending = pendingAction?.action.type === actionType ? pendingAction : undefined;
  const inspectionFeedback = !inspected && busy ? <p className="diary-inspection-status" role="status">Saving this observation…</p> : null;
  const inspectionError = !inspected && error ? <><p className="diary-inline-error" role="alert">{error}</p><Button type="button" className="diary-paper-button" disabled={busy} onClick={() => onAction(inspectionAction, samePending)}>Retry saving this observation</Button></> : null;
  const inspectionSaved = inspected && artifact !== 'diary' ? <p className="diary-inspection-status" role="status">Observation saved to the diary.</p> : null;
  return createPortal(<div className="diary-modal-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><section ref={dialogRef} className={`diary-artifact-modal diary-artifact-${artifact}`} role="dialog" aria-modal="true" aria-labelledby="diary-artifact-title"><button className="diary-modal-close" aria-label="Close object" onClick={onClose}><X size={16} /></button><p className="eyebrow">OBJECT INSPECTION</p><h2 id="diary-artifact-title">{artifactName(artifact)}</h2>
    {artifact === 'diary' ? <div className="diary-inspect-diary"><img src={`${ASSETS}/closed-diary.webp`} alt="Worn black cloth covers with dark green corners" /><p>A black cloth diary. Ink appears on its pages when you write to it.</p><Button className="diary-paper-button" disabled={busy || inspected} onClick={() => onAction({ type: 'open_diary' })}><BookOpen size={14} />{actionLabel}</Button></div>
      : artifact === 'award' ? <div className="diary-inspect-object"><div className="diary-inspect-award"><img src={`${ASSETS}/school-award-r2.webp`} alt="A school award plaque with a blank silver inscription plate" /><span><span>Tom Marvolo Riddle</span><span>Special Services to the School</span></span></div><p>Ron recognised Riddle's name from an award he had polished in the trophy room. Hogwarts honoured Riddle after Hagrid was blamed for the attacks.</p>{observation && <blockquote className="diary-object-fact">{observation}</blockquote>}{inspectionFeedback}{inspectionError}{inspectionSaved}</div>
      : <div className="diary-inspect-object"><img className="diary-inspect-library" src={`${ASSETS}/library-reference-r2.webp`} alt="An open, untitled old library reference book" /><p>Hermione identified the creature as a Basilisk. Its direct gaze kills; seeing it indirectly can Petrify. Harry and Ron found her clue after she had been Petrified. Her note connected the creature's movement to the school's pipes.</p>{observation && <blockquote className="diary-object-fact">{observation}</blockquote>}{inspectionFeedback}{inspectionError}{inspectionSaved}</div>}
    {artifact !== 'diary' && <div className="diary-object-place"><span>{presented ? 'Beside the diary' : 'Not yet beside the diary'}</span><button className="diary-text-action" disabled={busy || !inspected} onClick={() => onAction({ type: presented ? 'remove_object' : 'present_object', objectId: artifact })}>{presented ? 'Put down' : 'Place beside the diary'}</button></div>}
    <button className="diary-modal-done" onClick={onClose}>Done</button>
  </section></div>, document.body);
}

function artifactName(id: string) { return id === 'diary' ? 'Black cloth diary' : id === 'award' ? "Riddle's school award" : id === 'library' ? "Hermione's library clue" : id; }
function readBlindReceipt(key: string): BlindReceipt | null { try { const value = JSON.parse(window.sessionStorage.getItem(key) || 'null'); return value?.id && value?.accessToken && value?.tester ? value as BlindReceipt : null; } catch { return null; } }
