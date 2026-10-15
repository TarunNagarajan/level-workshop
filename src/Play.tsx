import { useEffect, useRef, useState } from 'react';
import { ArrowUp, ArrowUpRight, RefreshCcw, Lightbulb, GitBranch, Check, ChevronDown, Loader2 } from 'lucide-react';
import { api, ApiError, RECORDING_NOTICE, RECORDING_NOTICE_VERSION, setRecordingAcknowledged, time } from './api';
import { recordMetricsInteraction, recordMetricsReply, setMetricsPhase } from './telemetry';
import type { Round, PlayerLevel } from './types';
import { Button, Field, Mark, Modal } from './ui';
import { MachineReviewPanel } from './MachineReviewPanel';

export function PlayPanel({ level, round, setRound, start, restart, branch, connected, busy = false, standalone = false, hideModelLabel = false, canStart = true }: {
  level: PlayerLevel; round: Round | null; setRound: (r: Round) => void; start: () => Promise<void>;
  restart?: () => Promise<void>; branch?: (messageId: string) => Promise<void>; connected: boolean; busy?: boolean; standalone?: boolean; hideModelLabel?: boolean; canStart?: boolean;
}) {
  type PendingSubmission = { roundId: string; id: string; content: string };
  const [message, setMessage] = useState(''); const [answer, setAnswer] = useState('');
  const [error, setError] = useState(''); const [sending, setSending] = useState(false); const [answerOpen, setAnswerOpen] = useState(false);
  const [pendingSubmission, setPendingSubmission] = useState<PendingSubmission | null>(null); const pendingSubmissionRef = useRef<PendingSubmission | null>(null);
  const [now, setNow] = useState(Date.now()); const scrollRef = useRef<HTMLDivElement>(null); const roundRef = useRef(round); roundRef.current = round; const senderGeneration = useRef(0);
  const [starting, setStarting] = useState(false);
  const snapshot = round?.level || level;
  const remaining = round ? Math.min(snapshot.duration, Math.ceil((round.deadline - (round.endedAt || now)) / 1000)) : snapshot.duration;
  const closed = Boolean(round?.endedAt) || Boolean(round && remaining <= 0);
  useEffect(() => { setNow(Date.now()); if (!round || round.endedAt) return; const interval = setInterval(() => setNow(Date.now()), 500); return () => clearInterval(interval); }, [round?.id, round?.endedAt]);
  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' }); }, [round?.messages.length, sending]);
  useEffect(() => { senderGeneration.current += 1; setError(''); setMessage(''); setAnswer(''); setAnswerOpen(false); setSending(false); pendingSubmissionRef.current = null; setPendingSubmission(null); return () => { senderGeneration.current += 1; pendingSubmissionRef.current = null; }; }, [round?.id]);
  useEffect(() => { if (round) setMetricsPhase('read_think', round.id, round.accessToken); }, [round?.id]);
  const setPending = (pending: PendingSubmission | null) => { pendingSubmissionRef.current = pending; setPendingSubmission(pending); };
  const update = (next: Round, target = round) => { if (target && roundRef.current?.id === target.id) setRound({ ...next, accessToken: target.accessToken }); };
  const send = async (recover = false) => {
    if (!round || sending || busy) return;
    const existing = pendingSubmissionRef.current?.roundId === round.id ? pendingSubmissionRef.current : null;
    if (recover && !existing) return;
    if (!recover && (!message.trim() || closed || existing)) return;
    const targetRound = round, sentText = recover ? existing!.content : message, generation = senderGeneration.current, sendingRoundId = round.id;
    const pending = existing || { roundId: round.id, id: crypto.randomUUID(), content: sentText };
    if (!existing) setPending(pending);
    setSending(true); setError('');
    recordMetricsInteraction('submit', round.id, round.accessToken);
    try { const next = await api<Round>(`/rounds/${sendingRoundId}/messages`, { method: 'POST', body: { content: sentText, requestId: pending.id }, token: targetRound.accessToken }); if (generation !== senderGeneration.current || roundRef.current?.id !== sendingRoundId) return; update(next, targetRound); recordMetricsReply(sendingRoundId, targetRound.accessToken); setMessage(current => current === sentText ? '' : current); setPending(null); }
    catch (e) { if (generation !== senderGeneration.current || roundRef.current?.id !== sendingRoundId) return; const error = e as Error; if (error instanceof ApiError && error.submissionId) {
      const terminal = ['failed', 'rejected', 'interrupted'].includes(error.submissionStatus || '');
      if (terminal) setPending(null);
      const statusText = error.submissionStatus ? ` Status: ${error.submissionStatus}.` : '';
      setError(`${error.message} The server confirmed this prompt was saved.${statusText}${terminal ? ' You can send a new attempt.' : ' Check the previous submission to retrieve its result.'}`);
    } else if (error instanceof ApiError) { if (error.status < 500 && error.status !== 429) setPending(null); setError(error.status >= 500 ? `${error.message} The receipt is unknown; check the previous submission before sending another prompt.` : error.message); }
    else setError('The server receipt is unknown because the connection ended. Your text remains here. Check the previous submission before sending another prompt.'); }
    finally { if (generation === senderGeneration.current && roundRef.current?.id === sendingRoundId) setSending(false); }
  };
  const begin = async () => { setStarting(true); setError(''); try { await start(); } catch (e) { setError((e as Error).message); } finally { setStarting(false); } };
  return <section className={`play-panel ${standalone ? 'standalone-panel' : ''}`} aria-label="Player preview">
    {!standalone && <div className="panel-heading"><span className="eyebrow">PLAYER PREVIEW</span><span className="tiny">{round ? `SAVED SESSION · ${(round.source || 'session').toUpperCase()}` : 'NOT STARTED'}</span></div>}
    <div className="play-heading"><div><p className="eyebrow">{snapshot.theme}</p><h2>{snapshot.title}</h2></div><span className={`timer ${round && remaining < 60 && !round.endedAt ? 'urgent' : ''}`} aria-label="Time remaining">{time(remaining)}</span></div>
    <details className="briefing" open={!round}><summary>The briefing<ChevronDown size={14} /></summary><p>{snapshot.briefing || 'Add the player briefing in the scenario editor.'}</p></details>
    <div className="conversation" ref={scrollRef} aria-live="polite" aria-relevant="additions">
      {(round?.messages || (snapshot.opening ? [{ id: 'opening', role: 'assistant', content: snapshot.opening, opening: true }] : [])).map(m => <div key={m.id} className={`message ${m.role}`}>
        <div className="message-label"><span>{m.role === 'user' ? 'YOU' : m.role === 'hint' ? 'HINT' : snapshot.character.toUpperCase()}</span>{'latencyMs' in m && m.latencyMs !== undefined && <span className="response-time">{(m.latencyMs / 1000).toFixed(2)}s</span>}{branch && m.role === 'assistant' && round && !busy && !sending && <button className="branch-button" title="Start a fresh branch after this reply" aria-label="Branch from this reply" onClick={() => branch(m.id).catch(e => setError(e.message))}><GitBranch size={12} /></button>}</div><p>{m.content}</p>
      </div>)}
      {sending && <div className="target-wait"><Loader2 size={14} className="spin" />{snapshot.character} is responding…</div>}
    </div>
    {error && <p className="error chat-error" role="alert">{error}</p>}
    {round && !sending && pendingSubmission?.roundId === round.id && <div className="pending-submission" role="status"><p>The previous submission’s receipt is unknown. Your edited draft is saved separately.</p><button className="text-button" disabled={busy} onClick={() => void send(true)}>Check previous submission</button></div>}
    {!round ? <div className="start-test"><Button className="primary full" loading={starting} disabled={!connected || busy || !canStart} onClick={begin}>Start {standalone ? 'round' : 'test'}<ArrowUpRight size={16} /></Button>{!connected && <p className="muted">The target model is not connected.</p>}</div>
      : round.endedAt ? <div className="round-finished"><Check size={17} /><div><strong>Answer submitted</strong><p>{round.answer}</p><small>Saved for human review.</small><MachineReviewPanel key={round.id} round={round} setRound={update} isCurrent={() => roundRef.current?.id === round.id} /></div>{restart && <button className="icon-button" aria-label="Start a new test" onClick={() => restart().catch(e => setError(e.message))}><RefreshCcw size={15} /></button>}</div>
      : <div className="chat-footer">
        {closed ? <p className="muted time-ended">Time is up. Submit what you discovered.</p> : <div className="composer"><textarea aria-label="Message to target" placeholder={`Question ${snapshot.character}…`} value={message} maxLength={4000} disabled={busy} rows={2} onFocus={() => setMetricsPhase('compose', round.id, round.accessToken)} onBlur={() => setMetricsPhase('read_think', round.id, round.accessToken)} onChange={e => setMessage(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }} /><button className="send-button" aria-label="Send message" disabled={!message.trim() || sending || busy || Boolean(pendingSubmission?.roundId === round.id)} onClick={() => void send()}><ArrowUp size={18} /></button></div>}
        <div className="chat-actions"><div>{restart && <button className="text-button" disabled={sending || busy} onClick={() => restart().catch(e => setError(e.message))}><RefreshCcw size={13} />Restart</button>}{snapshot.hintCount > 0 && <button className="text-button" disabled={closed || sending || busy || round.hintsUsed >= snapshot.hintCount} onClick={async () => { recordMetricsInteraction('hint', round.id, round.accessToken); try { update(await api<Round>(`/rounds/${round.id}/hint`, { method: 'POST', token: round.accessToken })); } catch (e) { setError((e as Error).message); } }}><Lightbulb size={13} />Hint{round.hintsUsed ? ` ${round.hintsUsed}/${snapshot.hintCount}` : ''}</button>}</div><button className="text-button submit-action" disabled={sending || busy} onClick={() => { setAnswerOpen(true); setMetricsPhase('compose', round.id, round.accessToken); }}>Submit answer<ArrowUpRight size={13} /></button></div>
      </div>}
    <div className="model-footer"><span className={`connection-dot ${connected ? 'connected' : ''}`} />{!hideModelLabel && <span>{round?.model?.replace('openai/', '') || 'gpt-oss-20b'}</span>}{round && <span>{round.messages.filter(m => m.role === 'user').length} prompts</span>}</div>
    {answerOpen && round && <Modal title="What did you discover?" error={error} close={() => setAnswerOpen(false)}><form onSubmit={async e => { e.preventDefault(); setSending(true); setError(''); recordMetricsInteraction('finish', round.id, round.accessToken); try { update(await api<Round>(`/rounds/${round.id}/submit`, { method: 'POST', body: { answer }, token: round.accessToken })); setAnswerOpen(false); } catch (err) { setError((err as Error).message); } finally { setSending(false); } }}><Field label="Your answer" hint="Use your own words"><textarea autoFocus required rows={5} maxLength={4000} value={answer} onFocus={() => setMetricsPhase('compose', round.id, round.accessToken)} onBlur={() => setMetricsPhase('read_think', round.id, round.accessToken)} onChange={e => setAnswer(e.target.value)} /></Field><p className="muted small">Your answer and conversation will be saved for the level reviewer.</p><Button className="primary full" loading={sending}>Submit answer<ArrowUpRight size={15} /></Button></form></Modal>}
  </section>;
}

export function BlindPlay({ token }: { token: string }) {
  const [info, setInfo] = useState<{ level: PlayerLevel; version: number; connected: boolean } | null>(null);
  const [round, setRound] = useState<Round | null>(null); const [name, setName] = useState(''); const [error, setError] = useState(''); const [consented, setConsented] = useState(false); const [pendingRound, setPendingRound] = useState<Round | null>(null);
  const storageKey = `workshop-play-${token}`;
  useEffect(() => {
    let active = true;
    api<typeof info>(`/play/${token}`).then(async next => {
      if (!active) return; setInfo(next);
      const saved = sessionStorage.getItem(storageKey);
      if (saved) { try { const { id, accessToken } = JSON.parse(saved); const value = await api<Round>(`/rounds/${id}`, { token: accessToken }); const status = await api<{ accepted: boolean; version?: string }>(`/rounds/${id}/recording`, { token: accessToken }); if (active) { if (status.accepted && status.version === RECORDING_NOTICE_VERSION) { setRecordingAcknowledged(true); setRound({ ...value, accessToken }); } else setPendingRound({ ...value, accessToken }); } } catch { sessionStorage.removeItem(storageKey); } }
    }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [token]);
  const acknowledgeResume = async () => { if (!pendingRound) return; try { await api(`/rounds/${pendingRound.id}/recording`, { method: 'POST', token: pendingRound.accessToken, body: { version: RECORDING_NOTICE_VERSION, accepted: true } }); setRecordingAcknowledged(true); setRound(pendingRound); setPendingRound(null); } catch (e) { setError((e as Error).message); } };
  return <div className="blind-shell"><header className="blind-top"><Mark /><span className="tiny">PRIVATE PLAYTEST</span>{info && <span className="tiny">VERSION {info.version.toString().padStart(2, '0')}</span>}</header>
    {!info ? <div className="auth-shell"><p className={error ? 'error' : 'muted'}>{error || 'Opening the round…'}</p></div> : <>
      {!round && !pendingRound && <div className="tester-name"><Field label="Your name"><input value={name} maxLength={70} autoComplete="name" placeholder="For the reviewer" onChange={e => setName(e.target.value)} /></Field><label className="recording-consent"><input type="checkbox" checked={consented} onChange={e => setConsented(e.target.checked)} /><span>{RECORDING_NOTICE} <strong>I understand and agree to this recording.</strong></span></label></div>}
      {pendingRound && <section className="recording-resume-card"><p>{RECORDING_NOTICE}</p><label className="recording-consent"><input type="checkbox" checked={consented} onChange={e => setConsented(e.target.checked)} /><span>I understand and agree to this recording.</span></label><Button className="primary full" disabled={!consented} onClick={() => void acknowledgeResume()}>Continue saved round</Button></section>}
      {!pendingRound && <PlayPanel level={info.level} round={round} setRound={setRound} connected={info.connected} standalone canStart={consented && Boolean(name.trim())} start={async () => { if (!name.trim()) throw new Error('Enter your name before starting.'); if (!consented) throw new Error('Agree to the recording notice before starting.'); const next = await api<Round>(`/play/${token}`, { method: 'POST', body: { tester: name, consent: true } }); setRecordingAcknowledged(true); sessionStorage.setItem(storageKey, JSON.stringify({ id: next.id, accessToken: next.accessToken })); setRound(next); }} />}
    </>}
  </div>;
}
