CREATE TABLE `round_machine_reviews` (
	`round_id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`attempts` integer NOT NULL,
	`run_id` text,
	`started_at` integer,
	`completed_at` integer,
	`verdict` text,
	`reason` text,
	`evidence` text,
	`error_code` text,
	FOREIGN KEY (`round_id`) REFERENCES `rounds`(`id`) ON UPDATE no action ON DELETE restrict
);
