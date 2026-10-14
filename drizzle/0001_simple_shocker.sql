CREATE TABLE `onboarding` (
	`user_id` text PRIMARY KEY NOT NULL,
	`version` integer NOT NULL,
	`result` text NOT NULL,
	`completed_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
