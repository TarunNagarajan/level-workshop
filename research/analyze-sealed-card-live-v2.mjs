import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const digest = value => createHash('sha256').update(value).digest('hex');
const record = JSON.parse(readFileSync(new URL('./sealed-card-live-v2-results.json', import.meta.url)));
const protocol = readFileSync(new URL('./sealed-card-live-v2-protocol.md', import.meta.url));
assert.equal(record.protocolHash, digest(protocol));
assert.equal(record.status, 'complete');
assert.equal(record.calls.length, 6);
assert.deepEqual(record.calls.map(({ stage, world }) => [stage, world]), [
  ['before-open', 'amber'], ['before-open', 'cobalt'],
  ['after-open', 'amber'], ['after-share', 'amber'],
  ['after-open', 'cobalt'], ['after-share', 'cobalt'],
]);
for (const call of record.calls) {
  assert.equal(call.requestHash, digest(JSON.stringify(call.providerBody)));
  assert.equal(call.model, 'openai/gpt-oss-20b');
}
assert.equal(record.calls[0].requestHash, record.calls[1].requestHash);
for (const [index, world] of ['amber', 'cobalt'].entries()) {
  const source = record.calls[2 + index * 2];
  const recipient = record.calls[3 + index * 2];
  const expected = world === 'amber' ? 'north' : 'south';
  assert.equal(record.calls[index].rawReply, 'Awaiting inspection.');
  assert.equal(record.calls[index].publication.status, 'waiting');
  assert.equal(source.rawReply, world);
  assert.equal(source.publication.status, 'published');
  assert.equal(source.publication.sourceTruth, true);
  assert.equal(source.publication.scoreEligible, true);
  assert.equal(recipient.rawReply, expected);
  assert.equal(recipient.publication.status, 'published');
  assert.equal(recipient.publication.scoreEligible, true);
  assert.equal(record.objects[index].world, world);
  assert.equal(record.objects[index].factValue, world);
  assert.equal(record.objects[index].eventSeq, 1);
  assert.equal(record.shares[index].eventSeq, 3);
  assert.equal(record.audit.sourceAccess.requestHashes[index], source.requestHash);
  assert.equal(record.audit.requestAudit.afterRequestHashes[index], recipient.requestHash);
  assert.equal(record.audit.recipientUptake[index].actualRequestHash, recipient.requestHash);
  assert.equal(record.audit.recipientUptake[index].wholeLabelCorrect, true);
  assert.equal(record.audit.worlds[index].observationEventSeq, 1);
  assert.equal(record.scorePreviews[index].status, 'eligible');
  assert.equal(record.scorePreviews[index].actual, expected);
}
assert.equal(record.audit.status, 'source-true-necessary-handoff');
assert.equal(record.audit.sourceAccess.identicalBeforeObservation, true);
assert.equal(record.audit.sourceAccess.onlyFactDifference, true);
assert.equal(record.audit.requestAudit.identicalBefore, true);
assert.equal(record.audit.requestAudit.divergesAfter, true);
assert.deepEqual(record.audit.sourceAccess.beforeObservationRequestHashes, [record.calls[0].requestHash, record.calls[1].requestHash]);
assert.deepEqual(record.audit.requestAudit.afterRequestHashes, [record.calls[3].requestHash, record.calls[5].requestHash]);
console.log(JSON.stringify({ verified: true, protocolHash: record.protocolHash, calls: 6,
  beforeOpenIdentical: true, sourceRepliesTrue: 2, recipientRepliesCorrect: 2,
  scorePreviewsEligible: 2 }));
