CREATE TABLE `durable_submissions` (
	`id` text PRIMARY KEY NOT NULL,
	`client_request_id` text NOT NULL,
	`scope_key` text NOT NULL,
	`round_id` text,
	`orchestration_run_id` text,
	`lane` text,
	`actor_id` text,
	`source` text,
	`version_id` text,
	`collection_id` text,
	`profile_id` text,
	`scenario_id` text,
	`content` text NOT NULL,
	`desk_context` text,
	`presented` text,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`completed_at` integer,
	`status` text NOT NULL,
	`error_code` text,
	`reply` text,
	`reply_id` text,
	`transcript_saved` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`round_id`) REFERENCES `rounds`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`orchestration_run_id`) REFERENCES `orchestration_runs`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`actor_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `durable_submissions_scope_request_unique` ON `durable_submissions` (`scope_key`,`client_request_id`);--> statement-breakpoint
CREATE INDEX `durable_submissions_page` ON `durable_submissions` (`created_at`,`id`);--> statement-breakpoint
CREATE TABLE `user_recording_acknowledgements` (
	`user_id` text NOT NULL,
	`version` text NOT NULL,
	`accepted_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_recording_acknowledgements_pk` ON `user_recording_acknowledgements` (`user_id`,`version`);--> statement-breakpoint
ALTER TABLE `rounds` ADD `recording_accepted_at` integer;--> statement-breakpoint
ALTER TABLE `rounds` ADD `recording_notice_version` text;
