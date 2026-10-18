CREATE TABLE inception_provider_health (
  provider_id TEXT PRIMARY KEY,
  observed_at BIGINT NOT NULL,
  last_success_at BIGINT,
  blocked_until BIGINT,
  last_error_code TEXT,
  daily_limit BIGINT,
  daily_used BIGINT,
  daily_observed_at BIGINT,
  app_tokens_today BIGINT NOT NULL DEFAULT 0,
  app_usage_day TEXT,
  failed_calls_today BIGINT NOT NULL DEFAULT 0,
  failed_calls_day TEXT,
  app_tokens_after_observation BIGINT NOT NULL DEFAULT 0,
  reserved_tokens BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE inception_provider_reservations (
  reservation_id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  tokens BIGINT NOT NULL,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  round_id TEXT REFERENCES rounds(id) ON DELETE SET NULL
);

CREATE INDEX inception_provider_reservations_expiry ON inception_provider_reservations(expires_at);
CREATE INDEX inception_provider_reservations_round ON inception_provider_reservations(round_id);
