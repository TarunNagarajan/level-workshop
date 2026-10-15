import { neon } from '@neondatabase/serverless';

// Shared application SQL uses SQLite placeholders. Only unquoted placeholders
// are translated; all user input remains bound parameters.
export function postgresSql(sql) {
  let parameter = 0;
  return sql.replace(/'(?:''|[^'])*'|"(?:""|[^"])*"|\?/g, match => match === '?' ? `$${++parameter}` : match);
}

export function postgresRows(result) {
  const bigints = (result.fields || []).filter(field => field.dataTypeID === 20).map(field => field.name);
  return result.rows.map(row => {
    const value = { ...row };
    for (const name of bigints) {
      if (value[name] == null) continue;
      const number = Number(value[name]);
      if (!Number.isSafeInteger(number)) throw new Error('Database integer exceeds the supported range.');
      value[name] = number;
    }
    return value;
  });
}

export function postgresStore(sql) {
  const query = (text, args) => sql.query(postgresSql(text), args);
  return {
    dialect: 'postgres',
    get: async (text, ...args) => postgresRows(await query(text, args))[0],
    all: async (text, ...args) => postgresRows(await query(text, args)),
    run: async (text, ...args) => ({ changes: (await query(text, args)).rowCount }),
    batch: async statements => (await sql.transaction(statements.map(([text, ...args]) => query(text, args))))
      .map(result => ({ changes: result.rowCount })),
  };
}

export function neonStore(connectionString) {
  if (!connectionString) throw new Error('DATABASE_URL is required.');
  return postgresStore(neon(connectionString, { fullResults: true }));
}
