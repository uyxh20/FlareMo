-- migrations/9001_planner_task_details.sql: fork-owned, hand-written. Never edit once applied (add 9002_planner_...).
--
-- The task panel's data (docs/planning-cockpit-implementation-plan.md, section 13):
-- an effort estimate, which lives on the task's plan row, and a comment thread
-- per task. Hand-written and not listed in migrations/meta/_journal.json, like
-- 9000_planner_init.sql: never run pnpm db:generate for these (G3, the fork
-- exception to AGENTS.md). Wrangler orders migration files by leading number, so
-- this one is applied after 9000. Vitest suites apply it with
-- applyPlannerMigrations (packages/db/src/planner-migrations.ts).
--
-- Rules for this file, the same as for every 9NNN_planner_ file:
--   G10  no foreign key to an upstream table (planner-internal keys are fine)
--   G11  no triggers
--   G12  never edit a file once it is applied to a real database (dev or live)
--   G13  additive only: never rebuild a planner table here
--
-- Effort is nullable. A backlog task can get a plan row with a NULL horizon only to
-- hold its effort: the board already reads a NULL horizon as the backlog, so such a
-- row plans nothing.
ALTER TABLE `planner_task_plan` ADD COLUMN `effort` real;
--> statement-breakpoint
-- Comments are soft-deleted (`deleted_at`) and kept after their task is purged,
-- like the history archive, so `task_id` has no foreign key (G10). The body never
-- goes into a history event: events carry only the comment's id.
CREATE TABLE `planner_task_comment` (
  `id` text PRIMARY KEY NOT NULL,                  -- a random UUID, not namespaced
  `user_id` text NOT NULL,
  `task_id` text NOT NULL,                         -- upstream tasks.id, no FK (G10)
  `body` text NOT NULL,                            -- trimmed, 1 to 5000 characters
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  `deleted_at` text
);
--> statement-breakpoint
CREATE INDEX `planner_task_comment_task_idx` ON `planner_task_comment` (`task_id`,`created_at`);
