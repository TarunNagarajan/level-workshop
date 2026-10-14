import { readFileSync } from 'node:fs';
import { createWorkshop } from '../server/workshop.mjs';
import { openStore } from '../server/store.mjs';
import { postgresStore } from '../server/postgres-store.mjs';

export async function createFixture(options) {
  let store;
  if (process.env.TEST_DATABASE === 'postgres') {
    const { PGlite } = await import('@electric-sql/pglite');
    const db = new PGlite();
    await db.exec(readFileSync(new URL('../db/postgres/0001.sql', import.meta.url), 'utf8'));
    await db.exec(readFileSync(new URL('../db/postgres/0002.sql', import.meta.url), 'utf8'));
    await db.exec(readFileSync(new URL('../db/postgres/0003.sql', import.meta.url), 'utf8'));
    await db.exec(readFileSync(new URL('../db/postgres/0004.sql', import.meta.url), 'utf8'));
    await db.exec(readFileSync(new URL('../db/postgres/0005.sql', import.meta.url), 'utf8'));
    const result = value => ({ ...value, rowCount: value.affectedRows });
    // Neon queries are lazy. Transaction queries must not execute before BEGIN.
    const sql = {
      query(text, args) {
        return { text, args, then(resolve, reject) { return db.query(text, args).then(result).then(resolve, reject); } };
      },
      transaction(queries) {
        return db.transaction(async tx => {
          const results = [];
          for (const { text, args } of queries) results.push(result(await tx.query(text, args)));
          return results;
        });
      },
    };
    store = { ...postgresStore(sql), db };
  } else {
    store = openStore(':memory:');
  }
  return createWorkshop({ ...options, store });
}
