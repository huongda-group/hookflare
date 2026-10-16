CREATE TABLE `backups` (
	`id` text PRIMARY KEY NOT NULL,
	`day` text NOT NULL,
	`status` text NOT NULL,
	`prefix` text NOT NULL,
	`part_count` integer DEFAULT 0 NOT NULL,
	`row_counts_json` text DEFAULT '{}' NOT NULL,
	`bytes` integer DEFAULT 0 NOT NULL,
	`instance_id` text NOT NULL,
	`trigger` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`error` text,
	CONSTRAINT "backups_status_check" CHECK("status" IN ('running', 'verified', 'failed'))
);
--> statement-breakpoint
CREATE INDEX `backups_status_idx` ON `backups` (`status`);--> statement-breakpoint
CREATE INDEX `backups_started_at_idx` ON `backups` (`started_at`);