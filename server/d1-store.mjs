// D1 owns production data. Each statement is bound separately; batches are atomic.
export function d1Store(db) {
  const statement = (sql, args) => db.prepare(sql).bind(...args);
  return {
    dialect: 'sqlite',
    get: (sql, ...args) => statement(sql, args).first(),
    all: async (sql, ...args) => (await statement(sql, args).all()).results,
    run: async (sql, ...args) => ({ changes: (await statement(sql, args).run()).meta.changes }),
    batch: statements => db.batch(statements.map(([sql, ...args]) => statement(sql, args))),
  };
}
