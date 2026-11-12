# The flywheel

Fork-owned add-on. It turns the record of what the owner keeps, edits and
undoes into a better agent, with the owner deciding every change. Three parts:

1. **The log** (`planner_event`): every change to a goal, a review step or the
   agent's tuning, with sizes and short codes, never words.
2. **The scorecard** (`planner_metric_week`): a weekly table of numbers that
   compares what the agent proposed with what the owner did on their own,
   rebuilt every night.
3. **The loop** (`planner_tuning`): the owner's standing instructions to the
   agent, one row per version. The Sunday review shows the numbers and asks one
   question. Once a month the agent may propose a new version. Four weeks after
   a version starts, the owner keeps it or rolls it back.

Nothing in the loop changes the agent without the owner pressing a button.

## Files

| File | What it holds |
| ---- | ------------- |
| `migrations/9017_planner_flywheel.sql` | Three tables, and four nullable columns on `planner_agent_run` and `planner_week`. Hand-written, additive. |
| `packages/db/src/schema/planner.ts` | The Drizzle mirror (`plannerEvent`, `plannerMetricWeek`, `plannerTuning`). |
| `packages/contracts/src/planner-flywheel.ts` | The metric list, the three headline numbers, the limits, the DTOs and the route schemas. |
| `packages/domain/src/planner/flywheel.ts` | The log writer, the weekly rollup, the nightly sweep, the tuning lifecycle and the tuning proposal's prompt. |
| `packages/domain/src/planner/goals.ts`, `review.ts`, `period-review.ts` | Where goal and review writes call the log. |
| `packages/domain/src/planner/agent-store.ts`, `agent-tools.ts` | The proposal pause, and the agent's `read_scorecard` tool. |
| `apps/worker/src/routes/planner-flywheel-api.ts` | The five routes. |
| `apps/worker/src/routes/planner-agent.ts` | Adds the active version to each agent session's first message, and records the agent's version on the run. |
| `apps/worker/src/fork/agent-schedule.ts` | Runs the nightly rebuild inside the agent's own nightly step. |
| `apps/web/src/planner/flywheel-card.tsx`, `flywheel-api.ts`, `flywheel-strings.ts` | The card in Look back's side panel. |

## The log

`plannerRecordEvents` writes rows after the save they describe has landed. A
failure is logged and swallowed: the log never blocks a save. Kinds so far:

| Kind | When |
| ---- | ---- |
| `goal.created`, `goal.rewritten`, `goal.noted`, `goal.status`, `goal.judged`, `goal.deleted` | A goal is made, its words or its note change, its status or result changes, or it goes. `origin` is `proposal` when an accepted agent proposal made it: a goal proposal added in Look forward keeps the proposal's id, even when it fills an empty slot. |
| `review.look_back_saved` | Look back is saved: scores, summary length, how much of the drafted summary the owner rewrote, goals judged. |
| `review.look_forward_saved` | The plan is committed: goals, how many came from proposals, tasks, flags settled. |
| `review.start_over`, `review.period_saved` | The review is started again; a month, quarter or year review is saved. |
| `proposal.accepted_edited` | An agent proposal was accepted after the owner changed values on its card. `subject` is `proposal`, `subject_id` and `proposal_id` the action; `data` holds the row kind, the task field, the edited field names (comma list) and how many, `from_diary` (a to-do found in an entry), `starter` (the Ask button the proposal came from, or null) and, when the title was rewritten, `title_chars` (characters changed, never the words). The values themselves stay on the action row (`change.proposed`, `change.edited`). |
| `proposal.skipped` | A row left unticked when the rest of its card was accepted (`change.settled_reason` is `skipped`). `subject` is `proposal`; `data` holds the row kind, the task field, `from_diary` (a to-do found in an entry) and `starter`. |
| `proposal.redo` | The owner sent a card back with the one-line redo. `subject` is `proposal`, `subject_id` the conversation; `data` holds how many open rows were dismissed and their kinds (comma list). The note is in the chat, never in the log. |
| `review.tuning_note`, `review.tuning_skipped` | The owner answers or skips "What should the agent do differently?". |
| `tuning.proposed`, `tuning.accepted`, `tuning.dismissed`, `tuning.kept`, `tuning.rolled_back` | The tuning lifecycle. A proposal replaced by a newer one is logged as dismissed. |
| `scorecard.viewed` | The card was opened (at most one row an hour). |

Task changes are already in `planner_task_event`, and diary edits in
`memo_revisions`, so the log does not repeat them.

## The scorecard

A revert keeps the accept's time, so a reverted proposal stays in the week it
was accepted in. `plannerFlywheelRollup` rebuilds one week (Monday to Sunday, UTC) for one user.
The nightly sweep runs it for this week and the three before, because a
proposal is judged on its first seven days. Opening the card also rebuilds the
reviewed week when its numbers are over an hour old.

Each metric is stored per origin: `ai` (an accepted agent proposal started it),
`manual` (the owner did it on their own) and `all`. A share keeps `num` and
`den`, so the card shows "too few" under ten cases instead of a percentage.

| Metric | What it counts |
| ------ | -------------- |
| `proposals_seen` | Agent actions shown to the owner, of those made. A card counts as shown when the Ask chat or the task panel lists it, or when the owner settles it. |
| `proposals_accepted` | Accepted, of those settled. |
| `kept_7d` | Accepted actions with no owner edit in the seven days after. |
| `proposals_edited` | Accepted actions the owner changed on the card before accepting (`change.edited` is set), of those accepted in the week. |
| `proposals_redone` | Actions dismissed by a redo (`change.settled_reason` is `redo`), of those settled in the week: a card wrong as a whole. |
| `proposals_skipped` | Actions left unticked on an accepted card (`settled_reason` `skipped`), of those settled in the week: a row judged wrong on its own. |
| `todos_accepted`, `todos_edited` | Diary to-dos (a new task with `change.source`): accepted of those settled, and edited on the card of those accepted. |
| `entries_edited_7d`, `entry_edit_chars` | Diary entries edited within seven days, and the typical edit size. |
| `tasks_done_by_due` | Tasks due in the week that were done by their due day. |
| `tasks_carried` | Tasks planned into the week that were carried over. |
| `goals_met` | Week goals judged met, of those judged. |
| `goals_rewritten` | Goal rewrites in the week (a count). |
| `memo_rewrite_rate` | How much of the drafted weekly summary the owner rewrote. |
| `cost_per_kept` | Agent spend in the week per kept proposal, in cents. |

The Sunday card opens on three of them for the agent's side: accepted, kept a
week, and done on time.

## The loop

- **Every Sunday**, Look back's side panel shows the three numbers against last
  week and one question: "What should the agent do differently?". The answer,
  or a skip, is saved on `planner_week.tuning_note` with the active version.
- **Not on the card any more (2026-11-12).** The owner asked to remove the
  "Proposed change to the agent" block, so the card no longer shows a pending
  proposal or the "Suggest a change to the agent" button. The routes, tables
  and the four-week verdict below are unchanged; a version already accepted
  still gets its keep or roll back. To bring the block back, revert the commit
  "remove the proposed change to the agent from the review card". What follows
  describes the loop as it was built.
- **Once every four weeks** the card offered "Suggest a change to the agent".
  One model call (the weekly review's model) reads the current instructions,
  eight weeks of numbers and the owner's notes, and proposes one revision aimed
  at one metric. No diary text is sent. The owner can also write a version
  themselves through the same route.
- The owner **accepts** the proposal, after editing it if they like, or
  **dismisses** it. An accepted version becomes active; the one before is
  marked superseded.
- The active version rides on the **first message of every agent session**,
  and `read_scorecard` repeats it with the recent weeks.
- **Four weeks after** a version starts, if it named a metric, the card shows
  that metric before and after and asks to **keep** or **roll back**. A roll
  back restores the version before it as a new row, so the history stays a
  straight line.

### Guardrails

- The agent never changes its own instructions; only the owner's press does.
- A share over fewer than ten cases is shown as "too few" and the proposal
  prompt is told not to tune on it.
- Proposing pauses when, over the fourteen days before the last one, the agent
  made at least ten proposals and fewer than one in ten was ever shown. The
  last day is left out so one busy chat does not pause itself, and file reads
  the owner started are never counted or paused.
- The instructions are capped at 1,500 characters and the weekly note at 600.

## Routes

All under `/api/app/planner`. `:week` is the reviewed week's Monday, and every
route answers with that week's card.

| Route | Does |
| ----- | ---- |
| `GET /flywheel/:week?today` | The card. |
| `POST /flywheel/:week/note` | Saves the note, or `null` to skip. |
| `POST /flywheel/:week/rebuild` | Rebuilds the week's numbers now. |
| `POST /flywheel/:week/tuning/propose` | Asks the model for a proposal, or files the owner's `instructions`. |
| `POST /flywheel/:week/tuning/:id` | `accept` (with optional edited `instructions`), `dismiss`, `keep` or `roll_back`. |

## Known gaps

- Agent cards are accepted as they are; there is no edit-before-accept yet, so
  "kept a week" stands in for "accepted unchanged".
- Task proposals in Look forward get fresh ids when the plan is committed, so
  they are not yet joined to the tasks they became.
- Screen events (phase 4 of the plan) are not logged. That waits on the
  owner's decision.
- Weeks are UTC, like the rest of the review.

## Undoing it

Remove the card from `review-page.tsx` and the route mount from
`planner-api.ts`, and drop the `plannerFlywheelNightly` call from
`agent-schedule.ts`. The tables can stay: nothing upstream reads them. Never
edit the migration once applied; add a new one.
