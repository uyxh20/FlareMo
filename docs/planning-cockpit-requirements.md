# Planning cockpit — requirements

Status: requirements captured 2026-10-04 in an interview with the fork owner. Not designed or built yet. Fork-only add-on for `uyxh20/FlareMo`; not proposed upstream.

## Brief

Make FlareMo the one place to plan and execute work. Capture a task, plan it onto a day, a week or a month, work it on one cockpit page, and keep a permanent history of what was created, planned, moved, finished or dropped. Weekly and monthly reviews then compare plan against reality, per goal, and feed the next plan. Notion is retired for tasks.

## Problem

FlareMo already has `tasks`, `projects`, a kanban board at `/projects`, overdue reminders with Web Push, and a per-task `task_activity` log. What it lacks for this brief:

- One date per task (`due_at`, date-only). No week or month planning.
- History is recorded but readable only one task at a time. Delete and restore are not logged, and nothing aggregates planned versus done.
- No goals and no review loop.
- No task timeline. Upstream removed `/calendar` in v0.20.1.

## Interview decisions

1. **Scheduling**: day, week and month horizons, date-only. Calendar sync goes to the backlog. Start with a basic kanban.
2. **Interface**: one cockpit page inside the existing FlareMo deployment. Command bar, MCP agent tools and note-checkbox capture are not in v1.
3. **Goals**: no goal UI is required in v1, but the backend must support a goal hierarchy that scales.
4. **Notion**: fresh start. Open items are moved by hand and history starts at cutover. No importer and no sync.
5. **Build strategy**: an isolated add-on in the fork. It has its own tables, migrations and pages, and touches upstream code only at named hook-in points so upstream update PRs keep applying.

Follow-up decisions, 2026-10-04:

6. **Kanban columns**: by status, like the Notion board: Backlog, To Do, Doing, Done.
7. **Dates**: the plan date (day, week or month) is separate from the due date (upstream `due_at`).
8. **Review timing**: the weekly and monthly review stays in "Next".
9. **Cost**: Cloudflare pricing is accepted, with no new services.

The implementation plan is `docs/planning-cockpit-implementation-plan.md`, audited v2.

## Requirements

### v1 (must)

- **R1 Cockpit page**: a new route in the existing web app, usable on desktop and in the phone PWA.
- **R2 Basic kanban**: create, edit, move and complete tasks in place on the cockpit.
- **R3 Horizons**: a task is either unplanned (backlog) or planned to a day, a week or a month. Date-only.
- **R4 Roll-forward**: unfinished planned tasks carry into the current period, and every carry-over is recorded.
- **R5 Full history**: an append-only event log of every task lifecycle event, with time and actor. Events cover created, planned, re-planned, carried over, status changed, completed, reopened, dropped, deleted and restored. Events are never edited, and they survive the task being deleted or purged.
- **R6 Goal-ready backend**: schema and API for a goal tree of any depth with typed levels (for example area, yearly goal, quarterly goal, milestone), plus a task-to-goal link. Adding a level must not need a schema change. Roll-ups (planned, done and carried over per subtree) must stay cheap. Goal UI is optional in v1.
- **R7 Same task records**: the add-on works on FlareMo's existing `tasks` and `projects`. `/projects`, overdue reminders and "convert to task" keep working on the same data.
- **R8 Upstream-safe**: own Drizzle schema and migration track. Upstream files are touched only at the listed hook-in points.
- **R9 Single user**: owner-private, behind the same Better Auth session or PAT and Origin rules as the rest of `/api/app`.

### Next

- **N1 Timeline view**: scrollable past, today and future, by horizon.
- **N2 Weekly and monthly review**: planned versus done versus carried over, per goal, with a written reflection saved as a memo. The capture pilot's cutover criteria include one weekly-review loop end to end.
- **N3 Goal UI** on top of R6.

### Backlog

Calendar sync (start with a read-only iCal feed), MCP tools for tasks, goals and history, a command bar, note checkboxes to tasks, times of day and timed reminders, and recurring tasks.

### Out of scope

Notion import or sync. Shared or multi-user tasks.

## Architecture direction

- Upstream's `docs/concept-model.md` and PRD R10 exclude goals, recurrence, event tables and calendar sync. That is why this is a fork-only add-on.
- Reuse upstream `tasks` as the task record and add fork-owned side tables. Names are illustrative:
  - `planner_task_plan`: horizon, period start and goal for each task.
  - `planner_goal`: an adjacency-list tree with `parent_id`, `kind`, period, status and order.
  - `planner_task_event`: append-only, with no foreign key to `tasks` and a title snapshot.
- Goal roll-ups use SQLite `WITH RECURSIVE`. A closure table is the scale-up path if trees get large.
- Separate migration track: own Drizzle config and output folder (for example `migrations-planner/`) with its own migrations table, applied by the fork's `deploy-cloudflare.yml`. `drizzle.config.ts` writes into `migrations/` with a shared `_journal.json`, so fork migrations numbered `0030` and up would collide with upstream's next ones. Verify Wrangler support in a spike.
- History capture: changes made through upstream screens reach only upstream `task_activity`, where delete and restore are not logged. Preferred option:
  - Use SQLite triggers on `tasks` for raw changes, re-applied idempotently on every deploy because an upstream table rebuild drops them.
  - Write semantic events such as planned and carried over from add-on code.
- Hook-in points:
  - API mount in `apps/worker/src/index.ts`.
  - Route in `apps/web/src/router-tree.tsx` and `apps/worker/src/spa-routes.ts`.
  - Nav entry and i18n keys.
  - Table classification in `scripts/persistence-manifest.mjs`.

## Design questions (settled)

- Kanban columns: statuses, like the Notion board (decision 6).
- Plan date versus due date: separate (decision 7).
- Roll-forward: rollover when the cockpit opens, as an idempotent set-based batch. No cron.
- Navigation: the cockpit sits beside `/projects` (plan default D2).
- Projects and goals: not linked in v1 (plan default D2).
- Week start and time zone: Monday, with date maths on the client's local date (plan section 4).

## Cost

At single-user scale, v1 adds no new Cloudflare services. Its D1 and Worker usage stays well inside the free quotas. Cost flags for the other options are in the decision map artifact.
