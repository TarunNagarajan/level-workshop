import 'dotenv/config';
import { readdirSync, readFileSync } from 'node:fs';
import { neon } from '@neondatabase/serverless';
import { migrationChecksum, migrationChecksumVariants } from './migration-checksum.mjs';

const sql = neon(process.env.DATABASE_URL, { fullResults: true });
const preview = process.argv.includes('--preview');
if (!preview) await sql.query('CREATE TABLE IF NOT EXISTS workshop_migrations (name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at BIGINT NOT NULL)');
let trackingAvailable = true;
if (preview) {
  try {
    await sql.query('SELECT name FROM workshop_migrations LIMIT 0');
  } catch (error) {
    if (error.code !== '42P01') throw error;
    trackingAvailable = false;
  }
}
let pending = 0;
for (const name of readdirSync('db/postgres').filter(name => name.endsWith('.sql')).sort()) {
  const source = readFileSync(`db/postgres/${name}`, 'utf8');
  const checksum = migrationChecksum(source);
  const prior = trackingAvailable ? (await sql.query('SELECT checksum FROM workshop_migrations WHERE name = $1', [name])).rows[0] : null;
  if (prior) {
    if (!migrationChecksumVariants(source).has(prior.checksum)) throw new Error(`Applied migration changed beyond line endings: ${name}`);
    console.log(`${preview ? 'Verified applied' : 'Already applied'} ${name}`);
    continue;
  }
  pending++;
  if (preview) {
    console.log(`Would apply ${name}`);
    continue;
  }
  // Files contain plain DDL statements, with no functions or semicolon literals.
  const statements = source.split(';').map(text => text.trim()).filter(Boolean);
  await sql.transaction([
    ...statements.map(text => sql.query(text)),
    sql.query('INSERT INTO workshop_migrations VALUES ($1, $2, $3)', [name, checksum, Date.now()]),
  ]);
  console.log(`Applied ${name}`);
}
if (preview) console.log(`Preview complete: ${pending} migration(s) would apply; database was not changed.`);
