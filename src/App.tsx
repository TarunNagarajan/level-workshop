import { useEffect, useState, type ReactNode } from 'react';
import { PanelsTopLeft, FlaskConical, Users, SlidersHorizontal, Sun, Moon, LogOut, ArrowUpRight, Plus, Search, ChevronRight, Copy, Check, RefreshCcw, CircleHelp, Network, BookOpen, Layers3, ChartNoAxesCombined } from 'lucide-react';
import { api, date, setInceptionRecordingAuthorization, setRecordingAcknowledged } from './api';
import type { Bootstrap, Summary, User } from './types';
import { Mark, Status, Button, Field, Empty } from './ui';
import { Editor } from './Editor';
import { Attempts } from './Attempts';
import { BlindPlay } from './Play';
import { Tutorial } from './Tutorial';
import { OrchestrationLab } from './Orchestration';
import { PassportReference } from './PassportReference';
import { CollectionArea } from './Collections';
import { CollectionParticipant } from './CollectionParticipant';
import { Metrics } from './Metrics';
import { RecordingNotice } from './RecordingNotice';
import { RiddleDiary } from './RiddleDiary';
import { MissionLevel } from './MissionLevel';
import { InceptionLevel } from './InceptionLevel';
import { navigateMetrics, syncMetricsIdentity } from './telemetry';

let historyIndex = 0;
let approvedNavigation: string | null = null;
type InceptionEntryResult = { actorId: string; recordingAuthorized: boolean; policyId: string | null; ordinaryRecordingNotice?: boolean };
let inceptionEntryFlight: Promise<InceptionEntryResult> | null = null;
const establishInceptionEntry = () => {
  if (!inceptionEntryFlight) inceptionEntryFlight = api<InceptionEntryResult>('/inception/entry', { method: 'POST', body: {} }).finally(() => { inceptionEntryFlight = null; });
  return inceptionEntryFlight;
};

export function navigate(path: string) {
  if (!window.dispatchEvent(new CustomEvent('workshop:navigate', { cancelable: true }))) return false;
  historyIndex += 1;
  approvedNavigation = new URL(path, window.location.href).pathname;
  window.history.pushState({ ...window.history.state, __workshopIndex: historyIndex }, '', path);
  window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state }));
  return true;
}

export function App() {
  const [path, setPath] = useState(window.location.pathname);
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [dark, setDark] = useState(localStorage.getItem('workshop-theme') === 'dark');
  const [tourOpen, setTourOpen] = useState(false); const [tourUser, setTourUser] = useState('');
  const standaloneCollection = path.startsWith('/collect/');
  const isInceptionRoute = /^\/inception\/?$/.test(path);
  const inceptionDestination = isInceptionRoute ? `${path}${window.location.search}` : path;
  const inWorkspace = !/^\/(play|enter|owner|join|collect)\//.test(path) && !path.startsWith('/reference/play/') && !path.startsWith('/diary/play/') && path !== '/reference/research/preview' && !isInceptionRoute;
  const requiresStandaloneConsent = path.startsWith('/collect/') || path.startsWith('/play/') || path.startsWith('/reference/play/') || path.startsWith('/diary/play/');
  const recordingPermitted = Boolean(bootstrap) && (isInceptionRoute ? bootstrap?.recordingAccepted === true : bootstrap?.recordingAccepted === true || bootstrap?.recordingNoticeRequired !== true);
  useEffect(() => { if (bootstrap?.user && recordingPermitted && path === '/' && tourUser !== bootstrap.user.id) { setTourUser(bootstrap.user.id); if (!bootstrap.tutorialDone) setTourOpen(true); } }, [bootstrap, recordingPermitted, path, tourUser]);
  useEffect(() => {
    if (typeof window.history.state?.__workshopIndex === 'number') historyIndex = window.history.state.__workshopIndex;
    else window.history.replaceState({ ...window.history.state, __workshopIndex: historyIndex }, '');
    let currentPath = window.location.pathname;
    let restoringIndex: number | null = null;
    const listener = (event: PopStateEvent) => {
      const nextPath = window.location.pathname;
      const nextIndex = event.state?.__workshopIndex;
      if (restoringIndex !== null && nextIndex === restoringIndex) { restoringIndex = null; return; }
      if (approvedNavigation === nextPath) approvedNavigation = null;
      else if (nextPath !== currentPath && !window.dispatchEvent(new CustomEvent('workshop:navigate', { cancelable: true }))) {
        if (typeof nextIndex === 'number' && nextIndex !== historyIndex) {
          restoringIndex = historyIndex;
          window.history.go(historyIndex - nextIndex);
        } else window.history.pushState({ ...window.history.state, __workshopIndex: historyIndex }, '', currentPath);
        return;
      }
      if (typeof nextIndex === 'number') historyIndex = nextIndex;
      currentPath = nextPath;
      setPath(nextPath);
    };
    window.addEventListener('popstate', listener);
    return () => window.removeEventListener('popstate', listener);
  }, []);
  const reload = () => api<Bootstrap>('/bootstrap').then(setBootstrap).catch(e => setError(e.message));
  useEffect(() => { if (!standaloneCollection && !isInceptionRoute) void reload(); }, [standaloneCollection, isInceptionRoute]);
  useEffect(() => { if (isInceptionRoute) return; const allowed = !requiresStandaloneConsent && Boolean(bootstrap) && (bootstrap?.recordingAccepted === true || bootstrap?.recordingNoticeRequired !== true); setRecordingAcknowledged(allowed); navigateMetrics(path); }, [path, bootstrap, bootstrap?.recordingAccepted, bootstrap?.recordingNoticeRequired, requiresStandaloneConsent, isInceptionRoute]);
  useEffect(() => { if (isInceptionRoute) return; syncMetricsIdentity(bootstrap?.user?.id || null); }, [path, bootstrap?.user?.id, bootstrap?.needsSetup, bootstrap?.recordingAccepted, bootstrap?.recordingNoticeRequired, isInceptionRoute]);
  useEffect(() => {
    const listener = (event: MessageEvent) => {
      const frame = document.querySelector<HTMLIFrameElement>('.mission-host iframe');
      if (event.origin !== window.location.origin || event.source !== frame?.contentWindow || event.data?.type !== 'mission:return') return;
      navigate('/');
    };
    window.addEventListener('message', listener);
    return () => window.removeEventListener('message', listener);
  }, []);
  useEffect(() => { document.documentElement.dataset.theme = dark ? 'dark' : 'light'; localStorage.setItem('workshop-theme', dark ? 'dark' : 'light'); }, [dark]);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(''), 4500); return () => clearTimeout(timer); }, [toast]);
  const notify = (message: string) => setToast(message);
  let content: ReactNode;
  if (isInceptionRoute) content = <DirectInceptionEntry />;
  else if (path === '/reference/research/preview') content = <PassportReference researchPreview />;
  else if (path.startsWith('/reference/play/')) content = <PassportReference blindToken={path.split('/')[3]} />;
  else if (path.startsWith('/diary/play/')) content = <RiddleDiary blindToken={path.split('/')[3]} />;
  else if (path.startsWith('/collect/')) content = <CollectionParticipant key={path.split('/')[2]} token={path.split('/')[2]} />;
  else if (path.startsWith('/play/')) content = <BlindPlay token={path.split('/')[2]} />;
  else if (!bootstrap) content = <div className="auth-shell"><Mark />{error ? <><p className="error">{error}</p><Button onClick={reload}>Retry</Button></> : <p className="muted">Opening workshop…</p>}</div>;
  else if (path.startsWith('/enter/') || path.startsWith('/owner/')) content = <LinkEntry token={path.split('/')[2]} owner={path.startsWith('/owner/')} onDone={() => { navigate('/'); void reload(); }} />;
  else if (!bootstrap.user && bootstrap.rootEntry && !path.startsWith('/join/')) content = <RootEntry onDone={() => { navigate(isInceptionRoute ? inceptionDestination : path || '/'); void reload(); }} />;
  else if (!bootstrap.user && bootstrap.privateEntry && !path.startsWith('/join/')) content = <div className="auth-shell"><div className="auth-card"><Mark /><p className="eyebrow">LEVEL WORKSHOP</p><h1>A private workshop.</h1><p className="muted auth-description">Open the invitation link shared with you to enter the workshop.</p></div></div>;
  else if (!bootstrap.user || path.startsWith('/join/')) content = <Auth setup={bootstrap.needsSetup} invite={path.startsWith('/join/') ? path.split('/')[2] : undefined} onDone={() => { navigate(path === '/diary' || path === '/mission' ? path : isInceptionRoute ? inceptionDestination : '/'); void reload(); }} />;
  else if (bootstrap.recordingNoticeRequired === true && (bootstrap.recordingAccepted !== true || bootstrap.recordingNoticeVersion !== 'recording-notice-v1')) content = <RecordingNotice onAccepted={() => { setRecordingAcknowledged(true); void reload(); }} />;
  else {
    const user = bootstrap.user;
    const memberModel = { connected: bootstrap.model.connected, model: bootstrap.model.model || 'Not configured', provider: bootstrap.model.provider || 'Not configured' };
    const page = path === '/diary' || path.startsWith('/diary/') ? 'diary' : path === '/mission' ? 'mission' : path === '/inception' ? 'inception' : path.startsWith('/levels/') ? 'editor' : path.startsWith('/collections') ? 'collections' : path.startsWith('/attempts') ? 'attempts' : path.startsWith('/reference') ? 'reference' : path.startsWith('/orchestration') ? 'orchestration' : path.startsWith('/team') ? 'team' : path.startsWith('/settings') ? 'settings' : path.startsWith('/metrics') ? 'metrics' : 'levels';
    content = <div className="workspace">
      <aside className="sidebar">
        <div className="sidebar-top"><Mark /><span className="tiny">PRIVATE WORKSPACE</span></div>
        <nav aria-label="Main navigation">
          {[['/', 'Levels', PanelsTopLeft, 'levels'], ['/diary', "Riddle's diary", BookOpen, 'diary'], ['/mission', 'Mission: Impossible', Network, 'mission'], ['/inception', 'Inception', BookOpen, 'inception'], ['/reference', 'Reference', BookOpen, 'reference'], ['/collections', 'Collections', Layers3, 'collections'], ['/attempts', 'Tests', FlaskConical, 'attempts'], ['/orchestration', 'Orchestration', Network, 'orchestration'], ['/team', 'Team', Users, 'team'], ...(user.role === 'admin' ? [['/metrics', 'Metrics', ChartNoAxesCombined, 'metrics']] : [])].map(([url, label, Icon, key]) => { const C = Icon as typeof PanelsTopLeft; return <button aria-label={String(label)} data-tour={`nav-${key}`} key={String(url)} className={`nav-item ${page === key || (key === 'levels' && page === 'editor') ? 'active' : ''}`} onClick={() => navigate(String(url))}><C size={17} strokeWidth={1.5} />{String(label)}</button>; })}
        </nav>
        <div className="sidebar-bottom">
          <button className="nav-item" aria-label="Quick tour" onClick={() => { if (path !== '/') navigate('/'); setTourOpen(true); }}><CircleHelp size={17} strokeWidth={1.5} />Quick tour</button>
          <button className={`nav-item ${page === 'settings' ? 'active' : ''}`} onClick={() => navigate('/settings')}><SlidersHorizontal size={17} strokeWidth={1.5} />Connection<span className={`connection-dot ${bootstrap.model.connected ? 'connected' : ''}`} /></button>
          <div className="account-row"><span className="avatar">{user.name.slice(0, 1).toUpperCase()}</span><div><span>{user.name}</span><small>{user.role === 'admin' ? 'Workspace owner' : 'Level author'}</small></div></div>
          <div className="utility-row"><button className="icon-button" aria-label={dark ? 'Use light theme' : 'Use dark theme'} onClick={() => setDark(v => !v)}>{dark ? <Sun size={16} /> : <Moon size={16} />}</button><button className="icon-button" aria-label="Sign out" onClick={async () => { await api('/logout', { method: 'POST' }); await reload(); }}><LogOut size={16} /></button></div>
        </div>
      </aside>
      <main className={`main ${page === 'editor' ? 'editor-main' : ''}`}>
        {page === 'mission' ? <MissionLevel />
          : page === 'editor' ? <Editor key={path} levelId={path.split('/')[2]} user={user} model={memberModel} notify={notify} />
          : page === 'diary' ? <RiddleDiary canShare={user.role === 'admin'} onHome={() => navigate('/')} />
          : page === 'inception' ? <InceptionLevel />
          : page === 'attempts' ? <Attempts selectedId={path.split('/')[2]} notify={notify} />
          : page === 'collections' ? <CollectionArea path={path} notify={notify} user={user} />
          : page === 'reference' ? <PassportReference key={path} researchWorld={path.startsWith('/reference/research/') && user.role === 'admin' ? path.split('/')[3] : undefined} />
          : page === 'orchestration' ? <OrchestrationLab user={user} model={memberModel} configId={path.split('/')[2]} runId={path.split('/')[4]} notify={notify} />
          : page === 'team' ? <Team user={user} notify={notify} />
          : page === 'settings' ? <Connection model={memberModel} reload={reload} />
          : page === 'metrics' ? user.role === 'admin' ? <Metrics /> : <div className="page narrow"><Empty>This page is not available for this account.</Empty></div>
          : <Library user={user} notify={notify} />}
      </main>
    </div>;
  }
  return <>{content}{!isInceptionRoute && tourOpen && inWorkspace && bootstrap?.user && recordingPermitted && <Tutorial key={bootstrap.user.id} user={bootstrap.user} path={path} navigate={navigate} close={() => { setTourOpen(false); setBootstrap(b => b ? { ...b, tutorialDone: true } : b); }} />}{!isInceptionRoute && toast && <div role="status" className="toast"><Check size={15} />{toast}<button className="icon-button" aria-label="Dismiss notification" onClick={() => setToast('')}>×</button></div>}</>;
}

function DirectInceptionEntry() {
  const [entry, setEntry] = useState<InceptionEntryResult | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setRecordingAcknowledged(false);
    setInceptionRecordingAuthorization(false);
    syncMetricsIdentity(null);
    navigateMetrics(window.location.pathname);
    void establishInceptionEntry().then(result => {
      if (!active) return;
      setEntry(result);
      if (result.recordingAuthorized) {
        syncMetricsIdentity(result.actorId);
        setInceptionRecordingAuthorization(true);
        setRecordingAcknowledged(false);
        navigateMetrics(window.location.pathname);
      }
    }).catch(cause => { if (active) setError((cause as Error).message || 'The Inception entry link is unavailable.'); });
    return () => { active = false; setInceptionRecordingAuthorization(false); };
  }, [attempt]);
  if (!entry) return <main className="inception-loading" aria-busy={error ? 'false' : 'true'}>{error ? <><p role="alert">{error}</p><Button className="inception-quiet-button" onClick={() => { setError(''); setAttempt(value => value + 1); }}>Retry</Button></> : <p>Opening the strongroom…</p>}</main>;
  if (entry.ordinaryRecordingNotice) return <RecordingNotice title="Before you enter Inception" onAccepted={() => { syncMetricsIdentity(entry.actorId); setInceptionRecordingAuthorization(false); setRecordingAcknowledged(true); setEntry(current => current ? { ...current, recordingAuthorized: true, ordinaryRecordingNotice: false } : current); }} />;
  return <div className="inception-standalone-route"><InceptionLevel directEntry /></div>;
}

function RootEntry({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState(''); const [ready, setReady] = useState(false); const [checking, setChecking] = useState(true);
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const check = async () => {
    setChecking(true); setError(''); setReady(false);
    try { const result = await api<{ ready: boolean }>('/entry'); setReady(result.ready); }
    catch (e) { setError((e as Error).message); }
    finally { setChecking(false); }
  };
  useEffect(() => { void check(); }, []);
  return <div className="auth-shell"><div className="auth-card"><Mark /><p className="eyebrow">LEVEL WORKSHOP</p><h1>Enter the workshop.</h1><p className="muted auth-description">Enter your name to write and test levels with the team.</p>
    <form onSubmit={async event => {
      event.preventDefault(); setBusy(true); setError('');
      try { await api('/entry', { method: 'POST', body: { name } }); onDone(); }
      catch (e) { setError((e as Error).message); setReady(false); }
      finally { setBusy(false); }
    }}><Field label="Your name"><input autoComplete="name" autoFocus required maxLength={70} value={name} onChange={e => setName(e.target.value)} disabled={!ready || busy} /></Field>
      {checking && <p className="muted" role="status">Checking workshop availability…</p>}
      {error && <p className="error" role="alert">{error}</p>}
      <Button className="primary full" disabled={!ready || !name.trim()} loading={busy}>Enter workshop<ArrowUpRight size={16} /></Button>
    </form>{!ready && !checking && <Button className="secondary full" onClick={() => void check()}>Check availability again</Button>}
    <p className="settings-note">This browser will remember your workspace for 30 days.</p>
  </div></div>;
}

function LinkEntry({ token, owner, onDone }: { token: string; owner: boolean; onDone: () => void }) {
  const [name, setName] = useState(''); const [valid, setValid] = useState(false);
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const endpoint = `/${owner ? 'owner' : 'enter'}/${token}`;
  useEffect(() => { api(endpoint).then(() => setValid(true)).catch(e => setError(e.message)); }, [endpoint]);
  return <div className="auth-shell"><div className="auth-card"><Mark /><p className="eyebrow">LEVEL WORKSHOP</p><h1>{owner ? 'Your workshop.' : 'Join the workshop.'}</h1><p className="muted auth-description">{owner ? 'Enter your name to open the owner workspace.' : 'Enter your name to write and test levels with the team.'}</p><form onSubmit={async event => {
    event.preventDefault(); setBusy(true); setError('');
    try { await api(endpoint, { method: 'POST', body: { name } }); onDone(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }}><Field label="Your name"><input autoComplete="name" autoFocus required maxLength={70} value={name} onChange={e => setName(e.target.value)} /></Field>{error && <p className="error" role="alert">{error}</p>}<Button className="primary full" disabled={!valid} loading={busy}>Enter workshop</Button></form><p className="settings-note">This browser will remember you for 30 days.</p></div></div>;
}

function Auth({ setup, invite, onDone }: { setup: boolean; invite?: string; onDone: () => void }) {
  const [name, setName] = useState(''); const [email, setEmail] = useState(''); const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [validInvite, setValidInvite] = useState(!invite);
  useEffect(() => { if (invite) api(`/invite/${invite}`).then(() => setValidInvite(true)).catch(e => setError(e.message)); }, [invite]);
  const creating = setup || Boolean(invite);
  return <div className="auth-shell"><div className="auth-card"><Mark /><p className="eyebrow">LEVEL WORKSHOP</p><h1>{setup ? 'Set up your workspace.' : invite ? 'Join the workshop.' : 'Welcome back.'}</h1><p className="muted auth-description">{setup ? 'Create the owner account. Your three theme drafts will be ready inside.' : invite ? 'Create your author account to write and test levels with the team.' : 'Sign in to your private workspace.'}</p>
    <form onSubmit={async event => { event.preventDefault(); setBusy(true); setError(''); try { await api(invite ? `/invite/${invite}` : setup ? '/setup' : '/login', { method: 'POST', body: { name, email, password } }); onDone(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }}>
      {creating && <Field label="Your name"><input autoComplete="name" required maxLength={70} value={name} onChange={e => setName(e.target.value)} /></Field>}
      <Field label="Email"><input type="email" autoComplete="email" required value={email} onChange={e => setEmail(e.target.value)} /></Field>
      <Field label="Password" hint={creating ? 'At least 10 characters' : undefined}><input type="password" autoComplete={creating ? 'new-password' : 'current-password'} required minLength={creating ? 10 : 1} maxLength={200} value={password} onChange={e => setPassword(e.target.value)} /></Field>
      {error && <p className="error" role="alert">{error}</p>}<Button className="primary full" loading={busy} disabled={!validInvite}>{creating ? 'Create account' : 'Sign in'}<ArrowUpRight size={16} /></Button>
    </form>
  </div></div>;
}

function Library({ user, notify }: { user: User; notify: (s: string) => void }) {
  const [levels, setLevels] = useState<Summary[]>([]); const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState(''); const [filter, setFilter] = useState('all'); const [error, setError] = useState('');
  useEffect(() => { api<Summary[]>('/levels').then(setLevels).catch(e => setError(e.message)).finally(() => setLoading(false)); }, []);
  const shown = levels.filter(l => `${l.draft.title} ${l.draft.theme} ${l.owner}`.toLowerCase().includes(query.toLowerCase()) && (filter === 'all' || filter === 'mine' && l.ownerId === user.id || l.status === filter));
  const create = async () => { try { const level = await api<Summary>('/levels', { method: 'POST', body: {} }); navigate(`/levels/${level.id}`); } catch (e) { notify((e as Error).message); } };
  return <div className="page library-page" data-tour="library"><div className="breadcrumb">Workshop <ChevronRight size={12} /> Levels</div>
    <header className="page-heading"><div><h1>Levels<span className="heading-count">{levels.length.toString().padStart(2, '0')}</span></h1></div><Button className="primary" onClick={create}><Plus size={15} />New level</Button></header>
    <div className="library-toolbar"><div className="filter-tabs" aria-label="Filter levels">{[['all', 'All levels'], ['mine', 'Assigned to me'], ['review', 'In review'], ['approved', 'Approved']].map(([value, label]) => <button key={value} className={filter === value ? 'selected' : ''} onClick={() => setFilter(value)}>{label}</button>)}</div><label className="search"><Search size={15} /><input aria-label="Search levels" placeholder="Search levels" value={query} onChange={e => setQuery(e.target.value)} /></label></div>
    {error && <p className="error">{error}</p>}
    <div className="level-table"><div className="level-row table-heading"><span>SCENARIO</span><span>STATUS</span><span>AUTHOR</span><span>TESTS</span><span /></div>
      {shown.map((l, i) => <button className="level-row" key={l.id} onClick={() => navigate(l.id === 'reference-passport-desk' ? '/reference' : `/levels/${l.id}`)}>
        <span className="scenario-cell"><span className="level-number">{(i + 1).toString().padStart(2, '0')}</span><span><span className="level-title">{l.draft.title}</span><small>{l.draft.theme}<span className="middot">·</span>{l.draft.mode === 'deduction' ? 'Deduction' : 'Jailbreak'}<span className="middot">·</span>{Math.round(l.draft.duration / 60)} min</small></span></span>
        <span><Status value={l.status} /></span><span className="owner-cell">{l.owner}</span><span className="test-count">{l.attempts}<small>{l.versions ? `v${l.versions}` : 'No version'}</small></span><ArrowUpRight size={17} strokeWidth={1.3} />
      </button>)}
      {!shown.length && <Empty>{loading ? 'Loading levels…' : query || filter !== 'all' ? 'No levels match this view.' : 'Create your first level.'}</Empty>}
    </div>
    <footer className="library-footer"><span>{levels.filter(l => l.status === 'draft').length} drafts<span className="middot">·</span>{levels.filter(l => l.status === 'approved').length} approved</span><span>Human review</span></footer>
  </div>;
}

function Team({ user, notify }: { user: User; notify: (s: string) => void }) {
  const [team, setTeam] = useState<User[]>([]); const [link, setLink] = useState('');
  const [links, setLinks] = useState<{ id: string; createdAt: number; expires?: number; revoked: number; path?: string; rootEntry?: boolean; enabled?: boolean }[]>([]);
  const loadLinks = () => { if (user.role === 'admin') void api<typeof links>('/workshop-links').then(rows => { setLinks(rows); const initial = rows.find(l => l.path && !l.rootEntry && l.path !== '/'); if (initial && !link) setLink(window.location.origin + initial.path); }).catch(e => notify(e.message)); };
  const rootLink = links.find(item => item.rootEntry || item.path === '/');
  useEffect(() => { api<User[]>('/team').then(setTeam).catch(e => notify(e.message)); }, []);
  useEffect(loadLinks, []);
  return <div className="page narrow"><div className="breadcrumb">Workshop <ChevronRight size={12} /> Team</div><header className="page-heading"><div><h1>Team</h1></div>{user.role === 'admin' && <Button className="primary" onClick={async () => { try { const r = await api<{ path: string }>('/workshop-links', { method: 'POST', body: {} }); setLink(window.location.origin + r.path); loadLinks(); } catch (e) { notify((e as Error).message); } }}><Plus size={15} />Create workshop link</Button>}</header>
    {link && <div className="share-link"><input aria-label="Invitation link" value={link} readOnly /><button className="icon-button" aria-label="Copy invitation link" onClick={() => navigator.clipboard.writeText(link).then(() => notify('Workshop link copied.')).catch(() => notify('Select and copy the link.'))}><Copy size={16} /></button><small>Share with your developers. They only need a name. Expires in 30 days.</small></div>}
    {user.role === 'admin' && rootLink && <section className="root-entry-control"><div><h2>Main website entry</h2><p className="settings-note">Visitors can start a separate editor session from the main website. Pausing also signs out sessions created there. Private workshop links keep their own expiry.</p></div><div className="member-row"><span><strong>{rootLink.enabled ? 'Name-only entry is available' : 'Name-only entry is paused'}</strong><small>The public address is the main website.</small></span><Button className="secondary" onClick={async () => { try { await api('/entry', { method: 'PUT', body: { enabled: !rootLink.enabled } }); loadLinks(); notify(rootLink.enabled ? 'Main website entry paused.' : 'Main website entry reopened.'); } catch (e) { notify((e as Error).message); } }}>{rootLink.enabled ? 'Pause entry' : 'Reopen entry'}</Button></div></section>}
    <div className="member-list">{team.map(u => <div className="member-row" key={u.id}><span className="avatar">{u.name[0]}</span><div><strong>{u.name}</strong>{!u.email.endsWith('@workshop.invalid') && <small>{u.email}</small>}</div><span className="muted">{u.role === 'admin' ? 'Owner' : 'Author'}</span></div>)}</div>
    {user.role === 'admin' && links.some(l => !l.rootEntry && !l.revoked && l.expires && l.expires > Date.now()) && <><h2>Active workshop links</h2><p className="settings-note">Anyone with a link can join as an author. Revoking it also ends the author sessions created through it.</p><div className="member-list">{links.filter(l => !l.rootEntry && !l.revoked && l.expires && l.expires > Date.now()).map(l => <div className="member-row" key={l.id}><div><strong>Created {date(l.createdAt)}</strong><small>Expires {date(l.expires!)}</small></div><Button onClick={async () => { try { await api(`/workshop-links/${l.id}`, { method: 'DELETE' }); loadLinks(); notify('Workshop link revoked.'); } catch (e) { notify((e as Error).message); } }}>Revoke</Button></div>)}</div></>}
  </div>;
}

function Connection({ model, reload }: { model: { connected: boolean; model: string; provider: string }; reload: () => void }) {
  return <div className="page narrow"><div className="breadcrumb">Workshop <ChevronRight size={12} /> Connection</div><header className="page-heading"><div><h1>Target model</h1><p className="muted">One shared baseline for every author.</p></div><Button className="secondary" onClick={reload}><RefreshCcw size={14} />Refresh</Button></header>
    <div className="connection-sheet"><div><span>Connection</span><Status value={model.connected ? 'connected' : 'Not connected'} /></div><div><span>Model</span><code>{model.model}</code></div><div><span>Provider</span><span>{model.provider}</span></div><div><span>Reasoning effort</span><span>Low</span></div><div><span>Evaluation</span><span>Human review</span></div></div>
    <p className="settings-note">{model.connected ? 'A server API key is configured. A successful test conversation confirms provider access.' : 'Set GROQ_API_KEY in the server environment or sandbox/.env, then restart the server.'} Keys and hidden instructions stay on the server. Model outputs are saved with each test.</p>
    <a className="text-link" href="https://console.groq.com/keys" target="_blank" rel="noreferrer">Groq API keys<ArrowUpRight size={14} /></a>
  </div>;
}
