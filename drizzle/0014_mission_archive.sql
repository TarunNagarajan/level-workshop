CREATE TABLE `mission_sessions` (
	`round_id` text PRIMARY KEY NOT NULL,
	`state` text NOT NULL,
	FOREIGN KEY (`round_id`) REFERENCES `rounds`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE `mission_start_keys` (
	`actor_id` text NOT NULL,
	`start_key_hash` text NOT NULL,
	`round_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`actor_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`round_id`) REFERENCES `rounds`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mission_start_keys_round_id_unique` ON `mission_start_keys` (`round_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `mission_start_keys_actor_key_unique` ON `mission_start_keys` (`actor_id`,`start_key_hash`);--> statement-breakpoint
CREATE TABLE `mission_start_locks` (
	`actor_id` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`actor_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
