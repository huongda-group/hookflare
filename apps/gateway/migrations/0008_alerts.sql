CREATE TABLE `alert_channels` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`config_enc` text NOT NULL,
	`config_fingerprint` text NOT NULL,
	`chat_id` text,
	`enabled` integer DEFAULT true NOT NULL,
	`rules_json` text DEFAULT '[]' NOT NULL,
	`project_ids_json` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "alert_channels_type_check" CHECK("type" IN ('discord', 'slack', 'telegram'))
);
--> statement-breakpoint
CREATE TABLE `alert_notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`alert_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`kind` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`tries` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`created_at` integer NOT NULL,
	`claimed_at` integer,
	`sent_at` integer,
	FOREIGN KEY (`alert_id`) REFERENCES `alerts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`channel_id`) REFERENCES `alert_channels`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "alert_notifications_kind_check" CHECK("kind" IN ('opened', 'reminder', 'resolved')),
	CONSTRAINT "alert_notifications_status_check" CHECK("status" IN ('pending', 'sending', 'sent', 'failed'))
);
--> statement-breakpoint
CREATE INDEX `alert_notifications_status_created_idx` ON `alert_notifications` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `alert_notifications_alert_idx` ON `alert_notifications` (`alert_id`);--> statement-breakpoint
CREATE TABLE `alerts` (
	`id` text PRIMARY KEY NOT NULL,
	`rule` text NOT NULL,
	`resource_type` text NOT NULL,
	`resource_id` text NOT NULL,
	`project_id` text,
	`status` text NOT NULL,
	`opened_at` integer NOT NULL,
	`last_notified_at` integer,
	`resolved_at` integer,
	`details_json` text DEFAULT '{}' NOT NULL,
	CONSTRAINT "alerts_resource_type_check" CHECK("resource_type" IN ('destination', 'system')),
	CONSTRAINT "alerts_status_check" CHECK("status" IN ('open', 'resolved'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `alerts_open_key_uq` ON `alerts` (`rule`,`resource_type`,`resource_id`) WHERE status = 'open';--> statement-breakpoint
CREATE INDEX `alerts_status_opened_idx` ON `alerts` (`status`,`opened_at`);--> statement-breakpoint
ALTER TABLE `destinations` ADD `consecutive_failures` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `destinations_consecutive_failures_idx` ON `destinations` (`consecutive_failures`);