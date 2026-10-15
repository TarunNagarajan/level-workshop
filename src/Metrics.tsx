import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Activity, Clock3, Download, RefreshCcw, Users, X } from 'lucide-react';
import { api, date, download } from './api';
import { Button, Empty } from './ui';

type WindowRange = { from: number; to: number };
type Latency = { count: number; meanMs: number | null; minMs?: number | null; maxMs?: number | null; p50Ms: number | null; p90Ms: number | null; p95Ms: number | null };
type MetricSummary = {
  window: WindowRange; firstRecordedAt: number | null; instrumentationStartedAt?: number | null;
  enabled?: boolean;
  coverage: { modelCalls: { recorded: number; roundsWithoutCalls: number }; rounds: { withCalls: number; withoutCalls: number }; browserIntervals: { timed: number; missing: number } };
  visits: { sessions: number };
  browser: { sessions: number; events: number; activeMs: number | null; visibleMs: number | null; idleMs: number | null; readThinkMs: number | null; composeMs: number | null; waitingMs: number | null; timedIntervals: number; missingIntervals: number };
  modelCalls: { total: number; inFlight?: number; succeeded: number; failed: number; interrupted: number; inferredRetries: number; latency: Latency; tokens: Record<'input' | 'output' | 'total', { sum: number | null; covered: number; missing: number }>; response: { chars: number; words: number } };
  rounds: { started: number; submitted: number; active: number; abandoned: number; hints: number; questions: number; diagnostics?: { started: number; submitted: number; active: number; abandoned: number; hints: number; questions: number }; bySource?: { source: string; started: number; submitted: number; active: number; abandoned: number; hints: number }[] };
  routes: { view: string; sessions: number; events: number; activeMs: number | null; visibleMs: number | null }[];
  bySource: { source: string; calls: number; inFlight?: number; succeeded: number; failed: number; interrupted: number; inferredRetries: number; rounds: number }[];
  byModel: { model: string; calls: number; inFlight?: number; succeeded: number; failed: number; interrupted: number; latency: Latency }[];
  byProfile: { collectionId: string | null; source: string; profileId: string; calls: number; inFlight?: number; succeeded: number; failed: number; interrupted: number; inferredRetries: number; rounds: number; latency: Latency }[];
};
type Page<T> = { items: T[]; limit: number; nextCursor: string | null; window: WindowRange };
type RouteUsage = { view: string; events: number; activeMs: number | null };
type Session = { sessionId: string; createdAt: number; lastSeenAt: number; closedAt: number | null; userId: string | null; tabCount: number; pageCount: number; events: number; activeMs: number | null; visibleMs: number | null; idleMs: number | null; readThinkMs: number | null; composeMs: number | null; waitingMs: number | null; routeUsage: RouteUsage[]; rounds: { roundId: string; source: string; versionId: string | null; startedAt: number; submittedAt: number | null; hints: number; questions: number }[]; coverage: { timedIntervals: number; missingIntervals: number } };
type Call = { callId: string; context: { kind: string; roundId: string | null; runId: string | null; lane: string | null; userId: string | null; userRole: string | null; collectionId: string | null; profileId: string | null; source: string | null; versionId: string | null }; startedAt: number; completedAt: number | null; latencyMs: number | null; requestedModel: string; returnedModel: string | null; providerHost: string; status: string; errorCategory: string | null; tokens: { input: number | null; output: number | null; total: number | null }; response: { chars: number; words: number }; retry: { inferred: boolean; retryOfId: string | null }; transcriptSaved: boolean };
type ExportPage = { schema: string; schemaVersion: number; items: unknown[]; nextCursor: string | null; pageLimit: number; window: WindowRange };

function query(range: WindowRange, cursor?: string) {
  const params = new URLSearchParams({ from: String(range.from), to: String(range.to), limit: '50' });
  if (cursor) params.set('cursor', cursor);
  return params.toString();
}
function compactTime(ms: number | null | undefined) { return ms == null ? '—' : `${(ms / 60000).toFixed(ms >= 60000 ? 1 : 2)} min`; }
function elapsed(ms: number | null | undefined) { return ms == null ? '—' : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`; }
function number(value: number | null | undefined) { return value == null ? '—' : value.toLocaleString(); }
function stamp(value: number | null | undefined) { return value == null ? '—' : date(value); }

export function Metrics() {
  const [days, setDays] = useState(30);
  const [refreshedAt, setRefreshedAt] = useState(() => Date.now());
  const range = useMemo(() => ({ from: refreshedAt - days * 86400000, to: refreshedAt }), [days, refreshedAt]);
  const [summary, setSummary] = useState<MetricSummary | null>(null);
  const [calls, setCalls] = useState<Page<Call> | null>(null);
  const [sessions, setSessions] = useState<Page<Session> | null>(null);
  const [sample, setSample] = useState<'calls' | 'sessions'>('calls');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState({ pages: 0, rows: 0 });
  const exportController = useRef<AbortController | null>(null);
  const loadController = useRef<AbortController | null>(null);
  const moreController = useRef<AbortController | null>(null);
  const loadSequence = useRef(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [disabled, setDisabled] = useState(false);
  const rangeKeyRef = useRef(`${range.from}:${range.to}`);
  rangeKeyRef.current = `${range.from}:${range.to}`;
  const sampleRef = useRef(sample);
  sampleRef.current = sample;

  const load = async (nextRange = range) => {
    const sequence = ++loadSequence.current;
    loadController.current?.abort();
    moreController.current?.abort(); moreController.current = null; setLoadingMore(false);
    const controller = new AbortController(); loadController.current = controller;
    setLoading(true); setError('');
    setCalls(null); setSessions(null);
    try {
      const nextSummary = await api<MetricSummary & { enabled?: false }>(`/metrics/summary?${query(nextRange)}`, { signal: controller.signal });
      if (sequence !== loadSequence.current) return;
      if (nextSummary.enabled === false) { setDisabled(true); setSummary(null); return; }
      const [nextCalls, nextSessions] = await Promise.all([
        api<Page<Call>>(`/metrics/calls?${query(nextRange)}`, { signal: controller.signal }),
        api<Page<Session>>(`/metrics/sessions?${query(nextRange)}`, { signal: controller.signal }),
      ]);
      if (sequence !== loadSequence.current) return;
      setDisabled(false); setSummary(nextSummary); setCalls(nextCalls); setSessions(nextSessions);
    } catch (e) { if (!controller.signal.aborted && sequence === loadSequence.current) setError((e as Error).message); }
    finally { if (sequence === loadSequence.current) setLoading(false); }
  };
  useEffect(() => { void load(range); return () => { loadController.current?.abort(); moreController.current?.abort(); exportController.current?.abort(); }; }, [days, refreshedAt]);

  const loadMore = async () => {
    const current = sample === 'calls' ? calls : sessions;
    if (!current?.nextCursor || loadingMore) return;
    const sequence = loadSequence.current; const pageRange = range; const rangeKey = `${range.from}:${range.to}`; const requestedSample = sample;
    const controller = new AbortController(); moreController.current = controller; setLoadingMore(true);
    try {
      const path = requestedSample;
      const next = await api<Page<Call | Session>>(`/metrics/${path}?${query(pageRange, current.nextCursor)}`, { signal: controller.signal });
      if (sequence !== loadSequence.current || rangeKeyRef.current !== rangeKey || requestedSample !== sampleRef.current) return;
      if (requestedSample === 'calls') setCalls(previous => previous ? { ...next, items: [...previous.items, ...(next.items as Call[])] } : next as Page<Call>);
      else setSessions(previous => previous ? { ...next, items: [...previous.items, ...(next.items as Session[])] } : next as Page<Session>);
    } catch (e) { if (!controller.signal.aborted && sequence === loadSequence.current) setError((e as Error).message); }
    finally { if (moreController.current === controller) { moreController.current = null; setLoadingMore(false); } }
  };

  const startExport = async () => {
    if (exportController.current) return;
    const controller = new AbortController(); exportController.current = controller;
    const exportRange = { ...range };
    setExporting(true); setExportProgress({ pages: 0, rows: 0 }); setError('');
    const items: unknown[] = []; let cursor: string | undefined; let pages = 0;
    try {
      do {
        const params = new URLSearchParams({ from: String(exportRange.from), to: String(exportRange.to), limit: '100' });
        if (cursor) params.set('cursor', cursor);
        const result = await api<ExportPage>(`/metrics/export?${params}`, { signal: controller.signal });
        items.push(...result.items); pages += 1; cursor = result.nextCursor || undefined;
        setExportProgress({ pages, rows: items.length });
      } while (cursor && !controller.signal.aborted);
      if (!controller.signal.aborted && exportController.current === controller) download(`owner-metrics-${new Date(exportRange.from).toISOString().slice(0, 10)}-to-${new Date(exportRange.to).toISOString().slice(0, 10)}.json`, { schema: 'owner-metrics', schemaVersion: 1, window: exportRange, items });
    } catch (e) { if (!controller.signal.aborted) setError((e as Error).message); }
    finally { if (exportController.current === controller) { exportController.current = null; setExporting(false); } }
  };

  const activeSamples = sample === 'calls' ? calls?.items || [] : sessions?.items || [];
  return <div className="page metrics-page">
    <div className="breadcrumb">Workshop<Clock3 size={12} />Owner metrics</div>
    <header className="page-heading"><div><p className="eyebrow">OWNER ONLY</p><h1>Usage and timing</h1><p className="muted">Server model calls are authoritative. Browser activity and reading/composition phases are estimates from visible tabs.</p></div><div className="metrics-heading-actions"><label className="metrics-window"><span>Date window</span><select aria-label="Metrics date window" value={days} onChange={e => setDays(Number(e.target.value))}><option value={7}>Last 7 days</option><option value={30}>Last 30 days</option><option value={90}>Last 90 days</option><option value={365}>Last 365 days</option></select></label><Button className="secondary" loading={loading} onClick={() => setRefreshedAt(Date.now())}><RefreshCcw size={14} />Refresh</Button></div></header>
    {error && <p className="error" role="alert">{error}</p>}
    {disabled && <Empty>Owner metrics are disabled for this workshop.</Empty>}
    {loading && !summary ? <Empty>Loading owner metrics…</Empty> : summary && <>
      <p className="metrics-caveat">Reading/thinking is a UI phase estimate, not a measurement of attention. Call duration includes timed failures; succeeded means the provider returned a reply, not a security or jailbreak score.</p>
      <section className="metrics-grid" aria-label="Usage summary">
        <MetricCard label="Browser sessions" value={number(summary.visits.sessions)} detail={`${number(summary.browser.events)} first-party events`} icon={<Users size={16} />} />
        <MetricCard label="Active visible time" value={compactTime(summary.browser.activeMs)} detail={`${compactTime(summary.browser.visibleMs)} visible · ${compactTime(summary.browser.idleMs)} idle`} icon={<Activity size={16} />} />
        <MetricCard label="Read / think estimate" value={compactTime(summary.browser.readThinkMs)} detail={`${compactTime(summary.browser.composeMs)} composing`} icon={<Clock3 size={16} />} />
        <MetricCard label="Waiting on requests" value={compactTime(summary.browser.waitingMs)} detail={`${number(summary.browser.timedIntervals)} timed intervals · ${number(summary.browser.missingIntervals)} missing`} icon={<RefreshCcw size={16} />} />
        <MetricCard label="Model calls" value={number(summary.modelCalls.total)} detail={`${number(summary.modelCalls.succeeded)} succeeded · ${number(summary.modelCalls.failed)} failed · ${number(summary.modelCalls.interrupted)} interrupted · ${number(summary.modelCalls.inFlight)} in flight`} icon={<Activity size={16} />} />
        <MetricCard label="Call round-trip p50" value={elapsed(summary.modelCalls.latency.p50Ms)} detail={`Timed provider calls · p90 ${elapsed(summary.modelCalls.latency.p90Ms)} · p95 ${elapsed(summary.modelCalls.latency.p95Ms)}`} icon={<Clock3 size={16} />} />
        <MetricCard label="Participant rounds submitted" value={number(summary.rounds.submitted)} detail={`${number(summary.rounds.active)} active · ${number(summary.rounds.abandoned)} abandoned`} icon={<Users size={16} />} />
        <MetricCard label="Hints and questions" value={`${number(summary.rounds.hints)} / ${number(summary.rounds.questions)}`} detail="Counts from saved round records" icon={<Activity size={16} />} />
        {summary.rounds.diagnostics && <MetricCard label="Diagnostic rounds" value={number(summary.rounds.diagnostics.started)} detail={`${number(summary.rounds.diagnostics.submitted)} submitted · ${number(summary.rounds.diagnostics.active)} active`} icon={<Activity size={16} />} />}
      </section>

      <section className="metrics-section"><div className="metrics-section-heading"><div><h2>Coverage and token data</h2><p className="muted">Unknown token counts stay unknown. Older or untimed records remain visible in coverage.</p></div></div>
        <div className="metrics-detail-grid"><div className="metrics-detail-card"><h3>Record coverage</h3><DataLine label="Provider calls recorded" value={number(summary.coverage.modelCalls.recorded)} /><DataLine label="Rounds without a recorded call" value={number(summary.coverage.modelCalls.roundsWithoutCalls)} /><DataLine label="Rounds with / without calls" value={`${number(summary.coverage.rounds.withCalls)} / ${number(summary.coverage.rounds.withoutCalls)} (some rounds may not call a model)`} /><DataLine label="Browser intervals" value={`${number(summary.coverage.browserIntervals.timed)} timed · ${number(summary.coverage.browserIntervals.missing)} missing`} /><DataLine label="First record in window" value={stamp(summary.firstRecordedAt)} /><DataLine label="First recorded activity" value={stamp(summary.instrumentationStartedAt)} /></div>
          <div className="metrics-detail-card"><h3>Known token totals</h3>{(['input', 'output', 'total'] as const).map(key => <DataLine key={key} label={`${key[0].toUpperCase()}${key.slice(1)} tokens`} value={`${number(summary.modelCalls.tokens[key].sum)} · ${number(summary.modelCalls.tokens[key].covered)} covered · ${number(summary.modelCalls.tokens[key].missing)} unknown`} />)}</div></div>
      </section>

      <section className="metrics-section"><div className="metrics-section-heading"><div><h2>Breakdowns</h2><p className="muted">Participants, author diagnostics, branches, replays, and orchestration are kept separate.</p></div></div>
        <div className="metrics-breakdown-grid"><Breakdown title="Route usage" columns={['View', 'Sessions', 'Events', 'Active time']} rows={summary.routes.map(row => [row.view, number(row.sessions), number(row.events), compactTime(row.activeMs)])} />
          <Breakdown title="Activity source" columns={['Source', 'Calls', 'In flight', 'Succeeded', 'Failed', 'Interrupted', 'Retries', 'Rounds']} rows={summary.bySource.map(row => [row.source, number(row.calls), number(row.inFlight), number(row.succeeded), number(row.failed), number(row.interrupted), number(row.inferredRetries), number(row.rounds)])} />
          <Breakdown title="Requested model" columns={['Model', 'Calls', 'In flight', 'Succeeded', 'Failed', 'Interrupted', 'p50', 'p90']} rows={summary.byModel.map(row => [row.model, number(row.calls), number(row.inFlight), number(row.succeeded), number(row.failed), number(row.interrupted), elapsed(row.latency.p50Ms), elapsed(row.latency.p90Ms)])} />
          <ProfileBreakdown rows={summary.byProfile} />
        </div>
      </section>

      <section className="metrics-section"><div className="metrics-section-heading"><div><h2>Recorded samples</h2><p className="muted">Paged records contain safe metadata only; no prompts, transcripts, account names, or private paths.</p></div><div className="metrics-export-actions">{exporting ? <><span className="muted small">{exportProgress.pages} pages · {exportProgress.rows.toLocaleString()} records</span><Button className="secondary" onClick={() => exportController.current?.abort()}><X size={14} />Cancel export</Button></> : <Button className="secondary" onClick={() => void startExport()}><Download size={14} />Export all pages</Button>}</div></div>
        <div className="filter-tabs metrics-tabs" role="tablist" aria-label="Metric sample type"><button role="tab" aria-selected={sample === 'calls'} className={sample === 'calls' ? 'selected' : ''} onClick={() => setSample('calls')}>Model calls</button><button role="tab" aria-selected={sample === 'sessions'} className={sample === 'sessions' ? 'selected' : ''} onClick={() => setSample('sessions')}>Browser sessions</button></div>
        {sample === 'calls' ? <CallsTable calls={activeSamples as Call[]} /> : <SessionsTable sessions={activeSamples as Session[]} />}
        {((sample === 'calls' ? calls : sessions)?.nextCursor) && <Button className="secondary metrics-more" loading={loadingMore} onClick={() => void loadMore()}>Load more samples</Button>}
        {activeSamples.length === 0 && <Empty>{loading ? 'Loading samples…' : 'No samples are recorded in this date window.'}</Empty>}
      </section>
    </>}
    <SubmissionsJournal />
  </div>;
}

type Submission = { id: string; requestId: string; roundId: string | null; runId: string | null; lane: string | null; actorId: string | null; source: string | null; scenarioId?: string | null; collectionId?: string | null; profileId?: string | null; content: string; createdAt: number; startedAt: number | null; completedAt: number | null; status: 'accepted' | 'running' | 'succeeded' | 'failed' | 'interrupted' | 'rejected'; errorCode: string | null; reply?: string | null; replyId?: string | null; deskContext?: string | null; presented?: string[] | null };
type SubmissionPage = { items: Submission[]; nextCursor: string | null };
function SubmissionsJournal() {
  const [items, setItems] = useState<Submission[]>([]); const [cursor, setCursor] = useState<string | null>(null); const [busy, setBusy] = useState(true); const [more, setMore] = useState(false); const [error, setError] = useState('');
  const [exporting, setExporting] = useState(false); const [progress, setProgress] = useState({ pages: 0, rows: 0 }); const controller = useRef<AbortController | null>(null);
  const load = async (next?: string) => {
    setError(''); if (next) setMore(true); else setBusy(true);
    try { const params = new URLSearchParams({ limit: '100' }); if (next) params.set('cursor', next); const page = await api<SubmissionPage>(`/submissions?${params}`); setItems(previous => next ? [...previous, ...page.items] : page.items); setCursor(page.nextCursor); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); setMore(false); }
  };
  useEffect(() => { void load(); return () => controller.current?.abort(); }, []);
  const exportAll = async () => {
    if (controller.current) return;
    const active = new AbortController(); controller.current = active; setExporting(true); setProgress({ pages: 0, rows: 0 }); setError('');
    const rows: Submission[] = []; let next: string | undefined; let pages = 0;
    try {
      do { const params = new URLSearchParams({ limit: '200' }); if (next) params.set('cursor', next); const page = await api<SubmissionPage>(`/submissions?${params}`, { signal: active.signal }); rows.push(...page.items); pages++; next = page.nextCursor || undefined; setProgress({ pages, rows: rows.length }); }
      while (next && !active.signal.aborted);
      if (!active.signal.aborted && controller.current === active) download(`owner-submissions-${new Date().toISOString().slice(0, 10)}.json`, { schema: 'owner-submissions', schemaVersion: 1, exportedAt: Date.now(), items: rows });
    } catch (e) { if (!active.signal.aborted) setError((e as Error).message); }
    finally { if (controller.current === active) { controller.current = null; setExporting(false); } }
  };
  return <section className="metrics-section submissions-journal"><div className="metrics-section-heading"><div><h2>Submitted work</h2><p className="muted">Submissions received since the journal was enabled, including failed requests. Earlier successful conversations remain in Tests.</p></div><div className="metrics-export-actions">{exporting ? <><span className="muted small">{progress.pages} pages · {progress.rows.toLocaleString()} submissions</span><Button className="secondary" onClick={() => controller.current?.abort()}><X size={14} />Cancel export</Button></> : <Button className="secondary" onClick={() => void exportAll()}><Download size={14} />Export all submissions</Button>}</div></div>
    {error && <p className="error" role="alert">{error}</p>}
    <div className="submission-list">{items.map(item => <article className="submission-row" key={item.id}><div className="submission-row-top"><strong>{item.source || 'Submission'}{item.lane ? ` · ${item.lane}` : ''}</strong><span className={`metrics-state ${item.status}`}>{item.status}</span></div><div className="submission-facts"><span>{date(item.createdAt)}</span><span>{item.startedAt == null ? 'Not started' : `Started ${date(item.startedAt)}`}</span><span>{item.completedAt == null ? 'No completion time' : `Completed ${date(item.completedAt)}`}</span>{item.roundId && <span>Round {item.roundId.slice(0, 8)}</span>}{item.runId && <span>Run {item.runId.slice(0, 8)}</span>}{item.scenarioId && <span>{item.scenarioId}</span>}{item.collectionId && <span>Collection {item.collectionId.slice(0, 8)}</span>}{item.profileId && <span>Profile {item.profileId}</span>}{item.errorCode && <span>Error {item.errorCode}</span>}</div><p className="submission-content">{item.content}</p>{item.reply && <details className="metrics-sample-details"><summary>Model reply</summary><p className="submission-content">{item.reply}</p></details>}{(item.deskContext || item.presented?.length) && <details className="metrics-sample-details"><summary>Scene context</summary>{item.deskContext && <p className="submission-content">{item.deskContext}</p>}{Boolean(item.presented?.length) && <p className="submission-content">Presented: {item.presented!.join(', ')}</p>}</details>}</article>)}{!items.length && <Empty>{busy ? 'Loading submissions…' : 'No submitted prompts have been recorded.'}</Empty>}</div>
    {cursor && <Button className="secondary metrics-more" loading={more} onClick={() => void load(cursor)}>Load more submissions</Button>}
  </section>;
}

function MetricCard({ label, value, detail, icon }: { label: string; value: string; detail: string; icon: ReactNode }) { return <article className="metrics-card"><div><span className="eyebrow">{label}</span><i>{icon}</i></div><strong>{value}</strong><small>{detail}</small></article>; }
function DataLine({ label, value }: { label: string; value: string }) { return <div className="metrics-data-line"><span>{label}</span><strong>{value}</strong></div>; }
function Breakdown({ title, columns, rows }: { title: string; columns: string[]; rows: string[][] }) { return <div className="metrics-breakdown"><h3>{title}</h3><div className="metrics-table-scroll"><table><thead><tr>{columns.map(column => <th key={column}>{column}</th>)}</tr></thead><tbody>{rows.length ? rows.map((row, index) => <tr key={`${row[0]}-${index}`}>{row.map((cell, cellIndex) => <td key={cellIndex}>{cell || '—'}</td>)}</tr>) : <tr><td colSpan={columns.length}>No records in this window.</td></tr>}</tbody></table></div></div>; }
function ProfileBreakdown({ rows }: { rows: MetricSummary['byProfile'] }) { return <div className="metrics-breakdown"><h3>Profiles by collection and source</h3><div className="metrics-table-scroll"><table><thead><tr>{['Collection', 'Source', 'Profile', 'Calls', 'In flight', 'Failed', 'Interrupted', 'Retries', 'Rounds', 'Mean', 'p50', 'p95'].map(column => <th key={column}>{column}</th>)}</tr></thead><tbody>{rows.length ? rows.map((row, index) => <tr key={`${row.collectionId || 'none'}-${row.source}-${row.profileId}-${index}`}><td>{row.collectionId ? <a href={`/collections/${encodeURIComponent(row.collectionId)}`}>{row.collectionId.slice(0, 8)}</a> : '—'}</td><td>{row.source}</td><td>{row.profileId}</td><td>{number(row.calls)}</td><td>{number(row.inFlight)}</td><td>{number(row.failed)}</td><td>{number(row.interrupted)}</td><td>{number(row.inferredRetries)}</td><td>{number(row.rounds)}</td><td>{elapsed(row.latency.meanMs)}</td><td>{elapsed(row.latency.p50Ms)}</td><td>{elapsed(row.latency.p95Ms)}</td></tr>) : <tr><td colSpan={12}>No records in this window.</td></tr>}</tbody></table></div></div>; }
function CallsTable({ calls }: { calls: Call[] }) { return <div className="metrics-sample-list">{calls.map(call => <article className="metrics-sample" key={call.callId}><div className="metrics-sample-top"><strong>{call.requestedModel}</strong><span className={`metrics-state ${call.status}`}>{call.status}</span></div><div className="metrics-sample-facts"><span>{stamp(call.startedAt)}</span><span>{call.context.source || call.context.kind || '—'}{call.context.profileId ? ` · ${call.context.profileId}` : ''}</span><span>{elapsed(call.latencyMs)}</span><span>{call.context.userRole || 'visitor'}</span><span>{call.errorCategory || (call.retry.inferred ? 'inferred retry' : 'no provider error')}</span><span>tokens {number(call.tokens.total)}{call.tokens.total == null ? ' unknown' : ''}</span></div><details className="metrics-sample-details"><summary>Call details</summary><div className="metrics-detail-grid"><div className="metrics-detail-card"><DataLine label="Call ID" value={call.callId} /><DataLine label="Round ID" value={call.context.roundId || '—'} /><DataLine label="Run ID" value={call.context.runId || '—'} /><DataLine label="Lane" value={call.context.lane || '—'} /><DataLine label="Collection / profile" value={`${call.context.collectionId || '—'} / ${call.context.profileId || '—'}`} /><DataLine label="Source / version" value={`${call.context.source || '—'} / ${call.context.versionId || '—'}`} /></div><div className="metrics-detail-card"><DataLine label="Provider host" value={call.providerHost || '—'} /><DataLine label="Returned model" value={call.returnedModel || '—'} /><DataLine label="Completed" value={stamp(call.completedAt)} /><DataLine label="Token coverage" value={`input ${number(call.tokens.input)} · output ${number(call.tokens.output)} · total ${number(call.tokens.total)}`} /><DataLine label="Response length" value={`${number(call.response.chars)} characters · ${number(call.response.words)} words`} /><DataLine label="Retry relationship" value={call.retry.retryOfId || (call.retry.inferred ? 'inferred' : 'none')} /><DataLine label="Transcript saved" value={call.transcriptSaved ? 'Yes' : 'No'} /></div></div></details></article>)}</div>; }
function SessionsTable({ sessions }: { sessions: Session[] }) { return <div className="metrics-sample-list">{sessions.map(session => <article className="metrics-sample" key={session.sessionId}><div className="metrics-sample-top"><strong>Session {session.sessionId.slice(0, 8)}</strong><span>{session.userId ? `Account ${session.userId.slice(0, 8)}` : 'Anonymous'}</span></div><div className="metrics-sample-facts"><span>{stamp(session.createdAt)} – {stamp(session.lastSeenAt)}</span><span>{session.tabCount} tabs · {session.pageCount} pages · {session.events} events</span><span>{compactTime(session.activeMs)} active</span><span>{compactTime(session.visibleMs)} visible</span><span>{compactTime(session.composeMs)} compose</span><span>{session.coverage.timedIntervals} timed · {session.coverage.missingIntervals} missing intervals</span></div><div className="metrics-session-usage">{session.routeUsage.map(route => <span key={route.view}>{route.view}: {compactTime(route.activeMs)} active</span>)}</div><details className="metrics-sample-details"><summary>Session details</summary><div className="metrics-detail-grid"><div className="metrics-detail-card"><DataLine label="Session ID" value={session.sessionId} /><DataLine label="Closed" value={stamp(session.closedAt)} /><DataLine label="Read / think estimate" value={compactTime(session.readThinkMs)} /><DataLine label="Compose estimate" value={compactTime(session.composeMs)} /><DataLine label="Waiting" value={compactTime(session.waitingMs)} /><DataLine label="Idle" value={compactTime(session.idleMs)} /></div><div className="metrics-detail-card"><h3>Rounds</h3>{session.rounds.length ? session.rounds.map(round => <div className="metrics-round-detail" key={round.roundId}><strong>{round.source} · {round.roundId}</strong><span>Version {round.versionId || '—'} · started {stamp(round.startedAt)} · submitted {stamp(round.submittedAt)}</span><span>{round.hints} hints · {round.questions} questions</span></div>) : <span>No round activity recorded.</span>}</div></div></details></article>)}</div>; }
