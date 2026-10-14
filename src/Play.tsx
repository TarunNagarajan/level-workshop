import { useEffect, useRef, useState } from 'react';
import { ArrowUp, ArrowUpRight, RefreshCcw, Lightbulb, GitBranch, Check, ChevronDown, Loader2 } from 'lucide-react';
import { api, time } from './api';
import type { Round, PlayerLevel } from './types';
import { Button, Field, Mark, Modal } from './ui';

export function PlayPanel({ level, round, setRound, start, restart, branch, connected, busy = false, standalone = false }: {
  level: PlayerLevel; round: Round | null; setRound: (r: Round) => void; start: () => Promise<void>;
  restart?: () => Promise<void>; branch?: (messageId: string) => Promise<void>; connected: boolean; busy?: boolean; standalone?: boolean;
}) {
  const [message, setMessage] = useState(''); const [answer, setAnswer] = useState('');
  const [error, setError] = useState(''); const [sending, setSending] = useState(false); const [answerOpen, setAnswerOpen] = useState(false);
  const [now, setNow] = useState(Date.now()); const scrollRef = useRef<HTMLDivElement>(null);
  const [starting, setStarting] = useState(false);
  const snapshot = round?.level || level;
  const remaining = round ? Math.min(snapshot.duration, Math.ceil((round.deadline - (round.endedAt || now)) / 1000)) : snapshot.duration;
  const closed = Boolean(round?.endedAt) || Boolean(round && remaining <= 0);
  useEffect(() => { setNow(Date.now()); if (!round || round.endedAt) return; const interval = setInterval(() => setNow(Date.now()), 500); return () => clearInterval(interval); }, [round?.id, round?.endedAt]);
  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' }); }, [round?.messages.length, sending]);
  useEffect(() => { setError(''); setMessage(''); setAnswer(''); setAnswerOpen(false); }, [round?.id]);
  const update = (next: Round) => setRound({ ...next, accessToken: round?.accessToken });
  const send = async () => {
    if (!round || !message.trim() || sending || busy || closed) return;
    setSending(true); setError('');
    try { const next = await api<Round>(`/rounds/${round.id}/messages`, { method: 'POST', body: { content: message }, token: round.accessToken }); update(next); setMessage(''); }
    catch (e) { setError((e as Error).message); }
    finally { setSending(false); }
  };
  const begin = async () => { setStarting(true); setError(''); try { await start(); } catch (e) { setError((e as Error).message); } finally { setStarting(false); } };
  return <section className={`play-panel ${standalone ? 'standalone-panel' : ''}`} aria-label="Player preview">
    {!standalone && <div className="panel-heading"><span className="eyebrow">PLAYER PREVIEW</span><span className="tiny">{round ? `SAVED SESSION · ${round.source.toUpperCase()}` : 'NOT STARTED'}</span></div>}
    <div className="play-heading"><div><p className="eyebrow">{snapshot.theme}</p><h2>{snapshot.title}</h2></div><span className={`timer ${round && remaining < 60 && !round.endedAt ? 'urgent' : ''}`} aria-label="Time remaining">{time(remaining)}</span></div>
    <details className="briefing" open={!round}><summary>The briefing<ChevronDown size={14} /></summary><p>{snapshot.briefing || 'Add the player briefing in the scenario editor.'}</p></details>
    <div className="conversation" ref={scrollRef} aria-live="polite" aria-relevant="additions">
      {(round?.messages || (snapshot.opening ? [{ id: 'opening', role: 'assistant', content: snapshot.opening, opening: true }] : [])).map(m => <div key={m.id} className={`message ${m.role}`}>
        <div className="message-label"><span>{m.role === 'user' ? 'YOU' : m.role === 'hint' ? 'HINT' : snapshot.character.toUpperCase()}</span>{'latencyMs' in m && m.latencyMs !== undefined && <span className="response-time">{(m.latencyMs / 1000).toFixed(2)}s</span>}{branch && m.role === 'assistant' && round && !busy && !sending && <button className="branch-button" title="Start a fresh branch after this reply" aria-label="Branch from this reply" onClick={() => branch(m.id).catch(e => setError(e.message))}><GitBranch size={12} /></button>}</div><p>{m.content}</p>
      </div>)}
      {sending && <div className="target-wait"><Loader2 size={14} className="spin" />{snapshot.character} is responding…</div>}
    </div>
    {error && <p className="error chat-error" role="alert">{error}</p>}
    {!round ? <div className="start-test"><Button className="primary full" loading={starting} disabled={!connected || busy} onClick={begin}>Start {standalone ? 'round' : 'test'}<ArrowUpRight size={16} /></Button>{!connected && <p className="muted">The target model is not connected.</p>}</div>
      : round.endedAt ? <div className="round-finished"><Check size={17} /><div><strong>Answer submitted</strong><p>{round.answer}</p><small>Saved for human review.</small></div>{restart && <button className="icon-button" aria-label="Start a new test" onClick={() => restart().catch(e => setError(e.message))}><RefreshCcw size={15} /></button>}</div>
      : <div className="chat-footer">
        {closed ? <p className="muted time-ended">Time is up. Submit what you discovered.</p> : <div className="composer"><textarea aria-label="Message to target" placeholder={`Question ${snapshot.character}…`} value={message} maxLength={4000} disabled={busy} rows={2} onChange={e => setMessage(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }} /><button className="send-button" aria-label="Send message" disabled={!message.trim() || sending || busy} onClick={send}><ArrowUp size={18} /></button></div>}
        <div className="chat-actions"><div>{restart && <button className="text-button" disabled={sending || busy} onClick={() => restart().catch(e => setError(e.message))}><RefreshCcw size={13} />Restart</button>}{snapshot.hintCount > 0 && <button className="text-button" disabled={closed || sending || busy || round.hintsUsed >= snapshot.hintCount} onClick={async () => { try { update(await api<Round>(`/rounds/${round.id}/hint`, { method: 'POST', token: round.accessToken })); } catch (e) { setError((e as Error).message); } }}><Lightbulb size={13} />Hint{round.hintsUsed ? ` ${round.hintsUsed}/${snapshot.hintCount}` : ''}</button>}</div><button className="text-button submit-action" disabled={sending || busy} onClick={() => setAnswerOpen(true)}>Submit answer<ArrowUpRight size={13} /></button></div>
      </div>}
    <div className="model-footer"><span className={`connection-dot ${connected ? 'connected' : ''}`} /><span>{round?.model.replace('openai/', '') || 'gpt-oss-20b'}</span>{round && <span>{round.messages.filter(m => m.role === 'user').length} prompts</span>}</div>
    {answerOpen && round && <Modal title="What did you discover?" error={error} close={() => setAnswerOpen(false)}><form onSubmit={async e => { e.preventDefault(); setSending(true); setError(''); try { update(await api<Round>(`/rounds/${round.id}/submit`, { method: 'POST', body: { answer }, token: round.accessToken })); setAnswerOpen(false); } catch (err) { setError((err as Error).message); } finally { setSending(false); } }}><Field label="Your answer" hint="Use your own words"><textarea autoFocus required rows={5} maxLength={4000} value={answer} onChange={e => setAnswer(e.target.value)} /></Field><p className="muted small">Your answer and conversation will be saved for the level reviewer.</p><Button className="primary full" loading={sending}>Submit answer<ArrowUpRight size={15} /></Button></form></Modal>}
  </section>;
}

export function BlindPlay({ token }: { token: string }) {
  const [info, setInfo] = useState<{ level: PlayerLevel; version: number; connected: boolean } | null>(null);
  const [round, setRound] = useState<Round | null>(null); const [name, setName] = useState(''); const [error, setError] = useState('');
  const storageKey = `workshop-play-${token}`;
  useEffect(() => {
    let active = true;
    api<typeof info>(`/play/${token}`).then(async next => {
      if (!active) return; setInfo(next);
      const saved = sessionStorage.getItem(storageKey);
      if (saved) { try { const { id, accessToken } = JSON.parse(saved); const value = await api<Round>(`/rounds/${id}`, { token: accessToken }); if (active) setRound({ ...value, accessToken }); } catch { sessionStorage.removeItem(storageKey); } }
    }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [token]);
  return <div className="blind-shell"><header className="blind-top"><Mark /><span className="tiny">PRIVATE PLAYTEST</span>{info && <span className="tiny">VERSION {info.version.toString().padStart(2, '0')}</span>}</header>
    {!info ? <div className="auth-shell"><p className={error ? 'error' : 'muted'}>{error || 'Opening the round…'}</p></div> : <>
      {!round && <div className="tester-name"><Field label="Your name"><input value={name} maxLength={70} autoComplete="name" placeholder="For the reviewer" onChange={e => setName(e.target.value)} /></Field></div>}
      <PlayPanel level={info.level} round={round} setRound={setRound} connected={info.connected} standalone start={async () => { if (!name.trim()) throw new Error('Enter your name before starting.'); const next = await api<Round>(`/play/${token}`, { method: 'POST', body: { tester: name } }); sessionStorage.setItem(storageKey, JSON.stringify({ id: next.id, accessToken: next.accessToken })); setRound(next); }} />
    </>}
  </div>;
}
