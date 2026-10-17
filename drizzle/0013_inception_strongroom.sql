CREATE TABLE `inception_sessions` (
	`round_id` text PRIMARY KEY NOT NULL,
	`state` text NOT NULL,
	`start_key_hash` text NOT NULL,
	`actor_key_hash` text NOT NULL,
	`actor_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`round_id`) REFERENCES `rounds`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`actor_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `inception_sessions_actor_key_hash_unique` ON `inception_sessions` (`actor_key_hash`);
CREATE INDEX `inception_sessions_actor_created_idx` ON `inception_sessions` (`actor_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `inception_start_locks` (
	`actor_id` text PRIMARY KEY NOT NULL,
	`serial` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`actor_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);
