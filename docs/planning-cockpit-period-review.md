# The month, quarter and year reviews

Status: built 2026-10-17 on `feat/period-reviews`, folded into the one review page on `feat/unified-review` the same day. It goes to `flaremo-dev` first; live gets it only on the owner's word. A fork-only add-on inside the weekly review ([planning-cockpit-goals-review.md](planning-cockpit-goals-review.md)), under the same guardrails. Not proposed upstream. The agreed design is the page at https://claude.ai/artifact/Q2GCUEXzJBbdouPa6KJyrJ: every Sunday one Review, the date picks the chapters, nothing to choose.

## The idea in one paragraph

A month, a quarter and a year each close on the Sunday of their last week (a week belongs to the month of its Thursday, the Year map's rule). On that Sunday the weekly review runs first (Look back), then its "superset" runs in the middle, then Look forward plans the next week against the new goals. Each level has five steps in the same shape as the weekly review: raw rows on the right, the owner's own words and a chat with a reader on the left, a memo the owner edits, and Save. The raw rows (diary entries, health rows, tasks done, week records, goals) are evidence; the weekly summaries and the memories are claims to test. Every claim the review rests on is a **receipt**: a quote that the server checks word for word against the raw rows. The model reads, checks, counts and quotes; it never writes goals, verdicts or marks.

## Month and quarter: the weekly chat

The owner's decision of 17 October 2026, after a click-through mock: the month, quarter and year reviews are the weekly review's Look back, conversational and the same steps, over the bigger period. No step strip, no goal walk, no forecast, nothing to enter or grade by hand. Later the same day the owner folded them into the weekly page: there is one sidebar link, Review, at `/review`, and the page works out from the date which chapters to run, with no level or period to pick.

1. Before it starts, the chat shows what the review reads: diary entries, weekly memos, tasks done and goals, counted from the period's weeks.
2. Start: the review agent (or the review's model) reads the whole period. Its first message is the recap with **What happened in October 2026**: up to eight claims, each with the owner's own words, the day and where they were found (entry, health log, task, week record). The model must quote each claim; the server checks every quote word for word against the period's rows (`plannerVerifyQuote`) and drops the claims it cannot find, saying how many it left out. The owner does nothing with receipts.
3. Then the weekly steps, said of the period: last period's key question (the one the last month's or quarter's chat set), the period's goals marked met, partial or missed, the seven reflection prompts ("this week" becomes "this month"), the two scores (starting from the mean of the weeks' scores), the key question for next period's review, and a verdict, each with drafted options and the coach in the chat.
4. The memo sheet, as in the weekly review: the agent writes the memo (title `# Month review: October 2026`, What happened with its quotes, the prompts, goal progress with the scores table, the trajectory, the key question and the verdict), the owner edits and saves. Saving writes the memo, the verdict, the goal results and the What happened claims as receipts; the forecast stays empty. Then the weekly review's Look forward.

The chat is the weekly one (`review-back.tsx`, `review-model.ts`, `review-sheet.tsx`) fed the period's review shaped as a week's (`period-chat-model.ts`), and its AI requests go to the period's own routes, which take and answer the weekly ones' shapes (`/period-review/:level/:period/chat/ai/*`). With the review agent configured (docs/fork-review-memo-agent.md), one agent session carries the whole review, keyed by the period (`month:2026-10-01`) instead of a week; it reads `/data/this-period.md` (every week of the period with its record, saved summary and diary) and is told to read "week" in its standing instructions as "month" or "quarter".

## What the owner sees

`/review` (the page in [planning-cockpit-goals-review.md](planning-cockpit-goals-review.md)) shows a strip of chapters: Look back, then one tile per period closing with the reviewed week (a week belongs to the month of its Thursday, so a month, quarter or year closes on the Sunday of its last week), biggest last, then Look forward. The strip only shows where the review stands; tiles ahead of the open chapter are not links, and each chapter's "next" button names the chapter that follows ("October 2026 →", then "Look forward →"). A period's chapter is the chat above, read from `GET /period-review?level&period` and saved on its own routes; `?part=month` opens it directly when it exists. The sidebar link "Review" carries a dot from Saturday to Monday while anything, the week or a period, is not done (`GET /period-review/status`). On a weekday the page still shows last Sunday's chapters, so a missed one can be finished. Start over in the header clears the open chapter only. The old `/period-review` address goes to `/review`.

The five-step designs below (checks, themes, two readers, forecasts, the calendar walk) are no longer rendered: their routes and domain code stay for now, unused by the page.

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
| `packages/domain/src/planner/period-review-chat.ts` | The month and quarter chat's prompts: the opening with What happened and its check, the close, the coach, the memo, and the review agent's messages and files for a period. |
| `apps/web/src/planner/period-chat.tsx`, `period-chat-model.ts` | The month and quarter chat: the weekly chat on the period's routes, what the review reads, What happened, the save. |
| `apps/web/src/planner/period-*.ts(x)` | The chat (`period-chat.tsx`, `period-chat-model.ts`), the API client and the strings. `review-page.tsx` renders the chat as a chapter and decides the chapters from the date (`plannerPeriodsClosingWith`). |

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
| `POST …/chat/ai/opening`, `…/chat/ai/close` | The month and quarter chat, in the weekly review's shapes: the opening (with `happened` and `dropped`) and the scores and trajectory; `{"agent"}` when the review agent has the step. |
| `POST …/chat/ai/coach`, `…/chat/ai/memo`, `GET …/chat/ai/agent/:session` | The chat's coach and memo streams, and the review agent's answer to a step. |

The model's diary budget is the whole period's: 60,000 characters for OpenRouter and Anthropic, 9,000 for Workers AI, shared evenly across the weeks (at least 600 each). The raw rows are read whole regardless, for the receipt check. With no model (`FLAREMO_REVIEW_AI=off`, or a local `wrangler dev`) the reader is off, the checks and themes buttons are hidden, and the memo comes from the page's own template.

## Hook-ins

The weekly review is on hold for other work, so the page change is contained: `apps/web/src/planner/review-page.tsx` lists the chapters (the week's two parts and the periods closing with the week), draws the strip, renders `PlannerPeriodChat` for an open period chapter and points each chapter's next button at the one that follows. The chat adds three small hooks to the weekly review's own files: `review-back.tsx` takes an optional `period` (its name, its word, and what to draw at the start and under the recap), `review-sheet.tsx` an optional `name`, and `goals-api.ts`'s request paths accept the period chat's route path in place of a week. The sidebar link lives in the fork-owned `nav-link.tsx`. The upstream files gain one line each: `apps/worker/src/spa-routes.ts` lists `/review` and the old `/period-review` (`apps/web/public/sw.js` already listed both); `planner-wiring.test.ts` checks them and the routes.

## Undoing it

Delete the `period-*` files, the route file and its mount line, the chapter code in `review-page.tsx` (`periodChapters`, `PeriodChapter`, and the period branches of `Chapters`), the `period-review` entries in `spa-routes.ts`, `sw.js` and `planner-wiring.test.ts`, the contracts file and its re-export, the three domain files and their index lines, and the registry, probe, manifest and reset-list entries. The migration stays (G12): the two tables are harmless when nothing reads them. The memos it wrote are ordinary diary memos.
