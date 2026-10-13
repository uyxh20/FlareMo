-- migrations/9010_planner_health.sql: fork-owned, hand-written. Never edit once applied (add 9011_planner_...).
--
-- The health tracker (docs/fork-health-tracker.md): training sessions, breath work and
-- nights out, read from the diary's own entries. Hand-written and not listed in
-- migrations/meta/_journal.json, like 9000 to 9005: never run pnpm db:generate for these
-- (the fork exception to AGENTS.md). The file name keeps the 9NNN_planner_ shape on
-- purpose: packages/db/src/planner-migrations.ts and the dev tooling only pick up that
-- pattern. Wrangler orders migration files by leading number, so this one is applied after
-- 9005.
--
-- Rules for this file, the same as for every 9NNN_planner_ file:
--   no foreign key to an upstream table (memo_id is a memos.id by value)
--   no triggers
--   never edit a file once it is applied to a real database (dev or live)
--   additive only: never rebuild a table here
--
-- Safe for the previous release: only new tables, nothing old reads them.

-- One row per session or night. `day` is the local day (Europe/Copenhagen) the session
-- happened, or the evening of a night out STARTED. `memo_id` is the diary entry it was
-- read from (memos.id by value, no FK). Rows are never hard-deleted: a signal that
-- disappears sets `deleted_at`, and an owner's x on a label sets `dismissed`, which a
-- re-read of the diary respects. `edited` marks rows the owner fixed by hand, which a
-- re-read leaves alone.
CREATE TABLE `health_entry` (
  `id` text PRIMARY KEY NOT NULL,                  -- a random UUID
  `user_id` text NOT NULL,
  `kind` text NOT NULL,                            -- training | breath | night_out
  `day` text NOT NULL,                             -- YYYY-MM-DD, local
  `variant` text,                                  -- training: crossfit | push | ... | gym; breath: wim_hof | meditation
  `minutes` integer,                               -- breath (and timed cardio)
  `home_at` text,                                  -- night_out: HH:MM
  `units` real,                                    -- night_out: 0, 0.5 or 1; NULL while it needs a check
  `bender` integer NOT NULL DEFAULT 0,
  `needs_check` integer NOT NULL DEFAULT 0,
  `feel` text,
  `source` text NOT NULL,                          -- memo | manual | import
  `memo_id` text,                                  -- no FK
  `dismissed` integer NOT NULL DEFAULT 0,
  `edited` integer NOT NULL DEFAULT 0,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  `deleted_at` text
);
--> statement-breakpoint
CREATE INDEX `health_entry_user_day_idx` ON `health_entry` (`user_id`,`day`);
--> statement-breakpoint
CREATE INDEX `health_entry_user_memo_idx` ON `health_entry` (`user_id`,`memo_id`);
--> statement-breakpoint
-- A memo yields at most one row per kind, so a re-read (or two at once) can never
-- double a session.
CREATE UNIQUE INDEX `health_entry_memo_kind_uq` ON `health_entry` (`memo_id`,`kind`) WHERE `memo_id` IS NOT NULL;
--> statement-breakpoint
-- Append-only history of every write to health_entry, written in the same batch as the
-- write. Never deleted. `entry_id` has no FK so the history outlives anything.
CREATE TABLE `health_entry_event` (
  `id` text PRIMARY KEY NOT NULL,
  `entry_id` text NOT NULL,
  `user_id` text NOT NULL,
  `action` text NOT NULL,                          -- create | update | dismiss | delete | restore
  `before_json` text,
  `after_json` text,
  `at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `health_entry_event_entry_idx` ON `health_entry_event` (`entry_id`,`at`);
--> statement-breakpoint
-- The owner's targets. A missing row means the default (training 3 a week, breath 7
-- days a week, night out 12 units a year).
CREATE TABLE `health_target` (
  `user_id` text NOT NULL,
  `kind` text NOT NULL,
  `period` text NOT NULL,                          -- week | year
  `amount` real NOT NULL,
  `updated_at` text NOT NULL,
  PRIMARY KEY (`user_id`, `kind`, `period`)
);
--> statement-breakpoint
-- Bookkeeping for the first read of the diary: a user with no row has not been scanned
-- yet, and the first call to the health API scans everything once.
CREATE TABLE `health_sync_state` (
  `user_id` text PRIMARY KEY NOT NULL,
  `scanned_at` text NOT NULL,
  `memo_count` integer NOT NULL DEFAULT 0
);
