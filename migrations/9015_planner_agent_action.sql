-- migrations/9015_planner_agent_action.sql: fork-owned, hand-written. Never edit once applied (add 9016_planner_...).
--
-- The agent proposes into the record (docs/fork-general-agent.md, "Proposing
-- into tasks and the diary"): from a task's own chat or from Ask my diary it
-- proposes one change to one task field, a new task, or a new diary entry.
-- Each proposal waits here until the owner accepts or dismisses it; an accept
-- is what writes the task or the entry, and the History event it writes names
-- the proposal (actor_name "proposal:<id>"), so every agent-drafted change is
-- joinable from the archive to the proposal, its conversation and its session.
-- Hand-written and not listed in migrations/meta/_journal.json, like 9000 to
-- 9014: never run pnpm db:generate for these (G3, the fork exception to
-- AGENTS.md). Wrangler orders migration files by leading number, so this one
-- is applied after 9014.
--
-- Rules for this file, the same as for every 9NNN_planner_ file:
--   G10  no foreign key to an upstream table (planner-internal keys are fine)
--   G11  no triggers
--   G12  never edit a file once it is applied to a real database (dev or live)
--   G13  additive only: never rebuild a planner table here
--
-- Safe for the previous release: one new table and one nullable column, which
-- nothing old reads.

-- One row per proposed action. `kind` says what it is: `task_change` (one
-- field of one task: `task_id`, `field`, and the new value in `change`),
-- `task_new` (a task to add: title, notes, due day, priority, column in
-- `change`) or `entry_new` (a diary entry: its content in `change`). `why` is
-- the agent's reason, shown on the card. `state` moves from `open` to
-- `accepted`, `dismissed` or `expired` (open for seven days), and from
-- `accepted` to `reverted` when the owner reverts the History event it wrote.
-- `landed_id` is the task or entry the accept wrote to, and `before` what the
-- changed field held just before the accept (JSON, the field's old value), so
-- a revert can put it back even when upstream's activity log, which only
-- records new values, never held it. `shown_at` is the first time the owner's
-- page listed it, so "never seen" differs from "ignored".
CREATE TABLE `planner_agent_action` (
  `id` text PRIMARY KEY NOT NULL,                  -- a random UUID
  `user_id` text NOT NULL,
  `run_id` text,                                   -- planner_agent_run.id by value
  `conversation_id` text,                          -- planner_agent_chat.conversation_id by value
  `kind` text NOT NULL,                            -- task_change | task_new | entry_new
  `task_id` text,                                  -- upstream tasks.id by value, no FK
  `field` text,                                    -- title | notes | priority | due_at | effort | start_date | column
  `change` text NOT NULL DEFAULT '{}',             -- JSON: the proposed value(s)
  `why` text NOT NULL DEFAULT '',
  `state` text NOT NULL DEFAULT 'open',            -- open | accepted | dismissed | expired | reverted
  `landed_id` text,                                -- the task or memo id the accept wrote
  `before` text,                                   -- JSON: the field's value before the accept
  `created_at` text NOT NULL,
  `shown_at` text,
  `settled_at` text
);
--> statement-breakpoint
CREATE INDEX `planner_agent_action_user_conversation_idx` ON `planner_agent_action` (`user_id`,`conversation_id`,`state`);
--> statement-breakpoint
CREATE INDEX `planner_agent_action_user_created_idx` ON `planner_agent_action` (`user_id`,`created_at`);
--> statement-breakpoint
-- A conversation held from a task's own chat names the task; the global Ask
-- chat leaves it NULL, so each side lists only its own conversations.
ALTER TABLE `planner_agent_chat` ADD COLUMN `task_id` text;
