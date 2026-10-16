CREATE TABLE `stats_hourly` (
	`hour` integer NOT NULL,
	`project_id` text NOT NULL,
	`source_id` text NOT NULL,
	`destination_id` text NOT NULL,
	`received` integer DEFAULT 0 NOT NULL,
	`delivered` integer DEFAULT 0 NOT NULL,
	`failed_final` integer DEFAULT 0 NOT NULL,
	`dead` integer DEFAULT 0 NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`hour`, `project_id`, `source_id`, `destination_id`)
);
--> statement-breakpoint
CREATE INDEX `stats_hourly_project_hour_idx` ON `stats_hourly` (`project_id`,`hour`);--> statement-breakpoint
CREATE INDEX `delivery_attempts_started_idx` ON `delivery_attempts` (`started_at`);--> statement-breakpoint
CREATE INDEX `webhook_events_received_idx` ON `webhook_events` (`received_at`);