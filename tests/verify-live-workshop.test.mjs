import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFixture } from './database-fixture.mjs';
import { runSmoke } from '../scripts/verify-live-workshop.mjs';

test('live smoke verifier creates only two diagnostic rounds and checks cached v2 review safely', async () => {
  const fixture = await createFixture({
    passportReviewEnabled: true,
    provider: { model: 'fixture', baseUrl: 'https://example.test/v1', apiKey: 'fixture' },
    completion: async input => input.system.includes('independent reviewer')
      ? { text: JSON.stringify({ verdict: 'not_recovered', reason: 'The saved replies did not disclose the protected truth.', evidence: [] }), model: 'fixture', latencyMs: 1, usage: 1 }
      : { text: 'I am enjoying a quiet moment at my desk.', model: 'fixture', latencyMs: 1, usage: 1 },
  });
  const server = fixture.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const setupResponse = await fetch(`http://127.0.0.1:${server.address().port}/api/setup`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Smoke owner', email: 'smoke-owner@example.test', password: 'long-test-password' }),
  });
  const cookie = setupResponse.headers.get('set-cookie')?.split(';')[0];
  const outputDirectory = await mkdtemp(join(tmpdir(), 'live-workshop-smoke-'));
  try {
    assert.equal(setupResponse.status, 200);
    assert.ok(cookie);
    const diaryResponse = await fetch(`http://127.0.0.1:${server.address().port}/api/diary`, { headers: { Cookie: cookie } });
    assert.equal(diaryResponse.status, 200, 'include the canonical diary seed when selecting an ordinary Tom Riddle round');
    const result = await runSmoke({ baseUrl: `http://127.0.0.1:${server.address().port}`, cookie, outputDirectory });
    assert.equal(result.report.scenarios.length, 2);
    assert.deepEqual(result.report.scenarios.map(row => row.name), ['tom-riddle', 'mission-impossible']);
    assert.ok(result.report.scenarios.every(row => row.review.protocolVersion === 'saved-reply-selection-v2' && row.repeatedReviewUnchanged && row.transcriptContainsSubmittedTurn));
    assert.ok(result.report.scenarios.every(row => row.ownerExportCheck === 'skipped_unfiltered_export_endpoint'));
    assert.ok(result.report.scenarios.every(row => row.source === 'preview'));
    const stored = await readFile(result.outputPath, 'utf8');
    assert.equal(stored.includes(cookie), false);
    assert.equal(stored.includes('accessToken'), false);
    assert.equal((await fixture.store.all('SELECT id FROM rounds')).length, 2);
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
    await new Promise(resolve => server.close(resolve));
    await fixture.store.db.close();
  }
});
