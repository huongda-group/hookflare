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
ALTER TABLE `destinations` ADD `signing_secret_prev_enc` text;--> statement-breakpoint
ALTER TABLE `destinations` ADD `signing_secret_prev_expires_at` integer;--> statement-breakpoint
ALTER TABLE `sources` ADD `secret_prev_enc` text;--> statement-breakpoint
ALTER TABLE `sources` ADD `secret_prev_expires_at` integer;--> statement-breakpoint
CREATE INDEX `deliveries_status_completed_idx` ON `deliveries` (`status`,`completed_at`);