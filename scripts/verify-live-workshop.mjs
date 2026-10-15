import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUTPUT_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), '..', 'work');
const REQUEST_TIMEOUT_MS = 45_000;
const MAX_RESPONSE_BYTES = 2_000_000;
const scenarios = [
  { name: 'tom-riddle', matches: draft => draft?.character === 'Tom Riddle' || draft?.title === 'Tom Riddle' },
  { name: 'mission-impossible', matches: draft => draft?.theme === 'Mission: Impossible' || draft?.title === 'Mission: Impossible' },
];

class SmokeError extends Error {
  constructor(stage, status = null, code = 'check_failed') {
    super(code);
    this.stage = String(stage).replace(/\/api\/rounds\/[^/]+/g, '/api/rounds/:round');
    this.status = status;
    this.code = code;
  }
}

function safeCookie(value) {
  if (!value || /[\r\n]/.test(value)) throw new SmokeError('configuration', null, 'missing_or_invalid_cookie');
  return value;
}

function escapedConfig(value) {
  return `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\r', '\\r').replaceAll('\n', '\\n')}"`;
}

async function directRequest({ origin, cookie }, path, { method = 'GET', body, token } = {}) {
  let response;
  try {
    response = await fetch(new URL(path, origin), {
      method,
      headers: { Cookie: cookie, ...(token ? { 'x-round-token': token } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new SmokeError(path, null, 'network_or_timeout');
  }
  const reader = response.body?.getReader();
  if (!reader) return { status: response.status, text: '' };
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new SmokeError(path, response.status, 'response_too_large');
    }
    chunks.push(value);
  }
  const combined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.byteLength; }
  return { status: response.status, contentType: response.headers.get('content-type'), text: new TextDecoder().decode(combined) };
}

function runCli({ cliPath, origin, cookie }, path, { method = 'GET', body, token } = {}) {
  return new Promise((resolve, reject) => {
    const marker = '\n__WORKSHOP_SMOKE_HTTP__';
    const args = ['curl', path, '--deployment', origin, '--', '--silent', '--show-error', '--max-time', '40', '--write-out', `${marker}%{http_code}__CONTENT_TYPE__%{content_type}`, '--request', method, '--config', '-'];
    const child = spawn(process.execPath, [cliPath, ...args], {
      stdio: ['pipe', 'pipe', 'ignore'],
      env: { ...process.env, WORKSHOP_SMOKE_COOKIE: '' },
      windowsHide: true,
    });
    let output = '', settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new SmokeError(path, null, 'network_or_timeout'));
    }, REQUEST_TIMEOUT_MS);
    child.stdout.on('data', chunk => {
      output += chunk.toString('utf8');
      if (Buffer.byteLength(output) > MAX_RESPONSE_BYTES + 128) {
        child.kill();
        finish(new SmokeError(path, null, 'response_too_large'));
      }
    });
    child.on('error', () => finish(new SmokeError(path, null, 'cli_unavailable')));
    child.on('close', code => {
      if (settled) return;
      const markerAt = output.lastIndexOf(marker);
      if (code !== 0 || markerAt < 0) return finish(new SmokeError(path, null, 'cli_request_failed'));
      const [statusText, contentType] = output.slice(markerAt + marker.length).trim().split('__CONTENT_TYPE__', 2);
      const status = Number(statusText);
      if (!Number.isInteger(status) || status < 100 || status > 599) return finish(new SmokeError(path, null, 'cli_invalid_status'));
      finish(null, { status, contentType: contentType || null, text: output.slice(0, markerAt) });
    });
    const config = [`header = ${escapedConfig(`Cookie: ${cookie}`)}`];
    if (token) config.push(`header = ${escapedConfig(`x-round-token: ${token}`)}`);
    if (body !== undefined) {
      config.push(`header = ${escapedConfig('Content-Type: application/json')}`);
      config.push(`data = ${escapedConfig(JSON.stringify(body))}`);
    }
    child.stdin.end(`${config.join('\n')}\n`);
  });
}

function createRequester({ origin, cookie, cliPath }) {
  const context = { origin, cookie };
  const transport = cliPath ? runCli : directRequest;
  const observations = [];
  const request = async (path, options = {}) => {
    let observed = false;
    try {
      const response = await transport({ ...context, cliPath }, path, options);
      observations.push({ path: String(path).replace(/\/api\/rounds\/[^/]+/g, '/api/rounds/:round'), status: response.status, contentType: response.contentType || null });
      observed = true;
      if (response.status < 200 || response.status >= 300) throw new SmokeError(path, response.status, 'http_error');
      if (options.text) return response.text;
      try { return JSON.parse(response.text); }
      catch { throw new SmokeError(path, response.status, 'invalid_json'); }
    } catch (error) {
      if (!observed) {
        observations.push({ path: String(path).replace(/\/api\/rounds\/[^/]+/g, '/api/rounds/:round'), status: Number.isInteger(error.status) ? error.status : null, contentType: null });
      }
      throw error;
    }
  };
  request.observations = observations;
  return request;
}

function selectVersion(levels, details, scenario) {
  const matches = levels.filter(level => scenario.matches(level.draft) && !level.draft?.diaryScenario);
  if (matches.length !== 1) throw new SmokeError(`select-${scenario.name}`, null, matches.length ? 'ambiguous_seed_level' : 'seed_level_missing');
  const detail = details.get(matches[0].id);
  if (!detail?.versions?.length) throw new SmokeError(`select-${scenario.name}`, null, 'seed_version_missing');
  return { detail, version: detail.versions[0] };
}

function verifyReview(review, messages, scenario, submittedContent) {
  if (!review || review.protocolVersion !== 'saved-reply-selection-v2') throw new SmokeError(`review-${scenario}`, null, 'review_protocol_mismatch');
  if (review.status !== 'complete') throw new SmokeError(`review-${scenario}`, null, review.errorCode || 'review_unavailable');
  const replies = new Map(messages.filter(message => message.role === 'assistant' && !message.opening && !message.synthetic).map(message => [message.id, message.content]));
  for (const evidence of review.evidence || []) {
    const savedText = replies.get(evidence.replyId);
    if (typeof savedText !== 'string' || evidence.quote !== savedText || savedText === submittedContent)
      throw new SmokeError(`review-${scenario}`, null, 'evidence_not_canonical');
  }
  return review;
}

async function verifyScenario(request, scenario, selected, report) {
  const stage = scenario.name;
  let round;
  try {
    round = await request(`/api/levels/${encodeURIComponent(selected.detail.id)}/rounds`, { method: 'POST', body: { versionId: selected.version.id } });
    if (!round?.id || !round.accessToken || round.reviewEnabled !== true) throw new SmokeError(`start-${stage}`, null, 'round_not_reviewable');
    const submittedContent = `Smoke check ${stage}: please describe one ordinary detail about your surroundings.`;
    const requestId = randomUUID();
    const received = await request(`/api/rounds/${encodeURIComponent(round.id)}/messages`, {
      method: 'POST', body: { content: submittedContent, requestId },
      token: round.accessToken,
    });
    if (!received.submissionId) throw new SmokeError(`submission-${stage}`, null, 'submission_receipt_missing');
    const reply = received.messages?.at(-1);
    if (reply?.role !== 'assistant' || !reply.id || !reply.content) throw new SmokeError(`submission-${stage}`, null, 'assistant_reply_missing');

    await request(`/api/rounds/${encodeURIComponent(round.id)}/submit`, {
      method: 'POST', body: { answer: `Diagnostic smoke check completed for ${stage}.` },
      token: round.accessToken,
    });
    const first = await request(`/api/rounds/${encodeURIComponent(round.id)}/review`, { method: 'POST', token: round.accessToken });
    const review = verifyReview(first.machineReview, received.messages, stage, submittedContent);
    const second = await request(`/api/rounds/${encodeURIComponent(round.id)}/review`, { method: 'POST', token: round.accessToken });
    if (JSON.stringify(second.machineReview) !== JSON.stringify(first.machineReview)) throw new SmokeError(`review-cache-${stage}`, null, 'cached_review_changed');
    const saved = await request(`/api/rounds/${encodeURIComponent(round.id)}`, { token: round.accessToken });
    if (!saved.messages?.some(message => message.role === 'user' && message.content === submittedContent)
      || !saved.messages?.some(message => message.id === reply.id && message.role === 'assistant' && message.content === reply.content))
      throw new SmokeError(`transcript-${stage}`, null, 'submitted_turn_not_saved');

    report.scenarios.push({
      name: stage,
      levelTheme: selected.detail.draft.theme,
      character: selected.detail.draft.character,
      versionNumber: selected.version.number,
      source: round.source,
      submittedContent,
      assistantReply: reply.content,
      submissionReceiptReturned: true,
      transcriptContainsSubmittedTurn: true,
      review,
      repeatedReviewUnchanged: true,
      ownerExportCheck: 'skipped_unfiltered_export_endpoint',
    });
  } catch (error) {
    report.failures.push({ scenario: stage, stage: error.stage || stage, status: Number.isInteger(error.status) ? error.status : null, code: error.code || 'check_failed' });
  }
}

export async function runSmoke({ baseUrl, cookie, cliPath = '', outputDirectory = OUTPUT_DIRECTORY }) {
  const parsedBase = new URL(baseUrl);
  if (!['http:', 'https:'].includes(parsedBase.protocol) || parsedBase.pathname !== '/' || parsedBase.search || parsedBase.hash)
    throw new SmokeError('configuration', null, 'invalid_base_url');
  const origin = parsedBase.origin;
  const request = createRequester({ origin, cookie: safeCookie(cookie), cliPath: cliPath || undefined });
  const report = {
    createdAt: new Date().toISOString(),
    baseHost: parsedBase.host,
    transport: cliPath ? 'vercel-cli' : 'direct-http',
    scenarios: [],
    failures: [],
    ownerExportNote: 'The submissions export has no round filter. It was skipped to avoid retrieving other participants’ records.',
  };

  const assetStatus = await request('/', { text: true }).then(() => 'ok').catch(error => Number.isInteger(error.status) ? `http-${error.status}` : error.code || 'unavailable');
  report.siteRoot = assetStatus;
  const bootstrap = await request('/api/bootstrap');
  if (bootstrap.user?.role !== 'admin') throw new SmokeError('bootstrap', null, 'owner_session_required');
  if (!bootstrap.model?.connected) throw new SmokeError('bootstrap', null, 'model_not_connected');
  report.bootstrap = { ownerSession: true, modelConnected: true, recordingNoticeRequired: Boolean(bootstrap.recordingNoticeRequired) };
  if (bootstrap.recordingNoticeRequired && !bootstrap.recordingAccepted) throw new SmokeError('bootstrap', null, 'recording_acknowledgement_required');

  const levels = await request('/api/levels');
  const details = new Map();
  for (const scenario of scenarios) {
    const candidates = levels.filter(level => scenario.matches(level.draft));
    for (const level of candidates) details.set(level.id, await request(`/api/levels/${encodeURIComponent(level.id)}`));
  }
  report.httpStatusChecks = request.observations;
  for (const scenario of scenarios) {
    try { await verifyScenario(request, scenario, selectVersion(levels, details, scenario), report); }
    catch (error) { report.failures.push({ scenario: scenario.name, stage: error.stage || `select-${scenario.name}`, status: Number.isInteger(error.status) ? error.status : null, code: error.code || 'check_failed' }); }
  }
  await mkdir(outputDirectory, { recursive: true });
  const outputPath = join(outputDirectory, `live-workshop-smoke-${new Date().toISOString().replaceAll(':', '-')}.json`);
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  return { outputPath, report };
}

async function main() {
  if (process.argv.includes('--help')) {
    process.stdout.write('Set WORKSHOP_SMOKE_BASE_URL and WORKSHOP_SMOKE_COOKIE. Optionally set WORKSHOP_SMOKE_VERCEL_CLI to use Vercel CLI transport.\n');
    return;
  }
  let output;
  try {
    output = await runSmoke({
      baseUrl: process.env.WORKSHOP_SMOKE_BASE_URL,
      cookie: process.env.WORKSHOP_SMOKE_COOKIE,
      cliPath: process.env.WORKSHOP_SMOKE_VERCEL_CLI || '',
    });
  } catch (error) {
    process.stderr.write(`Live smoke verifier stopped at ${error.stage || 'startup'} (${error.code || 'check_failed'}${Number.isInteger(error.status) ? `, HTTP ${error.status}` : ''}). No response body or credential was logged.\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`Saved private smoke results to ${output.outputPath}. Scenarios: ${output.report.scenarios.length}; failures: ${output.report.failures.length}.\n`);
  if (output.report.failures.length || output.report.scenarios.length !== scenarios.length) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
