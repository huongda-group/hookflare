CREATE TABLE `deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`destination_id` text NOT NULL,
	`project_id` text NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`enqueued_at` integer,
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
CREATE TABLE `destinations` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`url` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`signing_secret_enc` text NOT NULL,
	`timeout_ms` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "destinations_status_check" CHECK("status" IN ('active', 'paused', 'disabled'))
);
--> statement-breakpoint
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
CREATE TABLE `sources` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`destination_id` text NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`auth_type` text NOT NULL,
	`auth_config` text NOT NULL,
	`secret_enc` text,
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
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `webhook_events_source_received_idx` ON `webhook_events` (`source_id`,`received_at`);--> statement-breakpoint
CREATE INDEX `webhook_events_project_received_idx` ON `webhook_events` (`project_id`,`received_at`);--> statement-breakpoint
CREATE INDEX `webhook_events_source_provider_idx` ON `webhook_events` (`source_id`,`provider_event_id`);