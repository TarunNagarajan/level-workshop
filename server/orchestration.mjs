import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { z } from 'zod';
import { compileOrchestrationContext } from './orchestration-context.mjs';
import { canShareContractReply, evaluateOrchestrationReply, orchestrationContractSchema, resolveSavedHandoff } from './orchestration-contract.mjs';
import { auditSavedRunWorldPair } from '../research/saved-run-world-audit.mjs';
import { sealedCardId, sealedCardObservation, sealedCardSystem, sealedCardWait } from './orchestration-observation.mjs';
import { scoreOrchestrationRun } from './orchestration-score.mjs';

const id = () => randomUUID();
const token = () => randomBytes(18).toString('base64url');
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const normalized = value => typeof value === 'string' ? value.trim().toLocaleLowerCase('en-US') : null;
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const slotId = z.enum(['A', 'B', 'C']);
const slotSchema = z.object({
  id: slotId,
  name: z.string().trim().min(1).max(60),
  systemPrompt: z.string().trim().min(1).max(12000),
  temperature: z.number().min(0).max(1),
});
export const orchestrationSchema = z.object({
  title: z.string().trim().min(1).max(120),
  task: z.string().trim().min(1).max(6000),
  slots: z.tuple([slotSchema, slotSchema, slotSchema]).refine(slots => slots.map(slot => slot.id).join('') === 'ABC', 'Keep one slot each for A, B and C.'),
  contract: orchestrationContractSchema.optional(),
});
export const emptyOrchestration = {
  title: 'Untitled orchestration',
  task: 'Describe the shared challenge here. Put only information every specialist should receive in this field.',
  slots: ['A', 'B', 'C'].map(letter => ({ id: letter, name: `Specialist ${letter}`, systemPrompt: `You are Specialist ${letter}. Work from the information you receive. Explain uncertainty and respond to the tester's question.`, temperature: 0.3 })),
};

export function addOrchestrationRoutes(app, { store, provider, completion, journal, requireRecording = async () => {} }) {
  const { get, all, run } = store;
  const member = (req, res, next) => req.user ? next() : res.status(401).json({ error: 'Sign in to use the workshop.' });
  const configRow = async configId => { const row = await get('SELECT * FROM orchestration_configs WHERE id = ?', configId); if (!row) fail(404, 'Configuration not found.'); return row; };
  const canEdit = (req, row) => { if (row.owner_id !== req.user.id && req.user.role !== 'admin') fail(403, 'Only the creator or workspace owner can edit this configuration.'); };
  const configView = row => ({ id: row.id, ownerId: row.owner_id, revision: row.revision, draft: JSON.parse(row.draft), updatedAt: row.updated_at });
  const runRow = async runId => { const row = await get('SELECT * FROM orchestration_runs WHERE id = ?', runId); if (!row) fail(404, 'Test run not found.'); return row; };
  const pairBindingRow = runId => get('SELECT orchestration_world_bindings.*, orchestration_world_pairs.source_lane, orchestration_world_pairs.target_lane, orchestration_world_pairs.observation_mode, orchestration_world_pairs.source_system_template FROM orchestration_world_bindings JOIN orchestration_world_pairs ON orchestration_world_pairs.id = orchestration_world_bindings.pair_id WHERE run_id = ?', runId);
  const eventRows = runId => all('SELECT seq, kind, payload, created_at FROM orchestration_events WHERE run_id = ? ORDER BY seq', runId);
  const runView = row => ({ id: row.id, configId: row.config_id, authorId: row.author_id, snapshot: JSON.parse(row.snapshot), testInput: row.test_input, model: row.model, messages: JSON.parse(row.messages), board: JSON.parse(row.board), eventSeq: row.event_seq, createdAt: row.created_at, updatedAt: row.updated_at });
  const canChangeRun = (req, row) => { if (row.author_id !== req.user.id && req.user.role !== 'admin') fail(403, 'Only the tester or workspace owner can continue this run.'); };
  const withLease = async (row, action) => {
    const lease = token(); const now = Date.now();
    const claimed = await run('INSERT INTO orchestration_locks (run_id, token, expires) VALUES (?, ?, ?) ON CONFLICT(run_id) DO UPDATE SET token = excluded.token, expires = excluded.expires WHERE orchestration_locks.expires <= ?', row.id, lease, now + 45000, now);
    if (!claimed.changes) fail(409, 'Wait for the current test response before changing this run.');
    try { return await action(lease); }
    finally { await run('DELETE FROM orchestration_locks WHERE run_id = ? AND token = ?', row.id, lease); }
  };
  const saveRunEvent = async ({ row, lease, messages, board, kind, sourceMessageId, boardId, observation }) => {
    const seq = Number(row.event_seq) + 1;
    const now = Date.now();
    const payload = JSON.stringify({
      messageCount: messages.length, boardCount: board.length,
      messagesHash: digest(messages), boardHash: digest(board),
      ...(sourceMessageId ? { sourceMessageId } : {}),
      ...(boardId ? { boardId } : {}),
      ...(observation ? { objectId: sealedCardId, factValue: observation.factValue } : {}),
    });
    const update = kind === 'observe'
      ? ['UPDATE orchestration_runs SET event_seq = event_seq + 1, updated_at = ? WHERE id = ? AND event_seq = ? AND EXISTS (SELECT 1 FROM orchestration_locks WHERE run_id = orchestration_runs.id AND token = ? AND expires > ?)', now, row.id, row.event_seq, lease, now]
      : [`UPDATE orchestration_runs SET ${kind === 'turn' ? 'messages' : 'board'} = ?, event_seq = event_seq + 1, updated_at = ? WHERE id = ? AND event_seq = ? AND EXISTS (SELECT 1 FROM orchestration_locks WHERE run_id = orchestration_runs.id AND token = ? AND expires > ?)`, JSON.stringify(kind === 'turn' ? messages : board), now, row.id, row.event_seq, lease, now];
    const [saved, event] = await store.batch([
      update,
      ['INSERT INTO orchestration_events (run_id, seq, kind, payload, created_at) SELECT ?, ?, ?, ?, ? FROM orchestration_runs WHERE id = ? AND event_seq = ?', row.id, seq, kind, payload, now, row.id, seq],
    ]);
    if (saved.changes !== 1 || event.changes !== 1) fail(409, 'The run changed before this event could be saved. Retry the action.');
  };

  app.get('/api/orchestration/configs', member, async (req, res) => {
    res.json((await all('SELECT orchestration_configs.*, users.name AS owner FROM orchestration_configs JOIN users ON users.id = orchestration_configs.owner_id ORDER BY updated_at DESC')).map(row => ({ ...configView(row), owner: row.owner })));
  });
  app.post('/api/orchestration/configs', member, async (req, res) => {
    const data = orchestrationSchema.parse(req.body?.draft || emptyOrchestration);
    const configId = id(); const now = Date.now();
    await run('INSERT INTO orchestration_configs (id, owner_id, draft, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', configId, req.user.id, JSON.stringify(data), now, now);
    res.status(201).json(configView(await configRow(configId)));
  });
  app.get('/api/orchestration/configs/:id', member, async (req, res) => {
    const row = await configRow(req.params.id);
    const versions = (await all('SELECT orchestration_versions.*, users.name AS author FROM orchestration_versions JOIN users ON users.id = orchestration_versions.author_id WHERE config_id = ? ORDER BY number DESC', row.id))
      .map(version => ({ id: version.id, number: version.number, data: JSON.parse(version.data), note: version.note, author: version.author, createdAt: version.created_at }));
    res.json({ ...configView(row), versions });
  });
  app.put('/api/orchestration/configs/:id', member, async (req, res) => {
    const row = await configRow(req.params.id); canEdit(req, row);
    const { revision, draft } = z.object({ revision: z.number().int(), draft: orchestrationSchema }).parse(req.body);
    const saved = await run('UPDATE orchestration_configs SET draft = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?', JSON.stringify(draft), Date.now(), row.id, revision);
    if (!saved.changes) fail(409, 'This configuration changed. Reload before saving.');
    res.json(configView(await configRow(row.id)));
  });
  app.post('/api/orchestration/configs/:id/versions', member, async (req, res) => {
    const row = await configRow(req.params.id); canEdit(req, row);
    const { revision, note } = z.object({ revision: z.number().int(), note: z.string().trim().min(1).max(1000) }).parse(req.body);
    if (revision !== row.revision) fail(409, 'The configuration changed. Reload before saving a version.');
    const versionId = id();
    await run('INSERT INTO orchestration_versions SELECT ?, ?, COALESCE(MAX(number), 0) + 1, ?, ?, ?, ? FROM orchestration_versions WHERE config_id = ?', versionId, row.id, row.draft, note, req.user.id, Date.now(), row.id);
    res.json({ versionId });
  });
  app.post('/api/orchestration/configs/:id/runs', member, async (req, res) => {
    const row = await configRow(req.params.id);
    const input = z.object({ testInput: z.string().trim().min(1).max(6000), versionId: z.string().optional() }).parse(req.body);
    let snapshot = JSON.parse(row.draft);
    if (input.versionId) {
      const version = await get('SELECT * FROM orchestration_versions WHERE id = ? AND config_id = ?', input.versionId, row.id);
      if (!version) fail(404, 'Saved version not found.');
      snapshot = JSON.parse(version.data);
    }
    if (!provider.apiKey) fail(503, 'Connect a model before starting a test run.');
    const runId = id(); const now = Date.now();
    await run('INSERT INTO orchestration_runs (id, config_id, author_id, snapshot, test_input, model, messages, board, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', runId, row.id, req.user.id, JSON.stringify(snapshot), input.testInput, provider.model, '[]', '[]', now, now);
    res.status(201).json(runView(await runRow(runId)));
  });
  app.post('/api/orchestration/configs/:id/world-pairs', member, async (req, res) => {
    const row = await configRow(req.params.id); canEdit(req, row);
    const input = z.object({
      testInput: z.string().trim().min(1).max(6000), versionId: z.string().optional(),
      sourceLane: slotId, targetLane: slotId,
      sourceValues: z.tuple([z.string(), z.string()]),
      observationMode: z.enum(['prompt', 'sealed-card']).default('prompt'),
    }).parse(req.body);
    let template = JSON.parse(row.draft);
    if (input.versionId) {
      const version = await get('SELECT * FROM orchestration_versions WHERE id = ? AND config_id = ?', input.versionId, row.id);
      if (!version) fail(404, 'Saved version not found.');
      template = JSON.parse(version.data);
    }
    const edge = template.contract?.edges.find(item => item.sourceLane === input.sourceLane && item.targetLane === input.targetLane);
    if (!edge) fail(400, 'Choose a declared source and recipient handoff.');
    if (template.contract.edges.some(item => item.targetLane === input.sourceLane)) fail(400, 'Paired world facts must enter at a root source specialist.');
    const choices = input.sourceValues.map(value => edge.choices.find(choice => choice.source === value));
    if (choices.some(value => !value) || choices[0].source === choices[1].source) fail(400, 'Choose two different declared source labels.');
    const sourceSlot = template.slots.find(slot => slot.id === input.sourceLane);
    const sourceSystemTemplate = input.observationMode === 'sealed-card'
      ? sealedCardSystem(sourceSlot.systemPrompt, '{{FACT}}') : sourceSlot.systemPrompt;
    if (sourceSystemTemplate.split('{{FACT}}').length !== 2) fail(400, 'The source system prompt must contain exactly one {{FACT}} slot in prompt mode, or none in sealed-card mode.');
    if ([template.task, input.testInput, ...template.slots.filter(slot => slot.id !== input.sourceLane).map(slot => slot.systemPrompt)].some(value => value.includes('{{FACT}}'))
      || (input.observationMode === 'sealed-card' && sourceSlot.systemPrompt.includes('{{FACT}}'))) {
      fail(400, 'The fact slot may appear only in the source system prompt in prompt mode.');
    }
    if (!provider.apiKey || !provider.baseUrl) fail(503, 'Connect a model before starting a paired run.');
    const pairId = id(); const runIds = [id(), id()]; const now = Date.now();
    const statements = [
      ['INSERT INTO orchestration_world_pairs (id, config_id, author_id, source_lane, target_lane, source_system_template, provider_base_url, observation_mode, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', pairId, row.id, req.user.id, input.sourceLane, input.targetLane, sourceSystemTemplate, provider.baseUrl, input.observationMode, now],
    ];
    for (const [index, choice] of choices.entries()) {
      const snapshot = structuredClone(template);
      if (input.observationMode === 'prompt') snapshot.slots.find(slot => slot.id === input.sourceLane).systemPrompt = sourceSystemTemplate.replace('{{FACT}}', choice.source);
      statements.push(['INSERT INTO orchestration_runs (id, config_id, author_id, snapshot, test_input, model, messages, board, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', runIds[index], row.id, req.user.id, JSON.stringify(snapshot), input.testInput, provider.model, '[]', '[]', now, now]);
      statements.push(['INSERT INTO orchestration_world_bindings (run_id, pair_id, position, fact_value, snapshot_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)', runIds[index], pairId, index, choice.source, digest(snapshot), now]);
    }
    await store.batch(statements);
    res.status(201).json({ pairId, runIds });
  });
  app.post('/api/orchestration/world-pairs/:id/audit', member, async (req, res) => {
    const pair = await get('SELECT * FROM orchestration_world_pairs WHERE id = ?', req.params.id);
    if (!pair) fail(404, 'Paired worlds not found.');
    canEdit(req, { owner_id: pair.author_id });
    const { content, shareEventSeqs } = z.object({
      content: z.string().trim().min(1).max(2000),
      shareEventSeqs: z.tuple([z.number().int().positive(), z.number().int().positive()]).optional(),
    }).parse(req.body);
    const bindingRows = await all('SELECT * FROM orchestration_world_bindings WHERE pair_id = ? ORDER BY position', pair.id);
    if (bindingRows.length !== 2) fail(409, 'The paired worlds are incomplete.');
    const rows = await Promise.all(bindingRows.map(binding => runRow(binding.run_id)));
    const eventLogs = await Promise.all(rows.map(row => eventRows(row.id)));
    const bindings = bindingRows.map(binding => ({ runId: binding.run_id, snapshotHash: binding.snapshot_hash, factValue: binding.fact_value, sourceSystemTemplate: pair.source_system_template, observationMode: pair.observation_mode }));
    const result = auditSavedRunWorldPair({
      runs: rows.map(runView), bindings,
      eventLogs: eventLogs.map(events => events.map(event => ({ seq: Number(event.seq), kind: event.kind, ...JSON.parse(event.payload) }))),
      shareEventSeqs, sourceLane: pair.source_lane, lane: pair.target_lane, content,
      provider: { model: rows[0].model, baseUrl: pair.provider_base_url },
    });
    res.json({ pairId: pair.id, ...result });
  });
  app.get('/api/orchestration/configs/:id/runs', member, async (req, res) => {
    await configRow(req.params.id);
    res.json((await all('SELECT orchestration_runs.*, users.name AS author FROM orchestration_runs JOIN users ON users.id = orchestration_runs.author_id WHERE config_id = ? ORDER BY created_at DESC LIMIT 40', req.params.id))
      .map(row => ({ id: row.id, configId: row.config_id, author: row.author, authorId: row.author_id, title: JSON.parse(row.snapshot).title, testInput: row.test_input, model: row.model, turns: JSON.parse(row.messages).filter(message => message.role === 'user').length, createdAt: row.created_at })));
  });
  app.get('/api/orchestration/runs/:id', member, async (req, res) => res.json(runView(await runRow(req.params.id))));
  app.get('/api/orchestration/runs/:id/world-pair', member, async (req, res) => {
    const row = await runRow(req.params.id); canChangeRun(req, row);
    const binding = await pairBindingRow(row.id);
    if (!binding) return res.json({ pair: null });
    const twin = await get('SELECT run_id FROM orchestration_world_bindings WHERE pair_id = ? AND run_id <> ?', binding.pair_id, row.id);
    const observed = binding.observation_mode === 'sealed-card' && (await eventRows(row.id)).some(event => event.kind === 'observe' && JSON.parse(event.payload).objectId === sealedCardId);
    res.json({ pair: { id: binding.pair_id, factValue: binding.observation_mode === 'prompt' || observed ? binding.fact_value : null,
      sourceLane: binding.source_lane, targetLane: binding.target_lane, twinRunId: twin?.run_id ?? null,
      observationMode: binding.observation_mode, observed } });
  });
  app.post('/api/orchestration/runs/:id/objects/dispatch-seal/open', member, async (req, res) => {
    const row = await runRow(req.params.id); canChangeRun(req, row);
    await withLease(row, async lease => {
      const current = await runRow(row.id);
      const binding = await pairBindingRow(row.id);
      if (binding?.observation_mode !== 'sealed-card') fail(404, 'This run has no sealed dispatch card.');
      if ((await eventRows(row.id)).some(event => event.kind === 'observe')) fail(409, 'The dispatch seal was already opened in this run.');
      await saveRunEvent({ row: current, lease, messages: JSON.parse(current.messages), board: JSON.parse(current.board), kind: 'observe', observation: { factValue: binding.fact_value } });
      res.json({ objectId: sealedCardId, observation: sealedCardObservation(binding.fact_value), factValue: binding.fact_value, eventSeq: Number(current.event_seq) + 1 });
    });
  });
  app.get('/api/orchestration/runs/:id/events', member, async (req, res) => {
    const row = await runRow(req.params.id); canChangeRun(req, row);
    res.json((await all('SELECT seq, kind, payload, created_at FROM orchestration_events WHERE run_id = ? ORDER BY seq', row.id))
      .map(event => ({ seq: Number(event.seq), kind: event.kind, ...JSON.parse(event.payload), createdAt: Number(event.created_at) })));
  });
  app.get('/api/orchestration/runs/:id/score-preview', member, async (req, res) => {
    const row = await runRow(req.params.id); canChangeRun(req, row);
    const binding = await pairBindingRow(row.id);
    if (!binding) fail(404, 'This run is not bound to a paired world.');
    const snapshot = JSON.parse(row.snapshot); let lane = binding.source_lane; let expected = binding.fact_value;
    let edge = snapshot.contract?.edges.find(item => item.sourceLane === lane && item.targetLane === binding.target_lane);
    while (edge) {
      const choice = edge.choices.find(item => normalized(item.source) === normalized(expected));
      if (!choice) fail(409, 'The saved handoff map cannot resolve this world fact.');
      expected = choice.output; lane = edge.targetLane;
      edge = snapshot.contract.edges.find(item => item.sourceLane === lane);
    }
    const events = (await eventRows(row.id)).map(event => ({ seq: Number(event.seq), kind: event.kind, ...JSON.parse(event.payload) }));
    res.json(scoreOrchestrationRun({ run: runView(row), binding, events, lane, expected }));
  });
  app.post('/api/orchestration/runs/:id/messages', member, async (req, res) => {
    const row = await runRow(req.params.id); canChangeRun(req, row);
    const { lane, content, requestId } = z.object({ lane: slotId, content: z.string().trim().min(1).max(2000), requestId: z.string().uuid().optional() }).parse(req.body);
    await requireRecording(req);
    const journalInput = { orchestrationRunId: row.id, lane, clientRequestId: requestId, actorId: req.user.id, source: 'orchestration', content };
    const returnReceipt = async entry => {
      if (entry.status === 'succeeded' && entry.transcript_saved) return res.json({ ...runView(await runRow(row.id)), submissionId: entry.id });
      return res.status(409).json({ error: entry.status === 'succeeded' ? 'The reply was recorded, but the run transcript save did not complete.' : 'This request was already received and will not be sent twice.', submissionId: entry.id, submissionStatus: entry.status, receiptConfirmed: true, ...(entry.status === 'succeeded' ? { transcriptSaved: false } : {}) });
    };
    if (requestId) {
      const existing = await journal.find(`run:${row.id}`, requestId);
      if (existing) {
        const checked = await journal.begin(journalInput);
        return returnReceipt(checked.entry);
      }
    }
    if (!provider.apiKey || provider.model !== row.model) fail(409, 'The configured test model changed. Start a new run.');
    const firstMessages = JSON.parse(row.messages), firstSnapshot = JSON.parse(row.snapshot), firstBoard = JSON.parse(row.board);
    if (firstMessages.filter(message => message.lane === lane && message.role === 'user').length >= 20) fail(409, 'This slot has reached its 20-question test limit.');
    if (resolveSavedHandoff({ contract: firstSnapshot.contract, lane, messages: firstMessages, board: firstBoard })?.status === 'invalid') fail(409, 'The saved source handoff is invalid. This turn was not sent to the model.');
    const { entry, shouldInvoke } = await journal.begin(journalInput);
    if (!shouldInvoke) return returnReceipt(entry);
    try { await withLease(row, async lease => {
      const current = await runRow(row.id); const snapshot = JSON.parse(current.snapshot);
      const messages = JSON.parse(current.messages); const board = JSON.parse(current.board);
      if (messages.filter(message => message.lane === lane && message.role === 'user').length >= 20) fail(409, 'This slot has reached its 20-question test limit.');
      if (resolveSavedHandoff({ contract: snapshot.contract, lane, messages, board })?.status === 'invalid') fail(409, 'The saved source handoff is invalid. This turn was not sent to the model.');
      const binding = await pairBindingRow(row.id);
      const observation = binding?.observation_mode === 'sealed-card' && lane === binding.source_lane
        ? (await eventRows(row.id)).find(event => event.kind === 'observe' && JSON.parse(event.payload).objectId === sealedCardId) : null;
      const sourceObservation = binding?.observation_mode === 'sealed-card' && lane === binding.source_lane
        ? { factValue: observation ? binding.fact_value : null } : undefined;
      const context = compileOrchestrationContext({ snapshot, testInput: current.test_input, messages, board, lane, content, model: provider.model, sourceObservation });
      if (!(await journal.claim(entry.id)).changes) fail(409, 'This request was already received and will not be sent twice.');
      let result;
      try { result = await completion({ config: provider, ...context, metricsContext: { kind: 'orchestration', runId: row.id, lane, userId: req.user.id, userRole: req.user.role } }); }
      catch (error) { await journal.fail(entry.id, error); error.submissionId = entry.id; throw error; }
      let publication = binding?.observation_mode === 'sealed-card' && lane === binding.source_lane && !observation
        ? normalized(result.text) === normalized(sealedCardWait)
          ? { status: 'waiting', reason: 'The dispatch seal has not been opened.', value: sealedCardWait, exactFormat: result.text === sealedCardWait }
          : { status: 'rejected', reason: 'A source label cannot publish before the dispatch seal is opened.' }
        : evaluateOrchestrationReply({ contract: snapshot.contract, lane, rawReply: result.text, messages, board });
      if (binding && publication.status === 'published') {
        if (lane === binding.source_lane) {
          const sourceTruth = normalized(publication.value) === normalized(binding.fact_value);
          publication = { ...publication, sourceTruth,
            scoreEligible: sourceTruth && binding.observation_mode === 'sealed-card' && Boolean(observation),
            observationEventSeq: observation ? Number(observation.seq) : null };
        } else if (publication.sourceMessageId) {
          const source = messages.find(message => message.id === publication.sourceMessageId);
          publication = { ...publication, sourceTruth: source?.publication?.sourceTruth === true, scoreEligible: source?.publication?.scoreEligible === true };
        }
      }
      const now = Date.now();
      const replyId = id();
      await journal.succeed(entry.id, { reply: result.text, replyId });
      const next = [...messages, { id: id(), lane, role: 'user', content, createdAt: now }, { id: replyId, lane, role: 'assistant', content: result.text, publication, model: result.model, latencyMs: result.latencyMs, usage: result.usage, context, createdAt: Date.now() }];
      await saveRunEvent({ row: current, lease, messages: next, board, kind: 'turn', sourceMessageId: next.at(-1).id });
      await journal.markTranscriptSaved(entry.id);
      if (result.metricsCallId) { try { await run("UPDATE metrics_model_calls SET transcript_saved=1 WHERE id=? AND status='succeeded'", result.metricsCallId); } catch { /* best effort */ } }
      res.json({ ...runView(await runRow(row.id)), submissionId: entry.id });
    }); } catch (error) {
      const current = await get('SELECT status FROM durable_submissions WHERE id = ?', entry.id);
      if (current?.status === 'accepted') await journal.reject(entry.id);
      else if (current?.status === 'running') await journal.fail(entry.id, error);
      error.submissionId ||= entry.id;
      error.submissionStatus ||= current?.status;
      error.receiptConfirmed = true;
      if (current?.status === 'failed') error.message = 'Your prompt was recorded, but the model could not return a reply.';
      throw error;
    }
  });
  app.post('/api/orchestration/runs/:id/board', member, async (req, res) => {
    const row = await runRow(req.params.id); canChangeRun(req, row);
    const { messageId, targets } = z.object({ messageId: z.string(), targets: z.array(slotId).min(1).max(3) }).parse(req.body);
    await withLease(row, async lease => {
      const current = await runRow(row.id);
      const message = JSON.parse(current.messages).find(item => item.id === messageId && item.role === 'assistant');
      if (!message) fail(400, 'Choose a saved specialist reply to share.');
      const contract = JSON.parse(current.snapshot).contract;
      if (contract && message.publication?.status !== 'published') fail(409, 'Only a published specialist reply can satisfy a handoff contract.');
      if (contract && targets.some(target => !canShareContractReply({ contract, sourceLane: message.lane, targetLane: target, rawReply: message.content }))) fail(409, 'This reply does not match a declared handoff edge and source label.');
      const board = JSON.parse(current.board);
      if (board.length >= 12) fail(409, 'This board is full. Start a fresh test.');
      if (board.some(item => item.messageId === messageId && targets.every(target => item.targets.includes(target)))) fail(409, 'This reply is already shared with those specialists.');
      board.push({ id: id(), messageId, from: message.lane, targets: [...new Set(targets)], content: message.content.slice(0, 2500), createdAt: Date.now() });
      await saveRunEvent({ row: current, lease, messages: JSON.parse(current.messages), board, kind: 'share', sourceMessageId: messageId, boardId: board.at(-1).id });
      res.json(runView(await runRow(row.id)));
    });
  });
}
