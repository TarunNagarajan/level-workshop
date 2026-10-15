PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_passport_scenario_counter` (
	`id` integer PRIMARY KEY NOT NULL,
	`value` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_passport_scenario_counter`("id", "value") SELECT "id", "value" FROM `passport_scenario_counter`;--> statement-breakpoint
DROP TABLE `passport_scenario_counter`;--> statement-breakpoint
ALTER TABLE `__new_passport_scenario_counter` RENAME TO `passport_scenario_counter`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
ALTER TABLE `round_machine_reviews` ADD `reviewer_protocol` text;