import { readFileSync, readdirSync } from 'node:fs';
import { createWorkshop } from '../server/workshop.mjs';
import { openStore } from '../server/store.mjs';
import { postgresStore } from '../server/postgres-store.mjs';

export async function createFixture(options) {
  const { wrapStore, store: injectedStore, adapter = 'auto', ...workshopOptions } = options;
  let store = injectedStore;
  const postgresFixture = adapter === 'pglite' || (adapter === 'auto' && process.env.TEST_DATABASE === 'postgres');
  if (!store && postgresFixture) {
    const { PGlite } = await import('@electric-sql/pglite');
    const db = new PGlite();
    for (const name of readdirSync(new URL('../db/postgres/', import.meta.url)).filter(name => name.endsWith('.sql')).sort()) {
      await db.exec(readFileSync(new URL(`../db/postgres/${name}`, import.meta.url), 'utf8'));
    }
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
  } else if (!store) {
    store = openStore(options.dbPath || ':memory:');
  }
  store = wrapStore ? wrapStore(store) : store;
  return createWorkshop({ passportScenarioRotation: false, ...workshopOptions, store });
}
