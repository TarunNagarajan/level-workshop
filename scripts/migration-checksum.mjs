import { createHash } from 'node:crypto';

export const normalizeMigrationSql = source => source.replace(/\r\n?/g, '\n');

export const migrationChecksum = source => createHash('sha256').update(normalizeMigrationSql(source)).digest('hex');

export const migrationChecksumVariants = source => {
  const normalized = normalizeMigrationSql(source);
  return new Set([
    createHash('sha256').update(source).digest('hex'),
    createHash('sha256').update(normalized).digest('hex'),
    createHash('sha256').update(normalized.replace(/\n/g, '\r\n')).digest('hex'),
  ]);
};
