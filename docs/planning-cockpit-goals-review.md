# Goals and the weekly review

Status: built 2026-10-10 on `feat/goals-weekly-review`. It goes to `flaremo-dev` first; live gets it only on the owner's word. A fork-only add-on to the planning cockpit ([planning-cockpit-implementation-plan.md](planning-cockpit-implementation-plan.md)), under the same guardrails. Not proposed upstream.

It delivers **N2** (the weekly review) and **N3** (the goal UI) of [planning-cockpit-requirements.md](planning-cockpit-requirements.md). The monthly review is not part of it. The approved design is the mock at https://claude.ai/artifact/TX9qjid1ihff2oH3Srsec8.

## What the owner sees

### Cockpit

- Above the board, one card per weekly goal, tinted by its objective, with how many of its tasks are done. An objective with no goal that week shows a dashed card.
- A task that serves a goal is tinted the same way.
- Clicking a card focuses its goal: the other cards and every task that does not serve it fade back. Click it again, or press Escape, to clear the focus.
- The cards show this week. On a weekend, once next week has been planned, they show next week.

### Goals (`/goals`)

The cascade from the north star down to a week, one level per address:

| Address | Shows |
| --- | --- |
| `/goals` | The current ISO year. |
| `/goals?year=2026` | The north star, the year's average scores, a heatmap of every week and the year goals. |
| `/goals?year=2026&q=4` | A quarter: its months and quarter goals. |
| `/goals?year=2026&q=4&m=10` | A month (1 to 12): its goals and weeks. |
| `/goals?week=2026-10-05` | One week, by its Monday: its scores and weekly goals, with a link to its summary memo. |

- The heatmap legend is On target, Below, Not scored and Not yet. A week is on target when both scores meet their floors.
- Each ISO week sits under the month of its Thursday, so no week is split between two months.
- The averages count only weeks that have ended.
- Every goal opens in the goal editor: its objective, its title, the points under it (each with an optional short note, or struck through), its status, its result and a note.
- An address that is not valid shows the year instead of an error.

### Weekly review (`/weekly-review`)

Two parts, done in any order and left at any point. The page saves where the review stands as it goes, and picks it up on the next visit. `?part=back` and `?part=forward&step=1..4` open a part or a step directly.

- The week looked back on is the current week on Saturday and Sunday. From Monday to Friday it is the week before.
- From Saturday to Monday the sidebar link carries a dot until both parts are done.

**Look back** is a chat over the week. It goes through:

1. Last week's key question.
2. Last week's goals, each marked met, partial or missed.
3. The seven reflection prompts.
4. The two scores, Authenticity and Achievement, from 1 to 5 in half steps.
5. The key question for next Sunday.
6. A verdict: continue, pivot or pause.

The model drafts answer options first and coaches in the chat as the owner answers. The side panel shows 19 weeks of both scores against their floors, and what has been answered so far.

Look back ends in the summary memo. It streams into a sheet with Stop, Write again, Copy markdown and Look forward, and is saved to the owner's memos as soon as it is finished:

- It has the same shape as the owner's past summaries (`packages/contracts/src/planner-review-memo.ts`) and carries the `vault-summary` tag.
- There is one memo per week, keyed by its client id `weekly-review-summary:<Monday>`.

**Look forward** plans the next week in four steps:

1. Settle the clashes the last conflict check flagged, by rewriting a goal or keeping it for now.
2. Choose the week's goals, one slot per objective. The Next Steps of the week's summary (or, before it exists, the one before) fill the slots as starting points.
3. Plan their tasks: linked from the board or new, under the To Do cap of 7.
4. Commit with the question for next Sunday, after a conflict check that only flags.

Save week then does all of this:

- writes the week's goals;
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
- **Weeks** are ISO weeks starting on Monday, with day keys read as UTC, the same as the cockpit.

## Data: `migrations/9005_planner_goals_review.sql`

Additive, with no foreign key to an upstream table and no triggers (G10 to G13). The previous release keeps working on it.

| Table or column | Holds |
| --- | --- |
| `planner_task_plan.goal_id` | The weekly goal a task serves (nullable). |
| `planner_goal` | A goal at one level: `north_star`, `year`, `quarter`, `month` or `week`, with its period's first day, objective, title, points (`lines`, JSON), status, result and note. Soft-deleted, so a link or a flag can still name a removed goal. |
| `planner_week` | One row per reviewed or imported week: the two scores, the key question for the next review, the verdict and the summary memo's id. |
| `planner_review` | The review in progress, as one JSON document the page saves as it goes. Its `commit_log` is the server's record of the tasks Save week already created, so a retried save never makes a task twice. |
| `planner_goal_flag` | What the conflict check flagged, open until it is kept or rewritten. |

All four tables are in `RESTORE_TABLES` (`scripts/persistence-manifest.mjs`).

## API, under `/api/app/planner`

The full list, with each response type, is the comment block in `packages/contracts/src/planner-goals.ts`. The routes are in `apps/worker/src/routes/planner-goals-api.ts`, and `planner-api.ts` mounts them, so they share its lazy mount, authentication and JSON 404. The domain work is in `packages/domain/src/planner/goals.ts` and `review.ts`.

| Routes | What they do |
| --- | --- |
| `GET/POST /goals`, `PATCH/DELETE /goals/:id` | Read a year of the cascade; create, edit and remove goals. |
| `PATCH /weeks/:weekStart` | Edit a week's record. |
| `GET /review`, `GET /review/status`, `PATCH /review/:week/state` | Read the review, read whether it is due and done (for the sidebar dot), and save its progress. |
| `POST /review/:week/look-back` | The week's record, last week's goal results and the summary memo. Safe to send again. |
| `POST /review/:week/look-forward` | Save week. The eight steps are listed at `plannerCommitPlan`. Safe to send again. |
| `POST /review/:week/ai/opening`, `/ai/close`, `/ai/check` | The opening drafts, the score and trajectory drafts, and the conflict check. JSON in, JSON out. |
| `POST /review/:week/ai/coach`, `/ai/memo` | The coach and the memo, streamed as NDJSON: `{"d"}` lines, then `{"done"}` or `{"error"}`. |

- `GET /board` also returns the cockpit's week and its goals.
- Writes use the `planner` rate-limit bucket, the review's autosave uses `planner-review-state`, and model calls use `planner-ai`, so a busy chat never blocks a save.
- Every AI route answers 503 `ai_unavailable` when the model is off or fails, and 429 when throttled. The two streams send that 429 in their own format, as one `{"error":"limited"}` line.

## The model

`apps/worker/src/routes/planner-review-ai.ts`. The prompts and their parsers are in `packages/domain/src/planner/review-prompts.ts`, and what the model reads is in `review-context.ts`.

| Setting | Effect |
| --- | --- |
| Nothing set | Workers AI through the existing `AI` binding, with `plannerReviewDefaultModel`. Workers AI runs only remotely, so a local `wrangler dev` has no model and the review uses its own drafts. |
| `FLAREMO_REVIEW_MODEL` | Another Workers AI text model. |
| `ANTHROPIC_API_KEY` (Worker secret) | Switches to Anthropic's Messages API, with `plannerReviewDefaultAnthropicModel` unless `FLAREMO_REVIEW_ANTHROPIC_MODEL` names another. It is optional and not set on dev or live. |
| `FLAREMO_REVIEW_AI=off` | No model: the review uses its own drafts. |

**What the model reads**, each time a draft is asked for, comes from the owner's own data:

- the goal cascade;
- up to eight weeks of scores;
- the previous summary;
- the week's tasks;
- the week's diary entries, without the summaries, up to 12,000 characters shared evenly between them.

With Workers AI this stays on Cloudflare. With `ANTHROPIC_API_KEY` set it goes to Anthropic. Nothing is logged except the provider, the model and an error message: never a prompt, an answer or a key.

**When the model fails,** the page falls back to its drafts. After two failures in a row that were not rate limits (the opening counts), it stops calling the coach for the rest of the visit.

## Web: `apps/web/src/planner/`

| File | What it holds |
| --- | --- |
| `goals-page.tsx`, `goal-editor.tsx`, `goals-ui.tsx` | The Goals page, the goal editor and their shared pieces. |
| `goal-cards.tsx` | The cockpit's goal cards. `board.tsx`, `task-card.tsx` and `cockpit-page.tsx` add the tint and the focus. |
| `review-page.tsx` | The weekly review: state, saves and model calls. |
| `review-back.tsx`, `review-charts.tsx`, `review-sheet.tsx`, `review-markdown.tsx` | Look back's chat, the score charts, the memo sheet and a small Markdown renderer. It renders to React elements, never to HTML. |
| `review-forward.tsx` | Look forward's four steps. |
| `review-model.ts`, `goals-model.ts` | Pure state and helpers, with tests. |
| `goals-api.ts` | The typed client, with an NDJSON reader for the two streams. |
| `goals-search.ts` | The two routes' search validators. They always return every key, because TanStack Router otherwise lets the root's raw search through. |
| `goals-strings.ts`, `nav-label.ts`, `nav-link.tsx` | Copy in English and Simplified Chinese, and the sidebar's Goals and Weekly review links. They sit beside Cockpit through `PlannerNavLink`, which the explorer already renders. |
| `goals.css` | The objectives' colours and tints, the heatmap cells, the charts and the memo's typography, in light and dark. |

## Upstream files with a hook-in

These are this feature's only edits outside planner paths:

| File | Hook-in | Lines |
| --- | --- | --- |
| `apps/web/src/router-tree.tsx` | Imports the two validators, adds two lazy pages and the `/goals` and `/weekly-review` routes, and registers them after `cockpitRoute`. | +51 |
| `apps/worker/src/spa-routes.ts` | `"/goals"` and `"/weekly-review"`. | +2 |
| `apps/web/public/sw.js` | The same two paths in the private navigations. | +2 |
| `apps/worker/src/env.ts` | The four optional review settings above. | +10 |
| `scripts/persistence-manifest.mjs` | The four new tables in `RESTORE_TABLES`. | +9 / -4 |
| `playwright.config.ts` | `goals-review` in the `memo-ui` project's `testMatch`. | +1 / -1 |

The guard command in section 10 of the implementation plan allows `tests/e2e/goals-review.spec.ts` alongside the cockpit spec.

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

- **Order:** local, then `flaremo-dev` (`node scripts/fork/dev-env.mjs deploy`, which applies 9005), then the owner tries it, then live on the owner's word.
- **Rollback:** revert the feature's commits. 9005 is additive, so the previous release runs on the new schema unchanged. If the tables must go, drop them in this order: `planner_goal_flag`, `planner_review`, `planner_week`, `planner_goal`. `planner_task_plan.goal_id` can stay.
- **Upstream sync:** keep both sides in the hook-in files above, then run the checks.
