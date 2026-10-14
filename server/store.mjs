import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openStore(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA foreign_keys=ON;
    PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, password TEXT NOT NULL, role TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS auth (token TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id), expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS invites (id TEXT PRIMARY KEY, token TEXT UNIQUE NOT NULL, role TEXT NOT NULL, expires INTEGER NOT NULL, used INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS levels (id TEXT PRIMARY KEY, owner_id TEXT REFERENCES users(id), draft TEXT NOT NULL, revision INTEGER DEFAULT 1, status TEXT DEFAULT 'draft', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS versions (id TEXT PRIMARY KEY, level_id TEXT REFERENCES levels(id), number INTEGER NOT NULL, data TEXT NOT NULL, note TEXT NOT NULL, author_id TEXT REFERENCES users(id), created_at INTEGER NOT NULL, UNIQUE(level_id, number));
    CREATE TABLE IF NOT EXISTS links (id TEXT PRIMARY KEY, token TEXT UNIQUE NOT NULL, version_id TEXT REFERENCES versions(id), created_at INTEGER NOT NULL, expires INTEGER NOT NULL, revoked INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS rounds (id TEXT PRIMARY KEY, token TEXT NOT NULL, level_id TEXT REFERENCES levels(id), version_id TEXT REFERENCES versions(id), author_id TEXT REFERENCES users(id), source TEXT NOT NULL, data TEXT NOT NULL, config TEXT NOT NULL, tester TEXT NOT NULL, messages TEXT NOT NULL, hints_used INTEGER DEFAULT 0, started_at INTEGER NOT NULL, ended_at INTEGER, answer TEXT, parent_id TEXT, UNIQUE(token));
    CREATE TABLE IF NOT EXISTS reviews (round_id TEXT PRIMARY KEY REFERENCES rounds(id), outcome TEXT NOT NULL, note TEXT NOT NULL, evidence TEXT NOT NULL, reviewer_id TEXT REFERENCES users(id), updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS comments (id TEXT PRIMARY KEY, level_id TEXT REFERENCES levels(id), user_id TEXT REFERENCES users(id), text TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS rounds_level ON rounds(level_id, started_at);
    CREATE UNIQUE INDEX IF NOT EXISTS one_workspace_owner ON users(role) WHERE role = 'admin';
    CREATE TABLE IF NOT EXISTS workshop_links (id TEXT PRIMARY KEY, token TEXT UNIQUE NOT NULL, created_at INTEGER NOT NULL, expires INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS link_sessions (auth_token TEXT PRIMARY KEY REFERENCES auth(token) ON DELETE CASCADE, link_id TEXT NOT NULL REFERENCES workshop_links(id));
    CREATE TABLE IF NOT EXISTS invite_claims (invite_id TEXT PRIMARY KEY REFERENCES invites(id), user_id TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS round_locks (round_id TEXT PRIMARY KEY REFERENCES rounds(id), token TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS onboarding (user_id TEXT PRIMARY KEY REFERENCES users(id), version INTEGER NOT NULL, result TEXT NOT NULL, completed_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS passport_sessions (round_id TEXT PRIMARY KEY REFERENCES rounds(id), state TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS orchestration_configs (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), draft TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS orchestration_versions (id TEXT PRIMARY KEY, config_id TEXT NOT NULL REFERENCES orchestration_configs(id), number INTEGER NOT NULL, data TEXT NOT NULL, note TEXT NOT NULL, author_id TEXT NOT NULL REFERENCES users(id), created_at INTEGER NOT NULL, UNIQUE(config_id, number));
    CREATE TABLE IF NOT EXISTS orchestration_runs (id TEXT PRIMARY KEY, config_id TEXT NOT NULL REFERENCES orchestration_configs(id), author_id TEXT NOT NULL REFERENCES users(id), snapshot TEXT NOT NULL, test_input TEXT NOT NULL, model TEXT NOT NULL, messages TEXT NOT NULL, board TEXT NOT NULL, event_seq INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS orchestration_locks (run_id TEXT PRIMARY KEY REFERENCES orchestration_runs(id), token TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS orchestration_events (run_id TEXT NOT NULL REFERENCES orchestration_runs(id), seq INTEGER NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(run_id, seq));
    CREATE TABLE IF NOT EXISTS orchestration_world_pairs (id TEXT PRIMARY KEY, config_id TEXT NOT NULL REFERENCES orchestration_configs(id), author_id TEXT NOT NULL REFERENCES users(id), source_lane TEXT NOT NULL, target_lane TEXT NOT NULL, source_system_template TEXT NOT NULL, provider_base_url TEXT NOT NULL, observation_mode TEXT NOT NULL DEFAULT 'prompt', created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS orchestration_world_bindings (run_id TEXT PRIMARY KEY REFERENCES orchestration_runs(id), pair_id TEXT NOT NULL REFERENCES orchestration_world_pairs(id), position INTEGER NOT NULL, fact_value TEXT NOT NULL, snapshot_hash TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(pair_id, position));
  `);
  if (!db.prepare('PRAGMA table_info(orchestration_runs)').all().some(column => column.name === 'event_seq')) {
    db.exec('ALTER TABLE orchestration_runs ADD COLUMN event_seq INTEGER NOT NULL DEFAULT 0');
  }
  if (!db.prepare('PRAGMA table_info(orchestration_world_pairs)').all().some(column => column.name === 'observation_mode')) {
    db.exec("ALTER TABLE orchestration_world_pairs ADD COLUMN observation_mode TEXT NOT NULL DEFAULT 'prompt'");
  }
  return {
    db,
    get: (sql, ...args) => db.prepare(sql).get(...args),
    all: (sql, ...args) => db.prepare(sql).all(...args),
    run: (sql, ...args) => db.prepare(sql).run(...args),
    batch(statements) {
      db.exec('BEGIN IMMEDIATE');
      try { const values = statements.map(([sql, ...args]) => db.prepare(sql).run(...args)); db.exec('COMMIT'); return values; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    transaction(fn) {
      db.exec('BEGIN IMMEDIATE');
      try { const value = fn(); db.exec('COMMIT'); return value; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    },
  };
}
