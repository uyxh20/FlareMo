CREATE TABLE `memo_hourly_counts` (
	`user_id` text NOT NULL,
	`utc_hour` text NOT NULL,
	`normal_count` integer DEFAULT 0 NOT NULL,
	`archived_count` integer DEFAULT 0 NOT NULL,
	`trashed_count` integer DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `utc_hour`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
-- Backfill the derived counter for existing installs.
--
-- Without this the workspace sidebar would read zero memos until the first
-- nightly recalibration ran, which is a user-visible regression on every
-- upgrade. The incremental write path only fires on new writes, so the
-- starting state has to be seeded here.
--
-- `updated_at` is stamped with `strftime` rather than `datetime('now')` on
-- purpose: the nightly recalibration sweeps rows whose stamp sorts before its
-- own ISO-8601 `now`, and SQLite's 'YYYY-MM-DD HH:MM:SS' would compare as
-- smaller than 'YYYY-MM-DDTHH:MM:SS.mmmZ' (space < 'T'), so a `datetime()`
-- stamp would make every backfilled row look like a stale tombstone and be
-- deleted by the very next rebuild. `strftime('%Y-%m-%dT%H:%M:%fZ','now')`
-- produces the same shape `Date#toISOString` does.
--
-- Rows that would hold only zeroes are omitted, matching what the incremental
-- path and the recalibration both treat as an absent bucket. This is additive
-- and reads only `memos`, so it is safe to run against a live database.
INSERT INTO `memo_hourly_counts` (
	`user_id`,
	`utc_hour`,
	`normal_count`,
	`archived_count`,
	`trashed_count`,
	`updated_at`
)
SELECT
	`user_id`,
	substr(`created_at`, 1, 13),
	sum(CASE WHEN `status` = 'normal' THEN 1 ELSE 0 END),
	sum(CASE WHEN `status` = 'archived' THEN 1 ELSE 0 END),
	sum(CASE WHEN `status` = 'trashed' THEN 1 ELSE 0 END),
	strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM `memos`
WHERE `created_at` IS NOT NULL
GROUP BY `user_id`, substr(`created_at`, 1, 13)
HAVING
	sum(CASE WHEN `status` = 'normal' THEN 1 ELSE 0 END) > 0
	OR sum(CASE WHEN `status` = 'archived' THEN 1 ELSE 0 END) > 0
	OR sum(CASE WHEN `status` = 'trashed' THEN 1 ELSE 0 END) > 0;
