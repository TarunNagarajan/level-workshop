CREATE TABLE round_machine_reviews (
  round_id TEXT PRIMARY KEY REFERENCES rounds(id) ON DELETE RESTRICT,
  status TEXT NOT NULL,
  attempts BIGINT NOT NULL,
  run_id TEXT,
  started_at BIGINT,
  completed_at BIGINT,
  verdict TEXT,
  reason TEXT,
  evidence TEXT,
  error_code TEXT
);
