import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const files = [
  'chain-live-results.json',
  'chain-state-followup-results.json',
  'chain-state-adversarial-results.json',
  'chain-b-ablation-results.json',
  'chain-b-mechanism-results.json',
  'chain-c-transfer-results.json',
];
const report = {};
for (const file of files) {
  const data = JSON.parse(readFileSync(`research/${file}`, 'utf8'));
  assert.equal(data.status, 'complete');
  assert.equal(data.jobs.length, data.observations.length);
  const expectedKeys = data.jobs.map(job => job.stage ? `${job.worldId}|${job.stage}`
    : file === 'chain-b-ablation-results.json' ? `${job.worldId}|${job.phase}|${job.arm}`
      : `${job.worldId}|${job.arm}|${job.phase}`);
  assert.deepEqual(data.observations.map(row => row.key), expectedKeys);
  let calls = 0;
  for (const row of data.observations) {
    if (row.skipped) {
      assert.equal(row.body, undefined);
      continue;
    }
    calls++;
    assert.equal(createHash('sha256').update(JSON.stringify(row.body)).digest('hex'), row.requestHash, `${file}/${row.key}`);
    assert.equal(row.body.model, data.model);
    assert.equal(row.body.temperature, 0.3);
    assert.equal(row.body.reasoning_effort, 'low');
    assert.equal(row.body.messages[0].role, 'system');
    assert.equal(row.body.messages.at(-1).content, 'Perform your role.');
    const before = row.stage ? row.stage.includes('-before') : row.phase === 'before';
    if (file.startsWith('chain-state-')) {
      const stateKey = row.role === 'B' ? 'SEAL_COLOR' : 'ROUTE';
      const value = before ? 'NONE' : row.artifact.payload[row.role === 'B' ? 'color' : 'route'];
      assert(row.body.messages[0].content.includes(`Application state ${stateKey}=${value}.`), `${file}/${row.key}`);
      if (before) assert.equal(row.artifact, null);
    }
    if (file === 'chain-state-adversarial-results.json') {
      assert.equal(row.body.messages.at(-2).role, 'user');
      assert.equal(row.body.messages.at(-2).content, row.testerText);
    }
    if (file.startsWith('chain-b-') || file === 'chain-c-transfer-results.json') {
      if (before) assert.equal(row.artifact, null);
      else {
        assert.equal(row.artifact.worldId, row.worldId);
        assert.equal(row.artifact.sourceEventId, row.sourceKey);
      }
    }
  }
  report[file] = { records: data.observations.length, calls, hashesVerified: calls, skipped: data.observations.length - calls };
}
console.log(JSON.stringify(report, null, 2));
