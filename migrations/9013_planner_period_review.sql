-- migrations/9013_planner_period_review.sql: fork-owned, hand-written. Never edit once applied (add 9014_planner_...).
--
-- The month, quarter and year reviews (docs/planning-cockpit-period-review.md): one
-- record per reviewed period (the page's progress, the memo, the verdict, the forecast
-- for the next period and how the last one's forecast turned out, the model's draft
-- against the saved memo) and the receipts each review rests on: a claim, the words it
-- rests on, and where those words were found. Hand-written and not listed in
-- migrations/meta/_journal.json, like 9000 to 9012: never run pnpm db:generate for
-- these (G3, the fork exception to AGENTS.md). Wrangler orders migration files by
-- leading number, so this one is applied after 9012.
--
-- Rules for this file, the same as for every 9NNN_planner_ file:
--   G10  no foreign key to an upstream table (planner-internal keys are fine)
--   G11  no triggers
--   G12  never edit a file once it is applied to a real database (dev or live)
--   G13  additive only: never rebuild a planner table here
--
-- Safe for the previous release: only new tables, nothing old reads them.

-- One row per reviewed period. `level` is month, quarter or year and `period_start`
-- the first day of the period (the 1st of the month, of the quarter's first month, or
-- 1 January). `state` is the page's own progress, saved as it goes. `memo_id` is the
-- period's memo (upstream memos.id by value, no FK). `forecast` is the owner's one
-- sentence about the next period; `forecast_grade` is set by the NEXT period's review
-- (held | partly | missed). `draft_memo` is what the model drafted, kept so the
-- rewrite rate (how much of the saved memo is the owner's own) can be read later.
CREATE TABLE `planner_period_review` (
  `user_id` text NOT NULL,
  `level` text NOT NULL,                           -- month | quarter | year
  `period_start` text NOT NULL,                    -- YYYY-MM-DD, the first day
  `state` text NOT NULL DEFAULT '{}',
  `memo_id` text,
  `verdict` text,
  `forecast` text,
  `forecast_grade` text,                           -- held | partly | missed, graded by the next review
  `draft_memo` text,
  `rewrite_rate` real,                             -- 0 to 1: share of saved lines not in the draft
  `week_marks` text NOT NULL DEFAULT '{}',         -- JSON: Monday -> repeat | never (the year walk)
  `done_at` text,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  PRIMARY KEY (`user_id`, `level`, `period_start`)
);
--> statement-breakpoint
-- A receipt: a claim the review makes and the words it rests on. `verified` is 1 when
-- the quote was found word for word in a raw row of the period (a diary entry, a health
-- row's note, a task event's title, a week record), and `source`/`source_id` say where.
-- An unverified receipt is kept and shown as unsourced. Rewritten whole on each save of
-- the period, never edited one by one.
CREATE TABLE `planner_evidence` (
  `id` text PRIMARY KEY NOT NULL,                  -- a random UUID
  `user_id` text NOT NULL,
  `level` text NOT NULL,
  `period_start` text NOT NULL,
  `pillar` text,                                   -- of | work | ai | health, or NULL
  `claim` text NOT NULL,
  `quote` text NOT NULL,
  `source` text,                                   -- memo | health | task_event | week, NULL when unsourced
  `source_id` text,                                -- the memo, row or event id by value, no FK
  `source_day` text,
  `verified` integer NOT NULL DEFAULT 0,
  `created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `planner_evidence_user_period_idx` ON `planner_evidence` (`user_id`,`level`,`period_start`);
