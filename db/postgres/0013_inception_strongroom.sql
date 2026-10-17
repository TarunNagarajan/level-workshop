CREATE TABLE inception_sessions (
  round_id TEXT PRIMARY KEY REFERENCES rounds(id) ON DELETE RESTRICT,
  state TEXT NOT NULL,
  start_key_hash TEXT NOT NULL,
  actor_key_hash TEXT NOT NULL UNIQUE,
  actor_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at BIGINT NOT NULL
);
CREATE TABLE inception_start_locks (
  actor_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
  serial INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX inception_sessions_actor_created_idx ON inception_sessions(actor_id, created_at);
