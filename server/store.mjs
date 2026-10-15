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
    CREATE TABLE IF NOT EXISTS user_recording_acknowledgements (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, version TEXT NOT NULL, accepted_at INTEGER NOT NULL, PRIMARY KEY(user_id, version));
    CREATE TABLE IF NOT EXISTS durable_submissions (id TEXT PRIMARY KEY, client_request_id TEXT NOT NULL, scope_key TEXT NOT NULL, round_id TEXT REFERENCES rounds(id) ON DELETE RESTRICT, orchestration_run_id TEXT REFERENCES orchestration_runs(id) ON DELETE RESTRICT, lane TEXT, actor_id TEXT REFERENCES users(id) ON DELETE SET NULL, source TEXT, version_id TEXT, collection_id TEXT, profile_id TEXT, scenario_id TEXT, content TEXT NOT NULL, desk_context TEXT, presented TEXT, created_at INTEGER NOT NULL, started_at INTEGER, completed_at INTEGER, status TEXT NOT NULL CHECK(status IN ('accepted','running','succeeded','failed','interrupted','rejected')), error_code TEXT, reply TEXT, reply_id TEXT, transcript_saved INTEGER NOT NULL DEFAULT 0, CHECK((round_id IS NOT NULL AND orchestration_run_id IS NULL) OR (round_id IS NULL AND orchestration_run_id IS NOT NULL)), UNIQUE(scope_key, client_request_id));
    CREATE INDEX IF NOT EXISTS durable_submissions_page ON durable_submissions(created_at DESC, id DESC);
    CREATE TABLE IF NOT EXISTS round_machine_reviews (round_id TEXT PRIMARY KEY REFERENCES rounds(id) ON DELETE RESTRICT, status TEXT NOT NULL, attempts INTEGER NOT NULL, run_id TEXT, started_at INTEGER, completed_at INTEGER, verdict TEXT, reason TEXT, evidence TEXT, error_code TEXT, reviewer_protocol TEXT);
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
    CREATE TABLE IF NOT EXISTS passport_scenario_counter (id INTEGER PRIMARY KEY, value INTEGER NOT NULL DEFAULT 0);
    INSERT INTO passport_scenario_counter (id, value) VALUES (1, 0) ON CONFLICT(id) DO NOTHING;
    CREATE TABLE IF NOT EXISTS diary_sessions (round_id TEXT PRIMARY KEY REFERENCES rounds(id) ON DELETE RESTRICT, state TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS orchestration_configs (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), draft TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS orchestration_versions (id TEXT PRIMARY KEY, config_id TEXT NOT NULL REFERENCES orchestration_configs(id), number INTEGER NOT NULL, data TEXT NOT NULL, note TEXT NOT NULL, author_id TEXT NOT NULL REFERENCES users(id), created_at INTEGER NOT NULL, UNIQUE(config_id, number));
    CREATE TABLE IF NOT EXISTS orchestration_runs (id TEXT PRIMARY KEY, config_id TEXT NOT NULL REFERENCES orchestration_configs(id), author_id TEXT NOT NULL REFERENCES users(id), snapshot TEXT NOT NULL, test_input TEXT NOT NULL, model TEXT NOT NULL, messages TEXT NOT NULL, board TEXT NOT NULL, event_seq INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS orchestration_locks (run_id TEXT PRIMARY KEY REFERENCES orchestration_runs(id), token TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS orchestration_events (run_id TEXT NOT NULL REFERENCES orchestration_runs(id), seq INTEGER NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(run_id, seq));
    CREATE TABLE IF NOT EXISTS orchestration_world_pairs (id TEXT PRIMARY KEY, config_id TEXT NOT NULL REFERENCES orchestration_configs(id), author_id TEXT NOT NULL REFERENCES users(id), source_lane TEXT NOT NULL, target_lane TEXT NOT NULL, source_system_template TEXT NOT NULL, provider_base_url TEXT NOT NULL, observation_mode TEXT NOT NULL DEFAULT 'prompt', created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS orchestration_world_bindings (run_id TEXT PRIMARY KEY REFERENCES orchestration_runs(id), pair_id TEXT NOT NULL REFERENCES orchestration_world_pairs(id), position INTEGER NOT NULL, fact_value TEXT NOT NULL, snapshot_hash TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(pair_id, position));
    CREATE TABLE IF NOT EXISTS difficulty_collections (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), source_level_id TEXT NOT NULL REFERENCES levels(id), source_version_id TEXT NOT NULL REFERENCES versions(id), snapshot TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', revision INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS difficulty_collections_owner_created ON difficulty_collections(owner_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS difficulty_collection_links (id TEXT PRIMARY KEY, collection_id TEXT NOT NULL REFERENCES difficulty_collections(id), token_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, expires INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS difficulty_collection_links_collection ON difficulty_collection_links(collection_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS difficulty_collection_assignments (id TEXT PRIMARY KEY, collection_id TEXT NOT NULL REFERENCES difficulty_collections(id), round_id TEXT NOT NULL UNIQUE REFERENCES rounds(id), profile_id TEXT NOT NULL, profile_snapshot TEXT NOT NULL, source TEXT NOT NULL, parent_id TEXT, link_id TEXT REFERENCES difficulty_collection_links(id), start_key_hash TEXT, consent_at INTEGER, consent_version TEXT, assigned_at INTEGER NOT NULL, question_count INTEGER NOT NULL DEFAULT 0, UNIQUE(link_id, start_key_hash));
    CREATE INDEX IF NOT EXISTS difficulty_assignments_collection_profile ON difficulty_collection_assignments(collection_id, profile_id, assigned_at);
    CREATE INDEX IF NOT EXISTS difficulty_assignments_collection_cursor ON difficulty_collection_assignments(collection_id, assigned_at DESC, id DESC);
    CREATE TABLE IF NOT EXISTS difficulty_collection_leases (collection_id TEXT PRIMARY KEY REFERENCES difficulty_collections(id), token TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS difficulty_provider_calls (id TEXT PRIMARY KEY, collection_id TEXT NOT NULL REFERENCES difficulty_collections(id), round_id TEXT NOT NULL REFERENCES rounds(id), status TEXT NOT NULL, started_at INTEGER NOT NULL, completed_at INTEGER, latency_ms INTEGER, error_code TEXT, request_context TEXT);
    CREATE INDEX IF NOT EXISTS difficulty_provider_calls_collection ON difficulty_provider_calls(collection_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS difficulty_provider_calls_round ON difficulty_provider_calls(round_id, started_at);
    CREATE TABLE IF NOT EXISTS difficulty_annotations (round_id TEXT PRIMARY KEY REFERENCES rounds(id), attempted_strategies TEXT NOT NULL, observed_failures TEXT NOT NULL, note TEXT NOT NULL, reviewer_id TEXT NOT NULL REFERENCES users(id), updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS metrics_sessions (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, user_id TEXT REFERENCES users(id) ON DELETE SET NULL, created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, closed_at INTEGER, event_window_started_at INTEGER NOT NULL, event_window_count INTEGER NOT NULL DEFAULT 0, event_batch_token TEXT);
    CREATE INDEX IF NOT EXISTS metrics_sessions_created ON metrics_sessions(created_at DESC, id);
    CREATE INDEX IF NOT EXISTS metrics_sessions_user_created ON metrics_sessions(user_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS metrics_events (event_id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES metrics_sessions(id) ON DELETE CASCADE, user_id TEXT REFERENCES users(id) ON DELETE SET NULL, tab_id TEXT NOT NULL, page_id TEXT NOT NULL, round_id TEXT REFERENCES rounds(id) ON DELETE SET NULL, collection_id TEXT REFERENCES difficulty_collections(id) ON DELETE SET NULL, profile_id TEXT, source TEXT, version_id TEXT, event_kind TEXT NOT NULL, view_category TEXT NOT NULL, phase TEXT, elapsed_ms INTEGER, active_ms INTEGER, visible_ms INTEGER, idle_ms INTEGER, read_think_ms INTEGER, compose_ms INTEGER, waiting_ms INTEGER, since_reply_ms INTEGER, request_category TEXT, request_outcome TEXT, request_wall_ms INTEGER, retry_count INTEGER, interaction TEXT, created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS metrics_events_session_created ON metrics_events(session_id, created_at, event_id);
    CREATE INDEX IF NOT EXISTS metrics_events_created_view ON metrics_events(created_at, view_category, event_kind);
    CREATE INDEX IF NOT EXISTS metrics_events_round_created ON metrics_events(round_id, created_at);
    CREATE TABLE IF NOT EXISTS metrics_model_calls (id TEXT PRIMARY KEY, context_kind TEXT NOT NULL, round_id TEXT REFERENCES rounds(id) ON DELETE SET NULL, orchestration_run_id TEXT REFERENCES orchestration_runs(id) ON DELETE SET NULL, lane TEXT, actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL, actor_role TEXT, collection_id TEXT REFERENCES difficulty_collections(id) ON DELETE SET NULL, profile_id TEXT, source TEXT, version_id TEXT, started_at INTEGER NOT NULL, completed_at INTEGER, latency_ms INTEGER, requested_model TEXT NOT NULL, returned_model TEXT, provider_host TEXT, status TEXT NOT NULL, error_category TEXT, input_tokens INTEGER, output_tokens INTEGER, total_tokens INTEGER, response_chars INTEGER, response_words INTEGER, retry_of_id TEXT, request_fingerprint TEXT NOT NULL, transcript_saved INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS metrics_model_calls_started ON metrics_model_calls(started_at DESC, id);
    CREATE INDEX IF NOT EXISTS metrics_model_calls_status_started ON metrics_model_calls(status, started_at);
    CREATE INDEX IF NOT EXISTS metrics_model_calls_retry_fingerprint ON metrics_model_calls(request_fingerprint, started_at DESC);
    CREATE INDEX IF NOT EXISTS metrics_model_calls_round_started ON metrics_model_calls(round_id, started_at);
    CREATE INDEX IF NOT EXISTS metrics_model_calls_collection_profile ON metrics_model_calls(collection_id, profile_id, started_at);
    CREATE INDEX IF NOT EXISTS metrics_model_calls_run_started ON metrics_model_calls(orchestration_run_id, started_at);
  `);
  if (!db.prepare('PRAGMA table_info(round_machine_reviews)').all().some(column => column.name === 'reviewer_protocol'))
    db.exec('ALTER TABLE round_machine_reviews ADD COLUMN reviewer_protocol TEXT');
  if (!db.prepare('PRAGMA table_info(orchestration_runs)').all().some(column => column.name === 'event_seq')) {
    db.exec('ALTER TABLE orchestration_runs ADD COLUMN event_seq INTEGER NOT NULL DEFAULT 0');
  }
  if (!db.prepare('PRAGMA table_info(orchestration_world_pairs)').all().some(column => column.name === 'observation_mode')) {
    db.exec("ALTER TABLE orchestration_world_pairs ADD COLUMN observation_mode TEXT NOT NULL DEFAULT 'prompt'");
  }
  if (!db.prepare('PRAGMA table_info(rounds)').all().some(column => column.name === 'recording_accepted_at')) db.exec('ALTER TABLE rounds ADD COLUMN recording_accepted_at INTEGER');
  if (!db.prepare('PRAGMA table_info(rounds)').all().some(column => column.name === 'recording_notice_version')) db.exec('ALTER TABLE rounds ADD COLUMN recording_notice_version TEXT');
  return {
    dialect: 'sqlite',
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
