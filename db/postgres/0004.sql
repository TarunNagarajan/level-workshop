ALTER TABLE orchestration_runs ADD COLUMN event_seq BIGINT NOT NULL DEFAULT 0;
CREATE TABLE orchestration_events (
  run_id TEXT NOT NULL REFERENCES orchestration_runs(id),
  seq BIGINT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (run_id, seq)
);
CREATE TABLE orchestration_world_pairs (
  id TEXT PRIMARY KEY,
  config_id TEXT NOT NULL REFERENCES orchestration_configs(id),
  author_id TEXT NOT NULL REFERENCES users(id),
  source_lane TEXT NOT NULL,
  target_lane TEXT NOT NULL,
  source_system_template TEXT NOT NULL,
  provider_base_url TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE TABLE orchestration_world_bindings (
  run_id TEXT PRIMARY KEY REFERENCES orchestration_runs(id),
  pair_id TEXT NOT NULL REFERENCES orchestration_world_pairs(id),
  position INTEGER NOT NULL,
  fact_value TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  UNIQUE (pair_id, position)
);
