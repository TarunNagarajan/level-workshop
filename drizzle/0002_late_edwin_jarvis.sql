CREATE TABLE `orchestration_configs` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`draft` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `orchestration_locks` (
	`run_id` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`expires` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `orchestration_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `orchestration_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`config_id` text NOT NULL,
	`author_id` text NOT NULL,
	`snapshot` text NOT NULL,
	`test_input` text NOT NULL,
	`model` text NOT NULL,
	`messages` text NOT NULL,
	`board` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`config_id`) REFERENCES `orchestration_configs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`author_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `orchestration_runs_config` ON `orchestration_runs` (`config_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `orchestration_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`config_id` text NOT NULL,
	`number` integer NOT NULL,
	`data` text NOT NULL,
	`note` text NOT NULL,
	`author_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`config_id`) REFERENCES `orchestration_configs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`author_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `orchestration_versions_config_id_number_unique` ON `orchestration_versions` (`config_id`,`number`);