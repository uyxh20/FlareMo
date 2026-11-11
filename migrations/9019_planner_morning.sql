-- migrations/9019_planner_morning.sql: fork-owned, hand-written. Never edit once applied (add 9020_planner_...).
--
-- The morning page (docs/fork-customizations.md, "Morning page"): the full page shown the first
-- time the owner opens the diary each day, with one idea line written by a
-- model from the owner's last three weeks, their goals, tasks and health
-- counts. Hand-written and not listed in migrations/meta/_journal.json, like
-- 9000 to 9018: never run pnpm db:generate for these (G3).
--
-- Rules for this file, the same as for every 9NNN_planner_ file:
--   G10  no foreign key to an upstream table (planner-internal keys are fine)
--   G11  no triggers
--   G12  never edit a file once it is applied to a real database (dev or live)
--   G13  additive only: never rebuild a planner table here
--
-- Safe for the previous release: two new tables that nothing old reads.

-- Every idea line ever written, kept like planner_task_event: it is flywheel
-- data (which lines the owner kept, which they replaced with "Another").
-- `day` is the owner's local date the line was written for. The line shown for
-- a day is its newest row with `replaced_by` NULL; "Another" writes a new row
-- and points the old one at it. `direction` is `away` (off-plan) or `free`
-- (the model's call). `shown` is 1 once the page drew it; `chosen` is 1 for the
-- line still on screen when the owner pressed "Start the day".
CREATE TABLE `planner_morning_line` (
  `id` text PRIMARY KEY NOT NULL,                  -- a random UUID
  `user_id` text NOT NULL,
  `day` text NOT NULL,                             -- YYYY-MM-DD, the owner's local date
  `text` text NOT NULL,
  `direction` text NOT NULL,                       -- away | free
  `model` text NOT NULL,
  `input_tokens` integer NOT NULL DEFAULT 0,
  `output_tokens` integer NOT NULL DEFAULT 0,
  `shown` integer NOT NULL DEFAULT 0,
  `chosen` integer NOT NULL DEFAULT 0,
  `replaced_by` text,                              -- planner_morning_line.id by value
  `created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `planner_morning_line_user_day_idx` ON `planner_morning_line` (`user_id`,`day`,`created_at`);
--> statement-breakpoint
-- One row per day the morning page was seen. `dismissed_at` is set by "Start
-- the day"; until then the diary opens on the morning page.
CREATE TABLE `planner_morning_day` (
  `user_id` text NOT NULL,
  `day` text NOT NULL,                             -- YYYY-MM-DD, the owner's local date
  `dismissed_at` text,
  `created_at` text NOT NULL,
  PRIMARY KEY (`user_id`, `day`)
);
