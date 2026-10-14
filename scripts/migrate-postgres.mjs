import 'dotenv/config';
import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL, { fullResults: true });
await sql.query('CREATE TABLE IF NOT EXISTS workshop_migrations (name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at BIGINT NOT NULL)');
for (const name of readdirSync('db/postgres').filter(name => name.endsWith('.sql')).sort()) {
  const source = readFileSync(`db/postgres/${name}`, 'utf8');
  const checksum = createHash('sha256').update(source).digest('hex');
  const prior = (await sql.query('SELECT checksum FROM workshop_migrations WHERE name = $1', [name])).rows[0];
  if (prior) {
    if (prior.checksum !== checksum) throw new Error(`Applied migration changed: ${name}`);
    console.log(`Already applied ${name}`);
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
