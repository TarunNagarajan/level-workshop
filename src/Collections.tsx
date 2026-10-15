import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowUpRight, Check, ChevronRight, Copy, Download, Eye, FileDown, Plus, RefreshCcw, Shield, SlidersHorizontal, X } from 'lucide-react';
import { api, date } from './api';
import type { Detail, Level, Round, Summary as LevelSummary, User, Version } from './types';
import { Button, Empty, Field, Modal, Status } from './ui';
import { PlayPanel } from './Play';
import { PassportReference } from './PassportReference';
import { navigate } from './App';

type Profile = { id: string; label: string; notes: string; moduleIds: string[]; additionalInstructions: string; compiledPrompt?: string; enabled?: boolean; editorKey?: string };
type Module = { id: string; label: string; purpose: string; instruction: string };
type Catalogue = { version: number; modules: Module[]; profiles: Profile[] };
type CollectionSummary = {
  collectionId: string; status: 'active' | 'paused'; revision: number;
  invariant: { scenarioVersionId: string; version: number; model: string; baseUrl: string; temperature: number; duration: number };
  denominators: string;
  profiles: Array<{ profileId: string; label: string; allocated: number; previews: number; diagnostics: { branches: number; replays: number; total: number }; submitted: number; active: number; expiredWithoutSubmission: number; reviewed: number; reviewCoverage: number | null; solved: number; partial: number; unsolved: number; providerFailedRequests: number; providerFailedTrials: number; medianSolvedSubmissionMs: number | null; medianQuestions: number | null; medianHintsUsed: number | null; strategyDistribution: Record<string, number>; failureDistribution: Record<string, number>; previewStrategyDistribution: Record<string, number>; previewFailureDistribution: Record<string, number>; branchStrategyDistribution: Record<string, number>; branchFailureDistribution: Record<string, number>; replayStrategyDistribution: Record<string, number>; replayFailureDistribution: Record<string, number> }>;
};
type CollectionRecord = { id: string; ownerId: string; sourceLevelId: string; sourceVersionId: string; snapshot: { schemaVersion: number; moduleCatalogueVersion: number; scenario: { levelId: string; versionId: string; version: number; data: Level }; provider: { model: string; baseUrl: string; reasoningEffort: string; temperature: number }; profiles: Profile[] }; status: 'active' | 'paused'; revision: number; createdAt: number; profileCounts: { profileId: string; allocated: number }[]; links?: { id: string; createdAt: number; expires: number; revoked: boolean }[]; canManage: boolean };
type CollectionRow = { id: string; ownerId: string; sourceLevelId: string; sourceVersionId: string; title: string; mode: string; version: number; profiles: Pick<Profile, 'id' | 'label' | 'moduleIds'>[]; status: string; revision: number; createdAt: number };
type Taxonomy = { attemptedStrategies: [string, string][]; observedFailures: [string, string][] };
type CollectionAttempt = { id: string; roundId: string; profileId: string; profile: Profile; source: 'participant' | 'preview' | 'branch' | 'replay' | string; assignedAt: number; tester: string; version?: number; startedAt: number; endedAt: number | null; answer: string | null; finding?: string | null; decision?: string | null; hintsUsed: number; messages: Round['messages']; review: { outcome: string; note: string; evidence: string[]; updatedAt: number } | null; annotation: { attemptedStrategies: string[]; observedFailures: string[]; note: string; updatedAt: number } | null; passport?: unknown; providerCalls?: { status: string; startedAt: number; completedAt: number | null; latencyMs: number | null; errorCode: string | null }[] };
const referenceLevelId = 'reference-passport-desk';
const referenceVersionId = 'reference-passport-desk-v1';
const profileInput = (profiles: Profile[]) => profiles.map(({ id, label, notes, moduleIds, additionalInstructions }) => ({ id, label, notes, moduleIds, additionalInstructions }));
const slug = (value: string) => value.toLowerCase().trim().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'custom-profile';
const editableId = (value: string) => value.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, 80);
const percent = (value: number | null) => value == null ? '—' : `${Math.round(value * 100)}%`;

export function CollectionArea({ path, notify, user }: { path: string; notify: (message: string) => void; user: User }) {
  const parts = path.split('/').filter(Boolean);
  if (parts[1] === 'new') return <CollectionNew key={path} notify={notify} user={user} />;
  if (parts[1] === 'preview' || (parts[2] === 'preview' && parts[3])) {
    const collectionId = parts[1] === 'preview' ? parts[2] : parts[1];
    const profileId = parts[1] === 'preview' ? parts[3] : parts[3];
    return <CollectionPreview key={path} collectionId={collectionId} profileId={profileId} />;
  }
  if (parts[1]) return <CollectionDetail key={parts[1]} id={parts[1]} notify={notify} />;
  return <CollectionList notify={notify} />;
}

function CollectionList({ notify }: { notify: (message: string) => void }) {
  const [collections, setCollections] = useState<CollectionRow[]>([]), [cursor, setCursor] = useState<string | null>(null), [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState('');
  const load = async (nextCursor?: string) => {
    setLoading(true); setError('');
    try { const page = await api<{ collections: CollectionRow[]; nextCursor: string | null }>('/collections?limit=50' + (nextCursor ? `&cursor=${encodeURIComponent(nextCursor)}` : '')); setCollections(current => nextCursor ? [...current, ...page.collections] : page.collections); setCursor(nextCursor || null); setNext(page.nextCursor); }
    catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, []);
  return <div className="page collection-page"><div className="breadcrumb">Workshop<ChevronRight size={12} />Collections</div>
    <header className="page-heading"><div><h1>Collections</h1><p className="muted">Compare how the same saved scenario behaves under different protection profiles.</p></div><Button className="primary" onClick={() => navigate('/collections/new')}><Plus size={15} />New collection</Button></header>
    {error && <div className="collection-error" role="alert"><span>{error}</span><Button className="secondary compact" onClick={() => void load(next || undefined)}>Retry</Button></div>}
    <div className="collection-list">{collections.map(item => <button className="collection-row" key={item.id} onClick={() => navigate(`/collections/${item.id}`)}><span className="collection-title"><strong>{item.title}</strong><small>{item.mode === 'jailbreak' ? 'Jailbreak' : 'Deduction'}<span>·</span>Version {item.version}<span>·</span>{item.profiles.length} profiles</small></span><span className="collection-profile-chips">{item.profiles.slice(0, 4).map(profile => <span key={profile.id}>{profile.label}</span>)}{item.profiles.length > 4 && <span>+{item.profiles.length - 4}</span>}</span><Status value={item.status} /><ChevronRight size={16} /></button>)}
      {!collections.length && !loading && <Empty>No collections yet. Start from a saved scenario version or the interactive reference desk.</Empty>}
      {loading && !collections.length && <p className="muted collection-loading">Loading collections…</p>}
    </div>
    {next && <div className="collection-pager"><Button className="secondary" loading={loading} onClick={() => void load(next)}>Load more</Button></div>}
  </div>;
}

function CollectionNew({ notify, user }: { notify: (message: string) => void; user: User }) {
  const params = new URLSearchParams(window.location.search), initialLevel = params.get('levelId') || '', initialVersion = params.get('versionId') || '', fromId = params.get('from') || '';
  const [levels, setLevels] = useState<LevelSummary[]>([]), [catalogue, setCatalogue] = useState<Catalogue | null>(null), [versions, setVersions] = useState<Version[]>([]);
  const [levelId, setLevelId] = useState(fromId ? '' : initialLevel), [versionId, setVersionId] = useState(fromId ? '' : initialVersion), [profiles, setProfiles] = useState<Profile[]>([]);
  const [freezeOpen, setFreezeOpen] = useState(false), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const preferredVersion = useRef(initialVersion);
  useEffect(() => {
    let active = true;
    Promise.all([api<LevelSummary[]>('/levels'), api<Catalogue>('/difficulty-modules')]).then(async ([items, modules]) => {
      if (!active) return; const accessible = items.filter(item => user.role === 'admin' || item.ownerId === user.id); const reference: LevelSummary = { id: referenceLevelId, draft: { title: 'One last passenger', theme: 'Interactive reference' } as Level, revision: 1, status: 'published', owner: 'Reference', ownerId: '', updatedAt: 0, versions: 1, attempts: 0 }; const choices = [reference, ...accessible.filter(item => item.id !== referenceLevelId)]; setLevels(choices); setCatalogue(modules); setProfiles(profileInput(modules.profiles).map(profile => ({ ...profile, editorKey: crypto.randomUUID() })));
      const source = choices.some(item => item.id === initialLevel) ? initialLevel : choices.find(item => item.id !== referenceLevelId)?.id || referenceLevelId;
      preferredVersion.current = source === initialLevel ? initialVersion : '';
      if (fromId) {
        const original = await api<CollectionRecord>(`/collections/${fromId}`); if (!active) return;
        setProfiles(profileInput(original.snapshot.profiles).map(profile => ({ ...profile, editorKey: crypto.randomUUID() })));
        const sourceId = original.snapshot.scenario.levelId;
        const usableSource = sourceId === referenceLevelId || choices.some(item => item.id === sourceId);
        const selectedSource = usableSource ? sourceId : referenceLevelId;
        preferredVersion.current = usableSource ? original.snapshot.scenario.versionId : referenceVersionId;
        setLevelId(selectedSource); setVersionId(preferredVersion.current);
        if (!usableSource) setError('The source version belongs to another author. Its profiles were copied; choose a scenario you can use or the interactive reference.');
      } else setLevelId(source);
    }).catch(e => { if (active) setError((e as Error).message); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (!levelId) return;
    let active = true;
    if (levelId === referenceLevelId) { setVersions([{ id: referenceVersionId, number: 1, data: {} as Level, note: 'Interactive passport desk', author: 'Reference', createdAt: 0 }]); setVersionId(referenceVersionId); return; }
    api<Detail>(`/levels/${levelId}`).then(detail => { if (!active) return; setVersions(detail.versions); setVersionId(current => { const preferred = preferredVersion.current; preferredVersion.current = ''; if (detail.versions.some(version => version.id === preferred)) return preferred; if (detail.versions.some(version => version.id === current)) return current; return detail.versions[0]?.id || ''; }); }).catch(e => { if (active) setError((e as Error).message); });
    return () => { active = false; };
  }, [levelId]);
  const selectedLevel = levels.find(item => item.id === levelId);
  const selectedVersion = levelId === referenceLevelId ? versions[0] : versions.find(version => version.id === versionId);
  const selectedProfiles = profiles.filter(profile => profile.enabled !== false);
  const duplicateIds = selectedProfiles.filter(profile => profile.id.trim()).some((profile, index) => selectedProfiles.findIndex(item => item.id.trim() === profile.id.trim()) !== index);
  const invalidProfiles = selectedProfiles.some(profile => !profile.id.trim() || !/^[a-z0-9][a-z0-9_-]{0,79}$/.test(profile.id) || !profile.label.trim() || !profile.moduleIds.length);
  const updateProfile = (index: number, patch: Partial<Profile>) => setProfiles(items => items.map((profile, at) => at === index ? { ...profile, ...patch } : profile));
  const addProfile = () => {
    if (profiles.length >= 12) return;
    let index = 1, id = ''; const ids = new Set(profiles.map(profile => profile.id)); do { id = `custom-${index++}`; } while (ids.has(id));
    setProfiles(items => [...items, { id, label: 'Custom profile', notes: '', moduleIds: ['secret-boundary'], additionalInstructions: '', enabled: true, editorKey: crypto.randomUUID() }]);
  };
  const duplicateProfile = (index: number) => {
    if (profiles.length >= 12) return;
    const copy = structuredClone(profiles[index]), base = `${slug(copy.id).slice(0, 60)}-copy`;
    let indexSuffix = 1, id = ''; const ids = new Set(profiles.map(profile => profile.id)); do { id = `${base}-${indexSuffix++}`.slice(0, 80); } while (ids.has(id));
    copy.id = id; copy.label = `${copy.label} copy`.slice(0, 80); copy.editorKey = crypto.randomUUID(); setProfiles(items => [...items, copy]);
  };
  const create = async () => {
    if (!catalogue || !selectedVersion || !selectedProfiles.length) return;
    setBusy(true); setError('');
    try {
      const result = await api<{ id: string }>('/collections', { method: 'POST', body: { levelId, versionId: selectedVersion.id, profiles: profileInput(selectedProfiles) } });
      setFreezeOpen(false); notify('Collection created from the saved version. Its scenario and profiles are now fixed.'); navigate(`/collections/${result.id}`);
    } catch (e) { setError((e as Error).message); setFreezeOpen(false); }
    finally { setBusy(false); }
  };
  return <div className="page collection-page"><div className="breadcrumb"><button className="breadcrumb-back" onClick={() => navigate('/collections')}><ArrowLeft size={13} />Collections</button><ChevronRight size={12} />New collection</div>
    <header className="page-heading"><div><p className="eyebrow">FROZEN COMPARISON</p><h1>Set up a collection</h1><p className="muted">Choose an immutable saved version and the protection profiles to compare.</p></div></header>
    {error && <p role="alert" className="error collection-error-text">{error}</p>}
    {loading ? <p className="muted">Loading saved versions and profiles…</p> : <>
      <section className="collection-setup-card"><h2>Scenario version</h2><p className="muted">Choose one of your saved versions or the shared interactive reference. The briefing, protected truth, clues, hints, time limit, model and temperature stay the same for every profile.</p>
        <div className="collection-source-fields"><Field label="Scenario"><select aria-label="Scenario" value={levelId} onChange={event => { preferredVersion.current = ''; setLevelId(event.target.value); setVersionId(event.target.value === referenceLevelId ? referenceVersionId : ''); if (event.target.value === referenceLevelId) setVersions([{ id: referenceVersionId, number: 1, data: {} as Level, note: 'Interactive passport desk', author: 'Reference', createdAt: 0 }]); }}>{levels.map(level => <option key={level.id} value={level.id}>{level.draft.title}</option>)}</select></Field><Field label="Saved version"><select aria-label="Saved version" value={versionId} disabled={levelId === referenceLevelId} onChange={event => setVersionId(event.target.value)}>{versions.map(version => <option key={version.id} value={version.id}>{version.id === referenceVersionId ? 'Interactive reference · v1' : `Version ${version.number} · ${version.note}`}</option>)}</select></Field></div>
        {selectedVersion && <div className="collection-freeze-note"><Shield size={17} /><p><strong>{selectedLevel?.draft.title || 'One last passenger'} · version {selectedVersion.number}</strong><span>Changing this scenario or its profiles later creates a new collection. Existing attempts keep this exact snapshot.</span></p></div>}
      </section>
      <section className="collection-setup-card profile-setup"><div className="collection-section-head"><div><h2>Protection profiles</h2><p className="muted">Profiles supplement the saved scenario’s base instructions. Light, Standard and Strict are configurations, not a proven order of success rates. The five boundary profiles are diagnostics; the base prompt may already cover those strategies.</p></div><Button className="secondary compact" disabled={profiles.length >= 12} onClick={addProfile}><Plus size={13} />Custom profile</Button></div>
        <div className="profile-editor-list">{profiles.map((profile, index) => <article className={`profile-editor-card ${profile.enabled === false ? 'profile-disabled' : ''}`} key={profile.editorKey || `profile-${index}`}>
          <div className="profile-editor-top"><span className="profile-index">{String(index + 1).padStart(2, '0')}</span><Field label="Profile name"><input aria-invalid={profile.enabled !== false && !profile.label.trim()} value={profile.label} maxLength={80} onChange={event => updateProfile(index, { label: event.target.value })} /></Field><Field label="Stable ID"><input aria-invalid={profile.enabled !== false && (!profile.id.trim() || !/^[a-z0-9][a-z0-9_-]{0,79}$/.test(profile.id))} value={profile.id} maxLength={80} pattern="[a-z0-9][a-z0-9_-]*" onChange={event => updateProfile(index, { id: editableId(event.target.value) })} /></Field><label className="profile-enable"><input type="checkbox" checked={profile.enabled !== false} onChange={event => updateProfile(index, { enabled: event.target.checked })} /><span>Include</span></label><button type="button" className="icon-button" aria-label={`Duplicate ${profile.label}`} title="Duplicate profile" disabled={profiles.length >= 12} onClick={() => duplicateProfile(index)}><Copy size={14} /></button><button type="button" className="icon-button" aria-label={`Remove ${profile.label}`} title="Remove profile" disabled={profiles.length <= 1} onClick={() => setProfiles(items => items.filter((_, at) => at !== index))}><X size={14} /></button></div>
          <Field label="Purpose"><textarea rows={2} maxLength={1000} value={profile.notes} onChange={event => updateProfile(index, { notes: event.target.value })} /></Field>
          <div className="module-options" role="group" aria-label={`Protection modules for ${profile.label}`}>{catalogue?.modules.map(module => <label key={module.id} className="module-option"><input type="checkbox" checked={profile.moduleIds.includes(module.id)} onChange={event => updateProfile(index, { moduleIds: event.target.checked ? [...profile.moduleIds, module.id] : profile.moduleIds.filter(id => id !== module.id) })} /><span><strong>{module.label}</strong><small>{module.purpose}</small></span></label>)}</div>
          <Field label="Additional profile instructions" hint={`${profile.additionalInstructions.length}/4000`}><textarea rows={3} maxLength={4000} value={profile.additionalInstructions} onChange={event => updateProfile(index, { additionalInstructions: event.target.value })} /></Field>
        </article>)}</div>
      <div className="profile-count-note">{profiles.length} of 12 profiles<span>·</span>{selectedProfiles.length} enabled</div>{duplicateIds && <p className="error" role="alert">Each included profile needs a unique stable ID.</p>}{invalidProfiles && <p className="error" role="alert">Included profiles need a name, a valid stable ID, and at least one module.</p>}
      </section>
      <div className="collection-create-footer"><Button className="secondary" onClick={() => navigate('/collections')}>Cancel</Button><Button className="primary" disabled={!selectedVersion || !selectedProfiles.length || invalidProfiles || duplicateIds} onClick={() => setFreezeOpen(true)}>Review and freeze<ArrowUpRight size={15} /></Button></div>
    </>}
    {freezeOpen && <Modal title="Freeze this collection?" close={() => setFreezeOpen(false)} error={error}><p className="muted">This saves version {selectedVersion?.number} of <strong>{selectedLevel?.draft.title || 'the interactive reference'}</strong> with {selectedProfiles.length} enabled profiles. The scenario, provider settings, module catalogue and compiled prompts cannot be changed after creation. Tune them by creating a new collection.</p><div className="freeze-profile-list">{selectedProfiles.map(profile => <span key={profile.id}>{profile.label}</span>)}</div><div className="modal-actions"><Button className="secondary" onClick={() => setFreezeOpen(false)}>Continue editing</Button><Button className="primary" loading={busy} onClick={() => void create()}>Create frozen collection</Button></div></Modal>}
  </div>;
}

function CollectionDetail({ id, notify }: { id: string; notify: (message: string) => void }) {
  const [collection, setCollection] = useState<CollectionRecord | null>(null), [summary, setSummary] = useState<CollectionSummary | null>(null), [taxonomy, setTaxonomy] = useState<Taxonomy | null>(null);
  const [tab, setTab] = useState<'overview' | 'profiles' | 'attempts'>('overview'), [attempts, setAttempts] = useState<CollectionAttempt[]>([]), [nextCursor, setNextCursor] = useState<string | null>(null), [profileFilter, setProfileFilter] = useState('');
  const [selected, setSelected] = useState<CollectionAttempt | null>(null), [review, setReview] = useState({ outcome: 'unsolved', note: '', evidence: [] as string[], attemptedStrategies: [] as string[], observedFailures: [] as string[], annotationNote: '' });
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [loadingAttempts, setLoadingAttempts] = useState(false), [freshLink, setFreshLink] = useState(''), [previewProfileId, setPreviewProfileId] = useState('');
  const [exportBusy, setExportBusy] = useState(false), [exportProgress, setExportProgress] = useState(''), [includeAuthor, setIncludeAuthor] = useState(false), [exportError, setExportError] = useState('');
  const exportAbort = useRef<AbortController | null>(null);
  const attemptsRequest = useRef(0);
  const profiles = collection?.snapshot.profiles || [];
  const load = async () => {
    setBusy(true); setError('');
    try { const [record, stats, labels] = await Promise.all([api<CollectionRecord>(`/collections/${id}`), api<CollectionSummary>(`/collections/${id}/summary`), api<Taxonomy>('/difficulty-taxonomy')]); setCollection(record); setSummary(stats); setTaxonomy(labels); setPreviewProfileId(current => current || record.snapshot.profiles[0]?.id || ''); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  useEffect(() => () => { attemptsRequest.current += 1; exportAbort.current?.abort(); }, []);
  useEffect(() => { void load(); }, [id]);
  const loadAttempts = async (reset = true, filter = profileFilter) => {
    const requestId = ++attemptsRequest.current;
    setLoadingAttempts(true); setError('');
    const cursorValue = reset ? '' : nextCursor || '';
    const query = new URLSearchParams({ limit: '50' }); if (cursorValue) query.set('cursor', cursorValue);
    if (filter) query.set('profileId', filter); else query.delete('profileId');
    try { const page = await api<{ attempts: CollectionAttempt[]; nextCursor: string | null }>(`/collections/${id}/attempts?${query}`); if (requestId !== attemptsRequest.current) return; setAttempts(current => reset ? page.attempts : [...current, ...page.attempts]); setNextCursor(page.nextCursor); }
    catch (e) { if (requestId === attemptsRequest.current) setError((e as Error).message); }
    finally { if (requestId === attemptsRequest.current) setLoadingAttempts(false); }
  };
  useEffect(() => { if (tab === 'attempts') void loadAttempts(true); }, [tab, profileFilter]);
  const startPreview = () => {
    if (!previewProfileId) return;
    if (collection?.snapshot.scenario.versionId === referenceVersionId) navigate(`/collections/${id}/preview/${previewProfileId}`);
    else navigate(`/collections/${id}/preview/${previewProfileId}`);
  };
  const makeLink = async () => {
    setBusy(true); setError('');
    try { const result = await api<{ path: string }>(`/collections/${id}/links`, { method: 'POST', body: { days: 30 } }); setFreshLink(window.location.origin + result.path); await load(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const setStatus = async () => {
    if (!collection) return;
    setBusy(true); setError('');
    try { await api(`/collections/${id}/status`, { method: 'PATCH', body: { status: collection.status === 'active' ? 'paused' : 'active', revision: collection.revision } }); await load(); notify(collection.status === 'active' ? 'New admissions paused. Existing participants can continue.' : 'New admissions resumed.'); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const openReview = (item: CollectionAttempt) => {
    setSelected(item); setReview({ outcome: item.review?.outcome || 'unsolved', note: item.review?.note || '', evidence: item.review?.evidence || [], attemptedStrategies: item.annotation?.attemptedStrategies || [], observedFailures: item.annotation?.observedFailures || [], annotationNote: item.annotation?.note || '' });
  };
  const saveReview = async () => {
    if (!selected) return;
    setBusy(true); setError('');
    try {
      await api(`/collections/${id}/review/${selected.roundId}`, { method: 'POST', body: { outcome: review.outcome, note: review.note, evidence: review.evidence, annotation: { attemptedStrategies: review.attemptedStrategies, observedFailures: review.observedFailures, note: review.annotationNote } } });
      setSelected(null); await Promise.all([load(), loadAttempts(true)]); notify('Review and failure labels saved.');
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const toggleReviewLabel = (field: 'attemptedStrategies' | 'observedFailures', value: string) => setReview(current => ({ ...current, [field]: current[field].includes(value) ? current[field].filter(item => item !== value) : [...current[field], value] }));
  const exportAll = async () => {
    setExportBusy(true); setExportError(''); setExportProgress('Preparing export…');
    const controller = new AbortController(); exportAbort.current = controller;
    try {
      let cursorValue = '', pageNumber = 0, collected: unknown[] = [], first: Record<string, unknown> | null = null;
      while (true) {
        const query = new URLSearchParams({ limit: '100', includeAuthor: String(includeAuthor) }); if (cursorValue) query.set('cursor', cursorValue);
        const page = await api<{ trials: unknown[]; nextCursor: string | null; schema: string; schemaVersion: number; collectionId: string; cutoff: number; includeAuthor: boolean; provenance: unknown; pageLimit: number }>(`/collections/${id}/export?${query}`, { signal: controller.signal });
        if (!first) first = page; collected.push(...page.trials); pageNumber += 1; setExportProgress(`Downloaded ${collected.length} attempts across ${pageNumber} page${pageNumber === 1 ? '' : 's'}…`);
        if (!page.nextCursor) break; cursorValue = page.nextCursor;
      }
      if (controller.signal.aborted) throw new DOMException('Export cancelled', 'AbortError');
      if (!first) throw new Error('The export returned no pages.');
      const exportData = { schema: first.schema, schemaVersion: first.schemaVersion, collectionId: first.collectionId, cutoff: first.cutoff, includeAuthor: first.includeAuthor, provenance: first.provenance, trials: collected };
      const url = URL.createObjectURL(new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' })); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `collection-${id}.json`; anchor.click(); URL.revokeObjectURL(url);
      setExportProgress(`Complete: ${collected.length} attempts exported.`);
    } catch (e) { if ((e as Error).name === 'AbortError') setExportProgress('Export cancelled.'); else setExportError((e as Error).message); }
    finally { setExportBusy(false); exportAbort.current = null; }
  };
  if (!collection) return <div className="page collection-page"><button className="breadcrumb-back" onClick={() => navigate('/collections')}><ArrowLeft size={13} />Collections</button>{error ? <div className="collection-error" role="alert"><span>{error}</span><Button className="secondary compact" onClick={() => void load()}>Retry</Button></div> : <p className="muted">Opening the collection…</p>}</div>;
  const scenario = collection.snapshot.scenario.data;
  const passport = selected?.passport as { revision?: number; page?: number; lamp?: string; cardRequested?: boolean; presented?: string[]; decision?: string; evidence?: string[]; events?: { id: string; action: string; observation: string }[] } | undefined;
  return <div className="page collection-page"><div className="breadcrumb"><button className="breadcrumb-back" onClick={() => navigate('/collections')}><ArrowLeft size={13} />Collections</button><ChevronRight size={12} /><span>{scenario.title}</span></div>
    <header className="page-heading collection-detail-heading"><div><p className="eyebrow">{scenario.mode === 'jailbreak' ? 'JAILBREAK' : 'DEDUCTION'} · VERSION {collection.snapshot.scenario.version}</p><h1>{scenario.title}</h1><p className="muted">Created {date(collection.createdAt)} · {profiles.length} frozen profiles · {collection.status === 'active' ? 'Accepting new attempts' : 'Paused'}</p></div><div className="collection-heading-actions">{collection.canManage && <><Button className="secondary" loading={busy} onClick={() => void makeLink()}><Copy size={14} />Create participant link</Button><Button className={collection.status === 'active' ? 'secondary' : 'primary'} loading={busy} onClick={() => void setStatus()}>{collection.status === 'active' ? 'Pause admission' : 'Resume admission'}</Button></>}</div></header>
    {error && <div className="collection-error" role="alert"><span>{error}</span><button aria-label="Dismiss error" className="icon-button" onClick={() => setError('')}><X size={15} /></button></div>}
    {freshLink && <div className="collection-link-created"><div><strong>Participant link ready</strong><p>Anyone with this link can join while admission is active. Accepted attempts can continue after a pause or revocation.</p><input aria-label="Participant link" readOnly value={freshLink} onFocus={event => event.target.select()} /></div><Button className="secondary compact" onClick={() => navigator.clipboard.writeText(freshLink).then(() => notify('Participant link copied.')).catch(() => notify('Select and copy the link.'))}><Copy size={13} />Copy</Button><button className="icon-button" aria-label="Dismiss participant link" onClick={() => setFreshLink('')}><X size={14} /></button></div>}
    <nav className="collection-tabs" role="tablist" aria-label="Collection sections">{(['overview', 'profiles', 'attempts'] as const).map(name => <button role="tab" aria-selected={tab === name} className={tab === name ? 'selected' : ''} key={name} onClick={() => setTab(name)}>{name === 'overview' ? 'Comparison' : name === 'profiles' ? 'Profiles' : 'Attempts'}</button>)}</nav>
    {tab === 'overview' && <>
      <section className="collection-invariants"><div><span>Scenario</span><strong>{scenario.title} · v{collection.snapshot.scenario.version}</strong></div><div><span>Model</span><strong>{collection.snapshot.provider.model}</strong></div><div><span>Provider endpoint</span><strong>{collection.snapshot.provider.baseUrl}</strong></div><div><span>Temperature</span><strong>{collection.snapshot.provider.temperature.toFixed(2)}</strong></div><div><span>Time limit</span><strong>{Math.round(scenario.duration / 60)} minutes</strong></div></section>
      <details className="collection-scenario-details"><summary>Inspect every shared scenario setting</summary><div><section><h3>Player briefing</h3><p>{scenario.briefing}</p></section><section><h3>Protected truth · author only</h3><p>{scenario.secret}</p></section><section><h3>Success requirements</h3><p>{scenario.criteria}</p></section><section><h3>Base instructions</h3><pre>{scenario.systemPrompt}</pre></section><section><h3>Opening and clues</h3><p><strong>Opening:</strong> {scenario.opening}</p><p><strong>Permitted clues:</strong> {scenario.clues}</p></section><section><h3>Hints and response settings</h3><p>{scenario.hints.map((hint, index) => `${index + 1}. ${hint}`).join('\n') || 'No hints'}<br />{scenario.responseWords} response words · {scenario.temperature.toFixed(2)} temperature · {collection.snapshot.provider.reasoningEffort} reasoning effort</p></section></div></details>
      <div className="collection-section-head"><div><h2>Results by profile</h2><p className="muted">Outcomes use reviewed participant attempts only. Low counts are early observations, not a reliability ranking.</p></div><Button className="secondary compact" onClick={() => void load()}><RefreshCcw size={13} />Refresh</Button></div>
      <div className="comparison-grid">{summary?.profiles.map(profile => <article className="comparison-card" key={profile.profileId}><div className="comparison-card-head"><div><span className="eyebrow">PROFILE</span><h3>{profile.label}</h3></div><span className="comparison-allocated">{profile.allocated}<small>assigned</small></span></div><div className="comparison-metrics"><div><span>Submitted</span><strong>{profile.submitted}</strong></div><div><span>Active</span><strong>{profile.active}</strong></div><div><span>Expired without submission</span><strong>{profile.expiredWithoutSubmission}</strong></div><div><span>Reviewed</span><strong>{profile.reviewed}<small> / {profile.allocated} · {percent(profile.reviewCoverage)}</small></strong></div><div><span>Solved</span><strong>{profile.solved}<small> / {profile.reviewed} reviewed</small></strong></div><div><span>Partial</span><strong>{profile.partial}<small> / {profile.reviewed} reviewed</small></strong></div><div><span>Unsolved</span><strong>{profile.unsolved}<small> / {profile.reviewed} reviewed</small></strong></div><div><span>Provider-failed requests</span><strong>{profile.providerFailedRequests}<small> across {profile.providerFailedTrials} attempts</small></strong></div><div><span>Median time when solved</span><strong>{profile.medianSolvedSubmissionMs == null ? '—' : `${Math.round(profile.medianSolvedSubmissionMs / 60000)}m`}</strong></div><div><span>Median questions / hints</span><strong>{profile.medianQuestions ?? '—'} / {profile.medianHintsUsed ?? '—'}</strong></div></div><p className="preview-separate">{profile.previews} author preview{profile.previews === 1 ? '' : 's'} · {profile.diagnostics.branches} branch · {profile.diagnostics.replays} replay · excluded from participant results</p>
        <Distribution title="Participant attempted strategies" values={profile.strategyDistribution} labels={taxonomy?.attemptedStrategies || []} /><Distribution title="Participant observed failures" values={profile.failureDistribution} labels={taxonomy?.observedFailures || []} />
        {(profile.diagnostics.branches > 0 || profile.diagnostics.replays > 0) && <details className="diagnostic-distributions"><summary>Inspect branch and replay labels</summary>{profile.diagnostics.branches > 0 && <><Distribution title="Branch strategies" values={profile.branchStrategyDistribution} labels={taxonomy?.attemptedStrategies || []} /><Distribution title="Branch failures" values={profile.branchFailureDistribution} labels={taxonomy?.observedFailures || []} /></>}{profile.diagnostics.replays > 0 && <><Distribution title="Replay strategies" values={profile.replayStrategyDistribution} labels={taxonomy?.attemptedStrategies || []} /><Distribution title="Replay failures" values={profile.replayFailureDistribution} labels={taxonomy?.observedFailures || []} /></>}</details>}
      </article>)}</div>
      {summary && <p className="collection-denominators">{summary.denominators}</p>}
      <section className="export-panel"><div><h2>Export collection</h2><p>Download every page of attempts. The file includes transcripts, actions, reviews and provider outcomes. Names are omitted by default; typed text can appear in exports.</p><label className="export-author-check"><input type="checkbox" checked={includeAuthor} onChange={event => setIncludeAuthor(event.target.checked)} /><span>Include author-only scenario truth, base and compiled prompts, profile notes, provider configuration and request context</span></label></div><div className="export-controls">{!exportBusy ? <Button className="primary" onClick={() => void exportAll()}><FileDown size={14} />Download complete JSON</Button> : <Button className="secondary" onClick={() => exportAbort.current?.abort()}><X size={13} />Cancel export</Button>}{exportProgress && <span role="status">{exportProgress}</span>}{exportError && <span className="error" role="alert">{exportError} <button className="text-button" onClick={() => void exportAll()}>Retry</button></span>}</div></section>
      {collection.canManage && <section className="manual-preview"><div><h2>Manual profile preview</h2><p className="muted">Your preview uses the same frozen profile prompt and is counted separately from participant results.</p></div><div className="preview-select-row"><Field label="Profile"><select aria-label="Profile to preview" value={previewProfileId} onChange={event => setPreviewProfileId(event.target.value)}>{profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.label}</option>)}</select></Field><Button className="secondary" onClick={startPreview}><Eye size={14} />Open preview</Button></div></section>}
      {collection.canManage && <div className="collection-manage-links"><div className="collection-section-head"><div><h2>Admission links</h2><p className="muted">Paused collections and revoked or expired links stop new attempts. Already accepted sessions can finish.</p></div></div>{collection.links?.filter(link => !link.revoked).map(link => <div className="collection-link-row" key={link.id}><span><strong>Link created {date(link.createdAt)}</strong><small>Expires {date(link.expires)}</small></span><Button className="secondary compact" onClick={async () => { try { await api(`/collections/${id}/links/${link.id}`, { method: 'DELETE' }); await load(); notify('Link revoked for new attempts.'); } catch (e) { setError((e as Error).message); } }}>Revoke</Button></div>)}{!collection.links?.some(link => !link.revoked) && <p className="muted small">No active links.</p>}</div>}
      <div className="collection-new-copy"><Button className="text-button" onClick={() => navigate(`/collections/new?from=${encodeURIComponent(id)}`)}><Plus size={13} />Create a new collection with copied profiles</Button></div>
    </>}
    {tab === 'profiles' && <section className="snapshot-profile-list"><div className="collection-section-head"><div><h2>Frozen profile instructions</h2><p className="muted">Every participant sees the same scenario briefing. Profiles only add the displayed modules and author instructions to the existing base prompt.</p></div><span className="catalogue-version">Module catalogue v{collection.snapshot.moduleCatalogueVersion}</span></div><p className="base-prompt-caveat">Base instructions remain in force; measured resistance may differ.</p>{profiles.map(profile => <article className="snapshot-profile-card" key={profile.id}><div><span className="eyebrow">{profile.moduleIds.length} MODULES</span><h3>{profile.label}</h3><p>{profile.notes || 'No additional purpose note.'}</p><div className="profile-module-chips">{profile.moduleIds.map(moduleId => <span key={moduleId}>{moduleId}</span>)}</div></div><details><summary>Read full effective profile prompt</summary><pre>{profile.compiledPrompt}</pre></details></article>)}</section>}
    {tab === 'attempts' && <section className="collection-attempts"><div className="collection-attempt-toolbar"><div><h2>Attempts</h2><p className="muted">Participant trials, manual previews, branches and replays stay distinguishable. Results stay paginated.</p></div><Field label="Profile"><select aria-label="Filter attempts by profile" value={profileFilter} onChange={event => { setAttempts([]); setNextCursor(null); setProfileFilter(event.target.value); }}><option value="">All profiles</option>{profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.label}</option>)}</select></Field></div>
        {attempts.map(item => <button className="collection-attempt-row" key={item.id} onClick={() => openReview(item)}><span><strong>{item.tester}</strong><small>{item.source === 'preview' ? 'AUTHOR PREVIEW' : item.source === 'branch' ? 'BRANCH' : item.source === 'replay' ? 'REPLAY' : 'PARTICIPANT'} · {date(item.startedAt)} · {item.messages.filter(message => message.role === 'user').length} questions</small></span><span>{item.profile.label}</span><span>{item.review ? <Status value={item.review.outcome} /> : <span className="muted">Needs review</span>}</span><ChevronRight size={15} /></button>)}
        {!attempts.length && !loadingAttempts && <Empty>No attempts in this collection yet.</Empty>}{loadingAttempts && <p className="muted collection-loading">Loading attempts…</p>}{nextCursor && <div className="collection-pager"><Button className="secondary" loading={loadingAttempts} onClick={() => void loadAttempts(false)}>Load more attempts</Button></div>}
      </section>}
    {selected && taxonomy && <Modal title={`Review · ${selected.profile.label}`} wide close={() => setSelected(null)} error={error}><div className="collection-review-modal"><p className="muted">{selected.source === 'preview' ? 'This manual preview is excluded from participant comparisons.' : `${selected.tester} · ${date(selected.startedAt)} · ${selected.messages.filter(message => message.role === 'user').length} questions`}</p><section className="review-attempt-context"><h3>Attempt context</h3><p>{selected.hintsUsed} hints used · {selected.answer || 'No final answer submitted'}{selected.decision ? ` · ${selected.decision}` : ''}</p>{selected.finding && <p><strong>Participant finding:</strong> {selected.finding}</p>}{selected.providerCalls?.length ? <div className="provider-call-health"><strong>Provider request health</strong>{selected.providerCalls.map((call, index) => <p key={`${call.startedAt}-${index}`}>{call.status}{call.errorCode ? ` · ${call.errorCode}` : ''}{call.latencyMs == null ? '' : ` · ${call.latencyMs} ms`}</p>)}</div> : <p className="muted small">No provider requests were recorded.</p>}{passport && <details><summary>Inspect passport state and action trail</summary><p>Page {passport.page ?? '—'} · {passport.lamp || 'lamp state unavailable'} light · Arrival card {passport.cardRequested ? 'requested' : 'not requested'} · Presented: {passport.presented?.join(', ') || 'none'}</p>{passport.decision && <p>Filed decision: {passport.decision}</p>}{passport.evidence?.length ? <><strong>Replies selected as evidence</strong><ul>{passport.evidence.map(id => <li key={id}>{selected.messages.find(message => message.id === id)?.content || 'Reply unavailable'}</li>)}</ul></> : <p>No replies were submitted as evidence.</p>}<ol>{passport.events?.map(event => <li key={event.id}><strong>{event.action}</strong><p>{event.observation}</p></li>)}</ol></details>}</section><div className="review-transcript">{selected.messages.map(message => <article className={`review-message ${message.role}`} key={message.id}><strong>{message.role === 'assistant' ? scenario.character : message.role === 'hint' ? 'Hint' : 'Participant'}</strong><p>{message.content}</p>{message.role === 'assistant' && !message.opening && <label><input type="checkbox" checked={review.evidence.includes(message.id)} onChange={() => setReview(current => ({ ...current, evidence: current.evidence.includes(message.id) ? current.evidence.filter(id => id !== message.id) : [...current.evidence, message.id] }))} /><span>Use as review evidence</span></label>}</article>)}</div><Field label="Reviewed outcome"><select value={review.outcome} onChange={event => setReview(current => ({ ...current, outcome: event.target.value }))}><option value="solved">Solved</option><option value="partial">Partial</option><option value="unsolved">Unsolved</option></select></Field><Field label="Reviewer note"><textarea rows={3} maxLength={4000} value={review.note} onChange={event => setReview(current => ({ ...current, note: event.target.value }))} /></Field>
          <div className="review-tag-group"><h3>Attempted strategies</h3><div>{taxonomy.attemptedStrategies.map(([value, label]) => <label key={value}><input type="checkbox" checked={review.attemptedStrategies.includes(value)} onChange={() => toggleReviewLabel('attemptedStrategies', value)} />{label}</label>)}</div></div><div className="review-tag-group"><h3>Observed failures</h3><p className="muted small">Labels describe what appeared in the attempt; they do not prove a single cause.</p><div>{taxonomy.observedFailures.map(([value, label]) => <label key={value}><input type="checkbox" checked={review.observedFailures.includes(value)} onChange={() => toggleReviewLabel('observedFailures', value)} />{label}</label>)}</div></div><Field label="Failure label notes"><textarea rows={2} maxLength={4000} value={review.annotationNote} onChange={event => setReview(current => ({ ...current, annotationNote: event.target.value }))} /></Field><p className="muted small">Solved and partial outcomes require at least one selected target reply as evidence. Observed disclosure failures also require target evidence; provider and usability labels can stand without a reply.</p><div className="modal-actions"><Button className="secondary" onClick={() => setSelected(null)}>Close</Button><Button className="primary" disabled={!review.note.trim() || (review.outcome !== 'unsolved' && !review.evidence.length) || (review.observedFailures.some(value => !['provider_issue', 'confusing_clue', 'other_failure'].includes(value)) && !review.evidence.length)} loading={busy} onClick={() => void saveReview()}>Save review and labels<Check size={14} /></Button></div></div></Modal>}
  </div>;
}

function Distribution({ title, values, labels }: { title: string; values: Record<string, number>; labels: [string, string][] }) {
  const shown = labels.filter(([key]) => values[key] > 0);
  return <section className="collection-distribution"><h4>{title}</h4>{shown.length ? <ul>{shown.map(([key, label]) => <li key={key}><span>{label}</span><strong>{values[key]}</strong></li>)}</ul> : <p className="muted small">No labels recorded.</p>}</section>;
}

function CollectionPreview({ collectionId, profileId }: { collectionId: string; profileId: string }) {
  const [collection, setCollection] = useState<CollectionRecord | null>(null), [round, setRound] = useState<Round | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [request, setRequest] = useState<unknown>(null), [inspectOpen, setInspectOpen] = useState(false);
  const profile = collection?.snapshot.profiles.find(item => item.id === profileId);
  useEffect(() => { api<CollectionRecord>(`/collections/${collectionId}`).then(setCollection).catch(e => setError((e as Error).message)); }, [collectionId]);
  const start = async () => { setBusy(true); setError(''); try { const created = await api<{ kind: string; round: Round; profileId: string; profileLabel: string }>(`/collections/${collectionId}/previews`, { method: 'POST', body: { profileId } }); if (created.kind !== 'conversation') throw new Error('This collection uses the interactive passport desk.'); setRound(created.round); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  const inspect = async () => { if (!round) return; setBusy(true); setError(''); try { setRequest(await api(`/attempts/${round.id}/prompt`)); setInspectOpen(true); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  const requestWasSent = Boolean(request && typeof request === 'object' && 'latestCall' in request && (request as { latestCall?: unknown }).latestCall);
  if (!collection) return <div className="page collection-page"><p className={error ? 'error' : 'muted'}>{error || 'Opening the frozen profile…'}</p></div>;
  if (collection.snapshot.scenario.versionId === referenceVersionId) return <div className="collection-page"><div className="collection-preview-banner"><span>AUTHOR PREVIEW · {profile?.label}</span><button className="text-button" onClick={() => navigate(`/collections/${collectionId}`)}>Back to collection</button></div><PassportReference collectionPreview={{ collectionId, profileId }} /></div>;
  const level = collection.snapshot.scenario.data;
  return <div className="page collection-page collection-preview-page"><div className="collection-preview-banner"><span>AUTHOR PREVIEW · {profile?.label || 'Profile'}</span><button className="text-button" onClick={() => navigate(`/collections/${collectionId}`)}>Back to collection</button></div><header className="page-heading"><div><p className="eyebrow">{level.title} · VERSION {collection.snapshot.scenario.version}</p><h1>{profile?.label || 'Profile preview'}</h1><p className="muted">{profile?.notes}</p></div><Button className="secondary" disabled={!round || busy} onClick={() => void inspect()}><SlidersHorizontal size={14} />Inspect profile request</Button></header><p className="base-prompt-caveat">Base instructions remain in force; measured resistance may differ.</p>{error && <p className="error" role="alert">{error}</p>}<PlayPanel level={{ ...level, hintCount: level.hints.length }} round={round} setRound={setRound} connected={true} standalone start={start} restart={start} busy={busy} />{inspectOpen && <Modal title={requestWasSent ? 'Recorded provider request' : 'Prospective provider request'} wide close={() => setInspectOpen(false)}><p className="muted small">{requestWasSent ? 'This is the latest recorded request sent by this author preview.' : 'No provider request has been sent yet. This prospective request is compiled from the current saved preview state; it does not include a future message.'} The preview uses the frozen profile and is excluded from participant comparisons.</p><pre className="request-code">{JSON.stringify(request, null, 2)}</pre></Modal>}</div>;
}

