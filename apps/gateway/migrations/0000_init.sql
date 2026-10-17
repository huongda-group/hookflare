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
CREATE TABLE `audit_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_email` text NOT NULL,
	`action` text NOT NULL,
	`resource_type` text NOT NULL,
	`resource_id` text,
	`reason` text,
	`diff_json` text,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_logs_at_idx` ON `audit_logs` (`at`);--> statement-breakpoint
CREATE INDEX `audit_logs_resource_idx` ON `audit_logs` (`resource_type`,`resource_id`,`at`);--> statement-breakpoint
CREATE INDEX `audit_logs_actor_idx` ON `audit_logs` (`actor_email`,`at`);--> statement-breakpoint
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
	CONSTRAINT "backups_status_check" CHECK("status" IN ('running', 'verified', 'failed', 'expiring'))
);
--> statement-breakpoint
CREATE INDEX `backups_status_idx` ON `backups` (`status`);--> statement-breakpoint
CREATE INDEX `backups_started_at_idx` ON `backups` (`started_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `backups_one_running_idx` ON `backups` (`status`) WHERE status = 'running';--> statement-breakpoint
CREATE TABLE `deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`destination_id` text NOT NULL,
	`project_id` text NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`enqueued_at` integer,
	`next_attempt_at` integer,
	`lease_until` integer,
	`last_http_status` integer,
	`last_error` text,
	`completed_at` integer,
	`created_by` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `webhook_events`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`destination_id`) REFERENCES `destinations`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "deliveries_kind_check" CHECK("kind" IN ('initial', 'replay', 'test')),
	CONSTRAINT "deliveries_status_check" CHECK("status" IN ('pending', 'queued', 'in_flight', 'retrying', 'paused', 'delivered', 'failed_final', 'dead'))
);
--> statement-breakpoint
CREATE INDEX `deliveries_event_idx` ON `deliveries` (`event_id`);--> statement-breakpoint
CREATE INDEX `deliveries_destination_created_idx` ON `deliveries` (`destination_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `deliveries_status_next_attempt_idx` ON `deliveries` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `deliveries_status_enqueued_idx` ON `deliveries` (`status`,`enqueued_at`);--> statement-breakpoint
CREATE INDEX `deliveries_status_completed_idx` ON `deliveries` (`status`,`completed_at`);--> statement-breakpoint
CREATE TABLE `delivery_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`delivery_id` text NOT NULL,
	`attempt_no` integer NOT NULL,
	`started_at` integer NOT NULL,
	`duration_ms` integer NOT NULL,
	`http_status` integer,
	`error_kind` text,
	`error_message` text,
	`response_snippet` text,
	FOREIGN KEY (`delivery_id`) REFERENCES `deliveries`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "delivery_attempts_error_kind_check" CHECK("error_kind" IS NULL OR "error_kind" IN ('http_3xx', 'http_4xx', 'http_5xx', 'timeout', 'network'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `delivery_attempts_delivery_attempt_uq` ON `delivery_attempts` (`delivery_id`,`attempt_no`);--> statement-breakpoint
CREATE INDEX `delivery_attempts_started_idx` ON `delivery_attempts` (`started_at`);--> statement-breakpoint
CREATE TABLE `destinations` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`url` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`signing_secret_enc` text NOT NULL,
	`signing_secret_prev_enc` text,
	`signing_secret_prev_expires_at` integer,
	`timeout_ms` integer,
	`max_attempts` integer,
	`backoff_base_s` integer,
	`backoff_max_s` integer,
	`max_in_flight` integer,
	`rate_limit_per_s` integer,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "destinations_status_check" CHECK("status" IN ('active', 'paused', 'disabled'))
);
--> statement-breakpoint
CREATE INDEX `destinations_consecutive_failures_idx` ON `destinations` (`consecutive_failures`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "projects_status_check" CHECK("status" IN ('active', 'disabled'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_slug_unique` ON `projects` (`slug`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value_json` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sources` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`destination_id` text NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`auth_type` text NOT NULL,
	`auth_config` text NOT NULL,
	`secret_enc` text,
	`secret_prev_enc` text,
	`secret_prev_expires_at` integer,
	`event_id_from` text DEFAULT 'none' NOT NULL,
	`event_id_selector` text,
	`max_body_bytes` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`destination_id`) REFERENCES `destinations`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "sources_status_check" CHECK("status" IN ('active', 'disabled')),
	CONSTRAINT "sources_auth_type_check" CHECK("auth_type" IN ('none', 'hmac', 'token')),
	CONSTRAINT "sources_event_id_from_check" CHECK("event_id_from" IN ('none', 'header', 'json_path')),
	CONSTRAINT "sources_secret_check" CHECK(("auth_type" = 'none') = ("secret_enc" IS NULL)),
	CONSTRAINT "sources_event_id_check" CHECK(("event_id_from" = 'none') = ("event_id_selector" IS NULL))
);
--> statement-breakpoint
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
CREATE TABLE `test_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`destination_id` text NOT NULL,
	`project_id` text NOT NULL,
	`actor_email` text NOT NULL,
	`started_at` integer NOT NULL,
	`duration_ms` integer NOT NULL,
	`http_status` integer,
	`error_kind` text,
	`error_message` text,
	`response_snippet` text,
	FOREIGN KEY (`destination_id`) REFERENCES `destinations`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "test_deliveries_error_kind_check" CHECK("error_kind" IS NULL OR "error_kind" IN ('http_3xx', 'http_4xx', 'http_5xx', 'timeout', 'network', 'ssrf_blocked'))
);
--> statement-breakpoint
CREATE INDEX `test_deliveries_destination_started_idx` ON `test_deliveries` (`destination_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `users` (
	`email` text PRIMARY KEY NOT NULL,
	`role` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`disabled_at` integer,
	CONSTRAINT "users_role_check" CHECK("role" IN ('admin', 'operator', 'viewer'))
);
--> statement-breakpoint
CREATE TABLE `webhook_events` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`source_id` text NOT NULL,
	`provider_event_id` text,
	`received_at` integer NOT NULL,
	`headers_json` text NOT NULL,
	`content_type` text,
	`size_bytes` integer NOT NULL,
	`payload_sha256` text NOT NULL,
	`body_inline` blob NOT NULL,
	`r2_key` text,
	`archive_batch_id` text,
	`archive_part` integer,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `webhook_events_source_received_idx` ON `webhook_events` (`source_id`,`received_at`);--> statement-breakpoint
CREATE INDEX `webhook_events_project_received_idx` ON `webhook_events` (`project_id`,`received_at`);--> statement-breakpoint
CREATE INDEX `webhook_events_received_idx` ON `webhook_events` (`received_at`);--> statement-breakpoint
CREATE INDEX `webhook_events_archive_mark_idx` ON `webhook_events` (`archive_batch_id`,`archive_part`);--> statement-breakpoint
CREATE UNIQUE INDEX `webhook_events_source_provider_uq` ON `webhook_events` (`source_id`,`provider_event_id`) WHERE provider_event_id IS NOT NULL;