CREATE TABLE `diary_sessions` (
	`round_id` text PRIMARY KEY NOT NULL,
	`state` text NOT NULL,
	FOREIGN KEY (`round_id`) REFERENCES `rounds`(`id`) ON UPDATE no action ON DELETE restrict
);
