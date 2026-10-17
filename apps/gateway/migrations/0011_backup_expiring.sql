PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_backups` (
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
	CONSTRAINT "backups_status_check" CHECK("status" IN ('running', 'verified', 'failed', 'expiring'))
);
--> statement-breakpoint
INSERT INTO `__new_backups`("id", "day", "status", "prefix", "part_count", "row_counts_json", "bytes", "instance_id", "trigger", "started_at", "finished_at", "error") SELECT "id", "day", "status", "prefix", "part_count", "row_counts_json", "bytes", "instance_id", "trigger", "started_at", "finished_at", "error" FROM `backups`;--> statement-breakpoint
DROP TABLE `backups`;--> statement-breakpoint
ALTER TABLE `__new_backups` RENAME TO `backups`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `backups_status_idx` ON `backups` (`status`);--> statement-breakpoint
CREATE INDEX `backups_started_at_idx` ON `backups` (`started_at`);