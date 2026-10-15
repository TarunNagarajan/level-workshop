CREATE TABLE `passport_scenario_counter` (
	`id` integer PRIMARY KEY NOT NULL,
	`value` integer NOT NULL DEFAULT 0
);
--> statement-breakpoint
INSERT INTO `passport_scenario_counter` (`id`, `value`) VALUES (1, 0) ON CONFLICT(`id`) DO NOTHING;
