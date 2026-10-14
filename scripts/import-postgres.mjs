import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { neon } from '@neondatabase/serverless';

const snapshot = JSON.parse(readFileSync('work/migration-snapshot.json', 'utf8'));
const sql = neon(process.env.DATABASE_URL, { fullResults: true });
const order = ['users', 'auth', 'invites', 'levels', 'versions', 'links', 'rounds', 'reviews', 'comments', 'workshop_links', 'link_sessions', 'invite_claims', 'round_locks'];
for (const table of order) {
  const { rows } = await sql.query(`SELECT COUNT(*) AS count FROM "${table}"`);
  if (Number(rows[0].count) !== 0) throw new Error(`Target table ${table} is not empty. Refusing duplicate import.`);
}
const statements = [];
for (const table of order) {
  const { columns, rows, model_projection: projection, has_more: more } = snapshot.tables[table];
  if (more || projection.omitted_columns || projection.omitted_rows) throw new Error(`Incomplete table ${table}`);
  if (!['levels', 'versions'].includes(table) && projection.truncated) throw new Error(`Truncated table ${table}`);
  for (const column of columns) if (!/^[a-z_]+$/.test(column)) throw new Error('Unexpected column');
  for (const row of rows) {
    if (table === 'levels') JSON.parse(row.draft);
    if (table === 'versions') JSON.parse(row.data);
    statements.push(sql.query(`INSERT INTO "${table}" (${columns.map(column => `"${column}"`).join(',')}) VALUES (${columns.map((_, index) => `$${index + 1}`).join(',')})`, columns.map(column => row[column])));
  }
}
// Either every source record is imported, or none is.
await sql.transaction(statements);
for (const table of order) {
  const { rows } = await sql.query(`SELECT * FROM "${table}"`);
  const original = snapshot.tables[table].rows;
  if (rows.length !== original.length) throw new Error(`Count mismatch in ${table}`);
  const key = snapshot.tables[table].columns[0];
  for (const row of original) {
    const actual = rows.find(candidate => candidate[key] === row[key]);
    if (!actual) throw new Error(`Missing record in ${table}`);
    for (const column of snapshot.tables[table].columns) {
      if (String(actual[column]) !== String(row[column])) throw new Error(`Value mismatch in ${table}.${column}`);
    }
  }
}
console.log('Imported all source rows atomically and verified every field.');
