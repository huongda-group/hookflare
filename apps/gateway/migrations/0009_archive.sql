CREATE TABLE `archive_batches` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`day` text NOT NULL,
	`status` text NOT NULL,
	`with_files` integer NOT NULL,
	`part_count` integer DEFAULT 0 NOT NULL,
	`item_count` integer DEFAULT 0 NOT NULL,
	`bytes` integer DEFAULT 0 NOT NULL,
	`workflow_instance_id` text NOT NULL,
	`error` text,
	`created_at` integer NOT NULL,
	`verified_at` integer,
	`purged_at` integer,
	CONSTRAINT "archive_batches_kind_check" CHECK("kind" IN ('events', 'audit')),
	CONSTRAINT "archive_batches_status_check" CHECK("status" IN ('building', 'verified', 'purged', 'failed', 'expired'))
);
--> statement-breakpoint
CREATE INDEX `archive_batches_status_idx` ON `archive_batches` (`status`);--> statement-breakpoint
CREATE INDEX `archive_batches_day_idx` ON `archive_batches` (`day`);--> statement-breakpoint
CREATE TABLE `archive_parts` (
	`batch_id` text NOT NULL,
	`part_no` integer NOT NULL,
	`r2_key` text,
	`item_count` integer NOT NULL,
	`bytes` integer NOT NULL,
	`sha256` text,
	`first_id` text NOT NULL,
	`last_id` text NOT NULL,
	PRIMARY KEY(`batch_id`, `part_no`),
	FOREIGN KEY (`batch_id`) REFERENCES `archive_batches`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `webhook_events` ADD `archive_batch_id` text;--> statement-breakpoint
ALTER TABLE `webhook_events` ADD `archive_part` integer;--> statement-breakpoint
CREATE INDEX `webhook_events_archive_mark_idx` ON `webhook_events` (`archive_batch_id`,`archive_part`);