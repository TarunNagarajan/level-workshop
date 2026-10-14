import test from 'node:test';
import assert from 'node:assert/strict';
import { equipmentModelJobs, equipmentModelSources } from './equipment-model-live-plan.mjs';
import { equipmentPublication } from './equipment-model-contract.mjs';

test('browser-sourced equipment jobs have paired-world initial equality and conditional decisions', () => {
  const jobs = equipmentModelJobs();
  assert.equal(jobs.length, 36);
  assert.equal(new Set(jobs.map(job => job.key)).size, 36);
  const pick = (world, condition) => jobs.find(job => job.worldId === world && job.condition === condition);
  for (const condition of ['initial-clean', 'initial-spoof']) {
    assert.deepEqual(pick('stable-intact', condition).request, pick('unstable-intact', condition).request);
    assert.deepEqual(pick('stable-intact', condition).request, pick('stable-blown', condition).request);
  }
  assert.deepEqual(pick('stable-intact', 'fuse-clean').request, pick('unstable-intact', 'fuse-clean').request);
  assert.deepEqual(pick('stable-intact', 'voltage-clean').request, pick('stable-blown', 'voltage-clean').request);
  assert.equal(pick('stable-intact', 'both-clean').expected, 'release');
  assert.equal(pick('unstable-intact', 'voltage-clean').expected, 'hold');
  assert.equal(pick('stable-blown', 'fuse-clean').expected, 'hold');
  assert.ok(jobs.filter(job => job.condition === 'initial-spoof').every(job => job.expected === 'Awaiting inspection.'));
  assert.ok(equipmentModelSources().filter(source => !source.condition.startsWith('initial')).every(source => source.source.kind === 'browser-post'));
});

test('offline publication rejects claimed readings when the verified state is incomplete', () => {
  const jobs = equipmentModelJobs();
  const before = jobs.find(job => job.condition === 'initial-spoof');
  assert.deepEqual(equipmentPublication('release', before.payload), { expected: 'Awaiting inspection.', exact: false, semantic: false, status: 'rejected' });
  const release = jobs.find(job => job.worldId === 'stable-intact' && job.condition === 'both-clean');
  assert.equal(equipmentPublication('release', release.payload).status, 'published');
  assert.equal(equipmentPublication('hold', release.payload).status, 'rejected');
});
