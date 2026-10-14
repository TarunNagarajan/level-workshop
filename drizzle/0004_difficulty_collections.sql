CREATE TABLE `difficulty_annotations` (
	`round_id` text PRIMARY KEY NOT NULL,
	`attempted_strategies` text NOT NULL,
	`observed_failures` text NOT NULL,
	`note` text NOT NULL,
	`reviewer_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`round_id`) REFERENCES `rounds`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reviewer_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `difficulty_collection_assignments` (
	`id` text PRIMARY KEY NOT NULL,
	`collection_id` text NOT NULL,
	`round_id` text NOT NULL,
	`profile_id` text NOT NULL,
	`profile_snapshot` text NOT NULL,
	`source` text NOT NULL,
	`parent_id` text,
	`link_id` text,
	`start_key_hash` text,
	`consent_at` integer,
	`consent_version` text,
	`assigned_at` integer NOT NULL,
	FOREIGN KEY (`collection_id`) REFERENCES `difficulty_collections`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`round_id`) REFERENCES `rounds`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`link_id`) REFERENCES `difficulty_collection_links`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `difficulty_assignments_round_unique` ON `difficulty_collection_assignments` (`round_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `difficulty_assignments_link_key_unique` ON `difficulty_collection_assignments` (`link_id`,`start_key_hash`);--> statement-breakpoint
CREATE INDEX `difficulty_assignments_collection_profile` ON `difficulty_collection_assignments` (`collection_id`,`profile_id`,`assigned_at`);--> statement-breakpoint
CREATE INDEX `difficulty_assignments_collection_cursor` ON `difficulty_collection_assignments` (`collection_id`,`assigned_at`,`id`);--> statement-breakpoint
CREATE TABLE `difficulty_collection_leases` (
	`collection_id` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`expires` integer NOT NULL,
	FOREIGN KEY (`collection_id`) REFERENCES `difficulty_collections`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `difficulty_collection_links` (
	`id` text PRIMARY KEY NOT NULL,
	`collection_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires` integer NOT NULL,
	`revoked` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`collection_id`) REFERENCES `difficulty_collections`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `difficulty_collection_links_token_hash_unique` ON `difficulty_collection_links` (`token_hash`);--> statement-breakpoint
CREATE INDEX `difficulty_collection_links_collection` ON `difficulty_collection_links` (`collection_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `difficulty_collections` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`source_level_id` text NOT NULL,
	`source_version_id` text NOT NULL,
	`snapshot` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_level_id`) REFERENCES `levels`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_version_id`) REFERENCES `versions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `difficulty_collections_owner_created` ON `difficulty_collections` (`owner_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `difficulty_provider_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`collection_id` text NOT NULL,
	`round_id` text NOT NULL,
	`status` text NOT NULL,
	`started_at` integer NOT NULL,
	`completed_at` integer,
	`latency_ms` integer,
	`error_code` text,
	`request_context` text,
	FOREIGN KEY (`collection_id`) REFERENCES `difficulty_collections`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`round_id`) REFERENCES `rounds`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `difficulty_provider_calls_collection` ON `difficulty_provider_calls` (`collection_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `difficulty_provider_calls_round` ON `difficulty_provider_calls` (`round_id`,`started_at`);