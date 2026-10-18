-- migrations/9014_planner_agent.sql: fork-owned, hand-written. Never edit once applied (add 9015_planner_...).
--
-- The general agent (docs/fork-general-agent.md): one Claude Managed Agent that reads
-- the whole record over its own read-only MCP and writes only proposals. Three tables:
-- each agent session it ran and what it cost (the monthly cap is summed from here),
-- the goals and tasks it proposed for a week (the review's Look forward shows them),
-- and the Ask chat (the owner's questions and the agent's answers). Memory proposals
-- need no table: they are inferred memories waiting on the Memory page. Hand-written
-- and not listed in migrations/meta/_journal.json, like 9000 to 9013: never run
-- pnpm db:generate for these (G3, the fork exception to AGENTS.md). Wrangler orders
-- migration files by leading number, so this one is applied after 9013.
--
-- Rules for this file, the same as for every 9NNN_planner_ file:
--   G10  no foreign key to an upstream table (planner-internal keys are fine)
--   G11  no triggers
--   G12  never edit a file once it is applied to a real database (dev or live)
--   G13  additive only: never rebuild a planner table here
--
-- Safe for the previous release: only new tables, nothing old reads them.

-- One row per agent session. `job` is what it was started for and `owner_key` which
-- review or chat it belongs to ("week:2026-10-12", "month:2026-10-01",
-- "ask:<conversation>"). `step` is the last step sent, `step_input` what that step
-- needs again when its answer is read (the plan a goal check checks) and
-- `step_done_at` when its answer was read. Money is in US cents at list price:
-- `budget_cents` is the session's hard cap, `cost_cents` the last cost read from it.
-- A row is `open` until the session is deleted.
CREATE TABLE `planner_agent_run` (
  `id` text PRIMARY KEY NOT NULL,                  -- a random UUID
  `user_id` text NOT NULL,
  `job` text NOT NULL,                             -- review | period | ask
  `owner_key` text NOT NULL,
  `session_id` text,                               -- sesn_..., NULL until the session exists
  `state` text NOT NULL DEFAULT 'open',            -- open | ended | failed
  `started_by` text NOT NULL DEFAULT 'owner',      -- owner | schedule
  `step` text,                                     -- opening | coach | close | memo | propose | check | ask
  `step_input` text,                               -- JSON, or NULL
  `step_at` text,
  `step_done_at` text,
  `budget_cents` integer NOT NULL,
  `cost_cents` integer NOT NULL DEFAULT 0,
  `error` text,                                    -- a short reason, never content
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  `ended_at` text
);
--> statement-breakpoint
CREATE INDEX `planner_agent_run_user_key_idx` ON `planner_agent_run` (`user_id`,`owner_key`,`state`);
--> statement-breakpoint
CREATE INDEX `planner_agent_run_user_created_idx` ON `planner_agent_run` (`user_id`,`created_at`);
--> statement-breakpoint
-- A goal or a task the agent proposes for the week being planned (`week_start`, its
-- Monday). The owner accepts one into the plan or dismisses it; nothing is written to
-- goals or tasks until the plan is saved. `goal_ref` ties a task to a goal: an
-- existing goal's id or a goal proposal's id. `quote` is the owner's words the proposal
-- rests on and `source_id` the diary entry they were found in, word for word
-- (`verified` 1), or NULL when the proposal cites nothing.
CREATE TABLE `planner_agent_proposal` (
  `id` text PRIMARY KEY NOT NULL,                  -- a random UUID
  `user_id` text NOT NULL,
  `run_id` text,                                   -- planner_agent_run.id by value
  `week_start` text NOT NULL,
  `kind` text NOT NULL,                            -- goal | task
  `pillar` text,                                   -- of | work | ai | health, or NULL
  `title` text NOT NULL,
  `lines` text NOT NULL DEFAULT '[]',              -- JSON: a goal's lines
  `goal_ref` text,
  `why` text NOT NULL,
  `quote` text,
  `source_id` text,                                -- upstream memos.id by value, no FK
  `source_day` text,
  `verified` integer NOT NULL DEFAULT 0,
  `state` text NOT NULL DEFAULT 'open',            -- open | accepted | dismissed
  `created_at` text NOT NULL,
  `settled_at` text
);
--> statement-breakpoint
CREATE INDEX `planner_agent_proposal_user_week_idx` ON `planner_agent_proposal` (`user_id`,`week_start`,`state`);
--> statement-breakpoint
-- The Ask chat: one row per message, the owner's question or the agent's answer, in a
-- conversation. A new conversation starts a new agent session.
CREATE TABLE `planner_agent_chat` (
  `id` text PRIMARY KEY NOT NULL,                  -- a random UUID
  `user_id` text NOT NULL,
  `conversation_id` text NOT NULL,
  `role` text NOT NULL,                            -- owner | agent
  `text` text NOT NULL,
  `run_id` text,                                   -- planner_agent_run.id by value
  `created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `planner_agent_chat_user_conversation_idx` ON `planner_agent_chat` (`user_id`,`conversation_id`,`created_at`);
