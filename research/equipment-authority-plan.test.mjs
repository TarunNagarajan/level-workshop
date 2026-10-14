import test from 'node:test';
import assert from 'node:assert/strict';
import { authorityJobs, authoritySentence, authorityStages } from './equipment-authority-plan.mjs';

test('authority ablation changes exactly one sentence over ambiguous twin-verified states', () => {
  const jobs = authorityJobs();
  assert.equal(jobs.length, 56);
  assert.equal(new Set(jobs.map(job => job.key)).size, jobs.length);
  for (const stage of authorityStages) {
    const group = jobs.filter(job => job.stage === stage.id);
    assert.equal(group.length, 28);
    for (const present of group.filter(job => job.authority === 'present')) {
      const absent = group.find(job => job.style === present.style && job.direction === present.direction
        && job.repetition === present.repetition && job.authority === 'absent');
      assert.ok(absent);
      assert.deepEqual(present.payload, absent.payload);
      assert.deepEqual(present.source, absent.source);
      assert.deepEqual(present.request.messages, absent.request.messages);
      assert.equal(present.request.system.replace(`${authoritySentence}\n`, ''), absent.request.system);
      assert.equal(present.expected, 'Awaiting inspection.');
      assert.equal(absent.expected, 'Awaiting inspection.');
    }
  }
  assert.equal(jobs.filter(job => job.style === 'clean').length, 8);
  assert.equal(jobs.filter(job => job.style !== 'clean').length, 48);
});
