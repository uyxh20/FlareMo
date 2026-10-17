# The month, quarter and year reviews

Status: built 2026-10-17 on `feat/period-reviews`. It goes to `flaremo-dev` first; live gets it only on the owner's word. A fork-only add-on next to the weekly review ([planning-cockpit-goals-review.md](planning-cockpit-goals-review.md)), under the same guardrails. Not proposed upstream. The agreed design is the page at https://claude.ai/artifact/FgfZ4ZR84bL6JoCabp7Jh4: a deeper version of the weekly review, not a bigger one.

## The idea in one paragraph

A month, a quarter and a year each close on the Sunday of their last week (a week belongs to the month of its Thursday, the Year map's rule). On that Sunday the weekly review runs first (Look back), then its "superset" runs in the middle, then Look forward plans the next week against the new goals. Each level has five steps in the same shape as the weekly review: raw rows on the right, the owner's own words and a chat with a reader on the left, a memo the owner edits, and Save. The raw rows (diary entries, health rows, tasks done, week records, goals) are evidence; the weekly summaries and the memories are claims to test. Every claim the review rests on is a **receipt**: a quote that the server checks word for word against the raw rows. The model reads, checks, counts and quotes; it never writes goals, verdicts or marks.

## What the owner sees

`/period-review` opens the review due this Sunday (the biggest level closing with the reviewed week), else the latest closed month. `?level=quarter` picks a level; `?period=2026-10-01` a period (its first day); `?step=3` a step. The sidebar link "Period review" carries a dot from Saturday to Monday while a period closes with the reviewed week and its review is not done. The weekly review shows a hand-off tile under its two parts on the same days.

| Level | Steps | Answered from |
| --- | --- | --- |
| Month | Check the summaries · Grade the key questions · Strike the month goals · Write the fold · Verdict and forecast | The weekly memos against the diary; each week's question against the next week's rows; each strike needs a receipt; one sentence per objective; graded at the next month review |
| Quarter | Goal walk (keep, rephrase, kill) · Themes · Scores · Pre-mortem · Close-out | The owner's grade with receipts per point; two independent readers with the agreement shown; thirteen weeks against the floors; the quarter's misses; next quarter's goals are the owner's |
| Year | Calendar walk (repeat, never again) · Grade the year goals · North star test · Belief ledger · Year sentence | One line per week from its own entries; twelve months of receipts; what the year proved and disproved; memories created against memories revised; next year's goals are the owner's |

The steps and their questions are the owner's method, word for word, in `packages/contracts/src/planner-period-review.ts` (`plannerPeriodSteps`).

## The proof checks

- **Receipts.** A claim and the words it rests on. On save, each quote is normalised (case, punctuation, spacing) and searched in every raw row of the period: diary entries, health rows' notes, done tasks' titles, notes and comments, week records' question, verdict and note. Found: `verified` with the row as its source. Not found: kept, shown as "unsourced". A quote under twelve characters never verifies.
- **The model's checks** (month, step 1) and **themes** (quarter, step 2) go through the same check: what the model says "holds" is its opinion; `verified` is the server's.
- **Two readers.** The themes call runs the model twice, with the weeks in opposite order, one after the other. Themes both readers named (half their long words in common) count for two readers; `agreement` is their share of all themes.
- **Forecasts graded.** Each review ends with one forecast sentence. The next review of the same level shows it and the owner grades it held, partly or missed; the grade is written on the earlier period's row.
- **Rewrite rate.** The model's draft is kept beside the saved memo; the share of the saved memo's lines that are not in the draft is recorded (0 to 1). A memo written from the page's own template has no draft and no rate.
- **Counts over adjectives.** The weeks table shows entries, health rows, tasks done, goal results and scores per week; the quarter's Scores step shows mean, spread and weeks under each floor, computed on the page from the rows.

## Data

Migration `migrations/9013_planner_period_review.sql` (hand-written, additive, not in the Drizzle journal, no foreign keys, no triggers; Drizzle mirror in `packages/db/src/schema/planner.ts`):

| Table | Holds |
| --- | --- |
| `planner_period_review` | One row per reviewed period: the page's state, the memo id, the verdict, the forecast and its grade (set by the next review), the model's draft, the rewrite rate, the year walk's week marks, when it was done. Key `(user_id, level, period_start)`. |
| `planner_evidence` | The receipts: claim, quote, source (`memo`, `health`, `task_event`, `week`), source id and day, verified flag. Rewritten whole on each save. |

The memo is a diary memo tagged `vault-summary` with source `period-review` and client id `period-review-summary:<level>:<period>`, so saving twice updates one memo. Goal results and decisions are written on the period's goals (and the level below's); a goal the owner kills is closed.

Both tables are registered in `packages/domain/src/fork/data-sources.ts` with probes, in `scripts/persistence-manifest.mjs` and in the planner test runtime's reset list.

## Code

| Where | What |
| --- | --- |
| `packages/contracts/src/planner-period-review.ts` | Period maths (the Thursday rule, the weeks of a period, what closes with a week, what is due), the steps, the schemas and routes. |
| `packages/domain/src/planner/period-review-context.ts` | Reads the period: weeks with records and counts, the raw rows kept whole (done tasks carry their notes and comments, so a receipt can rest on them), goals with linked-task counts, memories created and revised, the last review. `plannerVerifyQuote`. |
| `packages/domain/src/planner/period-review-prompts.ts` | The prompts (checks, themes per reader, coach per step, memo), their parsers, the memo cleaner, the rewrite rate. |
| `packages/domain/src/planner/period-review.ts` | Read, status, state autosave, start over, save. |
| `apps/worker/src/routes/planner-period-review-api.ts` | The routes, mounted from `planner-api.ts` like the weekly review's; the same model (`planner-review-ai.ts`), buckets and NDJSON streaming. |
| `apps/web/src/planner/period-*.ts(x)` | The page, its state model, API client, strings, and the hand-off tile the weekly review renders. |

Routes, under `/api/app/planner`:

| Route | Does |
| --- | --- |
| `GET /period-review?today&level?&period?` | The review as the page reads it. |
| `GET /period-review/status?today` | What closes with the reviewed week, and whether each is done. |
| `PATCH /period-review/:level/:period/state` | The page's progress. |
| `POST /period-review/:level/:period/start-over` | Clears the progress; saved results stay. |
| `POST /period-review/:level/:period/save` | Memo, verdict, forecast, last period's grade, goal results, receipts, week marks. |
| `POST …/ai/checks`, `…/ai/themes` | JSON: the summaries against the diary; two readers over the diary. |
| `POST …/ai/coach`, `…/ai/memo` | NDJSON streams, like the weekly review's. |

The model's diary budget is the whole period's: 60,000 characters for OpenRouter and Anthropic, 9,000 for Workers AI, shared evenly across the weeks (at least 600 each). The raw rows are read whole regardless, for the receipt check. With no model (`FLAREMO_REVIEW_AI=off`, or a local `wrangler dev`) the reader is off, the checks and themes buttons are hidden, and the memo comes from the page's own template.

## Hook-ins

The weekly review is on hold for other work, so this adds to it in one place: `apps/web/src/planner/review-page.tsx` imports `PlannerPeriodHandoff` and renders it under the two parts. The sidebar link lives in the fork-owned `nav-link.tsx`. The upstream files gain one line each: `apps/worker/src/spa-routes.ts` and `apps/web/public/sw.js` list `/period-review`; `planner-wiring.test.ts` checks both and the route.

## Undoing it

Delete the `period-*` files, the route file and its mount line, the hand-off line in `review-page.tsx`, the sidebar link, the `period-review` entries in `spa-routes.ts`, `sw.js` and `planner-wiring.test.ts`, the contracts file and its re-export, the three domain files and their index lines, and the registry, probe, manifest and reset-list entries. The migration stays (G12): the two tables are harmless when nothing reads them. The memos it wrote are ordinary diary memos.
