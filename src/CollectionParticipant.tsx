import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Check, ChevronRight } from 'lucide-react';
import { api, setRecordingAcknowledged } from './api';
import type { PlayerLevel, Round } from './types';
import { Button, Field, Mark } from './ui';
import { PlayPanel } from './Play';
import { PassportReference } from './PassportReference';

type Entry = { level: PlayerLevel; connected: boolean; kind: 'conversation' | 'passport'; consentTextVersion: string; accepting: boolean; isPassport: boolean };
type ParticipantEntry = Entry | { kind: 'passport' };
type Receipt = { tester: string; consent: true; startKey: string; id?: string; accessToken?: string; kind?: string };
type Admission = { kind: 'conversation' | 'passport'; round: Round; state?: unknown; documents?: unknown };

export function CollectionParticipant({ token }: { token: string }) {
  const storageKey = `workshop-collection:${token}`;
  const [entry, setEntry] = useState<ParticipantEntry | null>(null), [round, setRound] = useState<Round | null>(null);
  const [name, setName] = useState(''), [consented, setConsented] = useState(false), [error, setError] = useState(''), [busy, setBusy] = useState(false), [loading, setLoading] = useState(true);
  const starting = useRef(false);
  useEffect(() => {
    let active = true;
    setEntry(null); setRound(null); setError(''); setLoading(true); setName(''); setConsented(false); starting.current = false;
    const receipt = readReceipt(storageKey);
    if (receipt?.tester && receipt.startKey) { setName(receipt.tester); setConsented(true); }
    (async () => {
      try {
        if (receipt?.tester && receipt.startKey && receipt.kind === 'passport') {
          setEntry({ kind: 'passport' });
          return;
        }
        if (receipt?.tester && receipt.startKey && receipt.kind === 'conversation') {
          try {
            const resumed = await api<Admission>(`/collect/${token}`, { method: 'POST', body: { tester: receipt.tester, consent: true, startKey: receipt.startKey } });
            if (!active) return;
            setRecordingAcknowledged(true);
            saveReceipt(storageKey, { ...receipt, id: resumed.round.id, accessToken: resumed.round.accessToken, kind: resumed.kind });
            setRound(resumed.round); setEntry({ level: resumed.round.level, connected: true, kind: 'conversation', consentTextVersion: 'collection-recording-v1', accepting: true, isPassport: false });
            return;
          } catch { /* Continue to the briefing when no accepted assignment can be recovered. */ }
        }
        const publicEntry = await api<Entry>(`/collect/${token}`);
        if (!active) return;
        setEntry(publicEntry);
        if (receipt?.tester && receipt.startKey) {
          // The passport component owns its stateful resume route. Let it recover
          // after the safe briefing loads, instead of admitting the same receipt twice.
          if (publicEntry.kind === 'passport') return;
          try {
            const resumed = await api<Admission>(`/collect/${token}`, { method: 'POST', body: { tester: receipt.tester, consent: true, startKey: receipt.startKey } });
            if (!active) return;
            setRecordingAcknowledged(true);
            saveReceipt(storageKey, { ...receipt, id: resumed.round.id, accessToken: resumed.round.accessToken, kind: resumed.kind });
            setRound(resumed.round); setEntry(current => current?.kind === 'conversation' ? { ...current, level: resumed.round.level, kind: 'conversation', isPassport: false } : current);
            return;
          } catch { /* A missing receipt can be entered again; the original key remains available for a safe retry. */ }
        }
      } catch (e) { if (active) setError((e as Error).message); }
      finally { if (active) setLoading(false); }
    })();
    return () => { active = false; };
  }, [token]);
  const start = async () => {
    if (starting.current) return;
    starting.current = true; setBusy(true); setError('');
    try {
      const prior = readReceipt(storageKey);
      const receipt = prior?.tester && prior.startKey && (!prior.id || !round) ? prior : { tester: name.trim() || round?.tester || '', consent: true as const, startKey: crypto.randomUUID() };
      if (!receipt.tester) throw new Error('Enter your name before starting.');
      if (!consented && !prior?.id) throw new Error('Agree to the recording notice before starting.');
      saveReceipt(storageKey, receipt);
      const result = await api<Admission>(`/collect/${token}`, { method: 'POST', body: { tester: receipt.tester, consent: true, startKey: receipt.startKey } });
      setRecordingAcknowledged(true);
      saveReceipt(storageKey, { ...receipt, id: result.round.id, accessToken: result.round.accessToken, kind: result.kind });
      setRound(result.round); setEntry(current => current?.kind === 'conversation' ? { ...current, level: result.round.level, kind: 'conversation', isPassport: false } : current);
    } catch (e) { setError((e as Error).message); }
    finally { starting.current = false; setBusy(false); }
  };
  const pendingReceipt = readReceipt(storageKey);
  const retryingAdmission = Boolean(pendingReceipt?.tester && pendingReceipt.startKey && (!pendingReceipt.id || !round));
  if (loading) return <div className="collection-participant-shell"><header><Mark /><span className="tiny">PRIVATE PLAYTEST</span></header><p className="muted">Opening the collection link…</p></div>;
  if (entry?.kind === 'passport') return <PassportReference key={token} collectionToken={token} />;
  return <div className="blind-shell collection-participant-shell"><header className="blind-top"><Mark /><span className="tiny">PRIVATE PLAYTEST</span></header>
    {!entry ? <div className="auth-shell"><div className="auth-card"><p className="error" role="alert">{error || 'This collection link could not be opened.'}</p><Button className="secondary" onClick={() => location.reload()}>Retry</Button></div></div> : <>
      {!round ? <section className="collection-entry-card"><p className="eyebrow">{entry.level.theme}</p><h1>{entry.level.title}</h1><p className="collection-entry-briefing">{entry.level.briefing}</p><div className="collection-entry-meta"><span>{Math.round(entry.level.duration / 60)} minute session</span><span>Reviewed by a person</span></div>
        <Field label="Your name" hint="Shown to the collection reviewers"><input value={name} maxLength={70} autoComplete="name" required onChange={event => setName(event.target.value)} /></Field>
        <label className="collection-consent"><input type="checkbox" checked={consented} onChange={event => setConsented(event.target.checked)} /><span>Your submitted prompts, model replies, actions, findings and timing data are saved for project analysis and may be exported by the organizer. Failed requests are recorded too. Do not enter passwords or personal information. Text you have not submitted is not collected. Your name and submitted transcript are included in collection review; standard exports omit your name.</span></label>
        {!entry.accepting && !retryingAdmission && <p className="error" role="status">This collection is not accepting new attempts. Ask the organizer for an active link.</p>}
        {error && <p className="error" role="alert">{error}</p>}
        <Button className="primary full" disabled={(!entry.accepting || !entry.connected) && !retryingAdmission || !name.trim() || (!consented && !retryingAdmission)} loading={busy} onClick={() => void start()}>Start playthrough<ArrowUpRight size={15} /></Button>
        {!entry.connected && <p className="muted collection-entry-state">The target is temporarily unavailable. Ask the organizer when the collection is ready.</p>}
      </section> : <><div className="collection-participant-heading"><p className="eyebrow">{round.level.theme}</p><h1>{round.level.title}</h1><p className="muted">This playthrough is being recorded for human review.</p></div><PlayPanel level={round.level} round={round} setRound={next => { setRound(next); const saved = readReceipt(storageKey); if (saved) saveReceipt(storageKey, { ...saved, id: next.id, accessToken: saved.accessToken, kind: 'conversation' }); }} connected={entry.connected} standalone hideModelLabel busy={busy} start={start} restart={start} />{error && <p className="error" role="alert">{error}</p>}</>}
    </>}
    <footer className="collection-consent-footer"><Check size={13} />Submitted activity and timing are recorded for collection review, including failed requests.</footer>
  </div>;
}

function readReceipt(key: string): Receipt | null {
  try { return JSON.parse(sessionStorage.getItem(key) || 'null') as Receipt | null; } catch { return null; }
}
function saveReceipt(key: string, receipt: Receipt) { sessionStorage.setItem(key, JSON.stringify(receipt)); }

