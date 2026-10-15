ALTER TABLE `metrics_sessions` ADD `event_batch_token` text;--> statement-breakpoint
CREATE INDEX `metrics_model_calls_status_started` ON `metrics_model_calls` (`status`,`started_at`);--> statement-breakpoint
CREATE INDEX `metrics_model_calls_retry_fingerprint` ON `metrics_model_calls` (`request_fingerprint`,`started_at`);