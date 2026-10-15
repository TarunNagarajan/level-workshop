import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { migrationChecksum, migrationChecksumVariants } from '../scripts/migration-checksum.mjs';

const digest = source => createHash('sha256').update(source).digest('hex');

test('migration checksums accept LF and CRLF equivalents', () => {
  const lf = `CREATE TABLE example (id TEXT);${String.fromCharCode(10)}`;
  const crlf = lf.replaceAll(String.fromCharCode(10), `${String.fromCharCode(13)}${String.fromCharCode(10)}`);
  const variants = migrationChecksumVariants(lf);

  assert.ok(variants.has(digest(lf)));
  assert.ok(variants.has(digest(crlf)));
  assert.equal(migrationChecksum(lf), migrationChecksum(crlf));
});

test('migration checksums reject SQL content changes', () => {
  const original = 'CREATE TABLE example (id TEXT);';
  const changed = 'CREATE TABLE example (id INTEGER);';

  assert.ok(!migrationChecksumVariants(original).has(digest(changed)));
});
