DROP INDEX IF EXISTS `memory_items_user_fingerprint_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX `memory_items_user_fingerprint_idx` ON `memory_items` (`user_id`,`fingerprint`) WHERE status = 'active';--> statement-breakpoint
ALTER TABLE `memory_evidence` ADD `stale_at` text;--> statement-breakpoint
ALTER TABLE `memory_evidence` ADD `missing_at` text;--> statement-breakpoint
CREATE TABLE `memory_compile_archives` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`agent` text,
	`project_key` text,
	`workspace_key` text,
	`payload` text NOT NULL,
	`character_count` integer NOT NULL,
	`has_overflow` integer NOT NULL,
	`pinned_overflow` integer NOT NULL,
	`included_ids` text DEFAULT '[]' NOT NULL,
	`truncated_ids` text DEFAULT '[]' NOT NULL,
	`excluded_ids` text DEFAULT '[]' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX `memory_compile_archives_user_created_idx` ON `memory_compile_archives` (`user_id`, `created_at`);
