# Planning cockpit — implementation plan (v1)

Status: draft for independent audit, 2026-10-04. Executor: Sonnet, after the owner approves. Requirements: `docs/planning-cockpit-requirements.md`.

## 0. Locked decisions

- **Columns by status, like the Notion board**: Backlog · To Do · Doing · Done.
  - Backlog = status `todo` with no plan.
  - To Do = status `todo` with a plan.
  - Doing = `in_progress`.
  - Done = `done`.
  - Dropped (Notion "Archive") is hidden behind a filter.
- **Plan date and due date are separate.**
  - Plan = horizon (`day` | `week` | `month`) plus a period start, stored in planner tables.
  - Due = upstream `tasks.due_at`, unchanged. Overdue reminders keep working off `due_at` only.
- **Weekly and monthly review stays in "Next"**, not v1.
- **Fresh start from Notion**: no importer.
- **Cloudflare only, no new services**: same Worker, same D1 database. No new bindings, crons, queues or secrets.
- **Isolated add-on**: no change to upstream tables, columns or the Drizzle journal. Upstream files are edited only at the hook-in points in section 6.

## 1. Guardrails

Must not:

- **G1** Edit existing files in `packages/db/src/schema/` or anything in `migrations/meta/`.
- **G2** Export planner tables from the `packages/db/src/schema.ts` barrel. drizzle-kit reads that barrel and would fold planner tables into upstream's migration journal.
- **G3** Run `pnpm db:generate`.
- **G4** Add Cloudflare bindings, services, cron triggers, queues or secrets.
- **G5** Change `/api/v1/*`, the Memos-compatible MCP tools, or upstream task behaviour.
- **G6** Add a second auth path. Planner routes use `getRequestContext` (cookie session or PAT), like `tasks-api.ts`.
- **G7** Edit upstream files outside the hook-in list.
- **G8** Run `pnpm verify` or Playwright e2e (AGENTS.md). Write the e2e spec for the new route, but don't run it.
- **G9** Put secrets, cookies or tokens in code, docs, tests or logs.

Must:

- **M1** Change task rows only through upstream domain services: `createTask`, `updateTask`, `deleteTask`, `restoreTask`. Planner code writes only planner tables.
- **M2** Do planner data access with Drizzle in `packages/domain/src/planner/`, never as loose SQL in routes. The trigger DDL in `triggers.ts` is the one exception.
- **M3** Write every planner mutation's event in the same D1 batch as the change.
- **M4** Follow `docs/design-system.md`:
  - text at least 12px and Ember tokens
  - no new gradient CTA
  - optimistic edits with a toast
  - AlertDialog for destructive actions
- **M5** Ship tests in the same commit as the code they cover.
- **M6** Run `pnpm format` before every commit and only targeted vitest files.
- **M7** Commit in small steps straight to `main` (AGENTS.md), only after the owner says go. A push to `main` starts `deploy-cloudflare.yml`, which currently stops at its credentials check.

## 2. Architecture

```
browser / PWA ──HTTPS──▶ Worker
                          ├─ /cockpit (static SPA route)
                          └─ /api/app/planner/*  ──▶ packages/domain/src/planner/*
                                                      ├─ upstream task services (createTask, updateTask…)
                                                      └─ planner tables (Drizzle)
D1 (one database)
  upstream: tasks, projects, task_activity, …      ← unchanged
  planner : planner_goal, planner_task_plan, planner_task_event   ← new, 9000-series migration
  triggers: planner_v1_* on tasks → planner_task_event   ← created at runtime, idempotent
```

### Migration track

Planner tables are created by hand-written SQL files in the same `migrations/` folder, numbered from `9000_` and **not** listed in `migrations/meta/_journal.json`.

- **Production and local**: `wrangler d1 migrations apply` runs every `.sql` file in `migrations_dir` by filename and records each by name. `9000_*` therefore runs after all upstream migrations, and later upstream `00NN_*` files still apply.
- **Tests**: the upstream helper `applyFlaremoMigrations` reads only the journal. Planner tests call a new `applyPlannerMigrations(db)` after `createTestRuntime()`.
- **Statements**: separate them with `--> statement-breakpoint`, as the upstream SQL files do, so the test splitter works.
- **Fallback** if the step-0 spike shows Wrangler refuses unjournaled files: a second Wrangler config that points the same `database_id` at `migrations-planner/` with `migrations_table: "planner_migrations"`, plus one extra apply step in `deploy-cloudflare.yml` (a fork-owned file).

### History capture

SQLite triggers on `tasks` write raw changes into `planner_task_event`. They see every path: cockpit, `/projects`, PAT/API calls, "convert to task" and the 30-day trash purge. Planner code writes the semantic events (planned, re-planned, carried over, dropped) itself.

- **Created at runtime, not in a migration.** `ensurePlannerTriggers(db)` runs `CREATE TRIGGER IF NOT EXISTS` for each trigger, memoised per isolate. Every planner request calls it.
- **Why runtime**: an upstream table rebuild (Drizzle's create-copy-drop-rename for SQLite) drops triggers, and the next planner request restores them. This also avoids relying on Wrangler's SQL splitter for `BEGIN…END` bodies.
- **Guard**: `ensurePlannerTriggers` does nothing unless `planner_task_event` exists. A trigger pointing at a missing table would break upstream task writes.
- **Known gap**: after a deploy that rebuilds `tasks`, edits made in `/projects` before the cockpit's next request are not logged. This is acceptable for v1; record it in the runbook.

## 3. Data model

File: `packages/db/src/schema/planner.ts`, defining `plannerGoal`, `plannerTaskPlan` and `plannerTaskEvent`. It is not exported from the barrel. Import it as `@flaremo/db/src/schema/planner`; `@flaremo/db` has no `exports` map, so deep imports resolve.

SQL: `migrations/9000_planner_init.sql`. Times are ISO strings like upstream's. Dates are `YYYY-MM-DD`.

```sql
CREATE TABLE `planner_goal` (
  `id` text PRIMARY KEY NOT NULL,                 -- "goals/<uuid>"
  `user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE cascade,
  `parent_id` text REFERENCES `planner_goal`(`id`) ON DELETE set null,
  `kind` text NOT NULL,                           -- area | goal | milestone (validated in contracts; text in DB)
  `title` text NOT NULL,
  `notes` text,
  `period_start` text,
  `period_end` text,
  `status` text NOT NULL DEFAULT 'active',        -- active | achieved | archived
  `sort_order` integer NOT NULL DEFAULT 0,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `planner_goal_user_parent_idx` ON `planner_goal` (`user_id`,`parent_id`,`sort_order`);
--> statement-breakpoint
CREATE TABLE `planner_task_plan` (
  `task_id` text PRIMARY KEY NOT NULL REFERENCES `tasks`(`id`) ON DELETE cascade,
  `user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE cascade,
  `horizon` text,                                 -- day | week | month | NULL (backlog)
  `period_start` text,                            -- NULL iff horizon is NULL
  `goal_id` text REFERENCES `planner_goal`(`id`) ON DELETE set null,
  `carry_count` integer NOT NULL DEFAULT 0,
  `dropped_at` text,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `planner_task_plan_user_period_idx` ON `planner_task_plan` (`user_id`,`horizon`,`period_start`);
--> statement-breakpoint
CREATE INDEX `planner_task_plan_goal_idx` ON `planner_task_plan` (`goal_id`);
--> statement-breakpoint
CREATE TABLE `planner_task_event` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE cascade,
  `task_id` text NOT NULL,                        -- no FK: history outlives a purged task
  `task_title` text,                              -- snapshot at event time
  `type` text NOT NULL,
  `data` text NOT NULL DEFAULT '{}',              -- JSON
  `source` text NOT NULL,                         -- 'db' (trigger) | 'planner' (code)
  `actor_type` text,                              -- user | agent | NULL for triggers
  `actor_name` text,
  `created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `planner_task_event_task_idx` ON `planner_task_event` (`task_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `planner_task_event_user_created_idx` ON `planner_task_event` (`user_id`,`created_at`);
```

### Event types

- **From triggers** (`source = 'db'`):
  - `created`
  - `status_changed` `{from,to}`
  - `due_changed` `{from,to}`
  - `renamed` `{from,to}`
  - `project_changed` `{from,to}`
  - `deleted`
  - `restored`
  - `purged`
- **From planner code** (`source = 'planner'`):
  - `planned` `{horizon,period_start}`
  - `replanned` `{from,to}`
  - `unplanned`
  - `carried_over` `{horizon,from,to}`
  - `goal_changed` `{from,to}`
  - `dropped`
  - `undropped`

### Triggers

They live in `packages/domain/src/planner/triggers.ts`, named `planner_v1_*`. The status trigger is the template:

```sql
CREATE TRIGGER IF NOT EXISTS planner_v1_task_status AFTER UPDATE OF status ON tasks
WHEN OLD.status IS NOT NEW.status
BEGIN
  INSERT INTO planner_task_event (user_id, task_id, task_title, type, data, source, created_at)
  VALUES (NEW.user_id, NEW.id, NEW.title, 'status_changed',
          json_object('from', OLD.status, 'to', NEW.status), 'db',
          strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END
```

Upstream `updateTask` writes every column on each update. That is why each `AFTER UPDATE OF col` trigger needs a `WHEN OLD.col IS NOT NEW.col` guard; without it the trigger fires on every edit.

- **Delete and restore**: watch `deleted_at` going from NULL to set (`deleted`) and from set to NULL (`restored`).
- **Purge**: `AFTER DELETE ON tasks` writes `purged`.

## 4. Behaviour

### Periods

Pure helpers live in `packages/contracts/src/planner.ts`, so the worker and the web app share them; the web app already depends on `@flaremo/contracts`.

- `periodStart(horizon, dayKey, weekStart = "monday")`:
  - day → the day itself
  - week → the Monday on or before that day
  - month → the 1st of the month
- `isDayKey(value)`: the `YYYY-MM-DD` shape and a real date.

The client sends `today` as its local date. The server never guesses a time zone.

### Rollover

`POST /api/app/planner/rollover {today, week_start?}`:

- **Which tasks**: each plan with a horizon, `dropped_at` NULL, the task not deleted and not `done`, and `period_start` earlier than the current period start for its horizon.
- **What changes**: set `period_start` to the current period start and add 1 to `carry_count`. Write a `carried_over` event in the same batch.
- **When**: the cockpit calls it on open, at most once per day per tab.
- **Idempotent**: running it twice on the same day changes nothing.

### Board

`GET /api/app/planner/board?today=&done_days=14&include_dropped=false`:

- Upstream tasks for the user, excluding deleted ones, LEFT JOIN plan and goal.
- Grouped server-side into `backlog`, `todo`, `doing` and `done`:
  - `done` shows only tasks with `completed_at` within `done_days`.
  - `todo` is sorted by period start, then horizon (day before week before month), then `sort_order`.
- Cap of 500 cards. If the cap is hit, the oldest Backlog cards are dropped and the response returns `truncated: true`.

### Moves

`PATCH /api/app/planner/tasks/:id` accepts `{status?, plan?: {horizon, period_start} | null, goal_id?, dropped?, title?, notes?, due_at?}`.

- Task fields go through upstream `updateTask`, with the actor resolved as in `tasks-api.ts`.
- `plan` goes through `setPlan` or `clearPlan`, which emit `planned`, `replanned` or `unplanned`. `period_start` is normalised to `periodStart(horizon, period_start)`.
- Dragging a card from Backlog to To Do defaults to "this week". The card menu sets Today, Tomorrow, This week, Next week, This month, or a picked day.

### Create

`POST /api/app/planner/tasks {title, plan?, due_at?, goal_id?, notes?}`:

- Calls upstream `createTask` (status `todo`). The `created` trigger fires.
- Then inserts the plan row and a `planned` event in one batch.

### History

- `GET /api/app/planner/tasks/:id/events`: newest first, from `planner_task_event`.
- `GET /api/app/planner/events?from&to`: kept for the "Next" review.

### Goals (API only in v1)

- `GET /api/app/planner/goals`
- `POST /api/app/planner/goals`
- `PATCH /api/app/planner/goals/:id`: reparenting rejects cycles, and depth is capped at 6.
- `GET /api/app/planner/goals/:id/rollup?from&to`: total, open, done and carried-over counts over the subtree, using `WITH RECURSIVE`.
- To archive a goal, set its status. There is no delete in v1.

## 5. Web

All new files live under `apps/web/src/planner/`:

- **`api.ts`**: the client, using `apiRequest`.
- **`query-keys.ts`**: keys under `["planner", …]`.
- **`strings.ts`**: English and zh-CN copy for the cockpit only, chosen by `useI18n().locale` and falling back to English. No upstream locale files are touched.
- **`cockpit-page.tsx`**:
  - quick add: a title plus a horizon chip
  - four columns: Backlog, To Do, Doing, Done
  - each card shows the status icon (reuse `StatusIcon` from `pages/projects/task-card.tsx`), title, horizon chip ("Today", "Wed 8", "This week", "This month"), a "carried ×N" badge, the due chip (separate), the goal chip, and a menu
- **`board.tsx`**: dnd-kit, modelled on `pages/projects/board.tsx`. Use touch sensors, and add a "Move to…" menu so moves work on a phone without dragging.
- **`plan-picker.tsx`, `due-picker.tsx` and `history-sheet.tsx`.**

Additional behaviour:

- On open, the page calls rollover once with today's local date, then fetches the board.
- After any mutation, invalidate `["planner"]` and upstream `queryKeys.tasks.all` so `/projects` stays in step.

## 6. Hook-in edits (the only upstream files touched)

1. `apps/worker/src/index.ts`: import `plannerApi`, and add `app.route("/api/app/planner", plannerApi);` above `app.route("/api/app", appApi);`.
2. `packages/contracts/src/index.ts`: append `export * from "./planner";`.
3. `packages/domain/src/index.ts`: append `export * from "./planner";`.
4. `scripts/persistence-manifest.mjs`: append `planner_goal`, `planner_task_plan` and `planner_task_event` to `RESTORE_TABLES`, after `task_activity`. `pnpm persistence:check` scans the schema directory and would fail otherwise. This also puts planner data into the backup drills.
5. `apps/web/src/router-tree.tsx`: add a `/cockpit` route.
6. `apps/worker/src/spa-routes.ts`: add `"/cockpit"`. `share-page.test.ts` asserts parity with the router.
7. `apps/web/src/components/flaremo-explorer.tsx`: one nav link to `/cockpit`, using the label from planner strings.

Fork-owned new files:

- `packages/db/src/schema/planner.ts`
- `packages/db/src/planner-migrations.ts` (test helper)
- `migrations/9000_planner_init.sql`
- `packages/contracts/src/planner.ts`
- `packages/domain/src/planner/*`
- `apps/worker/src/routes/planner-api.ts`
- `apps/web/src/planner/*`
- `tests/e2e/cockpit.spec.ts` (written, not run)
- tests next to each module

## 7. Steps

Each step ends with targeted tests green, `pnpm format`, then one commit.

0. **Baseline and spike** (no product code):
   - Note the two existing failures on `main`: `dev-proxy-parity.test.ts` (missing `wrangler.jsonc`) and the `date-format.test.ts` time-zone assertion.
   - Copy `wrangler.jsonc.example` to `wrangler.jsonc` locally; it is gitignored.
   - Run `pnpm migrate:local` with a scratch `9000_` file and confirm Wrangler applies an unjournaled file.
   - Confirm D1 in Miniflare accepts `CREATE TRIGGER` through `prepare().run()`.
   - Record the results in section 10.
1. **Schema, migration and test helper**:
   - `schema/planner.ts`, `9000_planner_init.sql`, `applyPlannerMigrations`
   - the manifest entries and `periodStart` helpers
   - tests: the tables exist after migration, `pnpm persistence:check` passes, period edge cases (Sunday, month ends, leap day)
2. **Triggers and event log**:
   - `ensurePlannerTriggers` plus tests that run upstream create, update, status change, delete, restore, reorder and purge with triggers installed
   - assert both the events and the unchanged upstream behaviour (re-run `tasks-api.test.ts`)
3. **Domain services**: plans, rollover, board grouping, goals and roll-ups, with tests.
4. **Contracts and routes**: `planner.ts` contracts, `planner-api.ts` and the mount, plus API tests using `createTestRuntime()` and `applyPlannerMigrations`, with real auth as in `tasks-api.test.ts`.
5. **Web**: the cockpit page, the route, spa-routes and the nav link.
   - unit tests for grouping and labels
   - `pnpm --filter @flaremo/web typecheck`
   - write the e2e spec
   - check the page by eye with `pnpm dev:hot`, on desktop and phone width
6. **Docs**: mark the requirements as implemented, and add the runbook: the trigger list, dropping triggers with `wrangler d1 execute`, and rollback.
7. **Hand-off**: the owner adds `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as repo secrets, or deploys locally, then runs through the smoke list.

## 8. Acceptance

- `/cockpit` shows Backlog, To Do, Doing and Done with real tasks, on desktop and phone.
- Adding, moving and re-planning a task works; the due date is set separately; a task can be dropped and found again.
- Unfinished planned tasks move into the current period with "carried ×N".
- A task's history shows every change, including edits from `/projects` and the API, and it survives the task's purge.
- The goal API handles a nested tree and roll-ups (tested).
- `/projects`, overdue reminders and "convert to task" behave as before (their tests pass unchanged).
- Only the section 6 files differ from upstream outside fork-owned paths.

## 9. Checklist

Conformance (check before every commit):

- [ ] No edits to existing `packages/db/src/schema/*` files or `migrations/meta/*`
- [ ] `schema/planner.ts` is not exported from the schema barrel; no `pnpm db:generate`
- [ ] Upstream files changed only from the section 6 list
- [ ] No new Wrangler bindings, crons, queues or secrets
- [ ] Task rows change only through upstream domain services
- [ ] Each planner mutation writes its event in the same batch
- [ ] Columns are Backlog · To Do · Doing · Done
- [ ] Plan date and due date stay separate
- [ ] Text at least 12px, Ember tokens, no new gradient CTA
- [ ] Targeted tests green; `pnpm format` clean

Progress:

- [ ] 0 Baseline and spike
- [ ] 1 Schema, migration and test helper
- [ ] 2 Triggers and event log
- [ ] 3 Domain services
- [ ] 4 Contracts and routes
- [ ] 5 Web cockpit
- [ ] 6 Docs and runbook
- [ ] 7 Hand-off and smoke test

## 10. Log

(Executor notes: spike results, deviations approved by the owner, follow-ups.)
