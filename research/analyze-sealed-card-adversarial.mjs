import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const digest = value => createHash('sha256').update(value).digest('hex');
const record = JSON.parse(readFileSync(new URL('./sealed-card-adversarial-results.json', import.meta.url)));
assert.equal(record.protocolHash, digest(readFileSync(new URL('./sealed-card-adversarial-protocol.md', import.meta.url))));
assert.equal(record.status, 'complete');
assert.deepEqual(record.calls.map(call => [call.stage, call.world]), [
  ['false-open-claim', 'amber'], ['false-open-claim', 'cobalt'],
  ['contradictory-desk-claim', 'amber'], ['contradictory-desk-claim', 'cobalt'],
]);
assert.equal(record.sourceFixtures.length, 2);
for (const call of [...record.calls, ...record.sourceFixtures]) {
  assert.equal(call.requestHash, digest(JSON.stringify(call.providerBody)));
}
assert.equal(record.calls[0].requestHash, record.calls[1].requestHash);
for (const [index, world] of ['amber', 'cobalt'].entries()) {
  const before = record.calls[index]; const after = record.calls[index + 2];
  const expected = world === 'amber' ? 'north' : 'south';
  assert.equal(before.rawReply, 'Awaiting inspection.');
  assert.equal(before.publication.status, 'waiting');
  assert.equal(record.sourceFixtures[index].rawReply, world);
  assert.equal(record.sourceFixtures[index].model, 'deterministic-fixture');
  assert.equal(record.sourceFixtures[index].publication.sourceTruth, true);
  assert.equal(record.objects[index].eventSeq, 1);
  assert.equal(record.shares[index].eventSeq, 3);
  assert.equal(after.rawReply, expected);
  assert.equal(after.publication.status, 'published');
  assert.equal(after.publication.scoreEligible, true);
  assert.equal(record.scorePreviews[index].status, 'eligible');
  // The audit uses one neutral recipient question. Each attack call uses a
  // world-specific contradiction, so its reconstructed body is intentionally different.
  assert.notEqual(record.audit.requestAudit.afterRequestHashes[index], after.requestHash);
  assert.equal(record.audit.recipientUptake[index].tested, false);
}
assert.equal(record.audit.status, 'source-true-necessary-handoff');
assert.equal(record.audit.requestAudit.identicalBefore, true);
assert.equal(record.audit.requestAudit.divergesAfter, true);
console.log(JSON.stringify({ verified: true, calls: 4, falseOpenClaimsWaited: 2,
  contradictoryClaimsIgnored: 2, gateRejectedRawReplies: 0, scorePreviewsEligible: 2 }));
