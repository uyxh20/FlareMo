ALTER TABLE `memory_items` ADD `fact_key` text;--> statement-breakpoint
ALTER TABLE `memory_items` ADD `tags` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `memory_items` ADD `superseded_by_id` text;--> statement-breakpoint
ALTER TABLE `memory_items` ADD `superseded_at` text;--> statement-breakpoint
ALTER TABLE `memory_items` ADD `observed_at` text;--> statement-breakpoint
ALTER TABLE `memory_items` ADD `expires_at` text;--> statement-breakpoint
ALTER TABLE `memory_items` ADD `idempotency_key` text;--> statement-breakpoint
ALTER TABLE `memory_items` ADD `rejected_at` text;--> statement-breakpoint
CREATE UNIQUE INDEX `memory_items_user_fact_key_active_idx` ON `memory_items` (`user_id`, `fact_key`) WHERE status = 'active' AND verification != 'inferred' AND fact_key IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `memory_items_user_idempotency_idx` ON `memory_items` (`user_id`, `idempotency_key`) WHERE idempotency_key IS NOT NULL;--> statement-breakpoint
CREATE INDEX `memory_items_user_scope_fact_key_idx` ON `memory_items` (`user_id`, `scope_type`, `scope_key`, `fact_key`);--> statement-breakpoint
CREATE TABLE `memory_evidence` (
	`id` text PRIMARY KEY NOT NULL,
	`memory_id` text NOT NULL,
	`user_id` text NOT NULL,
	`source_type` text NOT NULL,
	`source_id` text NOT NULL,
	`source_revision` text,
	`relation_type` text DEFAULT 'derived_from' NOT NULL,
	`observed_at` text,
	`excerpt` text,
	`excerpt_hash` text,
	`metadata` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`memory_id`) REFERENCES `memory_items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX `memory_evidence_memory_idx` ON `memory_evidence` (`memory_id`);--> statement-breakpoint
CREATE INDEX `memory_evidence_source_idx` ON `memory_evidence` (`source_type`, `source_id`);--> statement-breakpoint
CREATE INDEX `memory_evidence_user_idx` ON `memory_evidence` (`user_id`);--> statement-breakpoint
CREATE TABLE `memory_events` (
	`id` text PRIMARY KEY NOT NULL,
	`memory_id` text NOT NULL,
	`user_id` text NOT NULL,
	`event_type` text NOT NULL,
	`actor_type` text NOT NULL,
	`actor_name` text,
	`metadata` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`memory_id`) REFERENCES `memory_items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX `memory_events_memory_created_idx` ON `memory_events` (`memory_id`, `created_at`);--> statement-breakpoint
CREATE INDEX `memory_events_user_created_idx` ON `memory_events` (`user_id`, `created_at`);--> statement-breakpoint
CREATE TABLE `memory_rejections` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`scope_type` text NOT NULL,
	`scope_key` text,
	`fact_key` text,
	`rejected_content` text NOT NULL,
	`fingerprint` text NOT NULL,
	`reason` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX `memory_rejections_user_scope_fact_idx` ON `memory_rejections` (`user_id`, `scope_type`, `scope_key`, `fact_key`);--> statement-breakpoint
CREATE INDEX `memory_rejections_user_created_idx` ON `memory_rejections` (`user_id`, `created_at`);
