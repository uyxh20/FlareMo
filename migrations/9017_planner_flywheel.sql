-- migrations/9017_planner_flywheel.sql: fork-owned, hand-written. Never edit once applied (add 9018_planner_...).
--
-- The flywheel (docs/fork-flywheel.md): a log of how goals and the weekly
-- review change, a weekly scorecard that compares what the agent proposed with
-- what the owner did on their own, and the owner-approved tuning of the agent
-- that the scorecard is read against. Hand-written and not listed in
-- migrations/meta/_journal.json, like 9000 to 9016: never run pnpm db:generate
-- for these (G3, the fork exception to AGENTS.md). Wrangler orders migration
-- files by leading number, so this one is applied after 9016.
--
-- Rules for this file, the same as for every 9NNN_planner_ file:
--   G10  no foreign key to an upstream table (planner-internal keys are fine)
--   G11  no triggers
--   G12  never edit a file once it is applied to a real database (dev or live)
--   G13  additive only: never rebuild a planner table here
--
-- Safe for the previous release: three new tables and four nullable columns,
-- which nothing old reads.

-- One row per change to a goal, a review step or the tuning, kept forever like
-- planner_task_event. `kind` is what happened ("goal.created",
-- "goal.rewritten", "goal.judged", "review.look_back_saved", ...), `subject`
-- and `subject_id` what it happened to. `origin` is `manual` or `proposal`;
-- `proposal_id` names the agent's proposal when one started it. `data` holds
-- numbers and short codes only (lengths, edit sizes, a level, a result):
-- never the words of a goal, an entry or a note, which stay in their own rows.
CREATE TABLE `planner_event` (
  `id` text PRIMARY KEY NOT NULL,                  -- a random UUID
  `user_id` text NOT NULL,
  `kind` text NOT NULL,
  `subject` text NOT NULL,                         -- goal | review | tuning | scorecard
  `subject_id` text,                               -- the goal id, the review's Monday, the tuning id
  `origin` text NOT NULL DEFAULT 'manual',         -- manual | proposal
  `proposal_id` text,                              -- planner_agent_proposal.id or planner_agent_action.id by value
  `data` text NOT NULL DEFAULT '{}',               -- JSON: numbers and codes, never text
  `occurred_at` text NOT NULL,
  `created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `planner_event_user_occurred_idx` ON `planner_event` (`user_id`,`occurred_at`);
--> statement-breakpoint
CREATE INDEX `planner_event_user_kind_idx` ON `planner_event` (`user_id`,`kind`,`occurred_at`);
--> statement-breakpoint
-- The weekly scorecard, rebuilt every night for the current and the last few
-- weeks from the rows above, the task history, the agent's proposals and the
-- diary's revisions. One row per week, metric and origin (`ai`, `manual`, or
-- `all`). `value` is the share or count shown; `num` and `den` are what it was
-- computed from, so a page can say "too few" instead of a percentage of four.
CREATE TABLE `planner_metric_week` (
  `user_id` text NOT NULL,
  `week_start` text NOT NULL,                      -- the Monday, YYYY-MM-DD
  `metric` text NOT NULL,
  `origin` text NOT NULL,                          -- ai | manual | all
  `value` real,
  `num` integer NOT NULL DEFAULT 0,
  `den` integer NOT NULL DEFAULT 0,
  `computed_at` text NOT NULL,
  PRIMARY KEY (`user_id`, `week_start`, `metric`, `origin`)
);
--> statement-breakpoint
-- The owner's standing instructions to the agent, one row per version. A
-- version is proposed (by the agent from the scorecard and the owner's weekly
-- notes, or written by the owner), then accepted into `active`, or dismissed.
-- Only one version is active at a time; it rides on the first message of every
-- agent session. Four weeks on, the owner judges it against the metric it
-- promised to move: `kept`, or `rolled_back` (the version before it becomes
-- active again as a new row, so the history stays a straight line).
CREATE TABLE `planner_tuning` (
  `id` text PRIMARY KEY NOT NULL,                  -- a random UUID
  `user_id` text NOT NULL,
  `version` integer,                               -- 1, 2, ... once accepted; NULL while proposed
  `instructions` text NOT NULL,                    -- the whole standing instructions
  `why` text NOT NULL DEFAULT '',
  `metric` text,                                   -- the scorecard metric it aims to move
  `baseline` real,                                 -- that metric over the four weeks before
  `state` text NOT NULL DEFAULT 'proposed',        -- proposed | active | kept | rolled_back | dismissed | superseded
  `proposed_by` text NOT NULL DEFAULT 'agent',     -- agent | owner
  `model` text,                                    -- the model that wrote the proposal
  `parent_id` text,                                -- the version active when it was proposed
  `created_at` text NOT NULL,
  `activated_at` text,
  `judged_at` text,
  `settled_at` text
);
--> statement-breakpoint
CREATE INDEX `planner_tuning_user_state_idx` ON `planner_tuning` (`user_id`,`state`);
--> statement-breakpoint
-- What ran each agent session: the agent's version on Anthropic's side, as the
-- session reported it, and the tuning version it was given.
ALTER TABLE `planner_agent_run` ADD COLUMN `agent_version` text;
--> statement-breakpoint
ALTER TABLE `planner_agent_run` ADD COLUMN `tuning_version` integer;
--> statement-breakpoint
-- The owner's answer, in Look back, to "What should the agent do differently?"
ALTER TABLE `planner_week` ADD COLUMN `tuning_note` text;
--> statement-breakpoint
-- Which tuning version was active when the week was reviewed.
ALTER TABLE `planner_week` ADD COLUMN `tuning_version` integer;
