import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Check, ChevronRight } from 'lucide-react';
import { api } from './api';
import type { PlayerLevel, Round } from './types';
import { Button, Field, Mark } from './ui';
import { PlayPanel } from './Play';
import { PassportReference } from './PassportReference';

type Entry = { level: PlayerLevel; connected: boolean; kind: 'conversation' | 'passport'; consentTextVersion: string; accepting: boolean; isPassport: boolean };
type Receipt = { tester: string; consent: true; startKey: string; id?: string; accessToken?: string; kind?: string };
type Admission = { kind: 'conversation' | 'passport'; round: Round; state?: unknown; documents?: unknown };

export function CollectionParticipant({ token }: { token: string }) {
  const storageKey = `workshop-collection:${token}`;
  const [entry, setEntry] = useState<Entry | null>(null), [round, setRound] = useState<Round | null>(null);
  const [name, setName] = useState(''), [consented, setConsented] = useState(false), [error, setError] = useState(''), [busy, setBusy] = useState(false), [loading, setLoading] = useState(true);
  const starting = useRef(false);
  useEffect(() => {
    let active = true;
    setEntry(null); setRound(null); setError(''); setLoading(true); setName(''); setConsented(false); starting.current = false;
    const receipt = readReceipt(storageKey);
    if (receipt?.tester && receipt.startKey) { setName(receipt.tester); setConsented(true); }
    (async () => {
      try {
        if (receipt?.tester && receipt.startKey) {
          try {
            const resumed = await api<Admission>(`/collect/${token}`, { method: 'POST', body: { tester: receipt.tester, consent: true, startKey: receipt.startKey } });
            if (!active) return;
            saveReceipt(storageKey, { ...receipt, id: resumed.round.id, accessToken: resumed.round.accessToken, kind: resumed.kind });
            setRound(resumed.round); setEntry(current => current || { level: resumed.round.level, connected: true, kind: resumed.kind, consentTextVersion: 'collection-recording-v1', accepting: true, isPassport: resumed.kind === 'passport' });
            return;
          } catch { /* A missing receipt can be entered again; the original key remains available for a safe retry. */ }
        }
        if (!active) return;
        const publicEntry = await api<Entry>(`/collect/${token}`);
        if (!active) return;
        setEntry(publicEntry);
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
      saveReceipt(storageKey, { ...receipt, id: result.round.id, accessToken: result.round.accessToken, kind: result.kind });
      setRound(result.round); setEntry(current => current ? { ...current, level: result.round.level, kind: result.kind, isPassport: result.kind === 'passport' } : current);
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
        <label className="collection-consent"><input type="checkbox" checked={consented} onChange={event => setConsented(event.target.checked)} /><span>My name, typed questions, replies, actions and submitted finding will be recorded for human review. Transcript text may appear in collection exports; my name is omitted from standard exports. The organizer may choose a full export that includes author-only scenario and prompt context.</span></label>
        {!entry.accepting && !retryingAdmission && <p className="error" role="status">This collection is not accepting new attempts. Ask the organizer for an active link.</p>}
        {error && <p className="error" role="alert">{error}</p>}
        <Button className="primary full" disabled={(!entry.accepting || !entry.connected) && !retryingAdmission || !name.trim() || (!consented && !retryingAdmission)} loading={busy} onClick={() => void start()}>Start playthrough<ArrowUpRight size={15} /></Button>
        {!entry.connected && <p className="muted collection-entry-state">The target is temporarily unavailable. Ask the organizer when the collection is ready.</p>}
      </section> : <><div className="collection-participant-heading"><p className="eyebrow">{round.level.theme}</p><h1>{round.level.title}</h1><p className="muted">This playthrough is being recorded for human review.</p></div><PlayPanel level={round.level} round={round} setRound={next => { setRound(next); const saved = readReceipt(storageKey); if (saved) saveReceipt(storageKey, { ...saved, id: next.id, accessToken: saved.accessToken, kind: 'conversation' }); }} connected={entry.connected} standalone hideModelLabel start={start} restart={start} />{error && <p className="error" role="alert">{error}</p>}</>}
    </>}
    <footer className="collection-consent-footer"><Check size={13} />Recorded for collection review. Standard exports omit your name.</footer>
  </div>;
}

function readReceipt(key: string): Receipt | null {
  try { return JSON.parse(sessionStorage.getItem(key) || 'null') as Receipt | null; } catch { return null; }
}
function saveReceipt(key: string, receipt: Receipt) { sessionStorage.setItem(key, JSON.stringify(receipt)); }

