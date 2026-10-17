# Goals and the weekly review

Status: built 2026-10-10 on `feat/goals-weekly-review`. It goes to `flaremo-dev` first; live gets it only on the owner's word. A fork-only add-on to the planning cockpit ([planning-cockpit-implementation-plan.md](planning-cockpit-implementation-plan.md)), under the same guardrails. Not proposed upstream.

It delivers the weekly review and the goal UI. The monthly review is not part of it. The approved design is the mock at https://claude.ai/artifact/TX9qjid1ihff2oH3Srsec8.

## What the owner sees

### Cockpit

- Above the board, one card per weekly goal, tinted by its objective, with how many of its tasks are done. An objective with no goal that week shows a dashed card.
- A task that serves a goal is tinted the same way, with a chip naming the goal's objective.
- A task's Goal, in the task panel, is one of the cockpit week's goals: None, then the week's open goals in the order the review set. A task whose goal is from another week says so until another is picked. Projects are no longer offered there and their chip is gone from the cards; a task keeps its project link in the database, untouched (the owner's decision, 2026-10-13).
- Clicking a card focuses its goal: the other cards and every task that does not serve it fade back. Click it again, or press Escape, to clear the focus.
- The cards show this week. On a weekend, once next week has been planned, they show next week.

### Goals (`/goals`)

The cascade from the north star down to a week, one level per address:

| Address                     | Shows                                                                                  |
| --------------------------- | -------------------------------------------------------------------------------------- |
| `/goals`                    | The current ISO year.                                                                  |
| `/goals?year=2026`          | The Year map: the whole cascade on one page (see below).                               |
| `/goals?year=2026&q=4`      | A quarter: its months and quarter goals.                                               |
| `/goals?year=2026&q=4&m=10` | A month (1 to 12): its goals and weeks.                                                |
| `/goals?week=2026-10-05`    | One week, by its Monday: its scores and weekly goals, with a link to its summary memo. |

- The Year map (`year-map.tsx`, `year-map-model.ts`) replaces the year's heatmap. The time column runs north star, year, Q1 to Q4 (each with its theme line, the quarter's first goal with no objective), months and weeks; the four objectives are the columns. Only the current month and current week are coloured cards; year and quarter goals keep larger type on plain cards, like every other month and week. Point chips have a plain grey border, never the pillar colour, and every goal card has the same small (7px) pillar dot. Goals have no parent link: a row lines them up by objective and period. A period's goals in one objective share one split row: one equal part per goal, its points as chips under its heading, the same at every level (the parts stack when all four objectives show, and sit side by side when one is followed); goals with no objective (most imported weekly goals) get one row across the four columns.
- Each month shows its week chips (hover gives the scores); a chip opens that week's row, the month label opens or closes all of them, and the current week starts open. A week's label opens its own page. A weekly goal opens a pop-up with the year, quarter and month goals of its objective, its tasks from the board (a year of Done cards) and, for this week and later ones, a field that adds a task to the Backlog linked to the goal. Other goals open the editor; an empty slot adds one.
- "Follow" an objective: only its column shows; the picker switches between them. A phone opens following Work.
- Quarter and month goals: no point chips. Each shows a five-position progress bar, one position per point (a solid position is a struck point; open and unused positions are the same grey), and the editor stops quarter and month goals at five points. Clicking a quarter goal lights up its objective's column (its points list under the bar, its month goals list theirs) and fades the other three; clicking again shows all. A pencil on the quarter card opens the editor. Following one objective, each point sits under its own position. No card draws its result or task count any more (✓, ◐, 2/3); both are still read out and shown on hover. Week chips always show the Monday with its month ("6 Apr").
- Compact quarters and plain cockpit cards: a quarter no longer has an empty theme band above its cards. Its label sits beside its cards, the way a month's does, under the quarter's divider line, and an old theme still shows in its own band. Quarter cards use month-card size (same title size, bar height and padding). Every box in a Year map row is as tall as the tallest one, with the heading at the top and the bar at the bottom, so bars line up across columns. Following one objective, each point is cut at two lines (the full text is in the hover hint), so quarter and month boxes come out the same height. On the cockpit, the week's goal cards are plain: no tint, no coloured border and no progress bar. The objective's colour is only in the dot, and the task count stays top right. A focused card keeps its coloured outline.
- A week is on target when both scores meet their floors.
- Each ISO week sits under the month of its Thursday, so no week is split between two months.
- The averages count only weeks that have ended.
- Every goal opens in the goal editor: its objective, its title, the points under it (each with an optional short note, or struck through), its status, its result and a note.
- An address that is not valid shows the year instead of an error.

### Weekly review (`/weekly-review`)

Two parts, done in any order and left at any point. The page saves where the review stands as it goes, and picks it up on the next visit. `?part=back` and `?part=forward&step=1..4` open a part or a step directly.

- The week looked back on is the current week on Saturday and Sunday. From Monday to Friday it is the week before.
- From Saturday to Monday the sidebar link carries a dot until both parts are done.
- **Start over** in the header clears the review's progress for that week, after a confirmation, and opens a fresh Look back. What the two saves already wrote stays: the week's record, the summary memo, goals and tasks. Saving again updates them, and the server's commit log is kept, so a task Save week already created is not made twice.

**Look back** is a chat over the week. It goes through:

1. Last week's key question.
2. Last week's goals, each marked met, partial or missed.
3. The seven reflection prompts.
4. The two scores, Authenticity and Achievement, from 1 to 5 in half steps.
5. The key question for next Sunday.
6. A verdict: continue, pivot or pause.

The model drafts answer options first and coaches in the chat as the owner answers. The side panel shows 19 weeks of both scores against their floors, and what has been answered so far.

Look back ends in the summary memo. It streams into a sheet with Stop, then Edit, Write again, Copy markdown and Save. It is not saved until the owner presses Save, so they can edit the markdown first; the text they save is the one kept, and its Next Steps fill Look forward. After saving, the main button is Look forward, until the memo is edited again. Look forward from the chat opens the sheet while the memo is unsaved:

- It has the same shape as the owner's past summaries (`packages/contracts/src/planner-review-memo.ts`) and carries the `vault-summary` tag.
- There is one memo per week, keyed by its client id `weekly-review-summary:<Monday>`.

**Look forward** plans the next week in four steps:

1. Settle the clashes the last conflict check flagged, by rewriting a goal or keeping it for now. A rewrite changes the goal's title and makes it active; its lines and note stay, and the old title is kept as a struck line, since goals keep no other history.
2. Choose the week's goals, one slot per objective. The Next Steps of the week's summary (or, before it exists, the one before) fill the slots as starting points.
3. Plan their tasks: linked from the board or new, under the To Do cap of 7.
4. Commit with the question for next Sunday, after a conflict check that only flags.

Save week then does all of this:

- writes the week's goals, removing only the ones the plan started from and left out (a goal added on the Goals page while the review was open is kept, with its tasks);
- links the tasks to them;
- moves the planned tasks to the top of To Do, and sends the cards the owner chose back to Backlog;
- creates the new tasks;
- keeps the flags;
- marks the review done;
- lands on the cockpit with the new goal cards.

**Without a model** the review still runs to the end. The page uses its own drafts, and the memo comes from the same template the model fills.

## Decisions

From the interview and the decision cards (2026-10-09 and 10):

- **Everything in the app.** Goals, scores, the review and the memo live in Schizo Diary. The memo is an ordinary memo.
- **Drafts plus a live chat.** Look back offers drafted answers first, and a coach probes in the chat.
- **Cleanse first.** Look forward starts by settling the goal clashes already on record.
- **Flag only.** The conflict check reports clashes and never rewrites anything. Save week is never blocked.
- **No backfill.** Old weekly-goal results are not filled in after the fact, so past weeks are judged by score alone.
- **Four objectives,** each with its own colour (`goals.css`): Objective Function (`of`), Work, AI Chops (`ai`) and Health.
- **Score floors:** Authenticity 4 and Achievement 3.5 (`plannerScoreFloors`).
- **Weeks** are ISO weeks starting on Monday, cut at local midnight in the owner's zone (see "The model" below), not in UTC.

## Data: `migrations/9005_planner_goals_review.sql`

Additive, with no foreign key to an upstream table and no triggers (G10 to G13). The previous release keeps working on it.

| Table or column             | Holds                                                                                                                                                                                                                                     |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `planner_task_plan.goal_id` | The weekly goal a task serves (nullable).                                                                                                                                                                                                 |
| `planner_goal`              | A goal at one level: `north_star`, `year`, `quarter`, `month` or `week`, with its period's first day, objective, title, points (`lines`, JSON), status, result and note. Soft-deleted, so a link or a flag can still name a removed goal. |
| `planner_week`              | One row per reviewed or imported week: the two scores, the key question for the next review, the verdict and the summary memo's id.                                                                                                       |
| `planner_review`            | The review in progress, as one JSON document the page saves as it goes. Its `commit_log` is the server's record of the tasks Save week already created, so a retried save never makes a task twice.                                       |
| `planner_goal_flag`         | What the conflict check flagged, open until it is kept or rewritten.                                                                                                                                                                      |

All four tables are in `RESTORE_TABLES` (`scripts/persistence-manifest.mjs`).

## API, under `/api/app/planner`

The full list, with each response type, is the comment block in `packages/contracts/src/planner-goals.ts`. The routes are in `apps/worker/src/routes/planner-goals-api.ts`, and `planner-api.ts` mounts them, so they share its lazy mount, authentication and JSON 404. The domain work is in `packages/domain/src/planner/goals.ts` and `review.ts`.

| Routes                                                           | What they do                                                                                    |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `GET/POST /goals`, `PATCH/DELETE /goals/:id`                     | Read a year of the cascade; create, edit and remove goals.                                      |
| `GET /review`, `GET /review/status`, `PATCH /review/:week/state` | Read the review, read whether it is due and done (for the sidebar dot), and save its progress.  |
| `POST /review/:week/start-over`                                  | Start over: clears the page's state and both done marks. Saved results stay.                    |
| `POST /review/:week/look-back`                                   | The week's record, last week's goal results and the summary memo. Safe to send again.           |
| `POST /review/:week/look-forward`                                | Save week. The eight steps are listed at `plannerCommitPlan`. Safe to send again.               |
| `POST /review/:week/ai/opening`, `/ai/close`, `/ai/check`        | The opening drafts, the score and trajectory drafts, and the conflict check. JSON in, JSON out. |
| `POST /review/:week/ai/coach`, `/ai/memo`                        | The coach and the memo, streamed as NDJSON: `{"d"}` lines, then `{"done"}` or `{"error"}`.      |

- `GET /board` also returns the cockpit's week and its goals.
- `PATCH /tasks/:id` takes `goal_id` (a goal's id, or `null` to unlink), written through `plannerSetTaskGoal` with a `goal_changed` history event, as Save week does. An unknown goal is a 404.
- Writes use the `planner` rate-limit bucket, the review's autosave uses `planner-review-state`, and model calls use `planner-ai`, so a busy chat never blocks a save.
- Every AI route answers 503 `ai_unavailable` when the model is off or fails, and 429 when throttled. The two streams send that 429 in their own format, as one `{"error":"limited"}` line.

## The model

`apps/worker/src/routes/planner-review-ai.ts`. The prompts and their parsers are in `packages/domain/src/planner/review-prompts.ts`, and what the model reads is in `review-context.ts`.

| Setting                                                                                | Effect                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Nothing set                                                                            | Workers AI through the existing `AI` binding, with `plannerReviewDefaultModel`. Workers AI runs only remotely, so a local `wrangler dev` has no model and the review uses its own drafts.                                                                                                                                                                                                                                                                                                                                                        |
| `FLAREMO_REVIEW_MODEL`                                                                 | Another Workers AI text model.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `OPENROUTER_API_KEY` (Worker secret)                                                   | Switches to OpenRouter with `plannerReviewDefaultOpenRouterModel` (GPT-6.1 Sol, the most accurate in the October 2026 model eval) unless `FLAREMO_REVIEW_OPENROUTER_MODEL` names another. Every call asks for zero-data-retention providers that do not train on prompts, low reasoning effort with the reasoning left out of the answer, and 4,000 tokens of reasoning room on top of the call's own limit. `ANTHROPIC_API_KEY` wins over it. It covers every call: Look back's opening, coach, close and memo, and Look forward's clash check. |
| `ANTHROPIC_API_KEY` (Worker secret)                                                    | Switches to Anthropic's Messages API, with `plannerReviewDefaultAnthropicModel` (Claude Sonnet 5.5) unless `FLAREMO_REVIEW_ANTHROPIC_MODEL` names another. No temperature (current Claude models refuse one) and 4,000 tokens of room for thinking on top of each call's own limit. Wins over `OPENROUTER_API_KEY` (from October 2026, to move the review off OpenRouter).                                                                                                                                                                       |
| `FLAREMO_REVIEW_MEMO_AGENT`, `_ENVIRONMENT`, `_STORE` (vars), with `ANTHROPIC_API_KEY` | A Claude Managed Agent runs Look back (opening, coach, scores, memo) in one session per review instead of single calls, capped at `FLAREMO_REVIEW_MEMO_BUDGET_USD` (default $5). Look forward's clash check stays one call, at medium effort on Claude. See `docs/fork-review-memo-agent.md`. |
| `FLAREMO_REVIEW_AI=off`                                                                | No model: the review uses its own drafts.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

**What the model reads**, each time a draft is asked for, comes from the owner's own data:

- the goal cascade of the reviewed week, and for the conflict check the cascade of the week being planned (its own month, quarter and year, so a plan for the first week of November is checked against November's goals and one for the first week of a new year against that year's);
- up to eight weeks of scores;
- the previous summary's first 4,000 characters, and its Next Steps on their own, since they usually come later;
- the week's tasks: titles of those done (40), in Doing (30) and planned To Do (30); and for those done, worked on or touched this week and those in Doing (up to 60, most recently touched first), their status, notes, live comments and what happened to them this week (`plannerReadTaskDetails`), 600 characters of notes and comments each, or 20,000 for the review agent. The clash check reads the same task details;
- the week's diary entries, without the summaries: up to 40,000 characters, or 12,000 with Workers AI. Entries shorter than an even share stay whole and give the rest to the longer ones, which are cut to one length.
- the health tracker's rows for the week (day, kind, variant, minutes, home time, units, bender, a short "feel" note) and its totals against the targets, including the night-out units used this year (`plannerReadWeekHealth`);
- the owner's live memories created or updated during the week, up to 25, most important first, with the ones the owner never confirmed marked (`plannerReadWeekMemories`).

A week runs from Monday 00:00 to the next Monday 00:00 in the owner's zone (`FORK_HEALTH_TIME_ZONE`, Europe/Copenhagen), not in UTC: diary entries, finished tasks and memories are cut at local midnight (`plannerWeekInstants`), and each entry is dated by its local day.

The context opens with rules for reading it, one for each kind of invented fact the model eval found: only what this week's material says happened is an event, an entry's day is when it was written and not always the day it describes, numbers are copied and never totalled, and #tags are not names. When the owner changes a drafted score, the memo is told which scores the drafts were written for and writes the basis afresh.

With Workers AI this stays on Cloudflare. With `OPENROUTER_API_KEY` set it goes through OpenRouter to a provider that keeps nothing. With `ANTHROPIC_API_KEY` set it goes to Anthropic; the review agent's files stay at Anthropic only until the memo is read, and its notes stay in its memory store. Nothing is logged except the provider, the model and an error message: never a prompt, an answer or a key.

**When the model fails,** the page falls back to its drafts. After two failures in a row that were not rate limits (the opening counts), it stops calling the coach for the rest of the visit.

## Web: `apps/web/src/planner/`

The files are named by feature: `goals-*` and `goal-*` (the Goals page, editor, API client, search validators, strings, CSS), `year-map*` (the Year map), `review-*` (the weekly review and its pure model), `goal-cards.tsx` (the cockpit's goal cards) and `nav-link.tsx` (the Goals and Weekly review sidebar links, beside Cockpit through `PlannerNavLink`). The goal and review pages are covered by tests of their pure modules (`review-model.ts`, `goals-model.ts`, `year-map-model.ts`); the page components themselves have none.

## Upstream files with a hook-in

See [fork-customizations.md](fork-customizations.md) for the fork's upstream hook-ins. This feature extends the cockpit's `router-tree.tsx`, `spa-routes.ts`, `sw.js`, `persistence-manifest.mjs` and `playwright.config.ts` entries, and adds six optional review settings to `apps/worker/src/env.ts`. The guard command in section 10 of the implementation plan allows `tests/e2e/goals-review.spec.ts` alongside the cockpit spec.

## Checks

```sh
pnpm exec vitest run packages/contracts/src/planner-goals.test.ts packages/contracts/src/planner-review-memo.test.ts packages/db/src/planner-migrations.test.ts packages/domain/src/planner apps/worker/src/routes/planner-goals-api.test.ts apps/worker/src/routes/planner-api.test.ts apps/web/src/planner --config vitest.config.ts
cd apps/web && npx tsc -b --pretty false
```

The Playwright spec is registered in the opt-in `memo-ui` project. As with every e2e spec here, it is written but not run by the agent that added it (AGENTS.md: e2e is opt-in). When the maintainer asks:

```sh
pnpm exec playwright test --project=memo-ui tests/e2e/goals-review.spec.ts
```

## Deploy and rollback

- **Order:** local, then `flaremo-dev` (`node scripts/fork/dev-env.mjs deploy`, which applies 9005), then the owner tries it, then live on the owner's word with `node scripts/fork/prod-deploy.mjs deploy --confirm flaremo` (there is no auto-deploy).
- **Rollback:** revert the feature's commits. 9005 is additive, so the previous release runs on the new schema unchanged. If the tables must go, drop them in this order: `planner_goal_flag`, `planner_review`, `planner_week`, `planner_goal`. `planner_task_plan.goal_id` can stay.
- **Upstream sync:** keep both sides in the hook-in files above, then run the checks.
