-- migrations/9011_planner_health_trackers.sql: fork-owned, hand-written. Never edit once applied (add 9012_planner_...).
--
-- Health trackers the owner edits in the app (docs/fork-health-tracker.md, "Trackers"):
-- a new habit (fasting, say) gets its own words and tags without a code change, and the
-- three built-in kinds take extra words and blocked words on top of their fixed reader.
-- Same rules as 9010: hand-written, not in migrations/meta/_journal.json, no foreign key
-- to an upstream table (goal_id is a planner_goal.id by value), no triggers, additive only.
--
-- Safe for the previous release: only new tables, nothing old reads them. Rows a tracker
-- reads go into health_entry with kind `t:<tracker id>`; the column has no CHECK, so the
-- old code simply ignores kinds it does not know.

-- One row per tracker. `kind` is what its health_entry rows carry: `t:<id>` for a
-- tracker the owner made, or the built-in kind (training | breath | night_out), which
-- gets a row only once the owner adds words to it (`builtin` = 1).
-- `words_json` and `blocked_json` are JSON arrays of lower-case words or phrases; a
-- leading # makes an entry a tag. Never hard-deleted: `archived_at` hides a tracker and
-- the next re-read soft-deletes its rows.
CREATE TABLE `health_tracker` (
  `id` text PRIMARY KEY NOT NULL,                  -- a short random id
  `user_id` text NOT NULL,
  `kind` text NOT NULL,                            -- t:<id>, or the built-in kind
  `label` text NOT NULL,
  `color` text NOT NULL,                           -- a palette name (see fork-health.ts)
  `measure` text NOT NULL DEFAULT 'days',          -- days | minutes | hours
  `words_json` text NOT NULL DEFAULT '[]',
  `blocked_json` text NOT NULL DEFAULT '[]',
  `goal_id` text,                                  -- planner_goal.id by value, no FK
  `builtin` integer NOT NULL DEFAULT 0,
  `sort_order` integer NOT NULL DEFAULT 0,
  `archived_at` text,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `health_tracker_user_kind_uq` ON `health_tracker` (`user_id`,`kind`);
--> statement-breakpoint
-- Append-only history of every save of a tracker, written in the same batch. Never
-- deleted; `tracker_id` has no FK so the history outlives anything.
CREATE TABLE `health_tracker_event` (
  `id` text PRIMARY KEY NOT NULL,
  `tracker_id` text NOT NULL,
  `user_id` text NOT NULL,
  `action` text NOT NULL,                          -- create | update | archive | restore
  `before_json` text,
  `after_json` text,
  `at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `health_tracker_event_tracker_idx` ON `health_tracker_event` (`tracker_id`,`at`);
