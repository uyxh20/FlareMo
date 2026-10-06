# Planning cockpit — implementation plan (v3, reuse-first)

Status: v3, 2026-10-04, re-audited (section 12). The owner gave the go-ahead to build and wants it on the dev deployment for QA. v3 replaces the audited v2: history copies the upstream activity log (no triggers), goals are upstream projects in a tree, and the board reuses upstream components. Every v2 audit finding that still applies is kept (section 12).

- Executor: Sonnet subagents, one step group at a time. The orchestrator reviews and pushes each commit.
- Requirements: `docs/planning-cockpit-requirements.md`.
- Canonical project doc (live status, decisions, build tracker, log): https://claude.ai/artifact/7nTJJXwmQALMZjtAPP4JhZ
- Base: upstream v0.22.0, merged into the fork as `a904b7f`.

## 0. Locked decisions

- **Columns by status, like the Notion board**: Backlog · To Do · Doing · Done.
  - Backlog: status `todo` with no plan.
  - To Do: status `todo` with a plan.
  - Doing: `in_progress`.
  - Done: `done`.
  - Dropped (Notion "Archive") is hidden behind a filter.
- **Plan date and due date are separate.**
  - Plan: horizon (`day` | `week` | `month`) plus a period start, in planner tables.
  - Due: upstream `tasks.due_at`, unchanged, so overdue reminders keep working.
- **Weekly and monthly review is not in v1** ("Next"). There is no goal UI in v1, but the backend supports a goal tree.
- **Fresh start from Notion.** No importer.
- **Cloudflare only, no new services.** Same Worker and D1, with no new bindings, crons, queues or secrets.
- **Isolated add-on.** No change to upstream tables, columns or the Drizzle journal; upstream files are touched only at the section 7 hook-ins.
- **Reuse first.** Use upstream services, components and helpers wherever they already work.

Build defaults (adopted for the build; the owner can change them after QA):

- **D1 Dropping a task clears its `due_at`** through upstream `updateTask`. The old value stays in history, and the dropped task stops sending overdue alerts.
- **D2 The cockpit lives at `/cockpit`**, beside `/projects` in navigation.
- **D3 Goals are upstream projects arranged in a tree** (`planner_project_node`). Tasks belong to goals through upstream `tasks.project_id`. A node's `level` is a validated slug (`^[a-z][a-z0-9-]{0,23}$`, for example `area`, `year`, `quarter`, `goal`, `milestone`), so adding a level needs no schema change.
- **D4 History is a permanent copy of upstream `task_activity`**, plus delete, restore and purge detection by comparing `tasks` with a snapshot. No SQL triggers anywhere.
- **Sync timing**: history syncs on cockpit open (rollover) and before history reads. There is no cron. Upstream keeps trash for 30 days, so a delete is missed only if the cockpit isn't opened for 30 days. A nightly hook into `apps/worker/src/scheduled-tasks.ts` stays an option for later.

## 1. Guardrails

Must not:

- **G1** Edit existing files in `packages/db/src/schema/` or anything in `migrations/meta/`.
- **G2** Export planner tables from the `packages/db/src/schema.ts` barrel, because drizzle-kit would fold them into upstream's journal.
- **G3** Run `pnpm db:generate`. Planner migrations are hand-written; this is the fork's exception to the AGENTS.md rule, and it's recorded in the header of every planner schema and migration file.
- **G4** Add Cloudflare bindings, services, cron triggers, queues or secrets.
- **G5** Change `/api/v1/*`, the MCP tools, or upstream task behaviour.
- **G6** Add a second auth path. Planner routes authenticate exactly like `apps/worker/src/routes/tasks-api.ts`: cookie session or PAT, with the same Origin rules.
- **G7** Edit upstream files outside the section 7 list.
- **G8** Run `pnpm verify` or Playwright e2e. Write and register the e2e spec, but don't run it.
- **G9** Put secrets, cookies or tokens in code, docs, tests or logs.
- **G10** Add any foreign key from a planner table to an upstream table. Planner-internal foreign keys are allowed.
- **G11** Create SQL triggers, at runtime or in migrations.
- **G12** Edit a `9xxx_planner_*.sql` file once it's applied to a real database (dev or live). Add the next number instead.
- **G13** Rebuild a planner table in a migration. Planner migrations are additive only.
- **G14** Write to upstream tables except through upstream domain services (M1). Planner code reads upstream tables only.

Must:

- **M1** Change task rows only through upstream domain services (`createTask`, `updateTask`, `deleteTask`, `restoreTask`, …). Planner code writes only planner tables.
- **M2** Do planner data access with Drizzle (including its `sql` template) in `packages/domain/src/planner/`. No loose SQL in routes.
- **M3** Write every planner mutation's planner event in the same D1 batch as the planner-table change.
- **M4** Follow `docs/design-system.md`:
  - text at least 12px and Ember tokens
  - no new gradient CTA
  - optimistic edits with a toast
  - AlertDialog for destructive actions
- **M5** Ship tests in the same commit as the code they cover.
- **M6** Before every commit, run `pnpm format`, the targeted vitest files and the guard command (section 10).
- **M7** Commit in small steps straight to `main`, without pushing; the orchestrator reviews and pushes.
- **M8** Prefix every planner export with `planner` or `Planner`.
- **M9** Reuse upstream components and helpers by import. Copy one into a fork-local file only when importing it would mean editing an upstream file.

## 2. Architecture

```
browser / PWA ──HTTPS──▶ Worker
                          ├─ /cockpit  (SPA route, WorkspaceLayout like /projects)
                          └─ /api/app/planner/*  (mountLazyRoute, mounted before /api/app)
                                 └─ packages/domain/src/planner/*  (deep import, not the domain barrel)
                                       ├─ upstream task services  (all task writes)
                                       ├─ upstream tables, read-only (tasks, projects, task_activity)
                                       └─ planner tables (Drizzle)
D1 (one database)
  upstream: tasks, projects, task_activity, …            ← unchanged
  planner : planner_task_plan, planner_task_event, planner_task_seen,
            planner_sync_state, planner_project_node    ← migrations/9000_planner_init.sql
            no FKs to upstream tables, no triggers
```

### Migration track (verified by the v2 audit)

- `migrations/9000_planner_init.sql` is hand-written and not in `migrations/meta/_journal.json`.
- `wrangler d1 migrations apply` orders files by leading integer, records each by name, and still applies later upstream `00NN_` files. This covers live, dev, the dev server and the drills.
- The vitest helper `applyFlaremoMigrations` reads only the journal, so planner tests also call the fork-owned `applyPlannerMigrations(db)` in `packages/db/src/planner-migrations.ts`.
- Separate statements with `--> statement-breakpoint`.

### Why there are no foreign keys to upstream tables (v2 audit B1)

Upstream rebuilds tables with `PRAGMA foreign_keys=OFF; … DROP TABLE tasks …`; see `migrations/0025_clammy_sunspot.sql`. Inside Wrangler's batch the PRAGMA does nothing, so the drop cascades. A reproduction wiped plan rows from 2 to 0, and upstream's own `task_activity` too. So:

- Planner tables reference upstream rows by id only.
- Board queries join `tasks` explicitly.
- Purge detection removes plan, snapshot and node rows whose upstream row is gone.

## 3. Data model

`packages/db/src/schema/planner.ts` defines the five tables with Drizzle. It is not in the barrel; import it as `@flaremo/db/src/schema/planner`. Its header records the `db:generate` exception.

```sql
-- migrations/9000_planner_init.sql — fork-owned, hand-written; never edit once applied (add 9001_…).
CREATE TABLE `planner_task_plan` (
  `task_id` text PRIMARY KEY NOT NULL,             -- upstream tasks.id, no FK (G10)
  `user_id` text NOT NULL,
  `horizon` text,                                  -- day | week | month | NULL (backlog)
  `period_start` text,                             -- YYYY-MM-DD; NULL iff horizon is NULL
  `carry_count` integer NOT NULL DEFAULT 0,
  `dropped_at` text,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `planner_task_plan_user_period_idx` ON `planner_task_plan` (`user_id`,`horizon`,`period_start`);
--> statement-breakpoint
CREATE TABLE `planner_task_event` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL, -- tie-breaker only
  `user_id` text NOT NULL,
  `task_id` text NOT NULL,                         -- no FK: history outlives the task
  `task_title` text,                               -- snapshot at copy time
  `type` text NOT NULL,                            -- see "Event types"
  `data` text NOT NULL DEFAULT '{}',               -- JSON
  `source` text NOT NULL,                          -- 'activity' | 'sync' | 'planner'
  `source_ref` text,                               -- idempotency key for activity/sync events
  `actor_type` text,                               -- user | agent | NULL
  `actor_name` text,
  `occurred_at` text NOT NULL,                     -- when it happened (source timestamp)
  `created_at` text NOT NULL                       -- when it was archived
);
--> statement-breakpoint
CREATE UNIQUE INDEX `planner_task_event_source_ref_uq` ON `planner_task_event` (`source`,`source_ref`) WHERE `source_ref` IS NOT NULL;
--> statement-breakpoint
CREATE INDEX `planner_task_event_task_idx` ON `planner_task_event` (`task_id`,`occurred_at`);
--> statement-breakpoint
CREATE INDEX `planner_task_event_user_idx` ON `planner_task_event` (`user_id`,`occurred_at`);
--> statement-breakpoint
CREATE TABLE `planner_task_seen` (                 -- snapshot used to detect delete/restore/purge
  `task_id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL,
  `title` text NOT NULL,
  `status` text NOT NULL,
  `project_id` text,
  `deleted_at` text,
  `last_seen_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `planner_task_seen_user_idx` ON `planner_task_seen` (`user_id`);
--> statement-breakpoint
CREATE TABLE `planner_sync_state` (
  `user_id` text PRIMARY KEY NOT NULL,
  `activity_watermark` text,                       -- max task_activity.created_at copied
  `activity_last_id` integer,                      -- max task_activity.id seen (may drop after an upstream rebuild)
  `last_sync_at` text,
  `status` text NOT NULL DEFAULT 'ok',             -- ok | paused
  `paused_reason` text
);
--> statement-breakpoint
CREATE TABLE `planner_project_node` (              -- goal tree over upstream projects
  `project_id` text PRIMARY KEY NOT NULL,          -- upstream projects.id, no FK (G10)
  `user_id` text NOT NULL,
  `parent_project_id` text REFERENCES `planner_project_node`(`project_id`) ON DELETE SET NULL,
  `level` text,                                    -- validated slug (D3) or NULL
  `period_start` text,
  `period_end` text,
  `sort_order` integer NOT NULL DEFAULT 0,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `planner_project_node_user_parent_idx` ON `planner_project_node` (`user_id`,`parent_project_id`,`sort_order`);
```

A project with no node row is a root with no level. Setting a parent creates the parent's node row if needed.

## 4. Behaviour

### Periods

They live in `packages/contracts/src/planner.ts`, shared by the worker and the web app.

- Monday week start everywhere.
- Dates are `YYYY-MM-DD`, parsed as UTC midnight with UTC getters. Tests cover DST change dates, Sundays, month ends and 29 Feb.
- `plannerPeriodStart(horizon, dayKey)`: day → that day; week → the Monday on or before it; month → the 1st.

### Today

- The client sends `today`, its local date.
- The server accepts it only within its own UTC date ±1 day; anything else gets a 400.
- New plans can't start before the current period for their horizon.
- The cockpit re-runs rollover on `visibilitychange` once the local date has changed.

### Event types

| Source | Types | Actor |
|---|---|---|
| `activity`: copied from `task_activity` | upstream `action` values as they are (e.g. `created`, `updated`, `status_changed`, …), with `changes` JSON in `data` | yes, from the activity row |
| `sync`: detected by snapshot diff | `deleted`, `restored`, `purged`, and `created` for a task first seen with no activity `created` event (e.g. bundle import) | none |
| `planner`: written by planner code | `planned`, `replanned`, `unplanned`, `carried_over`, `dropped`, `undropped` | yes, from the request |

"Completed" means a `status_changed` to `done`. Upstream `changes` holds only the new status (`packages/domain/src/tasks.ts`), so "reopened" (a change away from `done`) is derived later over the archived events with `LAG`. The executor must read upstream's real `action` enum and `changes` shape before mapping.

`occurred_at` and `data` for each type:

- **Activity events**: `occurred_at` is the activity's `created_at`; `data` is `changes`.
- **Sync events**:
  - `created`: `occurred_at` is `tasks.created_at`. `data` is a baseline `{status, project_id, due_at}`, because upstream's `created` activity doesn't log `due_at`.
  - `deleted`: `occurred_at` is `tasks.deleted_at`.
  - `restored` and `purged`: `occurred_at` is the sync time, and `data.detected` is `true`.
- **Planner events**:
  - `occurred_at` is the request time.
  - `dropped` stores `previous_due_at` in `data`, because that's the only reliable record of the cleared due date (D1).
  - `planned`, `replanned`, `unplanned` and `carried_over` store `{from, to}` as `{horizon, period_start}`.

### History sync: `plannerSyncHistory(db, { userId, now })`

It returns `{ history: "ok" | "paused" }` and **never throws**. The whole function, compatibility check included, is wrapped in try/catch. On any error it records `paused` with the reason (best effort) and returns `paused`. Callers always carry on, so rollover step 2, the board and history reads still run.

0. **Debounce.** If `last_sync_at` is under 30 seconds old, return the stored status without syncing.
1. **Compatibility check.**
   - `PRAGMA table_info` on `tasks`, `task_activity` and `projects` must include every column the sync and the board read. Keep that list in one exported constant, tested against Drizzle's `getTableColumns`. If a column is missing: record `paused` with the reason, return `paused`, and copy nothing.
   - Also compare the distinct `task_activity.action` and `tasks.status` values in use against the known sets from upstream's Drizzle enums. On drift, keep syncing but record a warning in `paused_reason` while status stays `ok`. Unknown statuses go to the board's `other` bucket.
2. **Copy activity** with `INSERT … SELECT … WHERE … ON CONFLICT DO NOTHING`.
   - Never `INSERT OR IGNORE`: it silently drops rows that break NOT NULL.
   - The SELECT needs a `WHERE` clause before `ON CONFLICT` so SQLite parses it.
   - **Rows**: from `task_activity` where `user_id = ?`, `task_id IS NOT NULL`, and either `id > activity_last_id` or `created_at >= watermark − 10 minutes`. The id clause catches bundle-import rows written with back-dated `created_at` (`packages/domain/src/import-export/import-data.ts`). The time clause catches rows after an upstream rebuild restarts ids. With no state yet, copy everything.
   - **Window**: compute "watermark − 10 minutes" in JS (`toISOString()`) or with `strftime('%Y-%m-%dT%H:%M:%fZ', …)`, never `datetime()`, whose format differs.
   - **`source_ref`**: `'a:' || task_id || '@' || created_at || '|' || action || '|' || coalesce(changes, '')`. It contains no id, so renumbered rows and skip-mode re-imports can't duplicate the archive.
   - **`task_title`**: the current task title, falling back to the snapshot title.
   - **State**: the new `activity_watermark` is the max `created_at` copied. `activity_last_id` is the current max `id` of the user's `task_activity` rows, which may go down after an upstream rebuild.
3. **Snapshot diff.** These run in the same batch as step 2's state update, in this order: restored, deleted, purged, created, then the snapshot upsert. Here `t` is a current task row and `s` its snapshot row.
   - **`restored`**:
     - When: `s.deleted_at IS NOT NULL AND t.deleted_at IS NOT s.deleted_at`. This also covers "restored, then deleted again".
     - `source_ref = 'res:' || task_id || '@' || s.deleted_at`.
   - **`deleted`**:
     - When: `t.deleted_at IS NOT NULL AND (s.task_id IS NULL OR s.deleted_at IS NOT t.deleted_at)`. This also covers a task created and deleted between two syncs.
     - `source_ref = 'del:' || task_id || '@' || t.deleted_at`.
     - Skip it when an activity event of type `deleted` already exists for the task with `occurred_at = t.deleted_at`. That guards against a future upstream `deleted` action.
   - **`purged`**:
     - When: a snapshot row with no `tasks` row.
     - `source_ref = 'pur:' || task_id`, with the title from the snapshot.
     - Then delete that task's plan and snapshot rows.
   - **`created` (sync)**: a task with no snapshot row and no `created` event yet. `source_ref = 'new:' || task_id`.
   - **Snapshot upsert**: upsert the snapshot for every current task with `ON CONFLICT DO UPDATE … WHERE` a tracked field changed (`excluded.title IS NOT title OR …`). Unchanged rows aren't rewritten.
   - **Orphan nodes**: delete `planner_project_node` rows whose project no longer exists (purged); their children's parent becomes NULL.
4. **Idempotent**: a second run with no upstream change adds no events and rewrites no snapshot rows. This is tested via D1 `meta.changes`.

Known gaps:

- A delete followed by a purge before the next sync isn't recorded, although the task's earlier archived events remain.
- A delete followed by a restore between two syncs is invisible, because upstream doesn't log delete or restore activity.

Both need the cockpit to stay unopened across the event. The first also needs 30 days of trash retention to pass.

### Rollover (v2 audit M2): `POST /api/app/planner/rollover {today}`

1. Run the history sync. Whatever it returns, continue.
2. Run one D1 batch of two statements sharing a predicate. The predicate selects a plan whose horizon is set, `dropped_at` is NULL, whose task exists, isn't deleted and isn't `done`, and whose `period_start` is before the target period.
   - Target period: `CASE horizon WHEN 'day' THEN :day WHEN 'week' THEN :week ELSE :month END`.
   - Statement 1: `INSERT … SELECT` `carried_over` events (planner source; `data` holds from and to).
   - Statement 2: `UPDATE` those plans to the target period and add 1 to `carry_count`.
3. Two concurrent rollovers must give exactly +1 carry and one event per task. This is tested.

The response is `{ history, carried }`.

### Board: `GET /api/app/planner/board?today=&done_days=14&include_dropped=false`

- **Query**: one Drizzle query over the user's non-deleted `tasks`, LEFT JOIN plan, LEFT JOIN `projects` (name only). It selects explicit columns, with no `notes`.
- **Grouping**: dropped takes precedence over status.
  - Dropped: plans with `dropped_at` set, whatever the status. Returned only with `include_dropped`, as a separate list.
  - Backlog: not dropped, `todo`, with no plan or a plan with a NULL horizon.
  - To Do: not dropped, `todo`, with a horizon.
  - Doing: not dropped, `in_progress`.
  - Done: not dropped, `done`, with `completed_at` within `done_days`.
  - Other: any unknown status (see the compatibility check). Shown only when it isn't empty.
- **Undrop**: an undropped task lands where its status and kept plan put it. A `todo` task with a horizon goes to To Do, otherwise Backlog.
- **Cap of 500 cards**: To Do and Doing are never cut. Backlog and Done share the rest, newest first, and the response sets `truncated: true` when it cuts.
- **Response**: `{ columns, today, periods: { day, week, month }, history: "ok" | "paused", truncated }`. The history status comes from `planner_sync_state`.

### Column moves (v2 audit m10)

| From → To | Effect |
|---|---|
| Backlog → To Do | Plan = this week (default); `planned` event |
| To Do → Backlog | Plan cleared; `unplanned` event |
| Backlog or To Do → Doing | Status `in_progress`; plan kept |
| any → Done | Status `done`; plan kept for history |
| Doing → To Do | Status `todo`; with no plan (or a NULL horizon), plan = this week |
| Doing or Done → Backlog | Status `todo`; plan cleared |
| Done → To Do | Status `todo` (reopened); if the plan is missing, has a NULL horizon or is past, plan = this week |
| Done → Doing | Status `in_progress` |

- **Status changes** go through upstream `updateTask`, which logs its own activity.
- **The card menu** offers "Move to…" plus plan choices: Today, Tomorrow, This week, Next week, This month, Next month, or a picked day.
- **Drop and undrop**: drop follows D1, and the `dropped` event stores `previous_due_at`. Undrop doesn't restore the old due date.

### Create: `POST /api/app/planner/tasks {title, today, plan?, due_at?, project_id?, notes?, priority?}`

1. Upstream `createTask` with status `todo`.
2. One batch writes the plan row and a `planned` event, when a plan is given.

If step 2 fails, the endpoint returns 201 `{task, plan: null, plan_error}`. The card lands in Backlog and offers "Retry plan".

### Other routes, all under `/api/app/planner`

- `PATCH /tasks/:id` — `{ today, column?, plan?, dropped?, title?, notes?, priority?, due_at?, project_id? }`, answering `{ task, plan }`. Upstream fields go through `updateTask`, planner fields through planner services.
  - `column` (`backlog` | `todo` | `doing` | `done`) replaces `status`. The move table above lives only on the server: the client sends the target column and the server sets the status and the plan (`plannerApplyColumnMove`). `column` and `plan` together are a 400, since a move sets the plan itself. `status` and `sort_order` are not accepted here.
  - Apply order, each step only when its field is present:
    1. `dropped: false` (undrop), so one request can revive and move a dropped task.
    2. The upstream fields through `updateTask`, only those given. A request with none never calls it.
    3. `column`, or else `plan` (`plannerSetPlan`).
    4. `dropped: true` last, so a due date set in the same request is the one the `dropped` event remembers before it is cleared.
  - Not atomic: a step that fails leaves the earlier ones applied, because task rows may change only through upstream services.
- `GET /tasks/:id/history` — sync first, then events ordered by `occurred_at`, then `id`, newest first.
- `GET /history?from&to` — the user's events in a range, after a sync.
- `GET /tree` — non-deleted projects merged with their node rows. A child whose parent project is soft-deleted shows as a root.
- `PATCH /tree/:projectId` — upserts the node: `{parent_project_id, level, period_start, period_end, sort_order}`. Use PATCH, not PUT: the Worker's CORS `allowMethods` has no PUT (`apps/worker/src/index.ts`).
  - Checks that the project, and the parent if one is given, belong to the user.
  - Upserts with `ON CONFLICT(project_id) DO UPDATE`. Never use `INSERT OR REPLACE`: it deletes the row, which sets every child's parent to NULL through the self-FK.
  - Rejects cycles inside the write itself (`… WHERE NOT EXISTS (WITH RECURSIVE ancestors …)`) rather than read-then-write.
  - Depth is capped at 6. The check counts the new parent's depth plus the height of the subtree being moved.
- `GET /tree/:projectId/rollup?from&to` — `WITH RECURSIVE … UNION` (not `UNION ALL`, so a stray cycle can't loop) over the subtree. It excludes deleted tasks and dropped plans, and counts per node and in total:
  - open and done tasks (by `tasks.project_id`)
  - planned in range (plans with `period_start` in range)
  - done in range (`completed_at` in range)
  - carried in range (`carried_over` events with `occurred_at` in range)

### Route conventions

- **Auth and errors**: use upstream's exported `getRequestContext` and `jsonError`, as `tasks-api.ts` does.
- **Actor**: `resolveActor` isn't exported from `tasks-api.ts`, so make a fork-local copy in `planner-api.ts`.
- **Rate limiting**: mutations use the exported `rateLimitGuard` with the bucket `"planner"`.
- **Validation**: zod or whatever `tasks-api.ts` uses, with the same error envelope.

## 5. Web

New files live under `apps/web/src/planner/`.

- **`api.ts` and `query-keys.ts`**: the client uses upstream's `apiRequest`, with keys under `["planner", …]`.
- **`strings.ts`**: English and zh-CN copy for the cockpit, chosen by `useI18n().locale` and falling back to English.
- **`nav-link.tsx`**: `<PlannerNavLink/>`, so the explorer edit is an import plus one element.
- **`cockpit-page.tsx`**:
  - Wrapper: `WorkspaceLayout` and `WorkspacePageHeader`, exactly like `apps/web/src/pages/projects-page.tsx`.
  - Header: quick add (a title plus a horizon chip: Backlog / Today / This week / This month) and horizon filter chips (All · Today · This week · This month).
  - Columns: Backlog · To Do · Doing · Done.
  - Notice: a quiet "history paused" notice when the board says so.
  - Card: the status icon, title, horizon chip ("Today", "Wed 8", "This week", "Oct"), a "carried ×N" badge, the due chip, the project chip and a menu.
    - Reuse `apps/web/src/pages/projects/task-card.tsx`, `constants.ts` (status and priority helpers) and `task-form-dialog.tsx` (full edit) by import.
    - If `TaskCard` can't take the extra chips, build a `PlannerTaskCard` from the same exported pieces rather than editing upstream.
- **`board.tsx`**: dnd-kit, modelled on `pages/projects/board.tsx`, with touch sensors, plus the "Move to…" menu so moves work on a phone.
- **`plan-picker.tsx` and `history-sheet.tsx`**: the history sheet is a per-task timeline from the archive, showing who and when.
- **On open**: the page runs rollover once, then fetches the board.
- **After any mutation**: invalidate `["planner"]`, upstream's task query keys and `["projects"]`.

## 6. Tests

- **Contracts**:
  - period helpers: Monday rule, UTC, DST, month ends, leap day
  - the bounds on `today`
  - the level slug
- **Domain**, using the pattern in `packages/domain/src/projects.test.ts` (`createTestRuntime` lives in `apps/worker` and isn't usable here) plus `applyPlannerMigrations`, deep-imported from `@flaremo/db/src/planner-migrations`:
  - history sync:
    - activity copy with actor
    - idempotency: a second run adds no events and no snapshot writes, checked with `meta.changes`
    - the 30-second debounce
    - the overlap window
    - delete, restore and purge detection
    - created then deleted between syncs
    - deleted, restored, deleted again
    - bundle-import back-dated activity is archived
    - `created` for a task without activity
    - title snapshot after purge
  - compatibility: with a required column missing from a table copy, the sync returns `paused` and upstream task writes still succeed
  - failure injection: a thrown D1 error inside the sync returns `paused`, and rollover step 2 and the board still work
  - tree: an upsert of a parent keeps its children's `parent_project_id`; moving a subtree respects depth including its height; a forced cycle doesn't loop the roll-up
  - rebuild survival: a 0025-shaped `tasks` rebuild through the batch path leaves planner tables and the archive intact, and the next sync records the gap honestly
  - rollover: idempotent, and two concurrent batches give one carry each
  - board: grouping, filters, the cap
  - tree: cycle and depth rejection, and roll-ups
- **Worker**:
  - every endpoint with real auth, as in `tasks-api.test.ts`, including 401 and the Origin rules
  - the upstream-flows suite (`apps/worker/src/routes/planner-upstream-compat.test.ts`) with the planner installed:
    - task create, update, status change, delete and restore, reorder
    - project delete, restore and purge, plus `hardDeleteExpiredTasks`
    - member removal
    - overdue notifications
    - convert-to-task
  - Assert that upstream results are unchanged and the expected archive events appear after a sync.
- **Web**: unit tests for column grouping, the transition table and labels.
- **E2E**: `tests/e2e/cockpit.spec.ts` covers the deep link, the anonymous redirect, the nav link and quick add (v1.1 adds the column "+" and task panel cases, section 13). Register it by adding `cockpit` to the `memo-ui` `testMatch` regex in `playwright.config.ts`. Written, not run (G8).

## 7. Hook-in edits (the only upstream files touched)

1. **`apps/worker/src/index.ts`**: `mountLazyRoute(app, "/api/app/planner", …)` loading `./routes/planner-api`, placed before `app.route("/api/app", appApi)`. Follow the neighbouring `mountLazyRoute` calls exactly. `scripts/startup-graph.mjs` is a report, not a gate: run it and confirm `planner-api` and `packages/domain/src/planner` aren't in the startup graph.
2. **`packages/contracts/src/index.ts`**: append `export * from "./planner";`.
3. **`scripts/persistence-manifest.mjs`**: append the planner tables to `RESTORE_TABLES`: the five from `9000`, and `planner_task_comment` from `9001` (v1.1). `pnpm persistence:check` must pass.
4. **`apps/web/src/router-tree.tsx`**: a lazy `CockpitPage` and a `cockpitRoute` with the literal `path: "/cockpit"`, registered beside `teamProjectsRoute`. v1.1 adds one import and `validateSearch: plannerCockpitSearch` on that route (the `?task=` address, section 13); the validator lives in `planner/cockpit-search.ts`.
5. **`apps/worker/src/spa-routes.ts`**: add `"/cockpit"`.
6. **`apps/web/src/components/flaremo-explorer.tsx`**: an import plus `<PlannerNavLink/>` after the team-projects link.
7. **`playwright.config.ts`**: append `cockpit` to the `memo-ui` `testMatch` regex.
8. **`apps/web/public/sw.js`**: add `cockpit` to `privateRoutes`.

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

Each step group ends with targeted tests green, `pnpm format`, the guard command and one or more commits on local `main`. The orchestrator reviews and pushes.

- **A. Baseline, schema and migration** (steps 0 and 1):
  - Set `planner-base` to the `main` SHA at the start, record it in section 11, and create it as a local tag.
  - Schema, `9000_planner_init.sql`, `applyPlannerMigrations`, the manifest entries and the period contracts, with tests.
  - Confirm locally that Wrangler applies the unjournaled `9000` file after `0033`, using a temp `--persist-to` directory.
- **B. History sync and domain services** (steps 2 and 3): sync, plans, rollover, board, tree and roll-ups, plus the upstream-flows suite.
- **C. Routes** (step 4): `planner-api.ts`, the lazy mount and the API tests.
- **D. Web** (step 5): the cockpit page and the hook-ins.
  - unit tests and `pnpm --filter @flaremo/web typecheck`
  - the e2e spec, written
  - check the page by eye in a local dev server at desktop and phone width
- **E. Docs and dev deploy** (steps 6 and 7):
  - this runbook and the requirements status
  - deploy to `flaremo-dev` with `scripts/fork/dev-env.mjs`, from a clean worktree at the pushed commit
  - smoke-test, then the owner runs QA

Live is deployed by hand only after the owner's QA.

## 9. Runbook

- **History paused**: upstream changed a column the sync reads. Update the column list and mapping in `packages/domain/src/planner/`. Copying resumes from the watermark, so nothing is lost unless tasks were purged meanwhile.
- **Restores and drills**: nothing special. There are no triggers, and the planner tables are in `RESTORE_TABLES`.
- **Upstream updates**: merge upstream `main` (`git merge`), keep both sides in the hook-in files, and run the planner test files. Deploy to dev first.
- **Rollback**: revert the planner commits. Optionally drop the planner tables, in this order: event, plan, seen, sync_state, node.
- **Removing a team member**: planner rows have no foreign key to `users`. Delete them by `user_id` by hand; not needed for a single user.
- **Upstream note**: migration 0025's rebuild ran inside a batch, so upstream's own `task_activity` rows were wiped when it deployed. This is an upstream issue, and it's why the archive exists.

## 10. Checklist

Guard command (run before every commit). It must print only section 7 hook-in files:

```sh
git diff --name-only planner-base..HEAD | grep -v -E '^(docs/planning-cockpit|docs/fork-|scripts/fork/|packages/db/src/schema/planner\.ts|packages/db/src/planner-|migrations/9[0-9]{3}_planner_|packages/contracts/src/planner|packages/domain/src/planner/|apps/worker/src/routes/planner-|apps/web/src/planner/|tests/e2e/cockpit\.spec\.ts)'
```

Conformance:

- [ ] The guard prints only section 7 files
- [ ] No foreign key from a planner table to an upstream table; no SQL triggers
- [ ] Applied `9xxx` files are unedited; migrations are additive only
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

- [x] A Baseline, schema and migration
- [x] B History sync and domain services
- [x] C Routes
- [x] D Web cockpit
- [ ] E Docs and dev deploy
- [x] v1.1 Column "+" and task panel (section 13)

Acceptance:

- `/cockpit` shows Backlog, To Do, Doing and Done with real tasks on desktop and phone. Adding, moving, re-planning, setting a due date and dropping all work.
- Unfinished planned tasks move into the current period with "carried ×N". Two concurrent rollovers give one carry each.
- Task history shows every change with its actor where upstream records one, including edits from `/projects` and the API. It survives purges and upstream table rebuilds.
- The tree API handles a nested project tree with roll-ups (tested).
- `/projects`, overdue reminders, convert-to-task and member removal behave as before; the compat suite is green.

## 11. Log

- planner-base: 80287b09aba4003b977bbcbdb6d19d8a1b41f12e (2026-10-04)
- v1.1 task panel (section 13): built 2026-10-06 on `main` at `cd24c41980892a13edb6dab96121b41da2116e3e`, as one branch of commits (data, contracts and API, web, e2e and docs, then the dev-env test fixture and a polish pass). The guard still prints only the eight hook-in files.

## 12. Audit resolution

v2 (2026-10-04) findings that still apply in v3:

- **B1**: no foreign keys to upstream tables; explicit joins; purge clean-up; rebuild-survival test.
- **M2**: set-based rollover.
- **M3**: Monday week start and UTC maths.
- **M5**: the e2e spec is registered.
- **M6**: the upstream-flows suite.
- **Minor**: m2 (export prefixes, deep import), m7 (rate-limit bucket), m8 (board query), m9 (create fallback), m10 (transition table), m11 (date bounds), m13 (invalidate `projects`), m14 (`sw.js`), m15 (header comments) and m17 (minimal explorer edit, literal route path).

v2 findings that v3 removes by design:

- **M1 trigger hazards** and **M4 actor capture**: there are no triggers, and the actor comes from the copied activity rows.

v3 focused re-audit (Opus, 2026-10-04) found 0 blockers, 4 major and 6 minor issues. All were adopted above:

- **Major 1**: the delete and restore predicates now cover tasks not live at the last sync, run restored before deleted, list the new gap, and have tests.
- **Major 2**: the `activity_last_id` plus watermark selection catches back-dated import activity; `source_ref` has no id.
- **Major 3**: the sync never throws (try/catch, `paused` with a reason), callers always continue, it uses `ON CONFLICT DO NOTHING` instead of `OR IGNORE`, and there's a failure-injection test.
- **Major 4**: `scripts/fork/dev-env.mjs` computes migration levels per track (upstream `0NNN` versus fork `9NNN_planner_`), with unit tests.
- **Minor**:
  - conditional snapshot upsert and a 30-second debounce
  - `occurred_at` and `data` semantics, a `created` baseline, and `previous_due_at` on `dropped`
  - a wider compatibility check (projects, enum drift, an `other` bucket)
  - tree upsert, cycle, depth and `UNION` rules, plus roll-up exclusions
  - board precedence for dropped and undrop placement
  - mechanics: guard regex, deep import, startup-graph as a report, PATCH for `/tree`, the domain test pattern, a `resolveActor` copy, and JS/`strftime` time maths

The verified-OK list is in the canonical doc log.

## 13. v1.1 task panel

Built 2026-10-06. The owner asked for the Notion-style task experience: a "+" in each column header that adds straight into that column, click a card to open it (the card's menu stays for quick actions), and an opened task with clickable properties (Status, Due date, Effort, Goal, Priority, Quarter, plus Plan), a notes box and a comments section. Same guardrails as the rest of the plan: no foreign keys to upstream tables, no triggers, additive migrations, task rows change only through upstream services, no new Cloudflare bindings. The guard still prints only the eight hook-in files (section 7).

### What shipped

- **Column "+"**: Backlog, To Do, Doing and Done have a "+" in the header (the Other bucket has none). It opens an inline composer at the top of the column. Enter adds and keeps the composer open and focused for rapid entry, Esc closes, leaving it empty closes it, leaving it with text keeps it, an IME Enter does not send, and a failed add puts the text back. Where the task lands follows the column and the filter chip:

  | Column | Plan |
  |---|---|
  | Backlog | none, whatever the chip says |
  | To Do | the chip's period; All means today |
  | Doing, Done | the chip's period; All means no plan |

  The card shows at once as a pending card (dimmed, inert, not draggable), then is swapped for the server's card or removed with a toast.
- **Click to open**: a click anywhere on a card opens it; the title is a real `<button>` (Enter and Space work, focus returns to it on close). The status icon and the ⋯ menu keep their own jobs, and a drag never opens the card: dnd-kit swallows the click that ends a drag, and a test with the real library proves it. The Dropped list opens a task the same way.
- **Task panel**: a right-hand sheet, 34rem wide and the whole screen under the `sm` breakpoint.
  - An editable title (Enter or blur saves, Esc puts the saved one back; an empty title is never saved).
  - Property rows, each a clickable value: Status (pill menu of the four columns, or Undrop), Plan (the card menu's choices, read-only for a finished or dropped task), Due date (a date field, with an X to clear), Priority, Goal (live projects shown by their goal path), Effort (a number) and Quarter (derived, read-only). An unset property says "Empty".
  - Notes that save by themselves, 800 ms after typing stops (at most about 12 saves a minute, T11) and on blur ("Saving…", "Saved", "Couldn't save" with Retry; typed text is never thrown away).
  - Comments, oldest first, each with "You", a relative time (the exact time on hover and for screen readers) and an "edited" mark; edit in place; delete behind an AlertDialog; Enter sends and Shift+Enter adds a line.
  - History, folded until opened (it shares the timeline of the card menu's History sheet), and a created/updated footer. "Updated" is the later of the task's time and its plan row's, because an effort, a plan or a drop changes only the plan row.
  - A dropped task shows a banner with Undrop and offers nothing else.
- **Address**: `/cockpit?task=<id>` opens the panel, so it can be linked to and reloaded. The back button closes it; closing leaves no stray history entry (it goes back when this page opened the panel and replaces the address when the link did).
- **Strings**: English and Simplified Chinese in `strings.ts`, covered by the parity test.

### Migration `9001_planner_task_details.sql`

Hand-written, unjournaled, additive, no foreign keys, no triggers. Wrangler applies it after `9000`; vitest applies it through `applyPlannerMigrations`. It is also safe for the previous release: the new column is nullable and nothing old reads the new table.

```sql
ALTER TABLE `planner_task_plan` ADD COLUMN `effort` real;
--> statement-breakpoint
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
```

`planner_task_comment` joins the restore manifest (`RESTORE_TABLES`), and `planner-upstream-compat.test.ts` now expects six planner tables.

### API changes, under `/api/app/planner`

| Route | Change |
|---|---|
| `GET /tasks/:id` | New. `{ task, plan, project, comments }`: the whole upstream task (notes included), its plan with `effort` (`null` when there is no plan row; a row with a null horizon only holds an effort), its goal as `{ id, name, ancestors }` with the live ancestors from the goal tree, root first, and its comments oldest first without the deleted ones. 404 for a missing, binned or another user's task. |
| `PATCH /tasks/:id` | Gains `effort`: a number from 0 to 999 with at most one decimal, or `null` to clear. Applied after `column` or `plan` and before a drop. It never moves the task and is allowed on a dropped one. |
| `POST /tasks` | Gains `column`. `backlog` refuses a plan (400), `todo` requires one (400), `doing` and `done` take an optional plan. Without `column` it behaves as before. |
| `GET /tasks/:id/comments` | New. `{ comments }`, oldest first. |
| `POST /tasks/:id/comments` | New. `{ body }`, answering 201 `{ comment }`. |
| `PATCH /comments/:id` | New. `{ body }`, answering `{ comment }` with a later `updated_at`. |
| `DELETE /comments/:id` | New. A soft delete, answering `{ ok: true }`. It is a real DELETE: the API's CORS allow-list already has it. |

- **Comment rules**: the text is trimmed and must be 1 to 5000 characters. Another user's task or comment is a 404. Comment writes use the same `planner` rate-limit bucket as every other mutation, and the same Origin rules.
- **New event types** (source `planner`, written in the same batch as the change, M3): `effort_changed` with `{ from, to }`, and `commented`, `comment_edited` and `comment_deleted`, which carry only `{ comment_id }`. A comment's text never enters the history archive. The history labels read "Effort set to 3.5", "Effort cleared" (with "Was 2"), "Comment added", "Comment edited" and "Comment deleted".
- **Contracts**: `plannerPlanDtoSchema` gains `effort`; new `plannerEffortSchema`, `plannerCommentBodySchema`, the comment and detail schemas, and `plannerQuarterLabel`.

### Decisions

- **T1 Effort lives on the plan row.** There is no new task column, and the upstream `tasks` table is untouched. A backlog task gets a plan row with a null horizon only to hold its effort; the board already reads a null horizon as Backlog, so such a row plans nothing, and clearing a plan keeps the row for the same reason.
- **T2 Effort is a number from 0 to 999 with one decimal.** `0` is an estimate, different from none (`null`). A comma is accepted as the decimal point in the field.
- **T3 Comments are soft-deleted and outlive their task**, like the history archive, so `task_id` has no foreign key. There is no restore for a deleted comment in v1.1.
- **T4 Doing and Done are created in one write.** `plannerCreateTask` passes the column's status to upstream `createTask`, rather than creating a `todo` task and updating it, so there is no half-created state and the history shows one `created` entry. This changes the "Create" description in section 4 for those two columns.
- **T5 The panel reads one endpoint.** `GET /tasks/:id` carries everything the panel shows, so opening a task is one request. The board's card still leaves `notes` out.
- **T6 Notes are upstream's `notes` field**, saved through `PATCH /tasks/:id` (empty notes are `null`). There is no second copy.
- **T7 Quarter is derived, not stored**: the calendar quarter (UTC maths) of the plan's period start, else of the due date, shown as "Q4 2026". It cannot be edited; planning or setting a due date changes it.
- **T8 Goal is upstream's `project_id`.** The menu lists live (active, not binned) projects by their goal path from the tree, and keeps an archived project in the list while the task still points at it.
- **T9 The address is the panel's state.** `?task=<bare id>` (without `tasks/`), read by `usePlannerTaskParam` and validated by `plannerCockpitSearch`. The route's `validateSearch` is one line in `router-tree.tsx`, which is why the validator is a fork-owned module and not inline.
- **T10 One optimistic engine for the board and the panel.** Every edit patches the board's cache and the open panel's cached detail together, rolls both back with a toast when the server refuses, and refreshes (`["planner"]`, upstream's task keys and `["projects"]`) only once the last change in flight has settled. Edits made in the panel are silent on success, because the panel shows the new value in place; the board's own actions still toast.
- **T11 Autosave rules** (`use-planner-autosave.ts`, tested with fake timers): a change that is the same once trimmed is never sent; two saves never overlap, and typing during a save sends one more with the newest text; saves the typing timer starts are at least 5 s apart, counted from the start of the previous save, so autosave makes about 12 a minute at most and typing leaves room for moves and comments in the shared 30-a-minute `planner` write bucket (a pause that ends inside the gap is held, never dropped; a blur, Retry and closing the panel ignore the gap and save at once); a failed save keeps the text and is retried by the next edit (after the gap), the next blur or Retry; the server's value is adopted only while nothing is unsaved; closing the panel saves what is left.
- **T12 Click versus drag.** The card's click handler ignores clicks that start inside a button, link, field, label or menu (including portaled menu items, which are React children but not DOM children of the card). Pending cards are inert. Escape inside a field of the panel (title, effort, due date, a comment being edited) belongs to the field: it never closes the panel.

### Files

All under `apps/web/src/planner/` unless noted.

- **Add**: `column-composer.tsx`, `column-add.ts`, `task-panel.tsx`, `task-panel-properties.tsx`, `task-panel-notes.tsx`, `task-panel-comments.tsx`, `use-planner-autosave.ts`, `use-task-param.ts`, `cockpit-search.ts`, `panel-model.ts`, `effort.ts`, `history-timeline.tsx` (the timeline the History sheet and the panel share).
- **Change**: `board.tsx`, `task-card.tsx`, `dropped-list.tsx`, `board-model.ts`, `use-planner-actions.ts` (adds `setTitle`, `setPriority`, `setProject`, `setEffort`, `createIn`), `plan-picker.tsx` (`PlannerPlanMenuItems`, shared by the card menu and the panel), `history-labels.ts`, `history-sheet.tsx`, `api.ts`, `query-keys.ts`, `strings.ts`, `cockpit-page.tsx`.
- **Elsewhere**: `migrations/9001_planner_task_details.sql`, `packages/db/src/schema/planner.ts`, `packages/domain/src/planner/` (`comments.ts`, `task-detail.ts`, effort and create-in-column in `plans.ts`), `packages/contracts/src/planner.ts`, `apps/worker/src/routes/planner-api.ts`, and the two hook-in lines above.

### Tests

- **Domain and db**: `comments.test.ts`, `task-panel.test.ts` (detail, effort, create-in-column) and the 9001 cases in `planner-migrations.test.ts` (including applying 9001 on top of a 9000 database that has rows).
- **Dev environment script** (`scripts/fork/dev-env.test.mjs`): the planner-track fixture now copies only upstream's migrations next to its stand-in planner file (the real 9001 alters a table the stand-in lacks), and a new case runs the fork's real files through the clone: production at 9000, this checkout adds 9001, so dev gets production's data and then rehearses 9001.
- **Contracts and worker**: the effort, comment, column and detail schemas; the endpoint table, Origin, rate-limit and CORS tests extended to the new routes; new suites for detail, effort, create-in-column and comments (happy paths, 401, 404 for another user's records, 400 validation, PAT).
- **Web**, with the network replaced and the real query cache: `use-planner-actions.test.tsx` (optimistic edits on both views, rollback, create-in-column); `board-interactions.test.tsx` (real dnd-kit click versus drag, the "+" buttons and composer, per-column and per-chip add targets); `task-card.test.tsx`; `task-panel.test.tsx` (loading, 404, error, every property, menus, title, effort, due date, dropped banner, history, footer); `task-panel-notes.test.tsx` (fake timers); `task-panel-comments.test.tsx`; `use-task-param.test.tsx` (a real router on an in-memory history); `use-planner-autosave.test.ts`; and the pure modules (`panel-model`, `effort`, `column-add`, `history-labels`, `api`).
- **E2E** (`tests/e2e/cockpit.spec.ts`, written, not run, G8): a column's "+" adds into that column; the composer's close rules; a click opens the panel and Escape closes it; a click on a chip opens it while the ⋯ menu does not; the link, the back button and closing a linked panel; a link to a missing task; notes saved and kept after a reload; a comment sent, kept and deleted after a confirmation; properties saved while the card follows; a drag does not open the panel. Both languages are matched. While the panel is open the board behind it is hidden from the accessibility tree (the sheet is modal), so the cases close the panel before they look at the board.
- Unit tests caught one bug before it shipped: in the title and effort fields Esc put the saved text back, but the blur it caused ran the save with the text as last rendered, so the text Esc discarded was saved. A ref now tells the save it is reverting.

### Not in v1.1

- Markdown, attachments, mentions or reactions in comments; comment pagination (the detail carries all of a task's comments); restoring a deleted comment; other authors' names (there is one user, shown as "You").
- Editing the quarter, the source memo or the sort order from the panel; a next/previous card shortcut.
