CREATE TABLE IF NOT EXISTS metrics_sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at BIGINT NOT NULL,
  last_seen_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  closed_at BIGINT,
  event_window_started_at BIGINT NOT NULL,
  event_window_count INTEGER NOT NULL DEFAULT 0,
  event_batch_token TEXT
);
CREATE INDEX IF NOT EXISTS metrics_sessions_created ON metrics_sessions(created_at DESC, id);
CREATE INDEX IF NOT EXISTS metrics_sessions_user_created ON metrics_sessions(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS metrics_events (
  event_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES metrics_sessions(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  tab_id TEXT NOT NULL,
  page_id TEXT NOT NULL,
  round_id TEXT REFERENCES rounds(id) ON DELETE SET NULL,
  collection_id TEXT REFERENCES difficulty_collections(id) ON DELETE SET NULL,
  profile_id TEXT,
  source TEXT,
  version_id TEXT,
  event_kind TEXT NOT NULL,
  view_category TEXT NOT NULL,
  phase TEXT,
  elapsed_ms BIGINT,
  active_ms BIGINT,
  visible_ms BIGINT,
  idle_ms BIGINT,
  read_think_ms BIGINT,
  compose_ms BIGINT,
  waiting_ms BIGINT,
  since_reply_ms BIGINT,
  request_category TEXT,
  request_outcome TEXT,
  request_wall_ms BIGINT,
  retry_count INTEGER,
  interaction TEXT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS metrics_events_session_created ON metrics_events(session_id, created_at, event_id);
CREATE INDEX IF NOT EXISTS metrics_events_created_view ON metrics_events(created_at, view_category, event_kind);
CREATE INDEX IF NOT EXISTS metrics_events_round_created ON metrics_events(round_id, created_at);

CREATE TABLE IF NOT EXISTS metrics_model_calls (
  id TEXT PRIMARY KEY,
  context_kind TEXT NOT NULL,
  round_id TEXT REFERENCES rounds(id) ON DELETE SET NULL,
  orchestration_run_id TEXT REFERENCES orchestration_runs(id) ON DELETE SET NULL,
  lane TEXT,
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  actor_role TEXT,
  collection_id TEXT REFERENCES difficulty_collections(id) ON DELETE SET NULL,
  profile_id TEXT,
  source TEXT,
  version_id TEXT,
  started_at BIGINT NOT NULL,
  completed_at BIGINT,
  latency_ms BIGINT,
  requested_model TEXT NOT NULL,
  returned_model TEXT,
  provider_host TEXT,
  status TEXT NOT NULL,
  error_category TEXT,
  input_tokens BIGINT,
  output_tokens BIGINT,
  total_tokens BIGINT,
  response_chars BIGINT,
  response_words BIGINT,
  retry_of_id TEXT,
  request_fingerprint TEXT NOT NULL,
  transcript_saved INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS metrics_model_calls_started ON metrics_model_calls(started_at DESC, id);
CREATE INDEX IF NOT EXISTS metrics_model_calls_status_started ON metrics_model_calls(status, started_at);
CREATE INDEX IF NOT EXISTS metrics_model_calls_retry_fingerprint ON metrics_model_calls(request_fingerprint, started_at DESC);
CREATE INDEX IF NOT EXISTS metrics_model_calls_round_started ON metrics_model_calls(round_id, started_at);
CREATE INDEX IF NOT EXISTS metrics_model_calls_collection_profile ON metrics_model_calls(collection_id, profile_id, started_at);
CREATE INDEX IF NOT EXISTS metrics_model_calls_run_started ON metrics_model_calls(orchestration_run_id, started_at);
