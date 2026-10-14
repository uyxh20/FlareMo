# Planning cockpit — implementation plan (v3, reuse-first)

Status: built and live (v3 design, 2026-10-04, with later additions in sections 13 and 14). History copies the upstream activity log (no triggers), goals are weekly goals (the first design's project tree was removed on 14 Oct 2026), and the board reuses upstream components.

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
- **Weekly and monthly review is not in v1** ("Next"). There is no goal UI in v1. (A goal tree over upstream projects was built in v1 and removed on 14 Oct 2026, after weekly goals replaced it; its table stays.)
- **Fresh start from Notion.** No importer.
- **Cloudflare only, no new services.** Same Worker and D1, with no new bindings, crons, queues or secrets.
- **Isolated add-on.** No change to upstream tables, columns or the Drizzle journal; upstream files are touched only at the section 7 hook-ins.
- **Reuse first.** Use upstream services, components and helpers wherever they already work.

Build defaults (adopted for the build; the owner can change them after QA):

- **D1 Dropping a task clears its `due_at`** through upstream `updateTask`. The old value stays in history, and the dropped task stops sending overdue alerts.
- **D2 The cockpit lives at `/cockpit`**, beside `/projects` in navigation.
- **D3 Goals are upstream projects arranged in a tree** (`planner_project_node`). Superseded: weekly goals replaced it (T8), and the tree code was removed on 14 Oct 2026. Tasks belong to goals through upstream `tasks.project_id`. A node's `level` is a validated slug (`^[a-z][a-z0-9-]{0,23}$`, for example `area`, `year`, `quarter`, `goal`, `milestone`), so adding a level needs no schema change.
- **D4 History is a permanent copy of upstream `task_activity`**, plus delete, restore and purge detection by comparing `tasks` with a snapshot. No SQL triggers anywhere.
- **Sync timing**: history syncs whenever the board is fetched (the GET runs it) and before history reads. The existing daily scheduled maintenance also syncs every user right before and right after upstream's trash purge (`plannerSyncAllUsers`, two hook-in lines in `apps/worker/src/scheduled-tasks.ts`), so a task deleted while the cockpit stays shut is still archived. No new cron is added.

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

The tables, hand-written in `migrations/9000_planner_init.sql` (the file is the schema reference; later `900x` files add columns and tables):

- `planner_task_plan`: one row per planned task, keyed by upstream `tasks.id` with no FK (G10): horizon, period start, carry count, dropped time.
- `planner_task_event`: the permanent history archive. A unique index on (`source`, `source_ref`) where `source_ref` is set makes copying idempotent. History outlives the task, so there is no FK.
- `planner_task_seen`: the snapshot used to detect delete, restore and purge.
- `planner_sync_state`: per-user watermark, last id, last sync time, and `ok` or `paused` with a reason.
- `planner_project_node`: the old goal tree over upstream projects, with a self-referencing parent (`ON DELETE SET NULL`), a level slug, a period and a sort order. Nothing reads it since the tree code was removed (14 Oct 2026); the table stays under the additive-only rule, and the history sync still deletes the rows of purged projects.

Statements are separated by `--> statement-breakpoint`.


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

### Event types

| Source | Types | Actor |
| --- | --- | --- |
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

The web stopped calling rollover in v1.2 (section 13.x); the route and service stay. The board GET runs the history sync.

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
| --- | --- |
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
- **On open**: the page fetches the board, and the board GET runs the history sync. The web no longer calls rollover (v1.2).
- **After any mutation**: invalidate `["planner"]`, upstream's task query keys and `["projects"]`.

## 6. Tests

- Every planner module has its own test file beside it; run them by path (`packages/contracts/src/planner*.test.ts`, `packages/domain/src/planner`, `apps/worker/src/routes/planner-*.test.ts`, `apps/web/src/planner`).
- Domain tests follow `packages/domain/src/projects.test.ts` and apply the planner migrations with `applyPlannerMigrations` from `@flaremo/db/src/planner-migrations`; `createTestRuntime` lives in `apps/worker` and is not usable there.
- `apps/worker/src/routes/planner-upstream-compat.test.ts` runs upstream task, project and notification flows with the planner installed and asserts upstream results are unchanged.
- `tests/e2e/cockpit.spec.ts` is registered in the `memo-ui` project but written, not run (G8).

## 7. Hook-in edits (the only upstream files touched)

The cockpit edits a few upstream files and nothing else (G7). The fork-wide table of upstream files with a hook-in is [fork-customizations.md](fork-customizations.md); the goals and weekly review additions are covered there too and in [planning-cockpit-goals-review.md](planning-cockpit-goals-review.md). Until that table lists every cockpit row, these are the files: `apps/worker/src/index.ts` (lazy mount of `/api/app/planner`), `packages/contracts/src/index.ts`, `scripts/persistence-manifest.mjs` (`RESTORE_TABLES`), `apps/web/src/router-tree.tsx`, `apps/worker/src/spa-routes.ts`, `apps/web/src/components/flaremo-explorer.tsx`, `playwright.config.ts`, `apps/web/public/sw.js` and `apps/worker/src/env.ts`.

Everything else is fork-owned and lives in planner-named paths (`schema/planner.ts`, `planner-migrations.ts`, `migrations/9xxx_planner_*.sql`, `contracts/src/planner*`, `domain/src/planner/`, `routes/planner-*`, `web/src/planner/`, `tests/e2e/cockpit.spec.ts`).

## 9. Runbook

- **History paused**: upstream changed a column the sync reads. Update the column list and mapping in `packages/domain/src/planner/`. Copying resumes from the watermark, so nothing is lost unless tasks were purged meanwhile.
- **Restores and drills**: nothing special. There are no triggers, and the planner tables are in `RESTORE_TABLES`.
- **Upstream updates**: merge upstream `main` (`git merge`), keep both sides in the hook-in files, and run the planner test files. Deploy to dev first.
- **Rollback**: revert the planner commits. Optionally drop the planner tables, in this order: event, plan, seen, sync_state, node.
- **Removing a team member**: planner rows have no foreign key to `users`. Delete them by `user_id` by hand; not needed for a single user.
- **Upstream note**: migration 0025's rebuild ran inside a batch, so upstream's own `task_activity` rows were wiped when it deployed. This is an upstream issue, and it's why the archive exists.

## 10. Guard command

Run this before every commit. It must print only the hook-in files listed in section 7:

```sh
git diff --name-only planner-base..HEAD | grep -v -E '^(docs/planning-cockpit|docs/fork-|scripts/fork/|packages/db/src/schema/planner\.ts|packages/db/src/planner-|migrations/9[0-9]{3}_planner_|packages/contracts/src/planner|packages/domain/src/planner/|apps/worker/src/routes/planner-|apps/web/src/planner/|tests/e2e/(cockpit|goals-review)\.spec\.ts)'
```

## 13. v1.1 task panel

Built 2026-10-06. The owner asked for the Notion-style task experience: a "+" in each column header that adds straight into that column, click a card to open it (the card's menu stays for quick actions), and an opened task with clickable properties (Status, Due date, Effort, Goal, Priority, Quarter, plus Plan), a notes box and a comments section. Same guardrails as the rest of the plan: no foreign keys to upstream tables, no triggers, additive migrations, task rows change only through upstream services, no new Cloudflare bindings. The guard still prints only the eight hook-in files (section 7).

### What shipped

- **Column "+"**: Backlog, To Do, Doing and Done have a "+" in the header (the Other bucket has none). It opens an inline composer at the top of the column. Enter adds and keeps the composer open and focused for rapid entry, Esc closes, leaving it empty closes it, leaving it with text keeps it, an IME Enter does not send, and a failed add puts the text back. Where the task lands follows the column and the filter chip:

  | Column      | Plan                                 |
  | ----------- | ------------------------------------ |
  | Backlog     | none, whatever the chip says         |
  | To Do       | the chip's period; All means today   |
  | Doing, Done | the chip's period; All means no plan |

  The card shows at once as a pending card (dimmed, inert, not draggable), then is swapped for the server's card or removed with a toast.

- **Click to open**: a click anywhere on a card opens it; the title is a real `<button>` (Enter and Space work, focus returns to it on close). The status icon and the ⋯ menu keep their own jobs, and a drag never opens the card: dnd-kit swallows the click that ends a drag, and a test with the real library proves it. The Dropped list opens a task the same way.
- **Task panel**: a right-hand sheet, 34rem wide and the whole screen under the `sm` breakpoint.
  - An editable title (Enter or blur saves, Esc puts the saved one back; an empty title is never saved).
  - Property rows, each a clickable value: Status (pill menu of the four columns, or Undrop), Plan (the card menu's choices, read-only for a finished or dropped task), Due date (a date field, with an X to clear), Priority, Goal (the cockpit week's goals; until 2026-10-13 it was the live projects by their goal path, see T8), Effort (a number) and Quarter (derived, read-only). An unset property says "Empty".
  - Notes that save by themselves, 800 ms after typing stops (at most about 12 saves a minute, T11), on blur and when the page is hidden ("Saving…", "Saved", "Couldn't save" with Retry; typed text is never thrown away).
  - Comments, oldest first, each with "You", a relative time (the exact time on hover and for screen readers) and an "edited" mark; edit in place; delete behind an AlertDialog; Enter sends and Shift+Enter adds a line.
  - History, folded until opened (it shares the timeline of the card menu's History sheet), and a created/updated footer. "Updated" is the later of the task's time and its plan row's, because an effort, a plan or a drop changes only the plan row.
  - A dropped task shows a banner with Undrop and offers nothing else.
- **Address**: `/cockpit?task=<id>` opens the panel, so it can be linked to and reloaded. The back button closes it; closing leaves no stray history entry (it goes back when this page opened the panel and replaces the address when the link did).
- **Strings**: English and Simplified Chinese in `strings.ts`, covered by the parity test.

### Migration `9001_planner_task_details.sql`

Hand-written, unjournaled, additive, no foreign keys, no triggers. Wrangler applies it after `9000`; vitest applies it through `applyPlannerMigrations`. It is also safe for the previous release: the new column is nullable and nothing old reads the new table.

It adds the nullable `planner_task_plan.effort` and the `planner_task_comment` table (soft delete, no foreign keys); see the migration file for the columns.

`planner_task_comment` joins the restore manifest (`RESTORE_TABLES`), and `planner-upstream-compat.test.ts` now expects six planner tables.

### API changes, under `/api/app/planner`

| Route | Change |
| --- | --- |
| `GET /tasks/:id` | New. `{ task, plan, project, comments }`: the whole upstream task (notes included), its plan with `effort` (`null` when there is no plan row; a row with a null horizon only holds an effort), its goal as `{ id, name }`, and its comments oldest first without the deleted ones. 404 for a missing, binned or another user's task. |
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
- **T8 Goal is the weekly goal (`planner_task_plan.goal_id`), since 2026-10-13.** The owner retired projects as goals: the menu lists the cockpit week's open goals and writes `goal_id` through `PATCH /tasks/:id`, and the project chip is gone from the cards. Upstream's `project_id` is kept on every task, untouched; `setProject` was removed from the actions on 14 Oct 2026 (it had no caller); the card menu's Edit… form can still set a project. Before that date the menu listed live projects by their goal path from the tree; see `docs/planning-cockpit-goals-review.md`.
- **T9 The address is the panel's state.** `?task=<bare id>` (without `tasks/`), read by `usePlannerTaskParam` and validated by `plannerCockpitSearch`. The route's `validateSearch` is one line in `router-tree.tsx`, which is why the validator is a fork-owned module and not inline.
- **T10 One optimistic engine for the board and the panel.** Every edit patches the board's cache and the open panel's cached detail together, rolls both back with a toast when the server refuses, and refreshes (`["planner"]`, upstream's task keys and `["projects"]`) only once the last change in flight has settled. Edits made in the panel are silent on success, because the panel shows the new value in place; the board's own actions still toast.
- **T11 Autosave rules** (`use-planner-autosave.ts`, tested with fake timers): a change that is the same once trimmed is never sent; two saves never overlap, and typing during a save sends one more with the newest text; saves the typing timer starts are at least 5 s apart, counted from the start of the previous save, so autosave makes about 12 a minute at most and typing leaves room for moves and comments in the shared 30-a-minute `planner` write bucket (a pause that ends inside the gap is held, never dropped; a blur, Retry, closing the panel and the page being hidden all ignore the gap and save at once); the cost of the gap is text still waiting for it when the page goes away, so a hidden page (`visibilitychange`, which covers a tab or app switch and most tab closes) and `pagehide` save at once as a `keepalive` request (a body over 32 KB, half of the 64 KB browsers allow for keepalive, goes as an ordinary request), which is best effort: on a tab or app switch the page stays alive and the save completes, but when the page is navigated away or closed the browser may still drop the request (observed in headless Chromium with the app's service worker controlling the page, `keepalive` or not), so the last few seconds of typing can still be lost on a close; a failed save keeps the text and is retried by the next edit (after the gap), the next blur or Retry; the server's value is adopted only while nothing is unsaved; closing the panel saves what is left.
- **T12 Click versus drag.** The card's click handler ignores clicks that start inside a button, link, field, label or menu (including portaled menu items, which are React children but not DOM children of the card). Pending cards are inert. Escape inside a field of the panel (title, effort, due date, a comment being edited) belongs to the field: it never closes the panel.

### Not in v1.1

- Markdown, attachments, mentions or reactions in comments; comment pagination (the detail carries all of a task's comments); restoring a deleted comment; other authors' names (there is one user, shown as "You").
- Editing the quarter, the source memo or the sort order from the panel; a next/previous card shortcut.

## 13.x v1.2 simplification

The owner's feedback on the first board (2026-10-08): the Today, This week and This month split, and carry-over, are more than the owner needs. The board is one view, and dates are a start and a due date. The owner moves cards Backlog → To Do → Doing → Done by hand.

What changed:

- **Period chips are gone.** The All / Today / This week / This month row and the period picker in quick add are removed. The board always shows every card. `todo-filter.ts` and its test are deleted.
- **Quick add and each column's "+" create the task straight into its column.** Quick add creates in Backlog. A To Do "+" sends the To Do marker (below); Doing and Done take no plan.
- **Carry-over is off the web.** `use-planner-rollover.ts` is deleted and nothing calls `POST /rollover`. The route and `rollover.ts` stay, unused, under the additive-only rule. There are no "Carried ×N" badges and no carry toast. Old `carried_over` events still render with their label, and the actor reads "Automatic" as before.
- **Plan is replaced by Start date.** `planner_task_plan.start_date` (migration `9002_planner_start_date.sql`, a nullable `YYYY-MM-DD` day) sits on the plan row, as the effort does. `PATCH /tasks/:id` takes `start_date` (a day or `null`), and the event is `start_date_changed` `{from, to}` in the same batch. The task panel sets it with the same date control as the due date. The card shows the range: "Oct 8 → Oct 12" with both dates, "Starts Oct 8" with only a start, and the due chip as before with only a due date. Priority and project stay. The plan menu and its chips are gone from the card and the panel.
- **Created** is a read-only row in the panel, from `tasks.created_at`. The footer keeps "Updated".
- **Quarter** is derived from the start date, or else the due date.
- **To Do without periods.** A To Do task still needs a plan row to tell it from the backlog. Every move into To Do plans it for today with horizon `day` (`plannerTodoMarker` in `packages/contracts/src/planner.ts`). Nothing shows that horizon, and rollover is the only code that would move it, so the marker stays put. Existing tasks keep their plans and stay in To Do. Moving to To Do from To Do is not touched, Done still shows the last 14 days, and To Do → Backlog still clears the plan.

Why a `day` horizon and not a new "no period" value: the planner's column rule (`plannerColumnFor`), the undrop placement and the `plannerHasPlan` check all read "has a horizon" as "in To Do", and keeping that rule avoids a migration that rebuilds planner rules (G13). The marker's date is not shown anywhere.

Known edges, kept on purpose:

- A `start_date` after the due date is accepted. The card then shows the range in the order typed.
- If someone calls the rollover route by hand, it would carry To Do markers forward day by day and bump `carry_count`. Nothing in the web does that.
- A Doing → To Do move with no plan writes two events: "Moved to Backlog" (the status change) and then "Moved to To Do" (the marker).

## 14. Drag to re-rank (migration 9004)

The owner's request (2026-10-08): drag the to-do items and re-rank them. Every column (Backlog, To Do, Doing, Done) can be reordered by drag and drop, and a card dropped from another column lands at the spot it was dropped on.

**Where the order lives.** `planner_task_plan.board_rank` (`migrations/9004_planner_board_rank.sql`, a nullable text column). Upstream `tasks.sort_order` is scoped per project and status, and a cockpit column mixes projects, so it cannot hold this. 9003 is skipped on purpose: a parallel branch uses it.

**The rank.** A fractional key in base-62 digits (`0-9A-Za-z`, so plain string order is code-unit order, in SQL and in JavaScript alike), stored as `<column>|<key>`, for example `todo|aV`. The maths are in `packages/contracts/src/planner-rank.ts`, shared by the domain service and the web board, so the board predicts the same order the server stores.

- **One row per move.** `plannerRankBetween(above, below)` makes a key strictly between its neighbours. Only the dropped card is written, with no `updated_at` change and no history event.
- **Column prefix.** A stored rank counts only while the card is in the column it names. A task moved to another column through `/projects`, the API or a plain move reads as unranked there, so nothing has to clear the old key. Moving it back restores its old place.
- **Unranked cards** sort after the ranked ones, in the column's old order (Backlog and Done newest first, To Do by plan, Doing by `sort_order`). Nothing is backfilled: a column stays as it was until its first re-rank.
- **Rebalance.** When a card is dropped below a card with no key, or when the new key would pass 24 characters, or when two neighbours share a key, the whole column gets fresh, evenly spaced keys in one batch (`plannerRankSpread`), at most about 500 rows. Keys grow about one character per five drops at one spot, so this is rare. Ties between equal keys break by task id on both sides.

**API.** `PATCH /api/app/planner/tasks/:id` gains `before_id` and `after_id`, both optional and valid only with `column`. `before_id` is the card that will sit directly below the dropped one, `after_id` the card directly above (`before_id` wins if both are sent). With `column` equal to the card's own column it is a reorder; with another column it is the move and then the placement, as separate writes (the move logs its event as before; the placement logs nothing). An anchor that is not in that column, a dropped task, or a column the task is not in answers 400, so the web rolls back and reloads. Same auth, Origin check and `planner` rate-limit bucket as the other PATCHes. Board cards carry `board_rank` (the bare key, or null); plan DTOs carry the stored `<column>|<key>` form.

**New tasks.** A column that already has a manual order puts a card added with its "+" on top (the server ranks it above the smallest key of that column, one extra row). A column nobody has ranked keeps today's order, which is not the same everywhere: Backlog and Done newest first, To Do after the cards of the same plan, Doing at the end.

**Web.** `@dnd-kit/sortable`: each column is a `SortableContext`, so cards move aside while one is carried inside its own column; carrying a card over another column draws a line where it will land. Two-step collision (the column under the pointer, then the nearest card in it). Dropping inside a column asks for a reorder, dropping on another column's card asks for a move with a place, dropping on an empty column is the plain move. Optimistic: the card is on the board at its place at once; a refused request puts both columns back as they were. Sensors: the mouse (6 px), the touch long press (400 ms, unchanged) and now the keyboard: focus a card, Space lifts it, arrows move it (sortable coordinates), Space drops, Escape cancels. The card itself is the keyboard handle, so keys pressed on the buttons inside it keep their meaning. A card still waiting for the server can be neither dragged nor dropped next to.

**Not done.** The Other bucket and the Dropped list are not reorderable. Nothing re-ranks on the server when the history sync runs (it never touches the plan row's rank).
