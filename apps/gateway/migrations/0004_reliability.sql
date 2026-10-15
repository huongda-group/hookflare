DROP INDEX `webhook_events_source_provider_idx`;--> statement-breakpoint
ALTER TABLE `webhook_events` ADD `r2_key` text;--> statement-breakpoint
CREATE UNIQUE INDEX `webhook_events_source_provider_uq` ON `webhook_events` (`source_id`,`provider_event_id`) WHERE provider_event_id IS NOT NULL;--> statement-breakpoint
ALTER TABLE `deliveries` ADD `next_attempt_at` integer;--> statement-breakpoint
ALTER TABLE `deliveries` ADD `lease_until` integer;--> statement-breakpoint
CREATE INDEX `deliveries_status_next_attempt_idx` ON `deliveries` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `deliveries_status_enqueued_idx` ON `deliveries` (`status`,`enqueued_at`);--> statement-breakpoint
ALTER TABLE `destinations` ADD `max_attempts` integer;--> statement-breakpoint
ALTER TABLE `destinations` ADD `backoff_base_s` integer;--> statement-breakpoint
ALTER TABLE `destinations` ADD `backoff_max_s` integer;