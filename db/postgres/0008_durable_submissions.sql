ALTER TABLE rounds ADD COLUMN recording_accepted_at BIGINT;
ALTER TABLE rounds ADD COLUMN recording_notice_version TEXT;

CREATE TABLE user_recording_acknowledgements (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  accepted_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, version)
);

CREATE TABLE durable_submissions (
  id TEXT PRIMARY KEY,
  client_request_id TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  round_id TEXT REFERENCES rounds(id) ON DELETE RESTRICT,
  orchestration_run_id TEXT REFERENCES orchestration_runs(id) ON DELETE RESTRICT,
  lane TEXT,
  actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  source TEXT,
  version_id TEXT,
  collection_id TEXT,
  profile_id TEXT,
  scenario_id TEXT,
  content TEXT NOT NULL,
  desk_context TEXT,
  presented TEXT,
  created_at BIGINT NOT NULL,
  started_at BIGINT,
  completed_at BIGINT,
  status TEXT NOT NULL CHECK (status IN ('accepted','running','succeeded','failed','interrupted','rejected')),
  error_code TEXT,
  reply TEXT,
  reply_id TEXT,
  transcript_saved BIGINT NOT NULL DEFAULT 0,
  CHECK ((round_id IS NOT NULL AND orchestration_run_id IS NULL) OR (round_id IS NULL AND orchestration_run_id IS NOT NULL)),
  UNIQUE (scope_key, client_request_id)
);
CREATE INDEX durable_submissions_page ON durable_submissions(created_at DESC, id DESC);
