import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MutableRefObject } from 'react';
import { createPortal } from 'react-dom';
import '@fontsource-variable/caveat/wght.css';
import './riddle-diary.css';
import { ArrowLeft, ArrowRight, BookOpen, Check, ChevronDown, ChevronLeft, ChevronRight, Clock3, Download, Eye, Feather, FileText, Loader2, Move, PenLine, RotateCcw, Send, X } from 'lucide-react';
import { api, ApiError, RECORDING_NOTICE, RECORDING_NOTICE_VERSION, setRecordingAcknowledged, time } from './api';
import type { MachineReview, Message, Round } from './types';
import { Button, Field, Mark } from './ui';
import { MachineReviewPanel } from './MachineReviewPanel';
import { recordMetricsInteraction, recordMetricsReply, setMetricsPhase } from './telemetry';

type DiaryProfile = { id: string; label: string; description: string; versionId?: string; scenarioId?: string; profileId?: string; profileRevision?: number; promptHash?: string; snapshotHash?: string };
type DiaryState = { revision: number; page: 'memory' | 'response'; diaryOpen: boolean; fragmentAligned: boolean; letterOpen: boolean; presentedObjects: string[]; keptReplyIds: string[]; observations: string[]; filed: boolean; filedEvidenceIds: string[] };
type DiaryRound = Round & { diary?: DiaryProfile; accessToken?: string; reviewEnabled?: boolean; machineReview?: MachineReview | null };
type DiarySession = { round: DiaryRound; state: DiaryState; diary: DiaryProfile };
type DiaryConfig = { title: string; scenarioId: string; profiles: DiaryProfile[]; connected: boolean; recordingNoticeRequired?: boolean; reviewEnabled?: boolean; profile?: DiaryProfile; activeRoundId?: string | null };
type DiaryAction = { type: 'open_diary' | 'turn_page' | 'align_fragment' | 'open_letter' } | { type: 'present_object' | 'remove_object'; objectId: 'diary' | 'fragment' | 'letter' } | { type: 'keep_reply' | 'remove_kept_reply'; replyId: string };
type PendingAction = { id: string; action: DiaryAction };
type BlindReceipt = { id: string; accessToken: string; tester: string };
type Artifact = 'diary' | 'fragment' | 'letter';

const ASSETS = '/diary-assets';
const LETTER_TEXT = 'Dear Mr Riddle,\n\nI have been asked to consider whether the school can continue next term. If Hogwarts closes, you will need to return to the orphanage until another school can be found. I can make no promises before the governors meet.\n\nYours sincerely,\nA. Dippet';

export function RiddleDiary({ blindToken, canShare = false, onHome }: { blindToken?: string; canShare?: boolean; onHome?: () => void }) {
  const blind = Boolean(blindToken);
  const receiptKey = `workshop-diary-play:${blindToken || ''}`;
  const [config, setConfig] = useState<DiaryConfig | null>(null);
  const [session, setSession] = useState<DiarySession | null>(null);
  const [pendingRound, setPendingRound] = useState<DiarySession | null>(null);
  const [pageOverride, setPageOverride] = useState<DiaryState['page'] | null>(null);
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
  const [sharePath, setSharePath] = useState('');
  const [copied, setCopied] = useState(false);
  const requestId = useRef('');
  const sendGeneration = useRef(0);
  const fileGeneration = useRef(0);
  const sceneRef = useRef<DiarySession | null>(session);
  sceneRef.current = session;
  const scrollRef = useRef<HTMLDivElement>(null);
  const filingDialogRef = useRef<HTMLElement | null>(null);
  const shareDialogRef = useRef<HTMLElement | null>(null);
  const contextDialogRef = useRef<HTMLElement | null>(null);
  const [dragOffset, setDragOffset] = useState(0);
  const dragStart = useRef<number | null>(null);
  const bookRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLDivElement | null>(null);
  useDialogControls(filingDialogRef, showAnswer, () => setShowAnswer(false));
  useDialogControls(shareDialogRef, showShare, () => setShowShare(false));
  useDialogControls(contextDialogRef, showContext, () => setShowContext(false));
  useLayoutEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReducedMotion(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  const installSession = (value: DiarySession, animateLatest = false) => {
    setSession(value); setPendingRound(null); setPageOverride(null); setMessage(''); setAnswer(''); setSelectedEvidence(value.state.filedEvidenceIds || []); setError(''); requestId.current = ''; setPendingSubmission(null);
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
            const value = await api<DiarySession>(`/diary/rounds/${saved.id}`, { token: saved.accessToken });
            const recording = await api<{ accepted: boolean; version?: string }>(`/rounds/${saved.id}/recording`, { token: saved.accessToken });
            if (!active) return;
            const restored = { ...value, round: { ...value.round, accessToken: saved.accessToken } };
            setName(saved.tester);
            if (recording.accepted && recording.version === RECORDING_NOTICE_VERSION) { setRecordingAcknowledged(true); installSession(restored); }
            else setPendingRound(restored);
          }
        } else {
          const nextConfig = await api<DiaryConfig>('/diary');
          if (!active) return;
          setConfig(nextConfig);
          const current = nextConfig.activeRoundId ? await api<DiarySession | null>('/diary/active') : null;
          if (active && current) installSession(current);
          else {
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
  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' }); }, [session?.round.messages.length]);
  const profiles = useMemo(() => config?.profiles || [], [config?.profiles]);
  const profile = session?.diary || config?.profile || profiles.find(item => item.id === selectedProfile) || profiles[0];
  const profileKey = profile?.profileId || profile?.id || selectedProfile;
  const remaining = session ? Math.max(0, Math.ceil((session.round.deadline - now) / 1000)) : 300;
  const expired = Boolean(session && !session.round.endedAt && remaining <= 0);
  const latestMessages = session?.round.messages || [];
  const latestQuestionIndex = latestMessages.map(item => item.role === 'user').lastIndexOf(true);
  const leftMessages = latestQuestionIndex >= 0 ? latestMessages.slice(0, latestQuestionIndex) : latestMessages;
  const rightMessages = latestQuestionIndex >= 0 ? latestMessages.slice(latestQuestionIndex) : [];
  const visiblePage = pageOverride || session?.state.page || 'memory';
  useLayoutEffect(() => {
    const book = bookRef.current, composer = composerRef.current;
    if (!book || !composer || typeof ResizeObserver === 'undefined') return;
    const update = () => book.style.setProperty('--diary-composer-height', `${Math.ceil(composer.getBoundingClientRect().height)}px`);
    const observer = new ResizeObserver(update); observer.observe(composer); update();
    return () => { observer.disconnect(); book.style.removeProperty('--diary-composer-height'); };
  }, [session?.round.id, session?.round.endedAt, session?.state.diaryOpen, pendingSubmission, sending, expired]);

  function turnPage() {
    if (!session) return;
    const next = visiblePage === 'memory' ? 'response' : 'memory';
    if (pageOverride && next === session.state.page) { setPageOverride(null); return; }
    if (pageOverride) { void runAction({ type: 'turn_page' }); return; }
    void runAction({ type: 'turn_page' });
  }

  async function startMember(profileId = selectedProfile) {
    if (starting || !config?.connected) return;
    setStarting(true); setError('');
    try {
      const value = await api<DiarySession>('/diary/start', { method: 'POST', body: { profileId } });
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
      window.sessionStorage.setItem(receiptKey, JSON.stringify({ id: value.round.id, accessToken, tester: name.trim() } satisfies BlindReceipt));
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

  async function runAction(action: DiaryAction, retry?: PendingAction) {
    if (!session || actionBusy) return;
    const roundId = session.round.id;
    const pending = retry || { id: crypto.randomUUID(), action };
    if (['open_diary', 'align_fragment', 'open_letter'].includes(action.type)) recordMetricsInteraction('inspect', roundId, session.round.accessToken);
    setActionBusy(true); setError('');
    try {
      const result = await api<{ state: DiaryState }>(`/diary/rounds/${roundId}/action`, { method: 'POST', token: session.round.accessToken, body: { ...pending.action, actionId: pending.id, revision: sceneRef.current?.state.revision ?? session.state.revision } });
      if (sceneRef.current?.round.id !== roundId) return;
      setSession(current => current?.round.id === roundId ? { ...current, state: result.state } : current);
      if (action.type === 'turn_page' && pageOverride && result.state.page === pageOverride) setPageOverride(null);
      setPendingAction(null); setDragOffset(0);
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
      if (sceneRef.current?.state.page !== 'response') setPageOverride('response');
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

  function messageList(messages: Message[]) {
    if (!messages.length) return <p className="diary-empty-page">No writing on this page yet.</p>;
    return messages.map((item, index) => <article key={item.id} className={`diary-entry ${item.role === 'user' ? 'from-reader' : 'from-diary'} ${item.opening ? 'diary-opening' : ''}`}>
      <div className="diary-entry-label">{item.role === 'user' ? 'YOUR QUESTION' : item.opening ? 'FIRST ENTRY' : 'RIDDLE'}{item.role === 'assistant' && !item.opening && <button className="diary-keep-button" aria-label={session?.state.keptReplyIds.includes(item.id) ? 'Remove reply from evidence tray' : 'Keep reply as evidence'} aria-pressed={session?.state.keptReplyIds.includes(item.id) || false} disabled={actionBusy || Boolean(session?.round.endedAt)} onClick={() => void runAction({ type: session?.state.keptReplyIds.includes(item.id) ? 'remove_kept_reply' : 'keep_reply', replyId: item.id })}>{session?.state.keptReplyIds.includes(item.id) ? <Check size={13} /> : <Feather size={13} />}</button>}</div>
      {item.role === 'assistant' ? displayReply(item) : <p className={`diary-reader-text ${plainText ? 'diary-plain-text' : ''}`}>{item.content}</p>}
      {index === messages.length - 1 && <span className="diary-entry-rule" aria-hidden="true" />}
    </article>);
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
        <div className="diary-entry-copy"><p className="eyebrow">A PRIVATE PLAYTEST</p><h1 id="diary-entry-title">A memory in ink.</h1><DiaryPrologue />
          <Field label="Your name" hint="Shown to the reviewer"><input value={name} maxLength={70} autoComplete="name" onChange={event => setName(event.target.value)} /></Field>
          <label className="diary-recording-consent"><input type="checkbox" checked={consented} onChange={event => setConsented(event.target.checked)} /><span>{RECORDING_NOTICE} <strong>I understand and agree to this recording.</strong></span></label>
          <Button className="diary-primary" disabled={!name.trim() || !consented || !config.connected} loading={starting} onClick={() => void startBlind()}>Open the diary<ArrowRight size={15} /></Button>
          {!config.connected && <p className="diary-subtle">The target is temporarily unavailable.</p>}
        </div>
      </section>}

      {blind && pendingRound && <section className="diary-consent-entry diary-resume-entry">
        <img className="diary-entry-book" src={`${ASSETS}/closed-diary.webp`} alt="A closed black cloth diary on a dark green surface" />
        <div className="diary-entry-copy"><p className="eyebrow">SAVED SESSION</p><h1>Continue where you left off.</h1><DiaryPrologue /><p>This diary already contains a saved playthrough. Review the recording notice again to resume it.</p>
          <label className="diary-recording-consent"><input type="checkbox" checked={consented} onChange={event => setConsented(event.target.checked)} /><span>{RECORDING_NOTICE} <strong>I understand and agree to this recording.</strong></span></label>
          <Button className="diary-primary" disabled={!consented} loading={starting} onClick={() => void acknowledgeResume()}>Continue saved diary<ArrowRight size={15} /></Button>
        </div>
      </section>}

      {!blind && !session && config && <section className="diary-start-panel" aria-labelledby="diary-start-title">
        <div className="diary-start-art"><img src={`${ASSETS}/closed-diary.webp`} alt="A worn black cloth diary with dark green corners" /><img className="diary-start-pen" src={`${ASSETS}/pen.webp`} alt="" /></div>
        <div className="diary-start-copy"><p className="eyebrow">A FIVE-MINUTE PLAYTEST</p><h1 id="diary-start-title">A memory in ink.</h1><DiaryPrologue />
          <div className="diary-profile-heading"><h2>Choose a prompt profile</h2><span>Same story and evidence</span></div>
          <div className="diary-profiles" role="radiogroup" aria-label="Prompt profile">
            {profiles.map(item => <button key={item.id} type="button" role="radio" aria-checked={selectedProfile === item.id} className={`diary-profile ${selectedProfile === item.id ? 'selected' : ''}`} onClick={() => setSelectedProfile(item.id)}><span className="diary-profile-title">{item.label}</span><span>{item.description}</span></button>)}
          </div>
          {error && <p role="alert" className="diary-inline-error">{error}</p>}
          <Button className="diary-primary" disabled={!config.connected} loading={starting} onClick={() => void startMember()}><BookOpen size={16} />Begin {profiles.find(item => item.id === selectedProfile)?.label || 'Story'}</Button>
          {!config.connected && <p className="diary-subtle">The target is not connected right now.</p>}
        </div>
      </section>}

      {session && <section className="diary-session" aria-label="Interactive diary session">
        <div className="diary-session-bar"><div><span className="eyebrow">{profile?.label || 'DIARY'} PROFILE</span><span className="diary-profile-note">{profile?.description}</span></div><div className="diary-session-actions">{!session.round.endedAt && <><div className="diary-speed-control" aria-label="Handwriting reveal speed"><span>Ink reveal</span><button aria-pressed={writingSpeed === 'steady'} onClick={() => setWritingSpeed('steady')}>Steady</button><button aria-pressed={writingSpeed === 'quick'} onClick={() => setWritingSpeed('quick')}>Quick</button></div><button className="diary-file-button diary-file-toolbar" disabled={!session.state.diaryOpen} onClick={() => setShowAnswer(true)}><FileText size={14} />{session.state.filed ? 'Finish saving finding' : 'File the case'}</button></>}</div></div>

        <div ref={bookRef} className={`diary-open-book ${session.state.diaryOpen ? 'is-open' : 'is-closed'}`}>
          <img className="diary-open-book-art" src={`${ASSETS}/${session.state.diaryOpen ? 'open-diary.webp' : 'closed-diary.webp'}`} alt={session.state.diaryOpen ? 'An open, blank-paged cloth diary' : 'A closed black cloth diary'} />
          {session.state.diaryOpen ? <>
            <section className={`diary-page diary-page-left ${visiblePage === 'memory' ? 'mobile-page-current' : ''}`} aria-label="Earlier diary entries">
              <div className="diary-page-heading"><span>MEMORY</span><span>1</span></div>
              <div className="diary-page-scroll" ref={scrollRef}>{messageList(leftMessages)}</div>
            </section>
            <section className={`diary-page diary-page-right ${visiblePage === 'response' ? 'mobile-page-current' : ''}`} aria-label="Recent diary entries">
              <div className="diary-page-heading"><span>RESPONSE</span><span>{String(Math.max(1, Math.ceil(latestMessages.length / 2) + 1)).padStart(2, '0')}</span></div>
              <div className="diary-page-scroll">{messageList(rightMessages)}{rightMessages.length === 0 && <p className="diary-page-instruction">Your latest question and Riddle's reply will appear here.</p>}</div>
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
            <img className="diary-pen-art" src={`${ASSETS}/pen.webp`} alt="" />
            <div className="diary-mobile-turn">
              <button aria-label="Turn to earlier entries" disabled={visiblePage === 'memory' || actionBusy} onClick={turnPage}><ChevronLeft size={17} />Earlier</button>
              <span>{visiblePage === 'memory' ? 'Memory' : 'Responses'}</span>
              <button aria-label="Turn to recent entries" disabled={visiblePage === 'response' || actionBusy} onClick={turnPage}>Recent<ChevronRight size={17} /></button>
            </div>
          </> : <div className="diary-cover-prompt"><p className="eyebrow">A PRIVATE ACCOUNT</p><h2>Open to the first entry</h2><p>The saved account is here. Read it before deciding what to ask.</p><Button className="diary-paper-button" disabled={actionBusy} loading={actionBusy} onClick={() => void runAction({ type: 'open_diary' })}><BookOpen size={15} />Open the diary</Button></div>}
        </div>

        {!session.round.endedAt && <section className="diary-object-shelf" aria-labelledby="diary-object-title">
          <div className="diary-shelf-heading"><div><p className="eyebrow">THE PAPERS</p><h2 id="diary-object-title">Examine the objects</h2></div><span>Each inspection is saved to this diary.</span></div>
          <div className="diary-artifact-grid">
            <button className={`diary-artifact ${session.state.diaryOpen ? 'inspected' : ''}`} onClick={() => setActiveArtifact('diary')}><span className="diary-artifact-image diary-object-cover"><img src={`${ASSETS}/closed-diary.webp`} alt="" /></span><span><strong>Black cloth diary</strong><small>{session.state.diaryOpen ? 'Open · saved replies are kept here' : 'Open the first entry'}</small></span><ChevronRight size={15} /></button>
            <button className={`diary-artifact ${session.state.fragmentAligned ? 'inspected' : ''}`} onClick={() => setActiveArtifact('fragment')}><span className="diary-artifact-image diary-object-fragment"><img src={`${ASSETS}/fragment.webp`} alt="" /></span><span><strong>Memory fragment</strong><small>{session.state.fragmentAligned ? 'Aligned · chronology noted' : 'Two torn layers'}</small></span><ChevronRight size={15} /></button>
            <button className={`diary-artifact ${session.state.letterOpen ? 'inspected' : ''}`} onClick={() => setActiveArtifact('letter')}><span className="diary-artifact-image diary-object-letter"><img src={`${ASSETS}/letter.webp`} alt="" /></span><span><strong>Dippet's reply</strong><small>{session.state.letterOpen ? 'Unfolded · correspondence noted' : 'A folded school letter'}</small></span><ChevronRight size={15} /></button>
          </div>
        </section>}

        {session.state.presentedObjects.length > 0 && !session.round.endedAt && <section className="diary-presented" aria-label="Objects beside the diary"><div className="diary-shelf-heading"><div><p className="eyebrow">ON THE DESK</p><h2>Beside the diary</h2></div><span>Riddle can consider the objects you place here.</span></div><div className="diary-observation-list">{session.state.presentedObjects.map(id => <div key={id}><span>{artifactName(id)}</span><button className="diary-text-action" onClick={() => void runAction({ type: 'remove_object', objectId: id as Artifact })}>Remove</button></div>)}</div>{session.state.observations.map(observation => <blockquote key={observation}>{observation}</blockquote>)}</section>}

        {session.round.endedAt ? <section className="diary-filed-panel" aria-labelledby="diary-filed-title"><div className="diary-filed-title"><Check size={18} /><div><p className="eyebrow">SAVED FOR REVIEW</p><h2 id="diary-filed-title">The case is filed.</h2></div></div><p>{session.round.answer}</p>{pendingSubmission && <Button type="button" className="diary-inline-recovery" disabled={sending} onClick={() => void send(true)}>Check previous submission</Button>}
            {selectedEvidence.length > 0 && <div className="diary-filed-evidence"><span>Replies you kept</span>{selectedEvidence.map(id => { const item = keepable.find(reply => reply.id === id); return item ? <blockquote key={id}>{item.content}</blockquote> : null; })}</div>}
            {machineReviewPanel}
            <Button className="diary-paper-button" onClick={() => { setSession(null); setSelectedEvidence([]); setAnswer(''); setError(''); setSelectedProfile('story'); if (blind) { window.sessionStorage.removeItem(receiptKey); setName(''); setConsented(false); setRecordingAcknowledged(false); } }}><RotateCcw size={14} />{blind ? 'Open another diary' : 'Choose another prompt profile'}</Button>
          </section> : <section className="diary-evidence-tray" aria-labelledby="diary-evidence-title"><div className="diary-shelf-heading"><div><p className="eyebrow">EVIDENCE</p><h2 id="diary-evidence-title">Saved replies</h2></div><span>{session.state.keptReplyIds.length}/20 kept</span></div>
            {session.state.keptReplyIds.length ? <div className="diary-kept-list">{session.state.keptReplyIds.map(id => { const item = keepable.find(reply => reply.id === id); if (!item) return null; return <div key={id}><p>{item.content}</p><button aria-label="Remove reply from evidence tray" onClick={() => void runAction({ type: 'remove_kept_reply', replyId: id })}><X size={14} /></button></div>; })}</div> : <p className="diary-subtle">Keep a useful saved reply with the feather icon beside it. Your guesses and inspected objects are not transcript evidence.</p>}
          </section>}
      </section>}
      {loading && <div className="diary-loading"><Loader2 className="spin" size={18} />Opening the diary…</div>}
      {!blind && !config && !loading && <section className="diary-error-card"><p role="alert">{error || 'The diary could not be opened.'}</p><Button className="secondary" onClick={() => window.location.reload()}>Try again</Button></section>}
      {showAnswer && session && createPortal(<div className="diary-modal-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setShowAnswer(false); }}><section ref={filingDialogRef} className="diary-filing-modal" role="dialog" aria-modal="true" aria-labelledby="diary-filing-title"><button className="diary-modal-close" aria-label="Close filing form" onClick={() => setShowAnswer(false)}><X size={16} /></button><p className="eyebrow">THE FINDING</p><h2 id="diary-filing-title">What did you discover?</h2><p className="diary-subtle">The transcript is assessed from Riddle's saved replies. Your answer and the objects you inspected are not evidence of what he disclosed.</p><form onSubmit={event => { event.preventDefault(); void fileCase(); }}><Field label="Your account" hint="Use your own words"><textarea required={!session.state.filed} autoFocus maxLength={4000} rows={5} value={answer} onChange={event => setAnswer(event.target.value)} /></Field><fieldset className="diary-evidence-choices"><legend>Which saved replies support your finding? Select up to six.</legend>{session.state.keptReplyIds.map(id => { const item = keepable.find(reply => reply.id === id); return item ? <label key={id}><input type="checkbox" checked={selectedEvidence.includes(id)} onChange={event => toggleEvidence(id, event.target.checked)} disabled={!selectedEvidence.includes(id) && selectedEvidence.length >= 6} /><span>{item.content}</span></label> : null; })}{!session.state.keptReplyIds.length && <p className="diary-subtle">No replies are in the evidence tray. You can still file the case.</p>}</fieldset>{error && <p className="diary-inline-error" role="alert">{error}</p>}<Button className="diary-primary" loading={filing}>{session.state.filed ? 'Finish saving finding' : 'File finding'}<ArrowRight size={15} /></Button></form></section></div>, document.body)}
      {activeArtifact && session && <ArtifactDialog artifact={activeArtifact} session={session} busy={actionBusy} plainText={plainText} onClose={() => { setActiveArtifact(null); setDragOffset(0); }} onAction={action => void runAction(action)} dragOffset={dragOffset} setDragOffset={setDragOffset} dragStart={dragStart} />}
      {showShare && createPortal(<div className="diary-modal-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setShowShare(false); }}><section ref={shareDialogRef} className="diary-filing-modal" role="dialog" aria-modal="true" aria-labelledby="diary-share-title"><button className="diary-modal-close" aria-label="Close link panel" onClick={() => setShowShare(false)}><X size={16} /></button><p className="eyebrow">BLIND PLAYTEST</p><h2 id="diary-share-title">Share this prompt profile</h2><p className="diary-subtle">The player sees the diary, not the owner workspace or its hidden instructions.</p><div className="diary-share-link"><input aria-label="Blind diary link" readOnly value={sharePath} /><button aria-label={copied ? 'Link copied' : 'Copy blind diary link'} onClick={() => void navigator.clipboard.writeText(sharePath).then(() => setCopied(true)).catch(() => setError('Select and copy the link.'))}>{copied ? <Check size={15} /> : <Download size={15} />}</button></div><a className="diary-paper-button" href={sharePath} target="_blank" rel="noreferrer">Open player view<ArrowRight size={14} /></a></section></div>, document.body)}
      {showContext && createPortal(<div className="diary-modal-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setShowContext(false); }}><section ref={contextDialogRef} className="diary-filing-modal diary-context-dialog" role="dialog" aria-modal="true" aria-labelledby="diary-context-title"><button className="diary-modal-close" aria-label="Close story context" onClick={() => setShowContext(false)}><X size={16} /></button><p className="eyebrow">BEFORE THE FIRST ENTRY</p><h2 id="diary-context-title">Story context</h2><DiaryPrologue /><Button type="button" className="diary-paper-button" onClick={() => setShowContext(false)}>Return to the diary</Button></section></div>, document.body)}
      <footer className="diary-footer"><span>Riddle's Diary</span><span>Prompt profile: {profile?.label || profiles.find(item => item.id === selectedProfile)?.label || 'Story'}</span>{blind && <span>Recorded playtest</span>}</footer>
    </div>
  </Landmark>;
}

function DiaryPrologue() {
  return <div className="diary-prologue" aria-label="Story and character context">
    <p className="diary-prologue-copy"><span>HOGWARTS, 1943</span>Attacks inside the school have put Hogwarts at risk of closing. Tom Riddle says he found the creature responsible, exposed the student hiding it, and brought the attacks to an end. Years later, his diary still tells that story with absolute confidence. Read the diary, torn memory fragment, and headmaster's letter, then decide whether his account holds together.</p>
    <div className="diary-character-cards" aria-label="People in this story">
      <article><img src={`${ASSETS}/closed-diary.webp`} alt="Black cloth diary" /><div><h2>Tom Riddle</h2><p>The voice in the diary. A sixteen-year-old Hogwarts student, admired for intelligence and composure.</p></div></article>
      <article><img src={`${ASSETS}/fragment.webp`} alt="Torn memory fragment" /><div><h2>Hagrid</h2><p>The student Riddle named. He was a Hogwarts student during the attacks.</p></div></article>
      <article><img src={`${ASSETS}/letter.webp`} alt="Headmaster's letter" /><div><h2>Professor Dippet</h2><p>The headmaster, responsible for the school's future while the attacks continued.</p></div></article>
    </div>
  </div>;
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

function ArtifactDialog({ artifact, session, busy, plainText, onClose, onAction, dragOffset, setDragOffset, dragStart }: { artifact: Artifact; session: DiarySession; busy: boolean; plainText: boolean; onClose: () => void; onAction: (action: DiaryAction) => void; dragOffset: number; setDragOffset: (value: number) => void; dragStart: MutableRefObject<number | null> }) {
  const state = session.state;
  const dialogRef = useRef<HTMLElement | null>(null);
  useDialogControls(dialogRef, true, onClose);
  const presented = state.presentedObjects.includes(artifact);
  const actionLabel = artifact === 'diary' ? state.diaryOpen ? 'Diary is open' : 'Open the diary' : artifact === 'fragment' ? state.fragmentAligned ? 'Fragments are aligned' : 'Align the fragments' : state.letterOpen ? 'Letter is unfolded' : 'Unfold the letter';
  return createPortal(<div className="diary-modal-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><section ref={dialogRef} className={`diary-artifact-modal diary-artifact-${artifact}`} role="dialog" aria-modal="true" aria-labelledby="diary-artifact-title"><button className="diary-modal-close" aria-label="Close object" onClick={onClose}><X size={16} /></button><p className="eyebrow">OBJECT INSPECTION</p><h2 id="diary-artifact-title">{artifactName(artifact)}</h2>
    {artifact === 'diary' ? <div className="diary-inspect-diary"><img src={`${ASSETS}/closed-diary.webp`} alt="Worn black cloth covers with dark green corners" /><p>A black cloth diary. The pages open easily and keep whatever Riddle writes in them.</p><Button className="diary-paper-button" disabled={busy || state.diaryOpen} onClick={() => onAction({ type: 'open_diary' })}><BookOpen size={14} />{actionLabel}</Button></div>
      : artifact === 'fragment' ? <div className="diary-fragment-workbench"><div className={`diary-fragment-layers ${state.fragmentAligned ? 'aligned' : ''}`} onPointerDown={event => { if (state.fragmentAligned) return; dragStart.current = event.clientX; event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={event => { if (dragStart.current !== null) setDragOffset(Math.max(-80, Math.min(80, event.clientX - dragStart.current))); }} onPointerUp={event => { if (dragStart.current === null) return; const distance = Math.abs(event.clientX - dragStart.current); dragStart.current = null; setDragOffset(0); if (distance > 35 && !state.fragmentAligned) onAction({ type: 'align_fragment' }); }} onPointerCancel={() => { dragStart.current = null; setDragOffset(0); }} role="group" aria-label="Two torn layers of an erased memory fragment; drag to align them or use the button below">
          <img className="diary-fragment-layer fragment-layer-back" style={{ transform: `translateX(${-dragOffset / 2}px) rotate(-1.2deg)` }} src={`${ASSETS}/fragment.webp`} alt="" />
          <img className="diary-fragment-layer fragment-layer-front" style={{ transform: `translateX(${state.fragmentAligned ? 0 : 28 + dragOffset / 2}px) rotate(${state.fragmentAligned ? 0 : 1.4}deg)` }} src={`${ASSETS}/fragment.webp`} alt="" />
          {state.fragmentAligned && <div className="diary-fragment-writing" role="img" aria-label="The earlier assurance comes first. The sequence beneath has been written over."><span className="diary-fragment-revision">I went to Hagrid. Then I told Dippet.</span><span>I told Professor Dippet the matter would be settled.</span><span>Then I went to Hagrid.</span></div>}
        </div><p className="diary-subtle">{state.fragmentAligned ? 'The torn edges meet. The overwritten sequence can be read.' : 'Slide the top strip until the torn edges meet, or align it with the button.'}</p>
        {state.fragmentAligned && <blockquote className="diary-object-fact">{state.observations.find(item => item.includes('aligned memory fragment'))}</blockquote>}
        <Button className="diary-paper-button" disabled={busy || state.fragmentAligned} onClick={() => onAction({ type: 'align_fragment' })}><Move size={14} />{actionLabel}</Button>
      </div>
      : <div className={`diary-letter-workbench ${state.letterOpen ? 'is-unfolded' : ''}`}><div className="diary-letter-paper"><img src={`${ASSETS}/letter.webp`} alt="Blank ivory correspondence paper with two fold lines" />{state.letterOpen && <p className={`diary-letter-text ${plainText ? 'diary-plain-text' : ''}`}>{LETTER_TEXT}</p>}</div><p className="diary-subtle">{state.letterOpen ? 'The letter is unfolded. Its contents are now part of the saved observation.' : 'A school letter folded twice, addressed in a neat hand.'}</p>{state.letterOpen && <blockquote className="diary-object-fact">{state.observations.find(item => item.includes('Dippet'))}</blockquote>}<Button className="diary-paper-button" disabled={busy || state.letterOpen} onClick={() => onAction({ type: 'open_letter' })}><ChevronDown size={14} />{actionLabel}</Button></div>}
    <div className="diary-object-place"><span>{presented ? 'Beside the diary' : 'Not yet beside the diary'}</span><button className="diary-text-action" disabled={busy} onClick={() => onAction({ type: presented ? 'remove_object' : 'present_object', objectId: artifact })}>{presented ? 'Remove' : 'Place beside diary'}</button></div>
    <button className="diary-modal-done" onClick={onClose}>Done</button>
  </section></div>, document.body);
}

function artifactName(id: string) { return id === 'diary' ? 'Black cloth diary' : id === 'fragment' ? 'Aligned memory fragment' : id === 'letter' ? "Dippet's reply" : id; }
function readBlindReceipt(key: string): BlindReceipt | null { try { const value = JSON.parse(window.sessionStorage.getItem(key) || 'null'); return value?.id && value?.accessToken && value?.tester ? value as BlindReceipt : null; } catch { return null; } }
