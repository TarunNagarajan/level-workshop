CREATE TABLE `auth` (
	`token` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`expires` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `comments` (
	`id` text PRIMARY KEY NOT NULL,
	`level_id` text,
	`user_id` text,
	`text` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`level_id`) REFERENCES `levels`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `invite_claims` (
	`invite_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	FOREIGN KEY (`invite_id`) REFERENCES `invites`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `invites` (
	`id` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`role` text NOT NULL,
	`expires` integer NOT NULL,
	`used` integer DEFAULT 0
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invites_token_unique` ON `invites` (`token`);--> statement-breakpoint
CREATE TABLE `levels` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text,
	`draft` text NOT NULL,
	`revision` integer DEFAULT 1,
	`status` text DEFAULT 'draft',
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `link_sessions` (
	`auth_token` text PRIMARY KEY NOT NULL,
	`link_id` text NOT NULL,
	FOREIGN KEY (`auth_token`) REFERENCES `auth`(`token`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`link_id`) REFERENCES `workshop_links`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `links` (
	`id` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`version_id` text,
	`created_at` integer NOT NULL,
	`expires` integer NOT NULL,
	`revoked` integer DEFAULT 0,
	FOREIGN KEY (`version_id`) REFERENCES `versions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `links_token_unique` ON `links` (`token`);--> statement-breakpoint
CREATE TABLE `reviews` (
	`round_id` text PRIMARY KEY NOT NULL,
	`outcome` text NOT NULL,
	`note` text NOT NULL,
	`evidence` text NOT NULL,
	`reviewer_id` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`round_id`) REFERENCES `rounds`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reviewer_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `round_locks` (
	`round_id` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`expires` integer NOT NULL,
	FOREIGN KEY (`round_id`) REFERENCES `rounds`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `rounds` (
	`id` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`level_id` text,
	`version_id` text,
	`author_id` text,
	`source` text NOT NULL,
	`data` text NOT NULL,
	`config` text NOT NULL,
	`tester` text NOT NULL,
	`messages` text NOT NULL,
	`hints_used` integer DEFAULT 0,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`answer` text,
	`parent_id` text,
	FOREIGN KEY (`level_id`) REFERENCES `levels`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`version_id`) REFERENCES `versions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`author_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `rounds_level` ON `rounds` (`level_id`,`started_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `rounds_token_unique` ON `rounds` (`token`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`password` text NOT NULL,
	`role` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `one_workspace_owner` ON `users` (`role`) WHERE role = 'admin';--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE TABLE `versions` (
	`id` text PRIMARY KEY NOT NULL,
	`level_id` text,
	`number` integer NOT NULL,
	`data` text NOT NULL,
	`note` text NOT NULL,
	`author_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`level_id`) REFERENCES `levels`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`author_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `versions_level_id_number_unique` ON `versions` (`level_id`,`number`);--> statement-breakpoint
CREATE TABLE `workshop_links` (
	`id` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires` integer NOT NULL,
	`revoked` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workshop_links_token_unique` ON `workshop_links` (`token`);