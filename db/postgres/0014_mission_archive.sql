CREATE TABLE mission_sessions (
  round_id TEXT PRIMARY KEY REFERENCES rounds(id) ON DELETE RESTRICT,
  state TEXT NOT NULL
);

CREATE TABLE mission_start_keys (
  actor_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  start_key_hash TEXT NOT NULL,
  round_id TEXT NOT NULL UNIQUE REFERENCES rounds(id) ON DELETE RESTRICT,
  created_at BIGINT NOT NULL,
  PRIMARY KEY(actor_id, start_key_hash)
);

CREATE TABLE mission_start_locks (
  actor_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL,
  expires_at BIGINT NOT NULL
);
