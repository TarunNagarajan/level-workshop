import { createInterface } from 'node:readline';
import { mkdirSync, writeFileSync } from 'node:fs';

if (process.stdin.isTTY) process.stdin.setRawMode(true);
const lines = createInterface({ input: process.stdin, terminal: false });
const input = await new Promise(resolve => lines.once('line', resolve));
lines.close();
const { origin, ownerPath, tables } = JSON.parse(input);
const owners = tables.users.rows.filter(user => user.role === 'admin');
if (owners.length !== 1) throw new Error('Expected existing owner; refusing to initialize source.');
const login = await fetch(`${origin}/api${ownerPath}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ name: owners[0].name }), signal: AbortSignal.timeout(30000) });
if (!login.ok) throw new Error(`Source sign-in failed (${login.status})`);
const cookie = login.headers.get('set-cookie')?.split(';')[0];
if (!cookie) throw new Error('Source session missing');
try {
  // The database viewer truncates long JSON cells. The authorized API provides
  // complete drafts and versions while native reads retain exact DB metadata.
  for (const level of tables.levels.rows) {
    const response = await fetch(`${origin}/api/levels/${level.id}`, { headers: { Cookie: cookie }, signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`Source level read failed (${response.status})`);
    const detail = await response.json();
    if (detail.revision !== level.revision) throw new Error('Source draft changed during migration. Export again.');
    level.draft = JSON.stringify(detail.draft);
    for (const version of tables.versions.rows.filter(row => row.level_id === level.id)) {
      const full = detail.versions.find(row => row.id === version.id && row.number === version.number);
      if (!full) throw new Error('Source version missing');
      version.data = JSON.stringify(full.data);
    }
  }
  for (const [name, table] of Object.entries(tables)) {
    if (!['levels', 'versions'].includes(name) && table.model_projection.truncated) throw new Error(`Truncated source table ${name}`);
    if (table.has_more || table.model_projection.omitted_rows || table.model_projection.omitted_columns) throw new Error(`Incomplete source table ${name}`);
  }
  const snapshot = { exportedAt: Date.now(), source: origin, tables };
  mkdirSync('work', { recursive: true });
  writeFileSync('work/migration-snapshot.json', JSON.stringify(snapshot), { mode: 0o600 });
  console.log('Complete snapshot saved locally. Counts: ' + JSON.stringify(Object.fromEntries(Object.entries(tables).map(([name, table]) => [name, table.rows.length]))));
} finally {
  await fetch(`${origin}/api/logout`, { method: 'POST', headers: { Cookie: cookie, Origin: origin } });
}
