# Planning cockpit — implementation plan (v2, audited)

Status: v2, revised after an independent audit on 2026-10-04 (section 12). Executor: Sonnet, after the owner approves. Requirements: `docs/planning-cockpit-requirements.md`.

## 0. Locked decisions

- **Columns by status, like the Notion board**: Backlog · To Do · Doing · Done.
  - Backlog = status `todo` with no plan.
  - To Do = status `todo` with a plan.
  - Doing = `in_progress`.
  - Done = `done`.
  - Dropped (Notion "Archive") is hidden behind a filter.
- **Plan date and due date are separate.**
  - Plan = horizon (`day` | `week` | `month`) plus a period start, in planner tables.
  - Due = upstream `tasks.due_at`, unchanged. Overdue reminders keep working off `due_at`.
- **Weekly and monthly review stays in "Next"**, not v1.
- **Fresh start from Notion**: no importer.
- **Cloudflare only, no new services**: same Worker, same D1. No new bindings, crons, queues or secrets.
- **Isolated add-on**: no change to upstream tables, columns or the Drizzle journal. Upstream files are edited only at the hook-in points in section 7.

Defaults the owner can still change before execution:

- **D1 Dropping a task clears its `due_at`.** The old value stays in history, so a dropped task stops sending overdue alerts. The task stays open in `/projects`.
- **D2 The cockpit sits beside `/projects`** in navigation. Upstream projects are not linked to goals in v1.
- **D3 Goal `kind` is a validated slug**, not a fixed enum: `^[a-z][a-z0-9-]{0,23}$`. Suggested values are `area`, `year`, `quarter`, `goal` and `milestone`. Adding a level needs no code or schema change.
- **D4 One extra trigger reads upstream `task_activity`.** It copies who made each change into planner history.

## 1. Guardrails

Must not:

- **G1** Edit existing files in `packages/db/src/schema/` or anything in `migrations/meta/`.
- **G2** Export planner tables from the `packages/db/src/schema.ts` barrel. drizzle-kit reads it and would fold planner tables into upstream's journal.
- **G3** Run `pnpm db:generate`. Planner migrations are hand-written. This is the fork's exception to the `db:generate` rule in AGENTS.md, recorded in the header of every planner schema and migration file.
- **G4** Add Cloudflare bindings, services, cron triggers, queues or secrets.
- **G5** Change `/api/v1/*`, the Memos-compatible MCP tools, or upstream task behaviour.
- **G6** Add a second auth path. Planner routes use `getRequestContext` (cookie session or PAT).
- **G7** Edit upstream files outside the section 7 list.
- **G8** Run `pnpm verify` or Playwright e2e (AGENTS.md). Write and register the e2e spec, but don't run it.
- **G9** Put secrets, cookies or tokens in code, docs, tests or logs.
- **G10** Add any foreign key from a planner table to an upstream table (`tasks`, `users` or anything else). Planner-internal foreign keys are allowed.
- **G11** Put triggers in a migration file. Triggers are created only at runtime by `ensurePlannerTriggers`.
- **G12** Edit a `9xxx_planner_*.sql` file once it has been applied anywhere. Add the next number instead.
- **G13** Rebuild (drop and recreate) a planner table in a migration. Planner migrations are additive only: new tables, `ADD COLUMN`, indexes.

Must:

- **M1** Change task rows only through upstream domain services: `createTask`, `updateTask`, `deleteTask`, `restoreTask`. Planner code writes only planner tables.
- **M2** Do planner data access with Drizzle (including its `sql` template) in `packages/domain/src/planner/`. Never use loose SQL in routes.
- **M3** Write every planner mutation's event in the same D1 batch as the change.
- **M4** Follow `docs/design-system.md`:
  - text at least 12px and Ember tokens
  - no new gradient CTA
  - optimistic edits with a toast
  - AlertDialog for destructive actions
- **M5** Ship tests in the same commit as the code they cover.
- **M6** Before every commit run `pnpm format`, the targeted vitest files, and the guard command in section 10.
- **M7** Commit in small steps straight to `main` (AGENTS.md), only after the owner says go. Start each session with `git switch main && git pull --ff-only`.
- **M8** Prefix every planner export with `planner` or `Planner` so nothing collides with upstream barrel names (TS2308).
- **M9** Make every trigger body unable to raise. It may only `INSERT` into `planner_task_event` or `DELETE` from `planner_task_plan`, and guards any JSON with `json_valid`.

## 2. Architecture

```
browser / PWA ──HTTPS──▶ Worker
                          ├─ /cockpit (SPA route)
                          └─ /api/app/planner/*  ──▶ packages/domain/src/planner/* (deep import)
                                                      ├─ upstream task services (createTask, updateTask…)
                                                      └─ planner tables (Drizzle)
D1 (one database)
  upstream: tasks, projects, task_activity, users …      ← unchanged
  planner : planner_goal, planner_task_plan, planner_task_event   ← 9000-series migration, NO FKs to upstream
  triggers: planner_v1_* on tasks + task_activity → planner_task_event   ← runtime, self-healing, column-checked
```

### Migration track (verified by audit)

- Hand-written `migrations/9000_planner_init.sql`, not in `migrations/meta/_journal.json`.
- **Production and local**: `wrangler d1 migrations apply` orders files by leading integer, records each by name, and still applies later upstream `00NN_` files. This was verified with wrangler's code and a real local apply.
- **Elsewhere**: the dev server, e2e and both backup drills also use Wrangler, so they get planner tables. Only the vitest helper `applyFlaremoMigrations` reads the journal, so planner tests call `applyPlannerMigrations(db)`.
- **Statements**: separate them with `--> statement-breakpoint`.
- **No fallback config**: the audit found it unnecessary and harmful, because the drills and dev server would never get the planner tables.

### Why there are no foreign keys to upstream tables (audit blocker B1)

Upstream rebuilds tables with `PRAGMA foreign_keys=OFF; … DROP TABLE tasks …`; see `migrations/0025_clammy_sunspot.sql`. Wrangler runs each migration file as one batch, where that PRAGMA does nothing. The audit reproduced the result:

- `DROP TABLE tasks` cascaded and deleted every row that pointed at it: plan rows went from 2 to 0, and upstream's own `task_activity` also went to 0.
- The rebuild also dropped all triggers.

So:

- Planner tables reference upstream rows by id only.
- The purge trigger removes a purged task's plan row.
- Board and rollover queries `INNER JOIN tasks`.
- Rollover sweeps orphan plan rows.

### History capture

Events come from three sources, without duplicates:

| Source | Events | Actor |
|---|---|---|
| Trigger on `task_activity` INSERT, `WHEN NEW.task_id IS NOT NULL`. Covers every upstream service write. | `created`, `updated`, `status_changed` (with upstream's `changes` JSON) | yes: user, or agent and its PAT hint |
| Triggers on `tasks` | `deleted` (deleted_at goes from NULL to set), `restored`, `purged` (AFTER DELETE; also deletes the plan row) | none; documented |
| Planner code, in the same batch as the change | `planned`, `replanned`, `unplanned`, `carried_over`, `goal_changed`, `dropped`, `undropped` | yes |

- "Completed" means `status_changed` to `done`. "Reopened" means a change from `done`.
- Tasks inserted without an activity row get no `created` event. Today only the bundle import does this; it is a known gap.

### `ensurePlannerTriggers(db)` (audit M1)

- **When it runs**: only after `getRequestContext` succeeds, on every planner request.
- **Memoising**: the in-flight promise is memoised per `env` in a WeakMap, with a 5-minute re-check of `sqlite_master`. The precedent is `apps/worker/src/context.ts:65`.
- **Compatibility check**: it confirms the planner tables exist and that every column the triggers reference exists, using `PRAGMA table_info('tasks')` and `PRAGMA table_info('task_activity')`. If anything is missing it creates nothing and returns `history: "paused"`; the board shows a quiet notice. A trigger that names a missing column breaks upstream writes.
- **Creation**: it creates the current `planner_v1_*` triggers with `IF NOT EXISTS`, and drops any `planner_*` trigger not in the current set.
- **Test**: a unit test asserts that every column referenced in the trigger SQL is in `getTableColumns(tasks)` and `getTableColumns(taskActivity)`.

## 3. Data model

File `packages/db/src/schema/planner.ts` defines `plannerGoal`, `plannerTaskPlan` and `plannerTaskEvent`. Its header comment says: not in the barrel, no `db:generate`, hand-written 9000-series migrations. Import it as `@flaremo/db/src/schema/planner`; the audit checked that this resolves under tsc and esbuild.

```sql
-- migrations/9000_planner_init.sql — fork-owned, hand-written; never edit once applied (add 9001_…).
CREATE TABLE `planner_goal` (
  `id` text PRIMARY KEY NOT NULL,                 -- "goals/<uuid>" (fork-local id helper)
  `user_id` text NOT NULL,                        -- no FK to users (G10)
  `parent_id` text REFERENCES `planner_goal`(`id`) ON DELETE set null,
  `kind` text NOT NULL,                           -- validated slug (D3)
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
  `task_id` text PRIMARY KEY NOT NULL,            -- no FK to tasks (G10)
  `user_id` text NOT NULL,
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
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL, -- order history by id (D1 and Worker clocks differ)
  `user_id` text NOT NULL,
  `task_id` text NOT NULL,                        -- no FK: history outlives a purged task
  `task_title` text,
  `type` text NOT NULL,
  `data` text NOT NULL DEFAULT '{}',
  `source` text NOT NULL,                         -- 'activity' | 'db' | 'planner'
  `actor_type` text,
  `actor_name` text,
  `created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `planner_task_event_task_idx` ON `planner_task_event` (`task_id`,`id`);
--> statement-breakpoint
CREATE INDEX `planner_task_event_user_idx` ON `planner_task_event` (`user_id`,`id`);
```

## 4. Behaviour

### Periods

They live in `packages/contracts/src/planner.ts` and are shared by the worker and the web app.

- **Week start**: Monday everywhere in v1. There is no week-start parameter.
- **Date maths**: dates are parsed as UTC midnight and use UTC getters. Tests cover DST change dates, Sundays, month ends and 29 Feb.
- **`plannerPeriodStart(horizon, dayKey)`**:
  - day → the day itself
  - week → the Monday on or before that day
  - month → the 1st of the month

### Today

The client sends `today` as its local date.

- The server accepts it only within the server's UTC date ±1 day; anything else gets a 400.
- New plans cannot start before the current period for their horizon.
- The cockpit re-runs rollover on `visibilitychange` once the local date has changed.

### Rollover (audit M2)

`POST /api/app/planner/rollover {today}` runs one D1 batch of two statements that share a predicate. The predicate selects a plan whose horizon is set, `dropped_at` is NULL, the task exists, is not deleted and not `done`, and whose `period_start` is before the target period.

- **Target period**: `CASE horizon WHEN 'day' THEN :day WHEN 'week' THEN :week ELSE :month END`.
- **Statement 1**: `INSERT … SELECT` `carried_over` events for the matching plans.
- **Statement 2**: `UPDATE` those plans to the target period and add 1 to `carry_count`.
- **In the same batch**: delete orphan plan rows, meaning those whose task no longer exists.
- **Required result**: two concurrent runs give exactly +1 carry and one event per task. This is tested.

### Board

`GET /api/app/planner/board?today=&done_days=14&include_dropped=false`:

- **Query**: one query that INNER JOINs plans to `tasks` and LEFT JOINs goals.
  - It filters deleted tasks, dropped plans and the done window in SQL.
  - It selects explicit columns only (no `notes`).
- **Cap of 500 cards**:
  - To Do and Doing are never truncated.
  - Backlog and Done share what is left, newest first, and set `truncated: true` when cut.
- **Response**: `history: "ok" | "paused"`.

### Column moves (audit m10)

| From → To | Effect |
|---|---|
| Backlog → To Do | Plan = this week (default); `planned` event |
| To Do → Backlog | Plan cleared; `unplanned` event |
| Backlog or To Do → Doing | Status `in_progress`; plan kept |
| any → Done | Status `done`; plan kept for history |
| Doing → To Do | Status `todo`; if there is no plan, plan = this week (so it lands in To Do, not Backlog) |
| Doing or Done → Backlog | Status `todo`; plan cleared |
| Done → To Do | Status `todo` (reopened); if the plan is missing or past, plan = this week |
| Done → Doing | Status `in_progress` |

The card menu offers "Move to…" and the plan choices: Today, Tomorrow, This week, Next week, This month, or a picked day. The due-date picker is separate. Drop follows D1, and undrop doesn't restore the old due date.

### Create (audit m9)

`POST /api/app/planner/tasks {title, plan?, due_at?, goal_id?, notes?}`:

1. Upstream `createTask` (status `todo`); the activity trigger logs `created` with the actor.
2. One batch that writes the plan row and a `planned` event.

If step 2 fails, the endpoint returns 201 `{task, plan: null, plan_error}`. The card lands in Backlog and offers "Retry plan". Nothing is compensated.

### Other routes

- `PATCH /api/app/planner/tasks/:id`
- `GET /api/app/planner/tasks/:id/events`: ordered by `id` descending.
- `GET /api/app/planner/events?from&to`
- `GET/POST /api/app/planner/goals`
- `PATCH /api/app/planner/goals/:id`: rejects cycles, and depth is capped at 6.
- `GET /api/app/planner/goals/:id/rollup?from&to`: uses `WITH RECURSIVE`, which the audit verified in D1.

### Route conventions

- Ids come from a fork-local `createPlannerId("goals")`. Upstream's `createResourceId` has no `goals` prefix (audit m6).
- The actor comes from a fork-local copy of `resolveActor`.
- Mutations use `rateLimitGuard` with a `"planner"` bucket (audit m7).

## 5. Web

All new files live under `apps/web/src/planner/`:

- **`api.ts`**: the client, using `apiRequest`. It handles 429 by rolling back the optimistic edit and showing a toast.
- **`query-keys.ts`**: keys under `["planner", …]`.
- **`strings.ts`**: English and zh-CN copy for the cockpit only, chosen by `useI18n().locale` and falling back to English. The audit found no test forbids this.
- **`nav-link.tsx`**: exports `<PlannerNavLink/>`, so the explorer edit is an import plus one element (audit m17).
- **`cockpit-page.tsx`**:
  - quick add (title plus a horizon chip)
  - four columns: Backlog, To Do, Doing, Done
  - each card shows the status icon (reuse `StatusIcon` from `pages/projects/task-card.tsx`), title, horizon chip ("Today", "Wed 8", "This week", "This month"), a "carried ×N" badge, the due chip, the goal chip, and a menu
  - a quiet "history paused" notice when the board response says so
- **`board.tsx`**: dnd-kit, modelled on `pages/projects/board.tsx`. Use touch sensors, plus a "Move to…" menu so moves work on a phone without dragging.
- **`plan-picker.tsx`, `due-picker.tsx` and `history-sheet.tsx`.**

Additional behaviour:

- On open, the page runs rollover once, then fetches the board.
- After any mutation, invalidate `["planner"]`, upstream `queryKeys.tasks.all` and `["projects"]` (audit m13).

## 6. Tests

- **Contracts**:
  - period helpers: Monday rule, UTC, DST, month ends, leap day
  - the bounds on `today`
  - the goal-kind slug
- **Domain and worker**, with `createTestRuntime()`, `applyPlannerMigrations` and `ensurePlannerTriggers`:
  - every endpoint, with real auth as in `tasks-api.test.ts`
  - rollover idempotency under two concurrent batches
  - the board cap and filters
  - goal cycle and depth checks, and roll-ups
- **Rebuild survival (B1)**: run a 0025-shaped rebuild of `tasks` through the batch path. Plan rows and events must survive, and triggers must come back on the next ensure.
- **Trigger safety (M1)**:
  - the column-compatibility unit test
  - with a column missing, ensure returns `paused` and upstream writes still succeed
- **Upstream flows with the planner installed (audit M6)**, fork-owned `apps/worker/src/routes/planner-upstream-compat.test.ts`:
  - task create, no-op update, status change, delete and restore, reorder
  - project delete, restore and purge, plus `hardDeleteExpiredTasks`
  - `finalizeFlaremoMemberRemoval`
  - overdue notifications
  - convert-to-task

  Assert that the upstream results are unchanged and that the expected events are written.
- **Web**: unit tests for column grouping, the transition table and labels.
- **E2E**: `tests/e2e/cockpit.spec.ts`, registered as a `planner-ui` project depending on `auth-ui` (audit M5). It covers the deep link, the anonymous redirect, the nav link and quick add. Written, not run (G8).

## 7. Hook-in edits (the only upstream files touched)

1. `apps/worker/src/index.ts`: import `plannerApi`, and add `app.route("/api/app/planner", plannerApi);` above `app.route("/api/app", appApi);`.
2. `packages/contracts/src/index.ts`: append `export * from "./planner";`. The web app can only import contracts through `.`.
3. `scripts/persistence-manifest.mjs`: append `planner_goal`, `planner_task_plan` and `planner_task_event` to `RESTORE_TABLES`. If upstream has appended a table, resolve by keeping both.
4. `apps/web/src/router-tree.tsx`: a `/cockpit` route. Keep the literal `path: "/cockpit"`, because the parity test scans only this file.
5. `apps/worker/src/spa-routes.ts`: add `"/cockpit"`.
6. `apps/web/src/components/flaremo-explorer.tsx`: an import plus `<PlannerNavLink/>`. This is the most-changed upstream file, so keep the edit tiny.
7. `playwright.config.ts`: the `planner-ui` project (M5).
8. `apps/web/public/sw.js`: add `cockpit` to `privateRoutes`, so the service worker treats the cockpit as a private page (audit m14).

The domain barrel is **not** touched; the worker deep-imports `@flaremo/domain/src/planner` (audit m2).

New fork-owned files:

- `packages/db/src/schema/planner.ts`
- `packages/db/src/planner-migrations.ts`
- `migrations/9000_planner_init.sql`
- `packages/contracts/src/planner.ts`
- `packages/domain/src/planner/*`
- `apps/worker/src/routes/planner-api.ts`
- `apps/worker/src/routes/planner-*.test.ts`
- `apps/web/src/planner/*`
- `tests/e2e/cockpit.spec.ts`

## 8. Steps

Each step ends with targeted tests green, `pnpm format`, the guard command, then one commit. Steps 1–4 also run `pnpm deploy:dry-run`, which needs the local `wrangler.jsonc` from step 0.

0. **Baseline and spike** (no product code):
   - `git switch main && git pull --ff-only`, then record the SHA in section 11 as `planner-base` and run `git tag -f planner-base <sha>` locally. Re-create the tag from the logged SHA in any new session.
   - Copy `wrangler.json` to `wrangler.jsonc` (gitignored). Not the `.example`: it lacks routes, so `dev-proxy-parity` would still fail.
   - Note the existing failures on `main`: `dev-proxy-parity` in CI (no `wrangler.jsonc`) and the `date-format` time-zone assertion.
   - Spike with `--persist-to` a temp directory, never under the final filename. Confirm that a scratch unjournaled `9xxx` file applies and that `prepare().run()` creates triggers.
1. **Schema, migration and test helper**:
   - `schema/planner.ts`, `9000_planner_init.sql`, `applyPlannerMigrations`
   - the manifest entries and period helpers
   - tests: the tables exist, `pnpm persistence:check` passes, period edge cases
2. **Triggers and history**:
   - `ensurePlannerTriggers` (pause, memo, version clean-up)
   - the column-compatibility test, the rebuild-survival test and the upstream-flows suite
3. **Domain services**: plans, rollover (set-based), board, goals and roll-ups, with tests.
4. **Contracts and routes**: `planner.ts` contracts, `planner-api.ts`, the mount and rate limiting, plus API tests.
5. **Web**: the cockpit page, route, spa-routes, nav link, `sw.js` entry and Playwright project.
   - unit tests
   - `pnpm --filter @flaremo/web typecheck`
   - write the e2e spec
   - check the page by eye with `pnpm dev:hot` on desktop and phone width
6. **Docs and runbook**: section 9, kept in this file, plus the requirements status.
7. **Hand-off**: the owner adds `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as repo secrets, or deploys locally, then runs through the smoke list.

## 9. Runbook

- **Triggers**:
  - `planner_v1_activity_insert` on `task_activity`
  - `planner_v1_task_deleted`, `planner_v1_task_restored` and `planner_v1_task_purged` on `tasks`
- **Drop all triggers**: `wrangler d1 execute DB --remote --config ./wrangler.jsonc --command "DROP TRIGGER IF EXISTS planner_v1_activity_insert; DROP TRIGGER IF EXISTS planner_v1_task_deleted; DROP TRIGGER IF EXISTS planner_v1_task_restored; DROP TRIGGER IF EXISTS planner_v1_task_purged;"`
- **Before merging an upstream update PR whose migrations touch `tasks` or `task_activity`**: drop the triggers first. Deploy, then open the cockpit; the triggers come back if the columns are still compatible, otherwise history shows "paused". Update PRs don't run CI, so run the planner test files locally first.
- **If a deploy fails with "error in trigger planner_*"**: drop the triggers and re-run the deploy.
- **Before any restore** (drill or real): drop the triggers. Replaying into a database that has them fails on the `planner_task_event` ids.
- **Rollback**: revert the planner commits, drop the triggers, then optionally drop the three planner tables, in the order event, plan, goal.
- **Upstream update conflict**: when `flaremo-update.yml` reports "Resolve the update manually", apply the release diff locally with `git apply --3way`, keep both sides in the hook-in files, run the planner tests, then commit.
- **Removing a team member**: planner rows have no foreign key to `users`. Delete their planner rows by `user_id` by hand. For a single-user setup this is not needed.
- **Upstream note**: migration 0025's rebuild ran inside a batch, so upstream's own `task_activity` rows were wiped when it deployed. This is an upstream issue, outside this plan's scope.

## 10. Checklist

Guard command (run before every commit). It must print only section 7 hook-in files:

```sh
git diff --name-only planner-base..HEAD | grep -v -E '^(docs/planning-cockpit|packages/db/src/schema/planner\.ts|packages/db/src/planner-migrations\.ts|migrations/9[0-9]{3}_planner_|packages/contracts/src/planner|packages/domain/src/planner/|apps/worker/src/routes/planner-|apps/web/src/planner/|tests/e2e/cockpit\.spec\.ts)'
```

Conformance (check before every commit):

- [ ] The guard prints only section 7 files
- [ ] No foreign key from a planner table to an upstream table
- [ ] No triggers in migrations; applied `9xxx` files unedited; migrations additive only
- [ ] `schema/planner.ts` is not in the barrel; no `pnpm db:generate`
- [ ] No new Wrangler bindings, crons, queues or secrets
- [ ] Task rows change only through upstream domain services
- [ ] Each planner mutation writes its event in the same batch
- [ ] Every planner export is prefixed with `planner` or `Planner`
- [ ] Columns are Backlog · To Do · Doing · Done; plan and due dates stay separate
- [ ] Monday week start and UTC date maths everywhere
- [ ] Text at least 12px, Ember tokens, no new gradient CTA
- [ ] Targeted tests green; `pnpm format` clean

Progress:

- [ ] 0 Baseline and spike
- [ ] 1 Schema, migration and test helper
- [ ] 2 Triggers and history
- [ ] 3 Domain services
- [ ] 4 Contracts and routes
- [ ] 5 Web cockpit
- [ ] 6 Docs and runbook
- [ ] 7 Hand-off and smoke test

Acceptance:

- `/cockpit` shows Backlog, To Do, Doing and Done with real tasks on desktop and phone. Adding, moving, re-planning, setting a due date and dropping all work.
- Unfinished planned tasks move into the current period with "carried ×N". Two concurrent rollovers give one carry each.
- History shows every change with its actor where upstream records one, including edits from `/projects` and the API. It survives purges and upstream table rebuilds.
- The goal API handles a nested tree with roll-ups (tested).
- `/projects`, overdue reminders, convert-to-task and member removal behave as before (the compat suite is green).
- The guard command prints only section 7 files.

## 11. Log

- planner-base: (set at step 0)

## 12. Audit resolution (2026-10-04)

An independent auditor ran experiments against the repo. Every finding was adopted:

- **B1 cascade wipe**: no foreign keys to upstream tables; purge clean-up; inner joins; rebuild-survival test.
- **M1 trigger hazards**: ensure after auth, column check with a "paused" state, WeakMap and TTL memo, version clean-up, runbook.
- **M2 rollover race**: set-based two-statement batch.
- **M3 week start**: Monday everywhere, UTC date maths, DST tests.
- **M4 actor**: `task_activity` trigger (D4), without duplicate events.
- **M5 e2e**: the `planner-ui` Playwright project.
- **M6 compat**: the upstream-flows suite with the planner installed.
- **Minor**:
  - m1: the restore runbook, and triggers never in migrations. The earlier "avoids the splitter" reason was wrong.
  - m2: export prefixes, and a deep import instead of the domain barrel.
  - m3: spike hygiene.
  - m4: dropped the fallback config.
  - m5: the guard is based on `planner-base`.
  - m6: fork-local id and actor helpers.
  - m7: the rate-limit bucket.
  - m8: board query details.
  - m9: the create fallback.
  - m10: the transition table.
  - m11: date bounds.
  - m12: the member-removal runbook.
  - m13: invalidate `projects`.
  - m14: `sw.js`.
  - m15: header comments record the `db:generate` exception.
  - m16: dry-run and pull steps.
  - m17: the minimal explorer edit and the literal route path.
