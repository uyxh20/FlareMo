-- migrations/9018_planner_goal_version.sql: fork-owned, hand-written. Never edit once applied (add 9019_planner_...).
--
-- The goal change log: the words of a goal before and after every change. The
-- flywheel log (planner_event, 9017) keeps sizes and codes only, so a rewrite
-- left no trace of the old words; this table keeps them. It is what lets the
-- agent's goal proposals be undone, and lets the owner see what a goal said
-- last month. Hand-written and not listed in migrations/meta/_journal.json,
-- like 9000 to 9017: never run pnpm db:generate for these (G3).
--
-- Rules for this file, the same as for every 9NNN_planner_ file:
--   G10  no foreign key to an upstream table (planner-internal keys are fine)
--   G11  no triggers
--   G12  never edit a file once it is applied to a real database (dev or live)
--   G13  additive only: never rebuild a planner table here
--
-- Safe for the previous release: one new table that nothing old reads.

-- One row per write to a goal, kept forever and never updated or deleted by
-- code, like planner_task_event: a goal is soft-deleted, and nothing purges
-- goals, so its versions outlive it. `before_json` and `after_json` are the
-- whole goal row (title, lines, note, status, result, pillar, level,
-- period_start, sort_order, deleted_at) as JSON; `before_json` is NULL for a
-- create and `after_json` NULL for a delete.
CREATE TABLE `planner_goal_version` (
  `id` text PRIMARY KEY NOT NULL,                  -- a random UUID
  `user_id` text NOT NULL,
  `goal_id` text NOT NULL,                         -- planner_goal.id by value
  `action` text NOT NULL,                          -- create | update | delete | restore
  `actor` text NOT NULL DEFAULT 'user',            -- user | review | proposal:<id>
  `before_json` text,
  `after_json` text,
  `created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `planner_goal_version_user_goal_idx` ON `planner_goal_version` (`user_id`,`goal_id`,`created_at`);
