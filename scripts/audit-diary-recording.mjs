import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const allowedFormats = new Set(['riddle-diary-live-evaluation-v1', 'riddle-diary-live-baseline-v1']);
const fields = 'id, client_request_id, round_id, source, profile_id, content, status, reply, reply_id, transcript_saved';

export function expectedSubmissions(document) {
  if (!document || !allowedFormats.has(document.format) || !Array.isArray(document.records)) throw new Error('Unsupported evaluation document.');
  const entries = [];
  const seen = new Set();
  let submittedTurnCount = 0;
  for (const record of document.records) {
    if (!record || !Array.isArray(record.prompts)) continue;
    const replies = Array.isArray(record.replies) ? record.replies : [];
    for (let index = 0; index < record.prompts.length; index += 1) {
      const prompt = record.prompts[index];
      if (!prompt || typeof prompt !== 'object') continue;
      const reply = replies[index];
      const successful = Boolean(prompt.completedAt || reply);
      const failedReceipt = index === record.prompts.length - 1 ? record.error?.submission : null;
      const id = prompt.submissionId || failedReceipt?.id;
      if (successful && !id) throw new Error('A completed turn is missing its submission ID.');
      if (!id) continue;
      submittedTurnCount += 1;
      if (submittedTurnCount > 1000) throw new Error('Evaluation exceeds the 1,000-turn audit limit.');
      if (!uuidPattern.test(id)) throw new Error('Evaluation contains an invalid submission ID.');
      if (seen.has(id)) throw new Error('Evaluation contains duplicate submission IDs.');
      seen.add(id);
      if (typeof prompt.content !== 'string' || typeof prompt.requestId !== 'string' || !uuidPattern.test(prompt.requestId)) throw new Error('A submission is missing valid request metadata.');
      if (!uuidPattern.test(record.roundId || '') || !uuidPattern.test(reply?.id || '') && successful) throw new Error('A completed turn is missing round or reply metadata.');
      entries.push({
        id,
        requestId: prompt.requestId,
        roundId: record.roundId,
        source: record.source || 'diary-diagnostic',
        profileId: record.profileId,
        content: prompt.content,
        expectedStatus: failedReceipt?.status || (successful ? 'succeeded' : null),
        replyId: successful ? reply.id : null,
        reply: successful ? reply.content : null,
        transcriptSaved: successful ? true : failedReceipt?.transcriptSaved,
      });
    }
  }
  return entries;
}

export function selectForIds(ids) {
  if (!Array.isArray(ids) || ids.length > 1000 || ids.some(id => !uuidPattern.test(id))) throw new Error('Invalid audit ID set.');
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate audit IDs.');
  if (!ids.length) return { text: `SELECT ${fields} FROM durable_submissions WHERE id IN (NULL)`, values: [] };
  return { text: `SELECT ${fields} FROM durable_submissions WHERE id IN (${ids.map((_, i) => `$${i + 1}`).join(', ')})`, values: ids };
}

const category = (counts, value) => { counts[value] = (counts[value] || 0) + 1; };
const persistedBoolean = value => value === true || value === 1 || value === '1'
  ? true
  : value === false || value === 0 || value === '0' ? false : null;

export async function auditEvaluation(document, queryRows) {
  const expected = expectedSubmissions(document);
  const rows = [];
  for (let offset = 0; offset < expected.length; offset += 100) {
    const batch = expected.slice(offset, offset + 100);
    const sql = selectForIds(batch.map(item => item.id));
    const found = await queryRows(sql.text, sql.values);
    if (!Array.isArray(found)) throw new Error('Database query returned an invalid result.');
    rows.push(...found);
  }
  const byId = new Map(rows.map(row => [row.id, row]));
  const categories = {};
  const persistedStatuses = {};
  for (const item of expected) {
    const row = byId.get(item.id);
    if (!row) { category(categories, 'missing_record'); continue; }
    category(persistedStatuses, typeof row.status === 'string' ? row.status : 'unknown');
    if (row.client_request_id !== item.requestId) category(categories, 'request_id_mismatch');
    if (row.round_id !== item.roundId) category(categories, 'round_id_mismatch');
    if (row.source !== item.source) category(categories, 'source_mismatch');
    if (item.profileId != null && row.profile_id !== item.profileId) category(categories, 'profile_mismatch');
    if (row.content !== item.content) category(categories, 'content_mismatch');
    if (item.expectedStatus && row.status !== item.expectedStatus) category(categories, row.status === 'failed' || row.status === 'interrupted' || row.status === 'rejected' ? `persisted_${row.status}` : 'status_mismatch');
    if (item.replyId && row.reply_id !== item.replyId) category(categories, 'reply_association_mismatch');
    if (item.reply != null && row.reply !== item.reply) category(categories, 'reply_content_mismatch');
    const transcriptSaved = persistedBoolean(row.transcript_saved);
    if (item.transcriptSaved === true && transcriptSaved !== true) category(categories, 'transcript_not_saved');
    if (item.transcriptSaved === false && transcriptSaved !== false) category(categories, 'unexpected_transcript_saved');
  }
  return {
    format: 'diary-recording-audit-v1',
    evaluationFormat: document.format,
    submittedTurnCount: expected.length,
    foundCount: expected.length - (categories.missing_record || 0),
    missingCount: categories.missing_record || 0,
    persistedStatuses,
    mismatchCounts: categories,
    passed: Object.keys(categories).length === 0,
    auditedAt: new Date().toISOString(),
  };
}

async function main() {
  const [, , inputArg, outputArg] = process.argv;
  if (!inputArg || !outputArg || process.argv.length !== 4) throw new Error('Usage: node scripts/audit-diary-recording.mjs <evaluation.json> <private-output.json>');
  const inputPath = resolve(inputArg);
  const outputPath = resolve(outputArg);
  if (inputPath === outputPath) throw new Error('Input and output paths must differ.');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
  const document = JSON.parse(await readFile(inputPath, 'utf8'));
  const { neon } = await import('@neondatabase/serverless');
  const sql = neon(process.env.DATABASE_URL, { fullResults: true });
  let result;
  try {
    result = await auditEvaluation(document, async (text, values) => (await sql.query(text, values)).rows);
  } catch {
    throw new Error('The read-only journal audit query failed.');
  }
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ passed: result.passed, submittedTurnCount: result.submittedTurnCount, foundCount: result.foundCount, missingCount: result.missingCount, mismatchCounts: result.mismatchCounts })}\n`);
  if (!result.passed) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(`${error.message || 'Audit failed.'}\n`); process.exitCode = 1; });
}
