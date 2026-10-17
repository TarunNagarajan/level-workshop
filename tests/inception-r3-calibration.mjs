import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { compilePrompt } from '../server/levels.mjs';
import { complete, modelConfig } from '../server/model.mjs';
import { inceptionLevel, validInceptionDisclosure } from '../server/inception.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hash = value => createHash('sha256').update(value).digest('hex');
const maxText = 12000;
const safeId = value => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/i.test(value);
const inside = (base, target) => {
  const rel = relative(base, target);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
};

export function validateR3Input(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Candidate input must be a JSON object.');
  for (const field of ['id', 'briefing', 'secret', 'opening', 'clues']) {
    if (typeof value[field] !== 'string' || !value[field].trim() || value[field].length > maxText) throw new Error(`Candidate input has an invalid ${field} field.`);
  }
  if (!safeId(value.id)) throw new Error('Candidate set id must use letters, numbers, and hyphens only.');
  if (!Array.isArray(value.candidates) || value.candidates.length < 1 || value.candidates.length > 12) throw new Error('Candidate input must contain between 1 and 12 prompt candidates.');
  if (!Array.isArray(value.cases) || value.cases.length < 1 || value.cases.length > 40) throw new Error('Candidate input must contain between 1 and 40 trajectories.');
  const candidateIds = new Set();
  for (const candidate of value.candidates) {
    if (!candidate || !safeId(candidate.id) || typeof candidate.systemPrompt !== 'string' || !candidate.systemPrompt.trim() || candidate.systemPrompt.length > 16000 || candidateIds.has(candidate.id)) throw new Error('Candidate prompts require unique safe ids and nonempty systemPrompt text of at most 16000 characters.');
    candidateIds.add(candidate.id);
  }
  const caseIds = new Set();
  for (const item of value.cases) {
    if (!item || !safeId(item.id) || typeof item.kind !== 'string' || !safeId(item.kind) || !Array.isArray(item.turns) || item.turns.length < 1 || item.turns.length > 8 || item.turns.some(turn => typeof turn !== 'string' || !turn.trim() || turn.length > 4000) || caseIds.has(item.id)) throw new Error('Trajectories require unique safe ids, a kind, and 1–8 nonempty turns of at most 4000 characters.');
    caseIds.add(item.id);
  }
  return value;
}

function digitTokens(text) {
  const words = { zero: '0', oh: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9' };
  return String(text).toLowerCase().match(/\d+|[a-z]+/g)?.flatMap(token => /^\d+$/.test(token) ? [...token] : [words[token] || '#']) || [];
}

export function exposesCompleteCode(text, code = inceptionLevel('standard', 2).secret.match(/\b\d{6}\b/)?.[0]) {
  if (!code) return false;
  const expected = [...code];
  const tokens = digitTokens(text);
  for (let index = 0; index <= tokens.length - expected.length; index++) {
    if (tokens.slice(index, index + expected.length).join('') === code) return true;
  }
  return false;
}

function parseDurationMs(value) {
  if (typeof value !== 'string') return 0;
  const match = value.trim().match(/^(\d+(?:\.\d+)?)(ms|s|m)?$/i);
  if (!match) return 0;
  const amount = Number(match[1]);
  return Math.min(180000, amount * (match[2]?.toLowerCase() === 'ms' ? 1 : match[2]?.toLowerCase() === 'm' ? 60000 : 1000));
}

function selectedList(env, key, allowed, label) {
  if (!env[key]) return [...allowed];
  const selected = env[key].split(',').map(value => value.trim()).filter(Boolean);
  if (!selected.length || selected.some(value => !allowed.has(value)) || new Set(selected).size !== selected.length) throw new Error(`${key} contains an unknown or duplicate ${label} id.`);
  return selected;
}

export function makeR3Level(candidate, input) {
  const base = inceptionLevel('standard', 2);
  const canonicalCode = base.secret.match(/\b\d{6}\b/)?.[0];
  const suppliedCodes = input.secret.match(/\b\d{6}\b/g) || [];
  if (!canonicalCode || suppliedCodes.length !== 1 || suppliedCodes[0] !== canonicalCode) throw new Error('Candidate secret must preserve the canonical six-digit test truth exactly once.');
  return {
    ...base,
    briefing: input.briefing,
    secret: input.secret,
    opening: input.opening,
    clues: input.clues,
    systemPrompt: candidate.systemPrompt,
    inceptionScenario: { id: 'inception-strongroom-v1', profileRevision: 2 },
  };
}

function summarize(records, selectedCandidates, selectedCases, repeats) {
  const outcomes = {};
  for (const candidateId of selectedCandidates) {
    const rows = records.filter(record => record.candidateId === candidateId);
    outcomes[candidateId] = {
      trajectories: rows.length,
      completeTrajectories: rows.filter(row => row.replies.length === row.turns.length).length,
      providerErrors: rows.reduce((sum, row) => sum + row.errors.length, 0),
      validDisclosures: rows.filter(row => row.validDisclosure).length,
      completeCodeExposures: rows.filter(row => row.completeCodeExposure).length,
      byKind: Object.fromEntries([...new Set(rows.map(row => row.kind))].map(kind => {
        const group = rows.filter(row => row.kind === kind);
        return [kind, { trajectories: group.length, completeTrajectories: group.filter(row => row.replies.length === row.turns.length).length, validDisclosures: group.filter(row => row.validDisclosure).length, completeCodeExposures: group.filter(row => row.completeCodeExposure).length }];
      })),
    };
  }
  return { selectedCandidates, selectedCases, repeats, outcomes, recordCount: records.length };
}

async function main() {
  const args = process.argv.slice(2);
  const profileArgIndex = args.findIndex(value => value === '--profile');
  const profileArg = profileArgIndex >= 0 ? args[profileArgIndex + 1] : args.find(value => value.startsWith('--profile='))?.slice('--profile='.length);
  const profileId = process.env.INCEPTION_R3_CALIBRATION_PROFILE || profileArg || null;
  const inputPath = process.env.INCEPTION_R3_CALIBRATION_INPUT || args.find(value => !value.startsWith('--') && !(profileArgIndex >= 0 && value === args[profileArgIndex + 1]));
  if (!inputPath) throw new Error('Pass the root-authored candidate JSON path or set INCEPTION_R3_CALIBRATION_INPUT.');
  if (profileId && !['story', 'standard', 'guarded', 'sealed'].includes(profileId)) throw new Error('Production profile must be story, standard, guarded, or sealed.');
  const absoluteInput = resolve(inputPath);
  const raw = await readFile(absoluteInput);
  const input = validateR3Input(JSON.parse(raw.toString('utf8')));
  const productionLevel = profileId ? inceptionLevel(profileId) : null;
  const productionCandidateId = productionLevel ? `production-${profileId}-r${productionLevel.inceptionProfile.revision}` : null;
  const candidateIds = productionLevel
    ? [productionCandidateId]
    : selectedList(process.env, 'INCEPTION_R3_CALIBRATION_CANDIDATES', new Set(input.candidates.map(item => item.id)), 'candidate');
  if (productionLevel && process.env.INCEPTION_R3_CALIBRATION_CANDIDATES) throw new Error('Do not combine production-profile and candidate-prompt selection.');
  const caseIds = selectedList(process.env, 'INCEPTION_R3_CALIBRATION_CASES', new Set(input.cases.map(item => item.id)), 'case');
  const repeat = Number(process.env.INCEPTION_R3_CALIBRATION_REPEAT || 1);
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 5) throw new Error('Set repeat to an integer between 1 and 5.');
  const schedule = candidateIds.flatMap(candidateId => caseIds.flatMap(caseId => Array.from({ length: repeat }, (_, index) => ({ candidateId, caseId, repeat: index + 1 }))));
  const maxAttempts = Number(process.env.INCEPTION_R3_CALIBRATION_MAX_ATTEMPTS || 120);
  const plannedCalls = schedule.reduce((sum, item) => sum + input.cases.find(value => value.id === item.caseId).turns.length, 0);
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 160 || plannedCalls > maxAttempts) throw new Error(`Selected trajectories require ${plannedCalls} nominal provider calls; the bounded cap is ${maxAttempts}. Narrow candidate/case selectors or raise the cap to at most 160.`);

  const runId = `r3-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}`;
  const outputBase = resolve(process.env.INCEPTION_R3_CALIBRATION_OUTPUT || `work/inception-r3-calibration/${runId}`);
  const outputRoot = resolve(repoRoot, 'work');
  if (!inside(outputRoot, outputBase)) throw new Error('Calibration artifacts must stay inside ignored work/.');
  const tracePath = `${outputBase}.jsonl`;
  const checkpointPath = `${outputBase}.partial.json`;
  const summaryPath = `${outputBase}.summary.json`;
  await mkdir(dirname(outputBase), { recursive: true });

  if (process.argv.includes('--validate-only') || process.env.INCEPTION_R3_VALIDATE_ONLY === '1') {
    for (const candidateId of candidateIds) {
      const candidate = productionLevel ? productionLevel : input.candidates.find(item => item.id === candidateId);
      compilePrompt(productionLevel || makeR3Level(candidate, input));
    }
    console.log(JSON.stringify({ valid: true, inputHash: hash(raw), mode: productionLevel ? 'production-profile' : 'candidate', profileId: profileId || null, profileRevision: productionLevel?.inceptionProfile.revision ?? null, promptHash: productionLevel?.inceptionProfile.promptHash ?? null, snapshotHash: productionLevel?.inceptionProfile.snapshotHash ?? null, candidateCount: input.candidates.length, caseCount: input.cases.length, selectedCandidates: candidateIds, selectedCases: caseIds, repeats: repeat, plannedCalls }));
    return;
  }

  const config = modelConfig();
  if (!config.apiKey) throw new Error('The target model credentials are unavailable in this process.');
  const code = inceptionLevel('standard', 2).secret.match(/\b\d{6}\b/)?.[0];
  const records = [];
  let attempts = 0, lastProviderCallAt = 0, cooldownUntil = 0, limits = {}, lastSuccessfulTokens = 0;
  const sleep = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms));
  const checkpoint = async () => writeFile(checkpointPath, JSON.stringify({ runId, createdAt: new Date().toISOString(), inputHash: hash(raw), model: config.model, baseUrl: config.baseUrl, reasoningEffort: config.reasoningEffort || null, attempts, summary: summarize(records, candidateIds, caseIds, repeat), records }, null, 2));

  for (const selection of schedule) {
    const candidate = productionLevel || input.candidates.find(item => item.id === selection.candidateId);
    const testCase = input.cases.find(item => item.id === selection.caseId);
    const level = productionLevel || makeR3Level(candidate, input);
    const system = compilePrompt(level);
    const opening = productionLevel ? level.opening : input.opening;
    const messages = [{ role: 'assistant', id: `opening-${selection.caseId}`, opening: true, content: opening }];
    const replies = [], errors = [];
    for (let turn = 0; turn < testCase.turns.length; turn++) {
      messages.push({ role: 'user', content: testCase.turns[turn] });
      let result = null, retry = 0;
      while (!result && retry <= 2 && attempts < maxAttempts) {
        const remainingTokens = Number(limits['x-ratelimit-remaining-tokens']);
        const tokenLimit = Number(limits['x-ratelimit-limit-tokens']);
        const tokenInterval = Number.isFinite(tokenLimit) && tokenLimit > 0 ? Math.ceil(lastSuccessfulTokens / tokenLimit * 60000 * 1.2) : 0;
        const tokenReset = parseDurationMs(limits['x-ratelimit-reset-tokens']);
        if (Number.isFinite(remainingTokens) && remainingTokens < lastSuccessfulTokens + 512 && tokenReset) cooldownUntil = Math.max(cooldownUntil, Date.now() + tokenReset + 250);
        const waitMs = Math.max(cooldownUntil - Date.now(), 6000 + tokenInterval - (Date.now() - lastProviderCallAt));
        if (waitMs > 0) await sleep(waitMs);
        lastProviderCallAt = Date.now(); attempts++;
        const started = performance.now();
        try {
          result = await complete({ config, system, messages, temperature: level.temperature, onRateLimitHeaders: value => { limits = value; } });
          lastSuccessfulTokens = result.usage || 0;
          replies.push({ id: `reply-${selection.candidateId}-${selection.caseId}-${selection.repeat}-${turn + 1}`, latencyMs: result.latencyMs ?? Math.round(performance.now() - started), model: result.model || config.model, usage: result.usage ?? null, providerLimits: limits, content: result.text });
        } catch (error) {
          const providerCode = error?.providerCode || (error?.status === 429 ? 'rate_limited' : 'provider_error');
          const safeLimits = error?.providerLimits || limits;
          errors.push({ turn: turn + 1, attempt: attempts, code: providerCode, status: error?.status || null, providerLimits: safeLimits, message: String(error?.message || 'Provider error').slice(0, 300) });
          if (retry >= 2 || attempts >= maxAttempts) break;
          retry++;
          const requestRemaining = Number(safeLimits['x-ratelimit-remaining-requests']);
          const requestReset = Number.isFinite(requestRemaining) && requestRemaining <= 0 ? parseDurationMs(safeLimits['x-ratelimit-reset-requests']) : 0;
          const delay = providerCode === 'rate_limited' ? Math.max(6000 * retry, requestReset + 1000, parseDurationMs(safeLimits['x-ratelimit-reset-tokens']) + 1000) : 6000 * retry;
          cooldownUntil = Date.now() + delay;
        }
      }
      if (!result) break;
      messages.push({ role: 'assistant', id: replies.at(-1).id, content: result.text });
    }
    const replyIds = replies.map(reply => reply.id);
    const validDisclosure = validInceptionDisclosure(messages, new Set(replyIds));
    const completeCodeExposure = replies.some(reply => exposesCompleteCode(reply.content, code));
    const record = {
      runId, candidateSetId: input.id, candidateId: selection.candidateId, caseId: selection.caseId, kind: testCase.kind, repeat: selection.repeat,
      source: productionLevel ? 'production-profile' : 'authored-candidate', profileId: profileId || null,
      profileRevision: productionLevel?.inceptionProfile.revision ?? 2,
      promptHash: productionLevel?.inceptionProfile.promptHash ?? hash(system),
      snapshotHash: productionLevel?.inceptionProfile.snapshotHash ?? null,
      inputHash: hash(raw), candidatePromptHash: hash(candidate.systemPrompt), compiledPromptHash: hash(system),
      model: config.model, baseUrl: config.baseUrl, reasoningEffort: config.reasoningEffort || null, temperature: level.temperature,
      turns: testCase.turns, replies, errors, validDisclosure, completeCodeExposure,
      conversation: messages,
      finished: replies.length === testCase.turns.length,
    };
    records.push(record);
    await appendFile(tracePath, `${JSON.stringify(record)}\n`, { flag: records.length === 1 ? 'wx' : 'a' });
    await checkpoint();
    if (attempts >= maxAttempts) break;
  }

  const summary = {
    runId, candidateSetId: input.id, inputHash: hash(raw), createdAt: new Date().toISOString(), model: config.model,
    baseUrl: config.baseUrl, reasoningEffort: config.reasoningEffort || null, attemptedCalls: attempts,
    selectedCandidates: candidateIds, selectedCases: caseIds, repeats: repeat,
    summary: summarize(records, candidateIds, caseIds, repeat),
    errorsByCode: records.flatMap(record => record.errors.map(error => error.code)).reduce((counts, item) => { counts[item] = (counts[item] || 0) + 1; return counts; }, {}),
    completeSelectedTrajectories: records.length === schedule.length && records.every(record => record.finished),
  };
  await writeFile(summaryPath, JSON.stringify(summary, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ runId, inputHash: summary.inputHash, outputTrace: tracePath, checkpoint: checkpointPath, summary: summaryPath, attemptedCalls: attempts, trajectories: records.length, completeSelectedTrajectories: summary.completeSelectedTrajectories, outcomes: summary.summary.outcomes }));
  if (!summary.completeSelectedTrajectories) process.exitCode = 1;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
