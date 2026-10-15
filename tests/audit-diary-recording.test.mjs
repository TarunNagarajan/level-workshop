import test from 'node:test';
import assert from 'node:assert/strict';
import { auditEvaluation, expectedSubmissions, selectForIds } from '../scripts/audit-diary-recording.mjs';

const subId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const roundId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const requestId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const replyId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const fixture = () => ({
  format: 'riddle-diary-live-evaluation-v1',
  records: [{
    status: 'complete', profileId: 'chronology', source: 'diary-diagnostic', roundId,
    prompts: [{ content: 'What did the note say?', requestId, submissionId: subId, completedAt: '2026-10-15T00:00:00Z' }],
    replies: [{ id: replyId, content: 'It mentioned the west corridor.' }],
  }],
});

test('audits only supplied UUIDs with bound parameters and compares saved content and transcript association', async () => {
  const calls = [];
  const result = await auditEvaluation(fixture(), async (text, values) => {
    calls.push({ text, values });
    return [{ id: subId, client_request_id: requestId, round_id: roundId, source: 'diary-diagnostic', profile_id: 'chronology', content: 'What did the note say?', status: 'succeeded', reply: 'It mentioned the west corridor.', reply_id: replyId, transcript_saved: true }];
  });
  assert.equal(result.passed, true);
  assert.equal(result.submittedTurnCount, 1);
  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /^SELECT .* FROM durable_submissions WHERE id IN \(\$1\)$/);
  assert.deepEqual(calls[0].values, [subId]);
  assert.equal(calls[0].text.includes(subId), false);
});

test('accepts PostgreSQL bigint text representations of persisted transcript flags', async () => {
  const row = {
    id: subId, client_request_id: requestId, round_id: roundId, source: 'diary-diagnostic', profile_id: 'chronology',
    content: 'What did the note say?', status: 'succeeded', reply: 'It mentioned the west corridor.', reply_id: replyId, transcript_saved: '1',
  };
  const result = await auditEvaluation(fixture(), async () => [row]);
  assert.equal(result.passed, true);

  const failedDocument = fixture();
  failedDocument.records[0].prompts[0] = { content: 'What did the note say?', requestId, submissionId: subId };
  failedDocument.records[0].replies = [];
  failedDocument.records[0].status = 'failed';
  failedDocument.records[0].error = { submission: { id: subId, status: 'failed', transcriptSaved: false } };
  const failedRow = { ...row, status: 'failed', reply: null, reply_id: null, transcript_saved: '0' };
  const failedResult = await auditEvaluation(failedDocument, async () => [failedRow]);
  assert.equal(failedResult.passed, true);
});

test('does not accept other truthy text values for transcript flags', async () => {
  const row = {
    id: subId, client_request_id: requestId, round_id: roundId, source: 'diary-diagnostic', profile_id: 'chronology',
    content: 'What did the note say?', status: 'succeeded', reply: 'It mentioned the west corridor.', reply_id: replyId, transcript_saved: 'true',
  };
  const result = await auditEvaluation(fixture(), async () => [row]);
  assert.equal(result.mismatchCounts.transcript_not_saved, 1);
});

test('reports a persisted failure and never includes row content or identifiers in summary', async () => {
  const result = await auditEvaluation(fixture(), async () => [{
    id: subId, client_request_id: requestId, round_id: roundId, source: 'diary-diagnostic', profile_id: 'chronology',
    content: 'What did the note say?', status: 'failed', reply: null, reply_id: null, transcript_saved: false,
  }]);
  assert.equal(result.passed, false);
  assert.equal(result.mismatchCounts.persisted_failed, 1);
  assert.equal(JSON.stringify(result).includes(subId), false);
  assert.equal(JSON.stringify(result).includes('What did the note say?'), false);
});

test('audits a known failed receipt without treating its ID as proof of success', async () => {
  const document = fixture();
  document.records[0].prompts[0] = { content: 'What did the note say?', requestId, submissionId: subId };
  document.records[0].replies = [];
  document.records[0].status = 'failed';
  document.records[0].error = { submission: { id: subId, status: 'failed' } };
  const [expected] = expectedSubmissions(document);
  assert.equal(expected.expectedStatus, 'failed');
  assert.equal(expected.replyId, null);
  const result = await auditEvaluation(document, async () => [{
    id: subId, client_request_id: requestId, round_id: roundId, source: 'diary-diagnostic', profile_id: 'chronology',
    content: 'What did the note say?', status: 'failed', reply: null, reply_id: null, transcript_saved: false,
  }]);
  assert.equal(result.passed, true);
  assert.deepEqual(result.persistedStatuses, { failed: 1 });
});

test('audits a receipt with unknown outcome without asserting success or failure', async () => {
  const document = fixture();
  document.records[0].prompts[0] = { content: 'What did the note say?', requestId, submissionId: subId };
  document.records[0].replies = [];
  document.records[0].status = 'failed';
  document.records[0].error = { submission: { id: subId, status: null } };
  const [expected] = expectedSubmissions(document);
  assert.equal(expected.expectedStatus, null);
  const result = await auditEvaluation(document, async () => [{
    id: subId, client_request_id: requestId, round_id: roundId, source: 'diary-diagnostic', profile_id: 'chronology',
    content: 'What did the note say?', status: 'running', reply: null, reply_id: null, transcript_saved: false,
  }]);
  assert.equal(result.passed, true);
  assert.deepEqual(result.persistedStatuses, { running: 1 });
});

test('rejects missing or duplicate successful submission IDs and invalid UUIDs before querying', () => {
  const missing = fixture();
  delete missing.records[0].prompts[0].submissionId;
  assert.throws(() => expectedSubmissions(missing), /missing its submission ID/);
  const duplicate = fixture();
  duplicate.records[0].prompts.push({ ...duplicate.records[0].prompts[0] });
  duplicate.records[0].replies.push({ ...duplicate.records[0].replies[0] });
  assert.throws(() => expectedSubmissions(duplicate), /duplicate submission IDs/);
  assert.throws(() => selectForIds(['not-a-uuid']), /Invalid audit ID set/);
});

test('parameterizes each ID and enforces the bounded query input', () => {
  const plan = selectForIds([subId, roundId]);
  assert.match(plan.text, /id IN \(\$1, \$2\)$/);
  assert.deepEqual(plan.values, [subId, roundId]);
  assert.throws(() => selectForIds(Array.from({ length: 1001 }, () => subId)), /Invalid audit ID set/);
});
