-- migrations/9005_planner_goals_review.sql: fork-owned, hand-written. Never edit once applied (add 9006_planner_...).
--
-- Goals and the weekly review (docs/planning-cockpit-goals-review.md): structured goals
-- from the north star down to a week, one record per reviewed week (scores, the question
-- for the next review, the verdict, the summary memo), the review in progress, and the
-- conflict check's flags. A task serves a goal through `goal_id` on its plan row, like
-- the effort and the start date. Hand-written and not listed in
-- migrations/meta/_journal.json, like 9000 to 9004: never run pnpm db:generate for these
-- (G3, the fork exception to AGENTS.md). Wrangler orders migration files by leading
-- number, so this one is applied after 9004.
--
-- Rules for this file, the same as for every 9NNN_planner_ file:
--   G10  no foreign key to an upstream table (planner-internal keys are fine)
--   G11  no triggers
--   G12  never edit a file once it is applied to a real database (dev or live)
--   G13  additive only: never rebuild a planner table here
--
-- Safe for the previous release: the new column is nullable and nothing old reads the
-- new tables.
ALTER TABLE `planner_task_plan` ADD COLUMN `goal_id` text;
--> statement-breakpoint
-- A goal in the owner's own words, at one level of the cascade. `period_start` is the
-- first day of its period (1 January, the first day of the quarter or the month, or the
-- Monday of the week) and NULL for the north star. `pillar` is one of the four
-- objectives (of, work, ai, health); NULL marks the north star, a period's theme line,
-- or an imported week goal that had no objective. `lines` is a JSON array of
-- {text, note?, struck?} under the title. Soft-deleted, so a task's link and a flag can
-- still name a goal that was removed.
CREATE TABLE `planner_goal` (
  `id` text PRIMARY KEY NOT NULL,                  -- a random UUID, not namespaced
  `user_id` text NOT NULL,
  `level` text NOT NULL,                           -- north_star | year | quarter | month | week
  `period_start` text,                             -- YYYY-MM-DD, NULL for the north star
  `pillar` text,                                   -- of | work | ai | health, or NULL
  `title` text NOT NULL,                           -- may be empty when `lines` holds the goal
  `lines` text NOT NULL DEFAULT '[]',
  `status` text NOT NULL DEFAULT 'active',         -- active | draft | contested | closed
  `note` text,                                     -- why it is contested, or the evidence for its result
  `result` text,                                   -- met | partial | missed, once judged
  `sort_order` integer NOT NULL DEFAULT 0,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  `deleted_at` text
);
--> statement-breakpoint
CREATE INDEX `planner_goal_user_level_idx` ON `planner_goal` (`user_id`,`level`,`period_start`);
--> statement-breakpoint
-- One row per reviewed (or imported) week. Scores are 1 to 5 in half steps; a week
-- with either score NULL is "not scored". `question` is the key question for the next
-- week's review. `memo_id` is the summary memo (upstream memos.id by value, no FK).
CREATE TABLE `planner_week` (
  `user_id` text NOT NULL,
  `week_start` text NOT NULL,                      -- the Monday, YYYY-MM-DD
  `auth` real,
  `ach` real,
  `note` text,
  `question` text,
  `verdict` text,
  `memo_id` text,
  `source` text NOT NULL DEFAULT 'review',         -- review | import
  `reviewed_at` text,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  PRIMARY KEY (`user_id`, `week_start`)
);
--> statement-breakpoint
-- The review of one week while it is in progress: the chat, the answers, the drafts and
-- the plan for the next week, as one JSON document the page saves as it goes. The
-- timestamps say which part is finished. `commit_log` is the server's own record of
-- what saving the plan already did (JSON: each new task's ref and the task it made),
-- so a retried save never creates a task twice; the page never writes it.
CREATE TABLE `planner_review` (
  `user_id` text NOT NULL,
  `week_start` text NOT NULL,                      -- the Monday of the week looked back on
  `state` text NOT NULL DEFAULT '{}',
  `commit_log` text NOT NULL DEFAULT '{}',
  `look_back_done_at` text,
  `look_forward_done_at` text,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  PRIMARY KEY (`user_id`, `week_start`)
);
--> statement-breakpoint
-- What the conflict check flagged when a week was planned, so the next review's
-- "Check goals" can show what is still open. A flag only reports: settling it is the
-- owner's rewrite of a goal or a "keep for now".
CREATE TABLE `planner_goal_flag` (
  `id` text PRIMARY KEY NOT NULL,                  -- a random UUID
  `user_id` text NOT NULL,
  `week_start` text NOT NULL,                      -- the Monday of the week that was planned
  `goal_id` text,                                  -- the week goal it is about, if any
  `pillar` text,
  `with_goal_id` text,                             -- the bigger goal it pulls against, if known
  `with_label` text NOT NULL,                      -- "Q4 · Work", "North star"
  `why` text NOT NULL,
  `state` text NOT NULL DEFAULT 'open',            -- open | kept | rewritten
  `created_at` text NOT NULL,
  `settled_at` text
);
--> statement-breakpoint
CREATE INDEX `planner_goal_flag_user_state_idx` ON `planner_goal_flag` (`user_id`,`state`);
