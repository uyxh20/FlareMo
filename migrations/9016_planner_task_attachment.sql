-- migrations/9016_planner_task_attachment.sql: fork-owned, hand-written. Never edit once applied (add 9017_planner_...).
--
-- Files on cockpit tasks (docs/fork-task-attachments.md): a screenshot, a PDF,
-- an email or any other file dropped on a task's panel. The bytes live in the
-- same R2 bucket as memo attachments, under the `planner/` prefix; this table
-- is the index: which file sits on which task, how big it is and whether it
-- has been read into a proposed comment (phase 2 of the plan). Hand-written
-- and not listed in migrations/meta/_journal.json, like 9000 to 9015: never
-- run pnpm db:generate for these (G3, the fork exception to AGENTS.md).
-- Wrangler orders migration files by leading number, so this one is applied
-- after 9015.
--
-- Rules for this file, the same as for every 9NNN_planner_ file:
--   G10  no foreign key to an upstream table (planner-internal keys are fine)
--   G11  no triggers
--   G12  never edit a file once it is applied to a real database (dev or live)
--   G13  additive only: never rebuild a planner table here
--
-- Safe for the previous release: one new table and one nullable column, which
-- nothing old reads.

-- One row per file. `task_id` is upstream's task id by value: the file outlives
-- nothing, but the table never links to an upstream table (G10). `removed_at`
-- is set when the owner removes the file; the row and the object stay seven
-- days, then the nightly sweep deletes both. `read_state` is `stored` for a
-- file nobody has read, and moves through `pending`, `read`, `skipped`, `failed`
-- and `capped` once reading on drop ships; `action_id` is the proposed comment
-- the read produced (planner_agent_action.id by value).
CREATE TABLE `planner_task_attachment` (
  `id` text PRIMARY KEY NOT NULL,                  -- a random UUID
  `user_id` text NOT NULL,
  `task_id` text NOT NULL,                         -- upstream tasks.id by value, no FK
  `filename` text NOT NULL,                        -- as uploaded, at most 200 characters
  `content_type` text,                             -- the browser's MIME type, or NULL
  `size` integer NOT NULL,                         -- bytes
  `r2_key` text NOT NULL,                          -- planner/<user>/<uuid>/<safe name>
  `etag` text,
  `read_state` text NOT NULL DEFAULT 'stored',     -- stored | pending | read | skipped | failed | capped
  `action_id` text,                                -- planner_agent_action.id by value
  `created_at` text NOT NULL,
  `removed_at` text
);
--> statement-breakpoint
CREATE INDEX `planner_task_attachment_task_idx` ON `planner_task_attachment` (`user_id`,`task_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `planner_task_attachment_removed_idx` ON `planner_task_attachment` (`removed_at`);
--> statement-breakpoint
-- The task's "Store only, don't read these files" switch (phase 2): NULL or 1
-- reads every file dropped on the task, 0 only stores it.
ALTER TABLE `planner_task_plan` ADD COLUMN `files_read` integer;
