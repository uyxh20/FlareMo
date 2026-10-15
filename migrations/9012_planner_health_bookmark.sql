-- migrations/9012_planner_health_bookmark.sql: fork-owned, hand-written. Never edit once applied (add 9013_planner_...).
--
-- A saved bookmark for the health projection (docs/fork-health-tracker.md, "Sync"):
-- a read of the diary that is cut off (CPU or wall limit, a deploy) carries on
-- from where it stopped instead of being lost or starting over.
-- Same rules as 9010: not in migrations/meta/_journal.json, no foreign key, no
-- triggers, additive only.
--
-- Safe for the previous release: three nullable columns on a fork table. The old
-- code writes only user_id, scanned_at and memo_count, which leaves the new ones
-- NULL, and NULL means "no read in progress", which is what the old code assumes.

-- JSON [created_at, id] of the last memo a full read has finished, '' while a
-- full read waits to start, NULL when no full read is in progress.
ALTER TABLE `health_sync_state` ADD `scan_cursor` text;
-- When the run doing the full read took it; a claim older than a few minutes is
-- a run that died, and the next caller takes over.
ALTER TABLE `health_sync_state` ADD `scan_claimed_at` text;
-- JSON [updated_at, id] of the last changed memo the nightly read has finished.
ALTER TABLE `health_sync_state` ADD `sweep_cursor` text;
