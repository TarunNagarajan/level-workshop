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
  failed_calls_day TEXT
);
