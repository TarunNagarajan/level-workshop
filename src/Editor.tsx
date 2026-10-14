import { useEffect, useRef, useState } from 'react';
import { ChevronRight, ArrowLeft, Plus, Copy, Link2, Eye, EyeOff, Code2, History, Play, X, Download, ArrowUpRight, Check } from 'lucide-react';
import { api, date, download } from './api';
import type { Bootstrap, Detail, Level, Round, User, Version } from './types';
import { Button, Field, Modal, Status, Empty } from './ui';
import { PlayPanel } from './Play';
import { navigate } from './App';

export function Editor({ levelId, user, model, notify }: { levelId: string; user: User; model: Bootstrap['model']; notify: (s: string) => void }) {
  const [detail, setDetail] = useState<Detail | null>(null); const [draft, setDraft] = useState<Level | null>(null);
  const [tab, setTab] = useState('scenario'); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const [round, setRound] = useState<Round | null>(null); const [modal, setModal] = useState(''); const [note, setNote] = useState('');
  const [showSecret, setShowSecret] = useState(false); const [share, setShare] = useState(''); const [request, setRequest] = useState<unknown>(null);
  const [team, setTeam] = useState<User[]>([]); const [comment, setComment] = useState('');
  const [replaying, setReplaying] = useState(false); const stopReplay = useRef(false);
  const [attempts, setAttempts] = useState<Round[]>([]); const [replayId, setReplayId] = useState('');
  const [selectedVersion, setSelectedVersion] = useState<Version | null>(null);
  useEffect(() => { const change = (event: Event) => { const section = (event as CustomEvent<string>).detail; if (['scenario', 'instructions', 'round', 'history'].includes(section)) setTab(section); }; window.addEventListener('workshop:tutorial-section', change); return () => window.removeEventListener('workshop:tutorial-section', change); }, []);
  const unsaved = Boolean(detail && draft && JSON.stringify(detail.draft) !== JSON.stringify(draft));
  useEffect(() => {
    if (!unsaved) return;
    const unload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    const leave = (event: Event) => { if (!window.confirm('Leave without saving these edits?')) event.preventDefault(); };
    window.addEventListener('beforeunload', unload); window.addEventListener('workshop:navigate', leave);
    return () => { window.removeEventListener('beforeunload', unload); window.removeEventListener('workshop:navigate', leave); };
  }, [unsaved]);
  useEffect(() => { void load(); api<User[]>('/team').then(setTeam).catch(() => {}); api<Round | null>(`/levels/${levelId}/active-round`).then(setRound).catch(() => {}); return () => { stopReplay.current = true; }; }, [levelId]);
  async function load(resetDraft = true) { try { const next = await api<Detail>(`/levels/${levelId}`); setDetail(next); if (resetDraft) setDraft(next.draft); } catch (e) { setError((e as Error).message); } }
  if (!detail || !draft) return <div className="page"><p className={error ? 'error' : 'muted'}>{error || 'Opening the draft…'}</p></div>;
  const editable = detail.ownerId === user.id || user.role === 'admin';
  const dirty = JSON.stringify(draft) !== JSON.stringify(detail.draft);
  const latest = detail.versions[0];
  const versionMatches = latest && JSON.stringify(latest.data) === JSON.stringify(draft);
  const update = <K extends keyof Level>(key: K, value: Level[K]) => setDraft({ ...draft, [key]: value });
  const act = async (fn: () => Promise<void>) => { setBusy(true); setError(''); try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  const saveDraft = async () => {
    if (!dirty) return detail;
    const saved = await api<Detail>(`/levels/${levelId}`, { method: 'PUT', body: { draft, revision: detail.revision } });
    const next = { ...detail, ...saved }; setDetail(next); setDraft(saved.draft); return next;
  };
  const start = async () => {
    if (!versionMatches) throw new Error('Save a version of these changes before testing.');
    const next = await api<Round>(`/levels/${levelId}/rounds`, { method: 'POST', body: { versionId: latest.id } }); setRound(next);
  };
  const status = async (value: string) => { if (dirty) throw new Error('Save the draft before changing its status.'); await api(`/levels/${levelId}/status`, { method: 'POST', body: { status: value } }); await load(false); notify('Status updated.'); };
  const openReplay = async () => { const tests = await api<Round[]>(`/attempts?levelId=${levelId}`); const useful = tests.filter(t => t.messages.some(m => m.role === 'user')); setAttempts(useful); setReplayId(useful[0]?.id || ''); setModal('replay'); };
  const replay = async () => {
    if (!versionMatches) throw new Error('Save a version before replaying.');
    const source = attempts.find(a => a.id === replayId); if (!source) throw new Error('Choose a conversation to replay.');
    setModal(''); setReplaying(true); stopReplay.current = false;
    try {
      let next = await api<Round>(`/levels/${levelId}/rounds`, { method: 'POST', body: { versionId: latest.id, replayOf: source.id } }); setRound(next);
      const accessToken = next.accessToken;
      for (const message of source.messages.filter(m => m.role === 'user')) {
        if (stopReplay.current) break;
        next = { ...await api<Round>(`/rounds/${next.id}/messages`, { method: 'POST', body: { content: message.content }, token: accessToken }), accessToken };
        setRound(next);
      }
      notify(stopReplay.current ? 'Replay stopped after the current turn.' : 'Replay complete. Review the new responses.');
    } finally { setReplaying(false); }
  };
  const inspect = async () => { setRequest(await api(round ? `/attempts/${round.id}/prompt` : `/levels/${levelId}/prompt`)); setModal('request'); };
  return <>
    <header className="editor-header"><div className="editor-location"><button className="icon-button" aria-label="Back to levels" onClick={() => navigate('/')}><ArrowLeft size={17} /></button><div className="breadcrumb">Levels<ChevronRight size={12} /><span>{detail.draft.title}</span></div></div><div className="editor-save"><span className="save-state">{dirty ? 'Unsaved edits' : 'Draft saved'}</span>{editable && <><Button className="secondary compact" loading={busy} disabled={!dirty} onClick={() => act(async () => { await saveDraft(); notify('Draft saved.'); })}>Save draft</Button><Button className="primary compact" loading={busy} onClick={() => { setNote(''); setModal('version'); }}>Save version<Plus size={14} /></Button></>}</div></header>
    {error && <div className="editor-error"><p role="alert">{error}</p><button className="icon-button" aria-label="Dismiss error" onClick={() => setError('')}><X size={14} /></button></div>}
    <div className="editor-columns"><section className="author-panel" aria-label="Level editor">
      <div className="author-heading"><p className="eyebrow">{draft.theme}</p><input className="title-input" aria-label="Level title" value={draft.title} maxLength={120} readOnly={!editable} onChange={e => update('title', e.target.value)} /><div className="author-meta"><Status value={detail.status} /><span>{latest ? `Version ${latest.number.toString().padStart(2, '0')}` : 'No saved version'}</span><span>{detail.owner}</span></div></div>
      <div className="editor-tabs" data-tour="editor-tabs" role="tablist" aria-label="Level sections">{[['scenario', 'Scenario'], ['instructions', 'Instructions'], ['round', 'Round'], ['history', 'History']].map(([key, label]) => <button role="tab" aria-selected={tab === key} className={tab === key ? 'selected' : ''} key={key} onClick={() => setTab(key)}>{label}</button>)}</div>
      <div className="author-body">
        {tab === 'scenario' && <fieldset data-tour="scenario" disabled={!editable}>
          <div className="field-pair"><Field label="Theme"><input value={draft.theme} maxLength={120} onChange={e => update('theme', e.target.value)} /></Field><Field label="Character"><input value={draft.character} maxLength={100} onChange={e => update('character', e.target.value)} /></Field></div>
          <Field label="Player briefing" hint="Visible to the player"><textarea rows={4} maxLength={6000} value={draft.briefing} onChange={e => update('briefing', e.target.value)} /></Field>
          <div className="secret-field"><div className="secret-label"><span className="field-label">Protected truth<span className="field-hint">Author only</span></span><button type="button" className="icon-button" aria-label={showSecret ? 'Hide protected truth' : 'Show protected truth'} onClick={() => setShowSecret(v => !v)}>{showSecret ? <EyeOff size={14} /> : <Eye size={14} />}</button></div>{showSecret ? <textarea aria-label="Protected truth" rows={4} maxLength={8000} value={draft.secret} onChange={e => update('secret', e.target.value)} /> : <button className="secret-cover" type="button" onClick={() => setShowSecret(true)}><Eye size={15} />Reveal protected truth</button>}</div>
          <Field label="Success requirements" hint="For the human reviewer"><textarea rows={3} maxLength={4000} value={draft.criteria} onChange={e => update('criteria', e.target.value)} /></Field>
          <Field label="Opening message"><textarea rows={3} maxLength={2000} value={draft.opening} onChange={e => update('opening', e.target.value)} /></Field>
        </fieldset>}
        {tab === 'instructions' && <fieldset data-tour="instructions" disabled={!editable}>
          <Field label="Challenge type"><select value={draft.mode} onChange={e => update('mode', e.target.value as Level['mode'])}><option value="deduction">Deduction · permitted clues</option><option value="jailbreak">Jailbreak · protected information</option></select></Field>
          <p className="field-explanation">{draft.mode === 'deduction' ? 'Focused questions can uncover the permitted clues. The player reconstructs the truth.' : 'The target is instructed to protect the truth and its implications. Players attempt to break that instruction.'}</p>
          <Field label="System prompt"><textarea className="code-input" rows={12} maxLength={16000} value={draft.systemPrompt} onChange={e => update('systemPrompt', e.target.value)} /></Field><p className="field-explanation">The server adds the protected truth, character, permitted clues and response limit to this prompt. Optional variables: <code>{'{{character}}'}</code>, <code>{'{{secret}}'}</code>, <code>{'{{clues}}'}</code>.</p>
          <Field label="Permitted clues" hint={draft.mode === 'jailbreak' ? 'Background only' : 'Define when each can emerge'}><textarea rows={5} maxLength={6000} value={draft.clues} onChange={e => update('clues', e.target.value)} /></Field>
        </fieldset>}
        {tab === 'round' && <fieldset disabled={!editable}>
          <div className="field-pair"><Field label="Time limit"><select value={draft.duration} onChange={e => update('duration', Number(e.target.value))}>{[60, 180, 240, 300, 600].map(v => <option key={v} value={v}>{v / 60} minute{v === 60 ? '' : 's'}</option>)}</select></Field><Field label="Reply length" hint="Word target"><input type="number" min={30} max={200} value={draft.responseWords} onChange={e => update('responseWords', Number(e.target.value))} /></Field></div>
          <Field label="Temperature" hint={draft.temperature.toFixed(2)}><input type="range" min="0" max="1" step="0.05" value={draft.temperature} onChange={e => update('temperature', Number(e.target.value))} /></Field>
          <div className="section-line"><span className="field-label">Player hints</span><Button className="text-button" disabled={draft.hints.length >= 5} onClick={() => update('hints', [...draft.hints, ''])}><Plus size={13} />Add hint</Button></div>
          {!draft.hints.length && <p className="muted small">No hints for this round.</p>}{draft.hints.map((hint, i) => <div className="hint-editor" key={i}><span>{i + 1}</span><textarea aria-label={`Hint ${i + 1}`} rows={2} maxLength={600} value={hint} onChange={e => update('hints', draft.hints.map((h, n) => n === i ? e.target.value : h))} /><button className="icon-button" aria-label={`Remove hint ${i + 1}`} onClick={() => update('hints', draft.hints.filter((_, n) => n !== i))}><X size={14} /></button></div>)}
          <div className="section-line"><span className="field-label">Level ownership</span></div><Field label="Assigned author"><select disabled={user.role !== 'admin'} value={detail.ownerId} onChange={e => act(async () => { await api(`/levels/${levelId}/owner`, { method: 'POST', body: { userId: e.target.value } }); await load(false); notify('Author assigned.'); })}>{team.map(u => <option value={u.id} key={u.id}>{u.name}</option>)}</select></Field>
          <Field label="Workflow status"><select value={detail.status} onChange={e => act(() => status(e.target.value))}>{[['draft', 'Draft'], ['testing', 'Testing'], ['revision', 'Needs revision'], ['review', 'Submit for review'], ...(user.role === 'admin' ? [['approved', 'Approved']] : [])].map(([v, label]) => <option value={v} key={v}>{label}</option>)}</select></Field>
        </fieldset>}
        {tab === 'history' && <>
          <div className="section-line"><span className="field-label">Saved versions</span><span className="tiny">{detail.versions.length}</span></div>
          {detail.versions.map(v => <button className="version-row" key={v.id} onClick={() => { setSelectedVersion(v); setModal('version-detail'); }}><span className="version-number">v{v.number}</span><span><strong>{v.note}</strong><small>{v.author}<span className="middot">·</span>{date(v.createdAt)}</small></span><ChevronRight size={14} /></button>)}{!detail.versions.length && <Empty>No saved versions yet.</Empty>}
          <div className="section-line comments-heading"><span className="field-label">Team notes</span></div>{detail.comments.map(c => <div className="comment" key={c.id}><div><strong>{c.author}</strong><small>{date(c.created_at)}</small></div><p>{c.text}</p></div>)}
          <form className="comment-form" onSubmit={e => { e.preventDefault(); void act(async () => { await api(`/levels/${levelId}/comments`, { method: 'POST', body: { text: comment } }); setComment(''); await load(false); }); }}><textarea aria-label="Team note" rows={2} maxLength={3000} value={comment} placeholder="Leave a note for the team…" onChange={e => setComment(e.target.value)} /><Button className="secondary compact" disabled={!comment.trim()} loading={busy}>Add note</Button></form>
        </>}
      </div>
      <div className="author-tools"><button className="text-button" disabled={busy} onClick={() => act(inspect)}><Code2 size={14} />Inspect request</button><button className="text-button" disabled={busy} onClick={() => act(async () => { const next = await api<{ id: string }>('/levels', { method: 'POST', body: { templateId: levelId } }); navigate(`/levels/${next.id}`); })}><Copy size={14} />Duplicate</button><button className="icon-button" aria-label="Export level" title="Export level" onClick={() => download(`${draft.title.replace(/[^a-z0-9]/gi, '-')}.json`, { draft, versions: detail.versions })}><Download size={14} /></button></div>
    </section>
    <div className="preview-column" data-tour="preview"><div className="preview-toolbar"><span>{round ? `v${detail.versions.find(v => v.id === round.versionId)?.number || '?'}` : latest ? `v${latest.number}` : 'No version'}<span className="middot">·</span>{round ? 'Frozen at test start' : versionMatches ? 'Ready to test' : 'Save a version to test changes'}</span><div>{replaying ? <button className="text-button" onClick={() => { stopReplay.current = true; }}>Stop replay</button> : <button className="icon-button" aria-label="Replay a conversation" title="Replay a conversation" disabled={!versionMatches || !model.connected} onClick={() => act(openReplay)}><Play size={14} /></button>}<button className="text-button" disabled={!latest || busy || !editable} onClick={() => act(async () => { if (!versionMatches) throw new Error('Save a version of these changes before sharing.'); const link = await api<{ path: string }>(`/levels/${levelId}/links`, { method: 'POST', body: { versionId: latest.id } }); await load(false); setShare(window.location.origin + link.path); setModal('share'); })}><Link2 size={14} />Blind test</button></div></div>
      <PlayPanel level={{ ...draft, hintCount: draft.hints.length }} round={round} setRound={setRound} start={start} restart={start} connected={model.connected} busy={replaying} branch={async messageId => { if (!round) return; setRound(await api<Round>(`/rounds/${round.id}/branch`, { method: 'POST', body: { messageId }, token: round.accessToken })); }} />
    </div></div>
    {modal === 'version' && <Modal error={error} title="Save a version" close={() => setModal('')}><form onSubmit={e => { e.preventDefault(); void act(async () => { const saved = await saveDraft(); await api(`/levels/${levelId}/versions`, { method: 'POST', body: { revision: saved.revision, note } }); await load(); setModal(''); notify('Version saved. Existing test links keep their earlier version.'); }); }}><Field label="What changed?"><textarea autoFocus rows={3} maxLength={1000} required value={note} placeholder="A short note for the next reviewer…" onChange={e => setNote(e.target.value)} /></Field><Button className="primary full" loading={busy}>Save version<Plus size={14} /></Button></form></Modal>}
    {modal === 'share' && <Modal error={error} title="Blind test" close={() => setModal('')}><p className="muted small">This link opens only the player view of version {latest?.number}. It expires in seven days.</p><div className="share-link"><input aria-label="Blind test link" readOnly value={share} /><button className="icon-button" aria-label="Copy blind test link" onClick={() => navigator.clipboard.writeText(share).then(() => notify('Test link copied.')).catch(() => notify('Select and copy the link.'))}><Copy size={16} /></button></div><a className="primary button-link" href={share} target="_blank" rel="noreferrer">Open player view<ArrowUpRight size={15} /></a><details className="active-links"><summary>Manage test links</summary>{detail.links.filter(l => !l.revoked).map(l => <div key={l.id}><span>v{detail.versions.find(v => v.id === l.versionId)?.number}<small>{date(l.createdAt)}</small></span><button className="text-button" onClick={() => act(async () => { await api(`/links/${l.id}`, { method: 'DELETE' }); await load(false); notify('Link revoked for new sessions.'); })}>Revoke</button></div>)}</details></Modal>}
    {modal === 'request' && <Modal error={error} title={round ? 'Saved test request' : 'Saved draft request'} close={() => setModal('')} wide>{dirty && !round && <p className="muted small">This is the saved draft. Save your edits to inspect their compiled instructions.</p>}<pre className="request-code">{JSON.stringify(request, null, 2)}</pre></Modal>}
    {modal === 'replay' && <Modal error={error} title="Replay against this version" close={() => setModal('')}><p className="muted small">The saved player prompts will run in order. Target replies are generated again; they can change. The replay gets a fresh timer.</p>{attempts.length ? <><Field label="Source conversation"><select value={replayId} onChange={e => setReplayId(e.target.value)}>{attempts.map(a => <option value={a.id} key={a.id}>{a.tester} · {a.messages.filter(m => m.role === 'user').length} prompts · {date(a.startedAt)}</option>)}</select></Field><Button className="primary full" onClick={() => act(replay)}><Play size={14} />Start replay</Button></> : <Empty>No conversations with player prompts yet.</Empty>}</Modal>}
    {modal === 'version-detail' && selectedVersion && <Modal error={error} title={`Version ${selectedVersion.number}`} close={() => setModal('')} wide><p className="muted small">{selectedVersion.note}<br />{selectedVersion.author} · {date(selectedVersion.createdAt)}</p><div className="version-compare">{(['briefing', 'secret', 'systemPrompt', 'clues', 'criteria'] as const).map(key => <details key={key}><summary>{({ briefing: 'Player briefing', secret: 'Protected truth', systemPrompt: 'System prompt', clues: 'Permitted clues', criteria: 'Success requirements' })[key]}{selectedVersion.data[key] !== draft[key] && <span className="changed">Differs from draft</span>}</summary><p>{selectedVersion.data[key]}</p>{selectedVersion.data[key] !== draft[key] && <div className="current-value"><small>CURRENT DRAFT</small><p>{draft[key]}</p></div>}</details>)}</div>{editable && <Button className="secondary full" loading={busy} onClick={() => act(async () => { if (dirty && !window.confirm('Replace your unsaved edits with this version?')) return; await api(`/levels/${levelId}/restore`, { method: 'POST', body: { versionId: selectedVersion.id, revision: detail.revision } }); await load(); setModal(''); notify('Version restored to the draft. Test history is preserved.'); })}><History size={14} />Restore to draft</Button>}</Modal>}
  </>;
}
