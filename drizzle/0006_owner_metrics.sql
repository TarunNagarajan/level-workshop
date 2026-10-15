CREATE TABLE `metrics_events` (
	`event_id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`user_id` text,
	`tab_id` text NOT NULL,
	`page_id` text NOT NULL,
	`round_id` text,
	`collection_id` text,
	`profile_id` text,
	`source` text,
	`version_id` text,
	`event_kind` text NOT NULL,
	`view_category` text NOT NULL,
	`phase` text,
	`elapsed_ms` integer,
	`active_ms` integer,
	`visible_ms` integer,
	`idle_ms` integer,
	`read_think_ms` integer,
	`compose_ms` integer,
	`waiting_ms` integer,
	`since_reply_ms` integer,
	`request_category` text,
	`request_outcome` text,
	`request_wall_ms` integer,
	`retry_count` integer,
	`interaction` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `metrics_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`round_id`) REFERENCES `rounds`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`collection_id`) REFERENCES `difficulty_collections`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `metrics_events_session_created` ON `metrics_events` (`session_id`,`created_at`,`event_id`);--> statement-breakpoint
CREATE INDEX `metrics_events_created_view` ON `metrics_events` (`created_at`,`view_category`,`event_kind`);--> statement-breakpoint
CREATE INDEX `metrics_events_round_created` ON `metrics_events` (`round_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `metrics_model_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`context_kind` text NOT NULL,
	`round_id` text,
	`orchestration_run_id` text,
	`lane` text,
	`actor_user_id` text,
	`actor_role` text,
	`collection_id` text,
	`profile_id` text,
	`source` text,
	`version_id` text,
	`started_at` integer NOT NULL,
	`completed_at` integer,
	`latency_ms` integer,
	`requested_model` text NOT NULL,
	`returned_model` text,
	`provider_host` text,
	`status` text NOT NULL,
	`error_category` text,
	`input_tokens` integer,
	`output_tokens` integer,
	`total_tokens` integer,
	`response_chars` integer,
	`response_words` integer,
	`retry_of_id` text,
	`request_fingerprint` text NOT NULL,
	`transcript_saved` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`round_id`) REFERENCES `rounds`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`orchestration_run_id`) REFERENCES `orchestration_runs`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`collection_id`) REFERENCES `difficulty_collections`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `metrics_model_calls_started` ON `metrics_model_calls` (`started_at`,`id`);--> statement-breakpoint
CREATE INDEX `metrics_model_calls_round_started` ON `metrics_model_calls` (`round_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `metrics_model_calls_collection_profile` ON `metrics_model_calls` (`collection_id`,`profile_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `metrics_model_calls_run_started` ON `metrics_model_calls` (`orchestration_run_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `metrics_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`user_id` text,
	`created_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`closed_at` integer,
	`event_window_started_at` integer NOT NULL,
	`event_window_count` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `metrics_sessions_token_hash_unique` ON `metrics_sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `metrics_sessions_created` ON `metrics_sessions` (`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `metrics_sessions_user_created` ON `metrics_sessions` (`user_id`,`created_at`);