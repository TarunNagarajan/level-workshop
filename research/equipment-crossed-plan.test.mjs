import test from 'node:test';
import assert from 'node:assert/strict';
import { equipmentCrossedJobs, equipmentConciseSystem } from './equipment-crossed-plan.mjs';
import { compileEquipmentRequest, equipmentSystem } from './equipment-model-contract.mjs';

test('crossed equipment design isolates wording and state placement on the same source payload', () => {
  const jobs = equipmentCrossedJobs();
  assert.equal(jobs.length, 96);
  assert.equal(new Set(jobs.map(job => job.key)).size, jobs.length);
  const pick = (world, condition, wording, placement) => jobs.find(job => job.worldId === world && job.condition === condition
    && job.wording === wording && job.placement === placement);
  for (const condition of ['initial-clean', 'initial-spoof']) for (const wording of ['explicit', 'concise']) for (const placement of ['system', 'user']) {
    assert.deepEqual(pick('stable-intact', condition, wording, placement).request,
      pick('unstable-intact', condition, wording, placement).request);
    assert.deepEqual(pick('stable-intact', condition, wording, placement).request,
      pick('stable-blown', condition, wording, placement).request);
  }
  for (const job of jobs) {
    const same = pick(job.worldId, job.condition, 'explicit', 'system');
    assert.deepEqual(job.payload, same.payload);
    assert.deepEqual(job.source, same.source);
    assert.equal(job.request.messages.at(-1).content, same.request.messages.at(-1).content);
    if (job.wording === 'explicit' && job.placement === 'system')
      assert.deepEqual(job.request, compileEquipmentRequest(job.payload, job.request.messages.at(-1).content));
    const instruction = job.wording === 'explicit' ? equipmentSystem : equipmentConciseSystem;
    const stateLine = `VERIFIED_INSPECTION=${JSON.stringify({ voltage: job.payload.observation.voltage, fuse: job.payload.observation.fuse })}`;
    if (job.placement === 'system') {
      assert.equal(job.request.system, `${instruction}\n${stateLine}`);
      assert.equal(job.request.messages.length, 1);
    } else {
      assert.equal(job.request.system, instruction);
      assert.equal(job.request.messages[0].content, stateLine);
      assert.equal(job.request.messages.length, 2);
    }
  }
  assert.equal(jobs.filter(job => job.condition === 'initial-spoof').length, 24);
  assert.equal(jobs.filter(job => job.condition === 'both-contradict').length, 24);
});
