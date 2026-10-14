import { useEffect, useState } from 'react';
import { ArrowLeft, ArrowUpRight, ChevronRight, Copy, Plus, Save, Send, Share2 } from 'lucide-react';
import { api, date } from './api';
import { Button, Empty, Field, Modal } from './ui';
import { navigate } from './App';
import type { Bootstrap, User } from './types';

type Lane = 'A' | 'B' | 'C';
type Slot = { id: Lane; name: string; systemPrompt: string; temperature: number };
type HandoffChoice = { source: string; output: string };
type HandoffEdge = { sourceLane: Lane; targetLane: Lane; waitLabel: string; choices: HandoffChoice[] };
type HandoffContract = { edges: HandoffEdge[] };
type Draft = { title: string; task: string; slots: [Slot, Slot, Slot]; contract?: HandoffContract };
type Config = { id: string; ownerId: string; revision: number; draft: Draft; updatedAt: number; owner?: string; versions?: { id: string; number: number; data: Draft; note: string; author: string; createdAt: number }[] };
type Message = { id: string; lane: Lane; role: 'user' | 'assistant'; content: string; model?: string; latencyMs?: number; usage?: number; publication?: { status: 'published' | 'waiting' | 'rejected' | 'unconstrained'; reason: string; value?: string; exactFormat?: boolean; sourceTruth?: boolean; scoreEligible?: boolean }; context?: { system: string; messages: { role: string; content: string }[]; temperature: number; model: string }; createdAt: number };
type BoardItem = { id: string; messageId: string; from: Lane; targets: Lane[]; content: string; createdAt: number };
type Run = { id: string; configId: string; authorId: string; snapshot: Draft; testInput: string; model: string; messages: Message[]; board: BoardItem[]; createdAt: number; updatedAt: number };
type WorldPair = { id: string; factValue: string | null; sourceLane: Lane; targetLane: Lane; twinRunId: string | null; observationMode: 'prompt' | 'sealed-card'; observed: boolean };
type PairAudit = { status: string; requestNecessity: boolean | null; sourceTruth: boolean | null; sourceAccess: { onlyFactDifference: boolean; identicalBeforeObservation: boolean | null } | null; worlds: { factValue: string; sourceValue: string | null; expectedOutcome: string | null; sourceTruth: boolean; observationValid: boolean }[]; requestAudit?: { afterDifference: { path: string; left: unknown; right: unknown } | null }; recipientUptake?: { tested: boolean; rawReply?: string; bodyMatchesAuditedAfter?: boolean; wholeLabelCorrect?: boolean; scoreEligible?: boolean }[]; scope: string };
type ScorePreview = { status: 'incomplete' | 'eligible' | 'diagnostic-only'; eligible: boolean; lane: Lane; expected: string; actual: string | null; reason: string };
type RunSummary = { id: string; author: string; testInput: string; model: string; turns: number; createdAt: number };
const lanes: Lane[] = ['A', 'B', 'C'];
const contractShareAllowed = (contract: HandoffContract, sourceLane: Lane, targetLane: Lane, reply: string) => Boolean(contract.edges.find(edge => edge.sourceLane === sourceLane && edge.targetLane === targetLane)?.choices.some(choice => choice.source.trim().toLocaleLowerCase('en-US') === reply.trim().toLocaleLowerCase('en-US')));
function requestDifference(left: unknown, right: unknown) {
  const a = String(left ?? ''), b = String(right ?? '');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const excerpt = (value: string, end: number) => `${start > 32 ? '…' : ''}${value.slice(Math.max(0, start - 32), Math.min(value.length, end + 32)).replace(/\s+/g, ' ')}${end + 32 < value.length ? '…' : ''}`;
  return [excerpt(a, endA), excerpt(b, endB)];
}

const emptyEdge = (index: number): HandoffEdge => ({ sourceLane: index === 0 ? 'A' : 'B', targetLane: index === 0 ? 'B' : 'C', waitLabel: '', choices: [{ source: '', output: '' }, { source: '', output: '' }] });

function HandoffRules({ contract, editable, onChange }: { contract?: HandoffContract; editable: boolean; onChange: (next?: HandoffContract) => void }) {
  const updateEdge = (index: number, patch: Partial<HandoffEdge>) => onChange({ edges: contract!.edges.map((edge, at) => at === index ? { ...edge, ...patch } : edge) });
  return <div className="orchestration-contract">
    <div className="orchestration-contract-intro"><div><span className="eyebrow">OPTIONAL / HANDOFF RULES</span><p>Use whole-label choices when a specialist must wait for another specialist's saved reply. The server adds a saved-handoff state to the recipient's prompt, keeps rejected raw replies visible, and shares only published replies along the declared chain. These rules check the handoff, not whether the source's observation is true.</p></div>
      {editable && <Button className="secondary" onClick={() => onChange(contract ? undefined : { edges: [emptyEdge(0)] })}>{contract ? 'Remove rules' : 'Add rules'}</Button>}</div>
    {contract?.edges.map((edge, index) => <div className="orchestration-contract-edge" key={index}>
      <div className="orchestration-contract-edge-head"><strong>Handoff {index + 1}</strong>{editable && <button className="text-button" onClick={() => { const edges = contract.edges.filter((_, at) => at !== index); onChange(edges.length ? { edges } : undefined); }}>Remove handoff</button>}</div>
      <div className="orchestration-contract-fields">
        <Field label="Source specialist"><select aria-label={`Handoff ${index + 1} source`} disabled={!editable} value={edge.sourceLane} onChange={event => updateEdge(index, { sourceLane: event.target.value as Lane })}>{lanes.map(lane => <option key={lane} value={lane}>{lane}</option>)}</select></Field>
        <Field label="Recipient specialist"><select aria-label={`Handoff ${index + 1} recipient`} disabled={!editable} value={edge.targetLane} onChange={event => updateEdge(index, { targetLane: event.target.value as Lane })}>{lanes.map(lane => <option key={lane} value={lane}>{lane}</option>)}</select></Field>
        <Field label="Reply while waiting"><input aria-label={`Handoff ${index + 1} wait label`} disabled={!editable} value={edge.waitLabel} placeholder="Awaiting source." onChange={event => updateEdge(index, { waitLabel: event.target.value })} /></Field>
      </div>
      <div className="orchestration-contract-choices"><span className="eyebrow">SOURCE REPLY → RECIPIENT REPLY</span>{edge.choices.map((choice, choiceIndex) => <div className="orchestration-contract-choice" key={choiceIndex}>
        <input aria-label={`Handoff ${index + 1} source choice ${choiceIndex + 1}`} disabled={!editable} value={choice.source} placeholder="Source label" onChange={event => updateEdge(index, { choices: edge.choices.map((item, at) => at === choiceIndex ? { ...item, source: event.target.value } : item) })} />
        <span aria-hidden="true">→</span>
        <input aria-label={`Handoff ${index + 1} output choice ${choiceIndex + 1}`} disabled={!editable} value={choice.output} placeholder="Recipient label" onChange={event => updateEdge(index, { choices: edge.choices.map((item, at) => at === choiceIndex ? { ...item, output: event.target.value } : item) })} />
        {editable && edge.choices.length > 2 && <button className="text-button" aria-label={`Remove choice ${choiceIndex + 1} from handoff ${index + 1}`} onClick={() => updateEdge(index, { choices: edge.choices.filter((_, at) => at !== choiceIndex) })}>Remove</button>}
      </div>)}{editable && edge.choices.length < 8 && <button className="text-button" onClick={() => updateEdge(index, { choices: [...edge.choices, { source: '', output: '' }] })}>Add choice</button>}</div>
    </div>)}
    {contract && editable && contract.edges.length < 2 && <button className="text-button" onClick={() => onChange({ edges: [...contract.edges, emptyEdge(1)] })}>Add another handoff</button>}
  </div>;
}

export function OrchestrationLab({ user, model, configId, runId, notify }: { user: User; model: Bootstrap['model']; configId?: string; runId?: string; notify: (message: string) => void }) {
  const [configs, setConfigs] = useState<Config[]>([]); const [config, setConfig] = useState<Config | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null); const [run, setRun] = useState<Run | null>(null);
  const [runs, setRuns] = useState<RunSummary[]>([]); const [testInput, setTestInput] = useState('');
  const [selectedVersion, setSelectedVersion] = useState(''); const [note, setNote] = useState('');
  const [pairMode, setPairMode] = useState<'prompt' | 'sealed-card'>('sealed-card');
  const [pairEdgeKey, setPairEdgeKey] = useState(''); const [pairFirst, setPairFirst] = useState(''); const [pairSecond, setPairSecond] = useState('');
  const [worldPair, setWorldPair] = useState<WorldPair | null>(null); const [pairQuestion, setPairQuestion] = useState(''); const [pairAudit, setPairAudit] = useState<PairAudit | null>(null);
  const [scorePreview, setScorePreview] = useState<ScorePreview | null>(null);
  const [text, setText] = useState<Record<Lane, string>>({ A: '', B: '', C: '' });
  const [compareId, setCompareId] = useState(''); const [compared, setCompared] = useState<Run | null>(null);
  const [inspectLane, setInspectLane] = useState<Lane | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const editable = Boolean(config && (config.ownerId === user.id || user.role === 'admin'));
  const dirty = Boolean(config && draft && JSON.stringify(draft) !== JSON.stringify(config.draft));
  const testedDraft = selectedVersion ? config?.versions?.find(version => version.id === selectedVersion)?.data : draft;
  const rootEdges = testedDraft?.contract?.edges.filter(edge => !testedDraft.contract?.edges.some(other => other.targetLane === edge.sourceLane)) || [];
  const selectedEdge = rootEdges.find(edge => `${edge.sourceLane}-${edge.targetLane}` === pairEdgeKey) || rootEdges[0];
  const firstValue = selectedEdge?.choices.some(choice => choice.source === pairFirst) ? pairFirst : selectedEdge?.choices[0]?.source || '';
  const secondValue = selectedEdge?.choices.some(choice => choice.source === pairSecond) ? pairSecond : selectedEdge?.choices[1]?.source || '';

  useEffect(() => {
    let active = true;
    setError('');
    if (!configId) {
      setConfig(null); setDraft(null); setRun(null); setRuns([]);
      api<Config[]>('/orchestration/configs').then(value => { if (active) setConfigs(value); }).catch(e => { if (active) setError(e.message); });
      return () => { active = false; };
    }
    setConfig(null); setDraft(null); setRuns([]); setTestInput(''); setSelectedVersion('');
    api<Config>(`/orchestration/configs/${configId}`).then(value => { if (active) { setConfig(value); setDraft(value.draft); } }).catch(e => { if (active) setError(e.message); });
    api<RunSummary[]>(`/orchestration/configs/${configId}/runs`).then(value => { if (active) setRuns(value); }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [configId]);
  useEffect(() => {
    let active = true;
    setRun(null); setCompareId(''); setCompared(null); setInspectLane(null); setText({ A: '', B: '', C: '' }); setWorldPair(null); setPairAudit(null); setScorePreview(null);
    if (runId) api<Run>(`/orchestration/runs/${runId}`).then(value => { if (active) { if (value.configId !== configId) setError('This run belongs to another configuration.'); else setRun(value); } }).catch(e => { if (active) setError(e.message); });
    if (runId) api<{ pair: WorldPair | null }>(`/orchestration/runs/${runId}/world-pair`).then(async value => { if (active) setWorldPair(value.pair); if (active && value.pair) setScorePreview(await api<ScorePreview>(`/orchestration/runs/${runId}/score-preview`)); }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [runId, configId]);
  useEffect(() => {
    let active = true;
    if (!compareId) { setCompared(null); return; }
    api<Run>(`/orchestration/runs/${compareId}`).then(value => { if (active) setCompared(value); }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [compareId]);
  useEffect(() => {
    if (!dirty) return;
    const protect = (event: Event) => { if (!window.confirm('Leave without saving your prompt changes?')) event.preventDefault(); };
    const unload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('workshop:navigate', protect);
    window.addEventListener('beforeunload', unload);
    return () => { window.removeEventListener('workshop:navigate', protect); window.removeEventListener('beforeunload', unload); };
  }, [dirty]);
  const act = async (action: () => Promise<void>) => { setBusy(true); setError(''); try { await action(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  const refreshRuns = async (id: string) => setRuns(await api<RunSummary[]>(`/orchestration/configs/${id}/runs`));
  const save = async () => {
    if (!config || !draft) throw new Error('Open a configuration first.');
    if (!dirty) return config;
    const value = await api<Config>(`/orchestration/configs/${config.id}`, { method: 'PUT', body: { revision: config.revision, draft } });
    setConfig({ ...config, ...value }); notify('Prompt changes saved.'); return { ...config, ...value };
  };
  const create = () => act(async () => { const value = await api<Config>('/orchestration/configs', { method: 'POST', body: {} }); navigate(`/orchestration/${value.id}`); });
  const updateSlot = (lane: Lane, change: Partial<Slot>) => setDraft(current => current ? { ...current, slots: current.slots.map(slot => slot.id === lane ? { ...slot, ...change } : slot) as Draft['slots'] } : current);
  const start = () => act(async () => {
    if (!config || !testInput.trim()) throw new Error('Enter a test case before starting a run.');
    if (dirty && !editable) throw new Error('Only the configuration owner can save these changes.');
    if (dirty) await save();
    const value = await api<Run>(`/orchestration/configs/${config.id}/runs`, { method: 'POST', body: { testInput, ...(selectedVersion ? { versionId: selectedVersion } : {}) } });
    await refreshRuns(config.id); navigate(`/orchestration/${config.id}/runs/${value.id}`);
  });
  const startPair = () => act(async () => {
    if (!config || !testInput.trim() || !selectedEdge) throw new Error('Save a handoff rule and enter a test case first.');
    if (firstValue === secondValue) throw new Error('Choose two different source values.');
    const sourcePrompt = testedDraft?.slots.find(slot => slot.id === selectedEdge.sourceLane)?.systemPrompt || '';
    if (pairMode === 'prompt' && !sourcePrompt.includes('{{FACT}}')) throw new Error(`Put one {{FACT}} slot in ${selectedEdge.sourceLane}'s system prompt.`);
    if (pairMode === 'sealed-card' && sourcePrompt.includes('{{FACT}}')) throw new Error(`Remove {{FACT}} from ${selectedEdge.sourceLane}'s prompt. The sealed card will supply the fact after inspection.`);
    if (dirty) await save();
    const pair = await api<{ pairId: string; runIds: [string, string] }>(`/orchestration/configs/${config.id}/world-pairs`, {
      method: 'POST', body: { testInput, ...(selectedVersion ? { versionId: selectedVersion } : {}), sourceLane: selectedEdge.sourceLane, targetLane: selectedEdge.targetLane, sourceValues: [firstValue, secondValue], observationMode: pairMode },
    });
    await refreshRuns(config.id); notify('Two linked worlds created. Test the source and share its reply in each.');
    navigate(`/orchestration/${config.id}/runs/${pair.runIds[0]}`);
  });
  const auditPair = () => act(async () => {
    if (!worldPair || !pairQuestion.trim()) throw new Error('Enter the same recipient question for both worlds.');
    setPairAudit(await api<PairAudit>(`/orchestration/world-pairs/${worldPair.id}/audit`, { method: 'POST', body: { content: pairQuestion } }));
  });
  const openSealedCard = () => act(async () => {
    if (!run || !worldPair || worldPair.observationMode !== 'sealed-card') return;
    const observed = await api<{ factValue: string }>(`/orchestration/runs/${run.id}/objects/dispatch-seal/open`, { method: 'POST' });
    setWorldPair(current => current ? { ...current, factValue: observed.factValue, observed: true } : current);
    setPairAudit(null); notify('The seal inspection was recorded.');
  });
  const send = (lane: Lane) => act(async () => {
    if (!run || !text[lane].trim()) return;
    const value = await api<Run>(`/orchestration/runs/${run.id}/messages`, { method: 'POST', body: { lane, content: text[lane] } });
    setRun(value); setText(current => ({ ...current, [lane]: '' })); setPairAudit(null); await refreshRuns(run.configId);
    if (worldPair) setScorePreview(await api<ScorePreview>(`/orchestration/runs/${run.id}/score-preview`));
  });
  const share = (message: Message, target: Lane) => act(async () => {
    if (!run) return;
    setRun(await api<Run>(`/orchestration/runs/${run.id}/board`, { method: 'POST', body: { messageId: message.id, targets: [target] } }));
    notify(`Shared ${message.lane}'s reply with ${target}.`);
  });

  if (!configId) return <div className="page orchestration-page"><div className="breadcrumb">Workshop <ChevronRight size={12} /> Orchestration</div>
    <header className="page-heading"><div><h1>Orchestration lab</h1><p className="muted">Write three specialist prompts. Test their behaviour on the same case.</p></div><Button className="primary" loading={busy} onClick={create}><Plus size={15} />New configuration</Button></header>
    <div className="orchestration-intro"><span className="eyebrow">CURRENT TEST MODEL</span><strong>{model.model}</strong><p>All three slots use this model while you develop the prompts. The conversations and shared board are separate.</p></div>
    {error && <p className="error" role="alert">{error}</p>}
    <div className="orchestration-list">{configs.map(item => <button className="orchestration-list-row" key={item.id} onClick={() => navigate(`/orchestration/${item.id}`)}><span><strong>{item.draft.title}</strong><small>{item.owner} · {date(item.updatedAt)}</small></span><ArrowUpRight size={17} /></button>)}{!configs.length && <Empty>No configurations yet. Create one to start testing.</Empty>}</div>
  </div>;

  return <div className="page orchestration-page">
    <div className="breadcrumb"><button className="text-button" onClick={() => navigate('/orchestration')}><ArrowLeft size={13} />Orchestration</button><ChevronRight size={12} />{config?.draft.title || 'Loading'}</div>
    <header className="page-heading"><div><h1>{draft?.title || 'Orchestration lab'}</h1><p className="muted">Three prompt slots · {model.model} · {dirty ? 'Unsaved changes' : 'Saved configuration'}</p></div>{editable && <Button className="primary" disabled={!dirty || busy} loading={busy} onClick={() => act(async () => { await save(); })}><Save size={14} />Save changes</Button>}</header>
    {error && <p className="error" role="alert">{error}</p>}
    {draft && <>
      <section className="orchestration-section"><div className="orchestration-section-heading"><span className="eyebrow">01 / CONFIGURE</span><p>Every specialist receives the shared task. Their instructions remain separate.</p></div>
        <div className="orchestration-task"><Field label="Configuration name"><input aria-label="Configuration name" value={draft.title} disabled={!editable} onChange={e => setDraft({ ...draft, title: e.target.value })} /></Field><Field label="Shared task"><textarea aria-label="Shared task" rows={3} value={draft.task} disabled={!editable} onChange={e => setDraft({ ...draft, task: e.target.value })} /></Field></div>
        <div className="orchestration-slots">{draft.slots.map(slot => <div className="orchestration-slot" key={slot.id}><div className="orchestration-slot-top"><span className="orchestration-letter">{slot.id}</span><span className="eyebrow">SPECIALIST PROMPT</span></div>
          <Field label="Name"><input aria-label={`Name for ${slot.id}`} value={slot.name} disabled={!editable} onChange={e => updateSlot(slot.id, { name: e.target.value })} /></Field>
          <Field label="System prompt"><textarea aria-label={`System prompt for ${slot.id}`} rows={11} value={slot.systemPrompt} disabled={!editable} onChange={e => updateSlot(slot.id, { systemPrompt: e.target.value })} /></Field>
          <Field label="Temperature"><input aria-label={`Temperature for ${slot.id}`} type="number" min="0" max="1" step="0.1" value={slot.temperature} disabled={!editable} onChange={e => updateSlot(slot.id, { temperature: Number(e.target.value) })} /></Field></div>)}</div>
        <HandoffRules contract={draft.contract} editable={editable} onChange={contract => setDraft(current => current ? { ...current, contract } : current)} />
      </section>
      <section className="orchestration-section"><div className="orchestration-section-heading"><span className="eyebrow">02 / TEST</span><p>Each test freezes the prompts and case. Later edits cannot change that run.</p></div>
        <div className="orchestration-controls"><Field label="Test case"><textarea aria-label="Test case" rows={3} placeholder="Give the three specialists a task to solve together..." value={testInput} onChange={e => setTestInput(e.target.value)} /></Field><div className="orchestration-start"><Field label="Configuration to test"><select aria-label="Configuration to test" value={selectedVersion} onChange={e => setSelectedVersion(e.target.value)}><option value="">Current draft</option>{config?.versions?.map(version => <option key={version.id} value={version.id}>Version {version.number} · {version.note}</option>)}</select></Field><Button className="primary" disabled={!model.connected || busy || !testInput.trim()} loading={busy} onClick={start}>Start test<ArrowUpRight size={14} /></Button></div></div>
        {editable && selectedEdge && <div className="orchestration-pair-setup"><div><span className="eyebrow">PAIRED WORLD TEST</span><p>{pairMode === 'sealed-card' ? 'Both worlds begin with the same source prompt. Opening a sealed card records the fact, then A can report it to the next specialist.' : <>Place one {'{{FACT}}'} in the root source prompt. The server creates two runs with different private facts.</>} Ask A in each world, share its reply, then audit what the recipient could know.</p><Field label="How A learns the fact"><select aria-label="Fact delivery" value={pairMode} onChange={e => setPairMode(e.target.value as 'prompt' | 'sealed-card')}><option value="sealed-card">Open a sealed card</option><option value="prompt">Fact in A's prompt</option></select></Field></div><div className="orchestration-pair-fields"><Field label="Handoff to test"><select aria-label="Paired handoff" value={`${selectedEdge.sourceLane}-${selectedEdge.targetLane}`} onChange={e => { setPairEdgeKey(e.target.value); setPairFirst(''); setPairSecond(''); }}>{rootEdges.map(edge => <option key={`${edge.sourceLane}-${edge.targetLane}`} value={`${edge.sourceLane}-${edge.targetLane}`}>{edge.sourceLane} to {edge.targetLane}</option>)}</select></Field><Field label="World one fact"><select aria-label="World one fact" value={firstValue} onChange={e => setPairFirst(e.target.value)}>{selectedEdge.choices.map(choice => <option key={choice.source} value={choice.source}>{choice.source} → {choice.output}</option>)}</select></Field><Field label="World two fact"><select aria-label="World two fact" value={secondValue} onChange={e => setPairSecond(e.target.value)}>{selectedEdge.choices.map(choice => <option key={choice.source} value={choice.source}>{choice.source} → {choice.output}</option>)}</select></Field><Button className="secondary" disabled={!model.connected || busy || !testInput.trim() || firstValue === secondValue} loading={busy} onClick={startPair}>Create paired worlds</Button></div></div>}
        {!model.connected && <p className="muted">Connect a model in Connection before running a live test.</p>}
        {editable && <div className="orchestration-version"><input aria-label="Version note" placeholder="What changed in this prompt set?" value={note} onChange={e => setNote(e.target.value)} /><Button className="secondary" disabled={!note.trim() || busy} onClick={() => act(async () => { const saved = await save(); await api(`/orchestration/configs/${configId}/versions`, { method: 'POST', body: { revision: saved.revision, note } }); setConfig(await api<Config>(`/orchestration/configs/${configId}`)); setNote(''); notify('Prompt version saved.'); })}><Copy size={14} />Save version</Button></div>}
      </section>
      {runs.length > 0 && <section className="orchestration-section"><div className="orchestration-section-heading"><span className="eyebrow">03 / HISTORY</span><p>Open any frozen run or compare two attempts on the same case.</p></div><div className="orchestration-history">{runs.map(item => <button className={`orchestration-history-row ${item.id === runId ? 'active' : ''}`} key={item.id} onClick={() => navigate(`/orchestration/${configId}/runs/${item.id}`)}><span><strong>{item.testInput}</strong><small>{item.author} · {date(item.createdAt)} · {item.turns} questions</small></span><ChevronRight size={14} /></button>)}</div></section>}
      {run && <section className="orchestration-section" aria-label="Live test run"><div className="orchestration-section-heading"><span className="eyebrow">04 / LIVE RUN</span><p>{run.testInput}</p></div><div className="orchestration-run-note">Frozen configuration · {run.model}. Choose a specialist, ask a question, then share a useful reply with another slot.{run.snapshot.contract && ' Handoff rules are active for this run.'}</div>
        {worldPair && <div className="orchestration-pair-run"><div><span className="eyebrow">PAIRED WORLD</span>{worldPair.observationMode === 'sealed-card' ? <><p>Open this card to record what {worldPair.sourceLane} can observe. Its front is identical in both worlds.</p><button className={`orchestration-seal-card ${worldPair.observed ? 'observed' : ''}`} aria-label="Open dispatch seal" disabled={busy || worldPair.observed} onClick={openSealedCard}><span className="eyebrow">DISPATCH SEAL</span><strong>{worldPair.observed ? worldPair.factValue : 'Sealed'}</strong><small>{worldPair.observed ? 'Inspection recorded' : 'Open to inspect'}</small></button></> : <p>This world's private {worldPair.sourceLane} fact is <strong>{worldPair.factValue}</strong>.</p>}<p>Test and share {worldPair.sourceLane}'s reply here, then do the same in the twin world.</p><button className="text-button" onClick={() => worldPair.twinRunId && navigate(`/orchestration/${configId}/runs/${worldPair.twinRunId}`)}>Open twin world <ArrowUpRight size={13} /></button>{scorePreview && <p className="orchestration-score-preview">Score preview: <strong>{scorePreview.status}</strong>. {scorePreview.reason}</p>}</div><div><Field label={`Question to compare for ${worldPair.targetLane}`}><input aria-label="Paired recipient question" value={pairQuestion} onChange={e => setPairQuestion(e.target.value)} placeholder="Ask the same question in both worlds" /></Field><Button className="secondary" disabled={busy || !pairQuestion.trim()} loading={busy} onClick={auditPair}>Audit saved handoff</Button></div>{pairAudit && <div className="orchestration-pair-result"><strong>{pairAudit.status === 'source-true-necessary-handoff' ? 'Request handoff passes for this pair' : pairAudit.status === 'invalid-checkpoint' ? 'Saved checkpoint could not be verified' : 'Pair needs review'}</strong><p>Recipient needs the share: {pairAudit.requestNecessity === null ? 'undetermined' : pairAudit.requestNecessity ? 'yes' : 'no'}. Source report matches each world: {pairAudit.sourceTruth === null ? 'undetermined' : pairAudit.sourceTruth ? 'yes' : 'no'}. Source requests differ only at the fact slot: {pairAudit.sourceAccess?.onlyFactDifference ? 'yes' : 'no'}.</p>{worldPair.observationMode === 'sealed-card' && <p>Source requests before inspection are identical: {pairAudit.sourceAccess?.identicalBeforeObservation ? 'yes' : 'no'}. Both recorded observations match their worlds: {pairAudit.worlds.every(world => world.observationValid) ? 'yes' : 'no'}.</p>}{pairAudit.worlds.map((world, index) => <p key={index}>World {index + 1}: fact {world.factValue}; saved source reply {world.sourceValue || 'none'}; expected recipient output {world.expectedOutcome || 'unknown'}.</p>)}<small>{pairAudit.scope}</small></div>}</div>}
        {pairAudit?.requestAudit?.afterDifference && <div className="orchestration-request-diff"><span className="eyebrow">FIRST RECIPIENT REQUEST DIFFERENCE</span><p>{pairAudit.requestAudit.afterDifference.path}</p><p>World one: {requestDifference(pairAudit.requestAudit.afterDifference.left, pairAudit.requestAudit.afterDifference.right)[0]}</p><p>World two: {requestDifference(pairAudit.requestAudit.afterDifference.left, pairAudit.requestAudit.afterDifference.right)[1]}</p></div>}
        {pairAudit?.recipientUptake?.some(item => item.tested) && <div className="orchestration-request-diff"><span className="eyebrow">ACTUAL RECIPIENT TEST</span>{pairAudit.recipientUptake.map((item, index) => <p key={index}>World {index + 1}: {item.tested ? `${item.rawReply} · ${item.wholeLabelCorrect ? 'correct label' : 'wrong label'} · ${item.bodyMatchesAuditedAfter ? 'audited request used' : 'request changed'} · ${item.scoreEligible ? 'score eligible' : 'diagnostic only'}` : 'not tested yet'}</p>)}</div>}
        <div className="orchestration-conversations">{run.snapshot.slots.map(slot => <div className="orchestration-conversation" key={slot.id}><div className="orchestration-conversation-top"><span className="orchestration-letter">{slot.id}</span><div><strong>{slot.name}</strong><small>{run.messages.filter(message => message.lane === slot.id && message.role === 'user').length} questions</small></div><button className="text-button" onClick={() => setInspectLane(slot.id)}>Inspect context</button></div>
          <div className="orchestration-transcript">{run.messages.filter(message => message.lane === slot.id).map(message => <div className={`orchestration-message ${message.role}`} key={message.id}><span className="eyebrow">{message.role === 'user' ? 'YOU' : slot.name.toUpperCase()}</span><p>{message.content}</p>{message.role === 'assistant' && run.snapshot.contract && <p className={`orchestration-verdict ${message.publication?.status || 'rejected'}`}>{message.publication?.status || 'rejected'} · {message.publication?.reason || 'No publication verdict was saved.'}{message.publication?.status === 'published' && message.publication.exactFormat === false && ' Output capitalization or spacing differs from the declared label.'}</p>}{message.role === 'assistant' && (!run.snapshot.contract || run.snapshot.contract.edges.some(edge => edge.sourceLane === slot.id)) && <div className="orchestration-share"><Share2 size={12} />Share with {(run.snapshot.contract ? run.snapshot.contract.edges.filter(edge => edge.sourceLane === slot.id).map(edge => edge.targetLane) : lanes.filter(target => target !== slot.id)).map(target => <button key={target} disabled={busy || Boolean(run.snapshot.contract && (message.publication?.status !== 'published' || !contractShareAllowed(run.snapshot.contract, slot.id, target, message.content))) || run.board.some(item => item.messageId === message.id && item.targets.includes(target))} onClick={() => share(message, target)}>{target}</button>)}</div>}</div>)}{!run.messages.some(message => message.lane === slot.id) && <p className="muted">No questions yet.</p>}</div>
          <div className="orchestration-composer"><textarea aria-label={`Question for ${slot.id}`} rows={2} value={text[slot.id]} onChange={e => setText(current => ({ ...current, [slot.id]: e.target.value }))} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(slot.id); } }} placeholder={`Ask ${slot.name}...`} /><button aria-label={`Send to ${slot.id}`} disabled={busy || !text[slot.id].trim()} onClick={() => send(slot.id)}><Send size={15} /></button></div></div>)}</div>
        <div className="orchestration-board"><div><span className="eyebrow">COMMON BOARD</span><p>Only replies you share appear here. Each specialist receives the entries addressed to them on their next question.</p></div><div>{run.board.map(item => <div className="orchestration-board-item" key={item.id}><strong>{item.from} → {item.targets.join(', ')}</strong><span>{item.content}</span></div>)}{!run.board.length && <span className="muted">Share a specialist reply to start the board.</span>}</div></div>
        <div className="orchestration-compare"><div><span className="eyebrow">COMPARE RUNS</span><p>Select another run to inspect how prompts and replies differed.</p></div><select aria-label="Compare with run" value={compareId} onChange={e => setCompareId(e.target.value)}><option value="">Choose a run</option>{runs.filter(item => item.id !== run.id).map(item => <option key={item.id} value={item.id}>{date(item.createdAt)} · {item.testInput.slice(0, 55)}</option>)}</select></div>
        {compared && <div className="orchestration-comparison">{[run, compared].map(item => <div key={item.id}><span className="eyebrow">{item.id === run.id ? 'CURRENT RUN' : 'COMPARISON'}</span><p>{item.testInput}</p><small>{item.model} · {item.messages.filter(message => message.role === 'user').length} questions · {item.board.length} shared findings</small>{item.snapshot.slots.map(slot => <details key={slot.id}><summary>{slot.name} · prompt and latest reply</summary><p>{slot.systemPrompt}</p><p><strong>Latest reply:</strong> {item.messages.filter(message => message.lane === slot.id && message.role === 'assistant').at(-1)?.content || 'No reply yet.'}</p></details>)}</div>)}</div>}
      </section>}
    </>}
    {inspectLane && run && <Modal title={`Context sent to ${inspectLane}`} close={() => setInspectLane(null)} wide><div className="orchestration-inspect"><span className="eyebrow">MODEL</span><p>{run.model}</p><span className="eyebrow">SYSTEM PROMPT USED ON LAST TURN</span><p>{run.messages.filter(message => message.lane === inspectLane && message.context).at(-1)?.context?.system || run.snapshot.slots.find(slot => slot.id === inspectLane)?.systemPrompt}</p><span className="eyebrow">SHARED TASK AND CASE</span><p>{run.snapshot.task}<br />{run.testInput}</p><span className="eyebrow">CURRENT BOARD ENTRIES ADDRESSED TO THIS SLOT</span>{run.board.filter(item => item.targets.includes(inspectLane)).map(item => <p key={item.id}>{item.from}: {item.content}</p>)}{!run.board.some(item => item.targets.includes(inspectLane)) && <p>None yet.</p>}{run.messages.filter(message => message.lane === inspectLane && message.context).at(-1)?.context && <><span className="eyebrow">LAST EXACT REQUEST</span>{run.messages.filter(message => message.lane === inspectLane && message.context).at(-1)?.context?.messages.map((message, index) => <p key={index}><strong>{message.role}:</strong> {message.content}</p>)}</>}</div></Modal>}
  </div>;
}
