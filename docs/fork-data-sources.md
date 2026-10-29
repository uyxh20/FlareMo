# Data sources and where they reach

Fork-owned. This page answers one question for every kind of data the app keeps: **which parts of the app use it?** The weekly review, search, the memory layer, AI agents over MCP, the personal export and the backup each read some data and not other data. Until now nothing checked that a new table or a new kind of structured data (goals, week records, soon health activity) actually reached the places that should use it.

Now one registry lists every data source and says, for each consumer, `yes` (with what is read), `no` (with why not) or `gap` (left out, and probably should not be). Tests hold the code to the registry, so a new table cannot land without someone deciding where it goes, and a claim like "the review reads goals" is checked on every run.

## The parts of the app (modules)

| Module | What it is | Main code |
|---|---|---|
| diary | Entries (memos), #tags, attachments, links, reactions | `packages/domain/src/memos-*.ts`, `attachments*.ts`, `tags.ts` |
| memory | Memories extracted from entries, the nightly dreaming | `packages/domain/src/memory/`, `apps/worker/src/memory-dreaming.ts` |
| search | Keyword index (FTS triggers) and semantic index (Vectorize, embedding outbox) | `packages/domain/src/semantic-search.ts`, `embedding-*.ts` |
| cockpit | Tasks, the board, plans, task comments, the history archive | `packages/domain/src/planner/` (board, plans, comments, history-*), `apps/web/src/planner/` |
| goals | Goals, week records, the weekly review and its prompts | `packages/domain/src/planner/goals.ts`, `review*.ts`, `apps/worker/src/routes/planner-goals-api.ts`, `planner-review-ai.ts` |
| account | Sign-in, sessions, keys, settings | `packages/domain/src/auth.ts`, `users.ts`, `settings.ts` |
| integrations | Webhooks, notifications, push | `packages/domain/src/memos-user-*.ts`, `push.ts` |
| ops | Export/import jobs, deploy and dev tooling | `packages/domain/src/data-tasks.ts`, `scripts/fork/` |
| articles | Articles (hidden in the sidebar) | `packages/domain/src/articles.ts` |

## The consumers

| Consumer | What it is | How the test checks it |
|---|---|---|
| `lookBack` | Weekly review, look back: the recap, the coach, the close and the summary memo | Builds every prompt from a seeded database and looks for the marker (`data-reach.test.ts`) |
| `lookForward` | Weekly review, look forward: the goal check | Builds the check prompt and looks for the marker (`data-reach.test.ts`) |
| `userExport` | The personal export bundle | Runs the export and looks for the marker (`data-reach.test.ts`) |
| `search` | Keyword and semantic search | Compares with the embedding resource types and the FTS tables (`data-sources.test.ts`); every way in is checked in `search-reach.test.ts` |
| `memory` | The memory layer | Compares with the tables the memory code imports (`data-sources.test.ts`) |
| `mcp` | AI agents over MCP | Declared only (the tools call shared domain code, so a static check would mislead) |
| `backup` | D1 backup, restore drill and the dev clone | Compares with `scripts/persistence-manifest.mjs` (`data-sources.test.ts`) |

## The matrix

Generated from `packages/domain/src/fork/data-sources.ts`; the test fails when this copy is out of date. "yes" reaches it, "–" deliberately does not, **gap** does not and probably should.

<!-- data-sources:start -->

| Data source | Part | Kind | lookBack | lookForward | search | memory | mcp | agent | userExport | backup |
|---|---|---|---|---|---|---|---|---|---|---|
| `memos` | diary | content | yes | – | yes | yes | yes | yes | yes | yes |
| `memos:earlier-week` | diary | content | – | – | yes | yes | yes | yes | yes | yes |
| `memos:weekly-summary` | goals | content | yes | – | yes | yes | yes | yes | yes | yes |
| `memo_tags` | diary | structure | – | – | – | – | yes | – | – | yes |
| `memo_revisions` | diary | history | – | – | – | – | – | – | – | yes |
| `memo_relations` | diary | structure | – | – | – | – | yes | – | yes | yes |
| `reactions` | diary | structure | – | – | – | – | yes | – | – | yes |
| `attachments` | diary | content | **gap** | – | – | – | yes | **gap** | yes | yes |
| `shares` | diary | bookkeeping | – | – | – | – | – | – | yes | yes |
| `memos_sse_events` | diary | bookkeeping | – | – | – | – | – | – | – | yes |
| `memo_hourly_counts` | diary | derived | – | – | – | – | – | – | – | – |
| `memory_items` | memory | content | yes | **gap** | yes | yes | yes | yes | yes | yes |
| `memory_revisions` | memory | history | – | – | – | yes | – | – | yes | yes |
| `memory_relations` | memory | structure | – | – | – | yes | – | – | yes | yes |
| `memory_resource_links` | memory | structure | – | – | – | yes | – | – | yes | yes |
| `memory_evidence` | memory | structure | – | – | – | yes | – | – | yes | yes |
| `memory_events` | memory | history | – | – | – | yes | – | – | yes | yes |
| `memory_rejections` | memory | bookkeeping | – | – | – | yes | – | yes | – | yes |
| `memory_compile_archives` | memory | bookkeeping | – | – | – | yes | – | – | – | yes |
| `embedding_tasks` | search | derived | – | – | – | – | – | – | – | – |
| `memos_fts` | search | derived | – | – | – | – | – | – | – | – |
| `memory_fts` | search | derived | – | – | – | – | – | – | – | – |
| `tasks` | cockpit | content | yes | yes | **gap** | – | yes | yes | yes | yes |
| `tasks:backlog` | cockpit | content | – | – | **gap** | – | yes | yes | yes | yes |
| `tasks.notes` | cockpit | content | yes | yes | **gap** | – | yes | yes | yes | yes |
| `projects` | cockpit | structure | – | – | – | – | – | yes | yes | yes |
| `task_activity` | cockpit | history | – | – | – | – | – | – | yes | yes |
| `planner_task_event` | cockpit | history | yes | yes | – | – | yes | yes | **gap** | yes |
| `planner_task_comment` | cockpit | content | yes | yes | **gap** | – | yes | yes | **gap** | yes |
| `planner_task_plan` | cockpit | structure | yes | – | – | – | yes | yes | **gap** | yes |
| `planner_project_node` | cockpit | structure | – | – | – | – | – | – | **gap** | yes |
| `planner_task_seen` | cockpit | bookkeeping | – | – | – | – | – | – | – | yes |
| `planner_sync_state` | cockpit | bookkeeping | – | – | – | – | – | – | – | yes |
| `planner_goal` | goals | content | yes | yes | **gap** | – | **gap** | yes | **gap** | yes |
| `planner_week` | goals | content | yes | – | – | – | **gap** | yes | **gap** | yes |
| `planner_review` | goals | content | – | – | – | – | – | – | **gap** | yes |
| `planner_goal_flag` | goals | content | yes | yes | – | – | – | yes | **gap** | yes |
| `planner_period_review` | goals | content | – | – | – | – | – | – | **gap** | yes |
| `planner_evidence` | goals | content | – | – | – | – | – | – | **gap** | yes |
| `planner_agent_proposal` | agent | content | – | – | – | – | – | – | **gap** | yes |
| `planner_agent_chat` | agent | content | – | – | – | – | – | – | **gap** | yes |
| `planner_agent_action` | agent | content | – | – | – | – | – | – | **gap** | yes |
| `planner_agent_run` | agent | bookkeeping | – | – | – | – | – | – | – | yes |
| `health_entry` | health | content | yes | – | – | – | **gap** | yes | **gap** | yes |
| `health_entry_event` | health | history | – | – | – | – | – | – | **gap** | yes |
| `health_target` | health | bookkeeping | – | – | – | – | – | – | – | yes |
| `health_sync_state` | health | bookkeeping | – | – | – | – | – | – | – | yes |
| `health_tracker` | health | bookkeeping | – | – | – | – | – | – | – | yes |
| `health_tracker_event` | health | history | – | – | – | – | – | – | – | yes |
| `articles` | articles | content | – | – | – | – | – | – | – | yes |

System tables, none of which reach a consumer except the backup: `shortcuts`, `users`, `auth_users`, `auth_sessions`, `auth_accounts`, `auth_verifications`, `auth_apikeys`, `auth_user_links`, `auth_bootstrap`, `auth_organizations`, `auth_members`, `auth_invitations`, `settings`, `voice_service_config`, `integration_config`, `usage_counters`, `memos_webhooks`, `memos_webhook_events`, `memos_webhook_deliveries`, `push_subscriptions`, `memos_notifications`, `data_tasks`, `member_removal_jobs`.

Gaps (left out, and probably should not be):

- `attachments` → lookBack: the review is not told an entry had a photo or file, nor its name.
- `attachments` → agent: the agent is not told an entry had a photo or file, nor its name.
- `memory_items` → lookForward: the goal check does not read memories (preferences, constraints).
- `tasks` → search: tasks are not in keyword or semantic search.
- `tasks:backlog` → search: tasks are not in keyword or semantic search.
- `tasks.notes` → search: tasks are not in keyword or semantic search.
- `planner_task_event` → userExport: fork tables are not in the personal export yet (only in the D1 backup).
- `planner_task_comment` → search: task comments are not searchable.
- `planner_task_comment` → userExport: fork tables are not in the personal export yet (only in the D1 backup).
- `planner_task_plan` → userExport: fork tables are not in the personal export yet (only in the D1 backup).
- `planner_project_node` → userExport: fork tables are not in the personal export yet (only in the D1 backup).
- `planner_goal` → search: goals are not searchable.
- `planner_goal` → mcp: agents cannot read goals over MCP.
- `planner_goal` → userExport: fork tables are not in the personal export yet (only in the D1 backup).
- `planner_week` → mcp: agents cannot read week scores over MCP.
- `planner_week` → userExport: fork tables are not in the personal export yet (only in the D1 backup).
- `planner_review` → userExport: fork tables are not in the personal export yet (only in the D1 backup).
- `planner_goal_flag` → userExport: fork tables are not in the personal export yet (only in the D1 backup).
- `planner_period_review` → userExport: fork tables are not in the personal export yet (only in the D1 backup).
- `planner_evidence` → userExport: fork tables are not in the personal export yet (only in the D1 backup).
- `planner_agent_proposal` → userExport: fork tables are not in the personal export yet (only in the D1 backup).
- `planner_agent_chat` → userExport: fork tables are not in the personal export yet (only in the D1 backup).
- `planner_agent_action` → userExport: fork tables are not in the personal export yet (only in the D1 backup).
- `health_entry` → mcp: agents cannot read health entries over MCP.
- `health_entry` → userExport: fork tables are not in the personal export yet (only in the D1 backup).
- `health_entry_event` → userExport: fork tables are not in the personal export yet (only in the D1 backup).

<!-- data-sources:end -->

## Ways in

Data gets into the app by more than one path: typing an entry, editing it, importing a bundle, an agent writing over MCP. Each path has to reach the same consumers. `search-reach.test.ts` writes an entry through each path and checks it lands in both search indexes. Known gaps are written as `it.fails`: the test says what should happen and is expected to fail until someone fixes it, at which point it passes and vitest asks for `it.fails` to become `it`.

- Known gap: **imported entries never reach semantic search.** `importData` (`packages/domain/src/import-export/import-data.ts`) inserts memos without queueing an embedding task, and nothing sweeps `not_indexed` rows later. They are found by keyword search only, until the admin "rebuild embeddings" action runs. Imported memories have the same problem (`embeddingStatus: "not_indexed"`, no task).

## Adding a new data source (for example health activity)

1. Add the table to the Drizzle schema and a migration named `9NNN_planner_<name>.sql`. Any other name is applied in production but skipped by every test and by the dev tooling; `data-sources.test.ts` fails on it.
2. Run `pnpm exec vitest run packages/domain/src/fork`. It fails and names the new table.
3. Add an entry to `packages/domain/src/fork/data-sources.ts`. For each consumer, answer `yes` (what is read), `no` (why not) or `gap` (left out for now). Add the table to `RESTORE_TABLES` in `scripts/persistence-manifest.mjs` so it is backed up and cloned to dev.
4. If it holds content (words or numbers about the owner), add a probe to `PROBES` in `data-reach.test.ts`: a few lines that write one row with the marker in its text.
5. Wire the consumers you said `yes` to (for the weekly review: `review-context.ts` reads it, `plannerReviewContextBlock` in `review-prompts.ts` prints it). Run the tests again until they pass.
6. Refresh this page: `FORK_DATA_SOURCES_WRITE=1 pnpm exec vitest run packages/domain/src/fork/data-sources.test.ts`.

## Tests per module

| Module | Covered by |
|---|---|
| Every module | `pnpm persistence:check` (backup manifest, schema files only, not in `pnpm test`); the registry contract in `data-sources.test.ts` (every table classified for every consumer, backup and memory checked against the code, migrations on a tested track) |
| diary | Upstream's memo, tag, attachment and import suites; probes for entries, earlier weeks and attachments |
| search | `embedding-outbox.test.ts`, `semantic-search.test.ts`, and `search-reach.test.ts` (every way in reaches both indexes; the import gap is pinned as `it.fails`) |
| memory | `memory*.test.ts`; memory reads exactly the tables marked for it |
| cockpit | The `planner-api`, `history-sync`, `board`, `plans` and migrations suites; the archive is never deleted or rewritten; the nightly-sync and API mount hook-ins |
| goals and review | `review.test.ts`, `review-prompts.test.ts` (including the month, quarter and year boundaries of the look forward check), probes for goals, weeks, flags, reviews, task notes and comments, and a snapshot of exactly what the model sees (`__snapshots__/`) |
| ops and deploy | `dev-env.test.mjs`, `prod-deploy.test.mjs` (pure helpers, not run by `pnpm test`); applied 9NNN migrations are frozen by hash (G12) |

## Checks

```sh
pnpm exec vitest run packages/domain/src/fork
```

Five files, no network and no model calls:

- `data-sources.test.ts`: every table is listed; backup, search and memory agree with the code; migrations are on a track the tests apply; this page is current.
- `data-reach.test.ts`: each content source reaches exactly the consumers marked `yes`, and one user's data never reaches another user's review or export.
- `search-reach.test.ts`: every way in reaches both search indexes (one known gap).
- `review-golden.test.ts`: the weekly review's context and goal check, word for word, saved in `__snapshots__/`. After a deliberate change, refresh with `-u` and read the diff.
- `guards.test.ts`: the task history archive is never deleted or rewritten, applied fork migrations are unchanged (hashes in `fork-migration-hashes.json`), and upstream files still call the fork's hooks.
