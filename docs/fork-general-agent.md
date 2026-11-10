# The general agent

Fork-owned. One Claude Managed Agent does the diary's thinking jobs: the weekly
review, the month, quarter and year chapters, the goal check, next week's
proposals, and Ask my diary. It replaces the weekly memo agent of
October 2026 and nightly memory dreaming. It reads the whole record through the app's own read-only MCP server
and changes nothing; its only writes are proposals the owner accepts or
dismisses.

## Why

A blind test on four past weeks in October 2026 (dev copy) preferred the
agent's memo over a single model call every week: about twice as high on "told
me something new" and on naming which goal is losing, at about $0.80 a memo
against under $0.10. The general agent keeps that and lets one agent, with one
set of notes, do the other jobs too, reading what it needs instead of being
handed a capped file.

## The jobs

| Job                       | Where the owner sees it                     | How it runs                                                                                                                                                                                                                                                       |
| ------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Look back (weekly review) | Review page, Sunday's conversation          | One session per review (`week:<monday>`). The opening, each coach reply, the scores and the memo are steps sent to that session; the page asks every few seconds for the answer.                                                                                  |
| Look forward              | Review page, Choose the week and Plan tasks | Both steps start from the month and quarter goals, not the week alone: the agent reads `read_goals`, takes each objective's goal for the month (else the quarter), and proposes the next step on its open points. After the memo the same session gets the propose step: at most one goal per objective, each naming the month or quarter goal it serves (`serves`, shown on the card as "Serves month 2026-10 · …", with where that goal stands in its why), plus at most three memories. Goal proposals sit at the top of Choose the week. When the plan opens after the look back with no goal proposals, the page asks once by itself (`POST /review/:week/proposals`, `kind: "goals"`): the review's session takes the step, else a session of its own starts from the saved summary and the goals. Plan tasks asks once by itself when it opens with goals chosen and no task proposals (`kind: "tasks"`, with the chosen goals, which are not saved yet): at most six tasks, each under one chosen goal and moving a month or quarter goal. Suggest again on either step tells the session its untaken proposals of that kind were withdrawn, and replaces them. Cards have Add and Dismiss; Add puts one into the plan, which is saved as before. |
| Period chapters           | Review page, month, quarter and year        | Same as Look back, one session per period (`month:2026-10-01`).                                                                                                                                                                                                   |
| Goal check                | Review page, before saving the week         | The check step in the review's session flags clashes in the drafted plan.                                                                                                                                                                                         |
| Ask my diary              | Chat bubble, bottom-right of every page     | One session per conversation. It reads anything and proposes nothing (the propose tools are off and its notes are read-only). A conversation picks up where it left off; a new chat ends the session.                                                             |

Memory proposals go to the Memory page, as dreaming's did. Nightly dreaming is
skipped whenever the agent is set up (`forkAgentReplacesDreaming`); the nightly
conflict patrol still runs.

**Sunday prep (live only).** At noon Copenhagen time on Sunday the Worker
starts the week's review session and sends the opening, so it is ready when the
owner opens the review. It skips a week already reviewed or one with a session
open. Dev has no Sunday cron.

## Reading and proposing

The agent's MCP server is `POST /api/app/planner/agent/mcp`
(`apps/worker/src/routes/planner-agent-mcp.ts`). Its tools
(`packages/domain/src/planner/agent-tools.ts`):

- reads: `review_week`, `review_period`, `week_diary`, `list_entries`,
  `read_entries`, `search_entries`, `read_goals`, `read_tasks`, `read_health`,
  `read_memories`, `read_scorecard` (the owner's standing instructions and up
  to 26 weeks of the flywheel's scorecard, `docs/fork-flywheel.md`);
- proposals: `propose_memory`, `propose_goal`, `propose_task`. A proposal is
  refused unless a review session is at its memo or propose step, and a quote
  it gives must be found word for word in the owner's entry.

## The cascade ladder

Since November 2026 the review can be asked to judge the week against the
goal cascade, not the week alone (`packages/domain/src/planner/review-cascade.ts`).
It is off unless the Worker var `FLAREMO_REVIEW_CASCADE` is `ladder`; flat,
the default, is the review as before. With the ladder on:

- `review_week` (and the model's context) shows the cascade per objective,
  top down: the year goal, the quarter goal, the month goal and the week's own
  goal, each upper goal with "x of n points struck", and the weeks left in the
  month, the quarter and the year once this week is over. The counts are the
  app's, not the model's. A week belongs to the month of its Thursday, as on
  the Goals page. Goal state is today's: points have no history of when they
  were struck.
- The memo gets two bullets before Evidence in every objective's section:
  **Serves** (the month goal, its open points and the weeks left) and **Moved**
  (Advanced, Maintained, Drifted or Idle, then the gap in plain words), with
  rules to be direct about the gap and to name the goal most behind its time
  in Pattern and Risk. Next Steps are read as before.
- The scores step weighs the month goal's open points in the Achievement
  basis, and its Risk, key questions and verdicts name a month or quarter goal.

The Sunday prep, the review routes and the agent's MCP server all read the
var, so one deploy switches every step at once. Nothing else changes: the
opening, the coach, the proposals and the goal check already read the
cascade.

**The replay** (`scripts/fork/review-cascade-sim/run.ts`) compares the two on
dev: it runs past Sundays the owner reviewed in the app (opening, scores with
the owner's saved answers, memo with the owner's saved scores, question and
verdict, proposals, goal check) through the dev Worker as the app does, once
with the var unset and once with `ladder`, and shuffles the memos for blind
reading. No coach replay: a new coach question cannot change an old answer.
It reads the dev database read-only for the saved answers and each session's
cost, stops at a dollar budget, and writes the answers outside the
repository. Dev only.

**The replay's cut** (`packages/domain/src/planner/review-as-of.ts`). A
replay of a past week runs against the diary as it is today, so without a
cut the agent reads the owner's own saved review of that week, tasks made
later and later weeks' scores, and copies them (round 1 showed it). With the
dev var `FLAREMO_REVIEW_AS_OF=review-week` the agent's MCP server hides, for
the week of the open review session, everything written after the owner
saved that week's look back (or after the Tuesday following the week, when
it was never saved): diary entries, memories, health days, tasks made or
finished later, comments and history on a task, goals made later and later
weeks' scores. `review_week`, `read_goals` and `read_tasks` take "today" as
the cut's day. Goal state cannot be rolled back: points struck and results
stay as they are today, and a task's status and notes are today's. Off (the
default) changes nothing, and live never sets it: a live review has nothing
after its Sunday to hide. Set it on dev for both arms of a replay, with
`FLAREMO_DEV_REVIEW_AS_OF=review-week` before `deploy`.

## Standing instructions

The owner's active tuning version (`docs/fork-flywheel.md`) is added to the
first message of every agent session, and the run records which version it
was given (`planner_agent_run.tuning_version`) and the agent's own version as
the session reported it (`agent_version`). The agent never edits the
instructions. Its proposing pauses when almost none of its recent proposals
were shown to the owner.

## Proposing into tasks and the diary

From the task panel's **Ask agent** button (by the Notes heading) the agent
holds a chat about that one task, beside the task on a wide screen and under
it on a phone. From Ask my diary's window it holds the global chat. In either,
when the owner asks it to write, draft, set, move or add something, the agent
proposes it as a card, and nothing is written until the owner accepts the
card. "Propose first, then act on confirmation":

- `read_task` reads one task whole (fields, notes, comments, the last 30
  History lines) so the agent drafts from what is there;
- `propose_task_change` proposes one field of one task per call: title,
  notes, priority, due date, effort, start date or column;
- `propose_add_task` proposes a new task (title, notes, due day, priority,
  column);
- `propose_entry` proposes a new diary entry.

Since November 2026 (the control panel, design option B) it can also propose:

- in `propose_task_change`, a task's weekly goal link (`goal_id`, or null to
  unlink) and dropping it off the board or putting it back (`dropped`);
- `propose_task_comment`, a comment on a task;
- `propose_entry_edit`, a flag on an existing entry that looks off, only when
  the owner asks: `flag` (what looks off, "line 2 says Tuesday but the gym was
  Monday") and an optional `quote` (the entry's own words, found word for word
  or refused). The agent writes no text: the owner rewrites the entry on the
  card (see "Whose words");
- `propose_entry_tags`, #tags added to or taken from an entry (`add`,
  `remove`: tag names, validated as upstream reads tags). The server writes
  the new text (a new tag at the end of a last line of tags, else on its own
  line; a removed one leaves the words around it), files it as an
  `entry_edit` with `tags`, and the card shows the lines it changes;
- `propose_entry_state`, archiving an entry or bringing it back, pinning or
  unpinning it;
- in `propose_task_change`, `column` with `before_id` or `after_id`: the task
  at an exact spot of that column (the field is stored as `place`, with
  `was: { column, board_rank }`; the card reads "To To Do, above <task>");
- `propose_entry_link`, linking two entries (or `remove: true` to unlink): a
  `reference` relation from `entry_id` to `related_entry_id`, with `was` the
  entry's sorted reference ids;
- `propose_memory_change`, correcting a memory (`action: correct`, with the
  new `content`) or forgetting it (`action: forget`), by the id `read_memories`
  lists, only for an active memory the owner has ruled on (not a proposal
  waiting on the Memory page). Stored as kind `memory_change` with
  `was: { content, status }`. The review-only `propose_memory` is unchanged;
- `propose_health_change`, fixing a health row the diary misread
  (`action: fix`, `entry_id` from `read_health`, any of `day`, `variant`,
  `minutes`, `home_at`; `was` holds the values of just those fields) or adding
  one it missed (`action: add`, `day` and `kind`, with `variant`, `minutes` or
  `home_at`), adding one it missed (`action: add`, `day` and `kind`, with
  `variant`, `minutes` or `home_at`), or removing a false row (`action: remove`,
  `entry_id` only; for example the diary said "skipped the gym" but a session
  was logged; `was` holds the row's day, kind, variant, minutes and home time).
  The agent cannot change a row's kind: that is remove plus add. Stored as kind
  `health_change`. `read_health` now prints each row's id;
- `propose_goal_change`, pointing at a weekly goal the owner seems to need
  (`action: add`, `period_start` a Monday, this week or later (up to about six
  months ahead; a past week is refused), `pillar` and a `flag`, "you wrote
  you'd train three times") or at one of the owner's that looks off
  (`action: edit`, `goal_id` from `read_goals`, a `flag`, and `pillar` only to
  move it; only a goal of this week or a later one, a past week's goal is
  refused; "today" is the tool context's, so a replay's `asOf` day counts).
  No title, lines or note: the owner writes them on the card. An edit cannot
  move a goal to another week (`plannerUpdateGoal` has no week).
  Weekly goals only, never a delete, and never a goal's status, result or
  score: those are the owner's own verdicts, and the tool refuses them (its
  input has no such fields). Stored as kind `goal_change`; an edit keeps `was`
  (the goal's title, lines, note and pillar) and the card shows the goal's
  title and week. On an edit, a line that stays word for word keeps its note
  and strike. The old words are kept by the goal change log
  (`planner_goal_version`, migration 9018).

Since November 2026 it also reads links the owner gives it (`read_link`) and
proposes a summary entry (`propose_entry` with `link`), saved as a link
summary that the rest of the diary never reads as the owner's words; see
`docs/fork-link-summaries.md`. The sandbox still has no web: the Worker
fetches the link.

Nothing it proposes deletes: dropping a task and archiving an entry are as far
as it goes. A weekly goal can be added or rewritten (never deleted, and its
status, result and scores are the owner's): every write is logged in the goal
change log with the actor `proposal:<id>`, which is what Undo reads.

Each proposal records what the field or entry held when it was proposed
(`change.was`, plus `task_title`, `goal_title` or the entry's first words for
the card), so the card shows the value before and after, and an **accept is
refused when the record changed since** ("This changed since the agent
proposed it"): the proposal stays open, to dismiss and ask again.

### One card per answer

Every proposal filed while one question was being answered shows in **one
card** (the chat groups a conversation's proposals by the owner question they
follow). Each row has a tick box; **Accept N** writes the ticked rows one after
another, each through the same route as before, so a refused row says why on
its own line and the others go on; **Dismiss** settles the rows still open;
**Undo all** puts back the accepted rows, newest first. A lone proposal keeps
its own card, with **Undo** once accepted. One answer holds at most 25
proposals (`PLANNER_AGENT_ACTIONS_PER_ANSWER`).

### Edit before Accept

Every value on an open row is a field ("fix it, then accept"), drawn as a small
inline control in the app's own input styling. The agent is for many edits at
once and for things buried in the diary; one simple task is faster typed by
hand, and it may say so. What is editable, by row:

| Row | Fields |
| --- | ------ |
| New task | title, column, due day (or none), weekly goal (or none) |
| Task change | its one value: title, column, due day, priority, effort, start day or goal; for a place, the column and top, bottom or the agent's own spot |
| Health add | kind and variant, minutes, day |
| Health fix | minutes, and variant (from the row's own kind) |
| Weekly goal add | objective and week; the title (empty, the owner must write it) and lines |
| Weekly goal edit | the title and lines, starting from the goal's own; the objective, when the proposal moves it |
| Flagged entry | the entry's text, starting from its own |

Comments, new entries and memory wording are not editable. A row whose values
differ from the proposal shows an **Edited** tag with a **Reset**; unticked rows
stay skipped.

### Whose words

Since November 2026 (the owner's decision, mockup "Whose words") the agent
fills in values everywhere but writes no words of a weekly goal or a diary
entry: it points at one and says in a few words what looks off (`flag`), and
the owner writes the words on the card. A flagged entry shows the flag, the
quote if any, and the entry's text in a box that starts with that text;
Accept stays off until the owner changed it (`text` in `edit`). A goal add
shows an empty title field the owner must fill (`title`, optional `lines`); a
goal edit shows the goal's title and lines to rewrite, and Accept needs a
changed word or a moved objective. In a card of many rows, a row that still
waits on words is skipped by **Accept N** and says what it needs. The checks
are the same as before: the stale check on `was`, current and future weeks
only, no twin goal (now checked on Accept, against the owner's title),
weekly goals only. Tags, links, objectives, weeks, dates and health values
stay agent-proposable. Memory corrections are not part of this decision.

The words ride in `edit` (`text` for an entry; `title`, `lines`, `note` for a
goal) and the accept writes them as before; the row keeps them as
`change.content` or `change.title`/`lines` with `change.edited`, so Undo and
the learning log work unchanged (`proposal.accepted_edited` with the field
names, never the words). What a field starts at is `plannerAgentEditBaseline`
(contracts), the same for the card and the Worker; whether a row still waits
on words is `plannerAgentNeedsWords`.

**Older rows.** An open proposal filed before this change may still hold the
agent's words (`content`, `title`, `lines`). They are never written:
`plannerAgentWordless` drops them before the accept, and the card shows the
row as a flag, its field filled from the record (`was`), not from the agent's
text, so the owner must write before Accept.

### Redo

Under the open rows of a card sits one line, "Tell it what to change", and
**Redo** (mockup option B): for a card that is wrong as a whole. Redo sends
`POST /ask` with `redo: { action_ids, note }` (no `text`; the conversation is
required). The Worker dismisses the card's open rows that belong to the
conversation, marking each `change.settled_reason: "redo"` (never deleted, so
the flywheel sees them; dismissed before the turn, so the new proposals are
not taken for repeats of open ones), and sends the agent a new turn in the
same session: the note and a compact list of the dismissed rows (id, kind,
field, values; old values and long text cut). The chat shows the owner's
line as "Redo: <note>", and the agent's new proposals come after it, so they
form a new card. If the turn cannot be sent, the rows open again. The usual
limits apply (25 an answer, 100 a day), and a redo while the last question is
still being answered is refused like any question. The flywheel logs
`proposal.redo` (counts and kinds, never words) and the scorecard counts
`proposals_redone` (`agent-redo.ts`).

`POST /agent/actions/:id` takes an optional `edit` with `state: "accepted"`: a
flat object of only the keys the row offers (`plannerAgentEditableKeys`, one
list for the card and the Worker), for example `{ "due_at": "2026-11-09" }` or
`{ "column": "doing", "spot": "bottom" }`. `plannerAgentApplyEdit`
(`agent-edit.ts`) refuses any other key and checks each value the way the tool
checked the proposal (a weekly goal, a real column, an anchor on the board, a
variant that fits the kind, a goal week not in the past, no twin), then lays it
over the proposal's `change`. The write goes through the owner's usual code, and
the stale check still reads the agent's original `was`. A refused edit leaves the
row open with the reason on its line.

The action row keeps both versions in `change` (no migration): the merged values
that were written, `proposed` (the agent's values for the edited keys) and
`edited` (the owner's). Undo reads the merged `change`, so it puts back what was
really written. The flywheel logs `proposal.accepted_edited` in `planner_event`
(field names only, never words) and the scorecard counts `proposals_edited`:
accepted rows the owner changed, of those accepted (see
[fork-flywheel.md](fork-flywheel.md)).

A card shows the proposed text or value and the agent's reason, with
**Accept** and **Dismiss**. The accept is the write: the Worker makes the
change through the same code the panel's own edits use (`plannerChangeTask`,
`plannerAddTask`, upstream's `createMemo` with source `agent-draft`), as the
actor `proposal:<id>`. The field then reads as the owner's own; nothing in
the app marks it as agent-written. The record keeps the mark: every History
line the accept wrote names the proposal, and the proposal row
(`planner_agent_action`, migration 9015) keeps the run, the conversation, the
field, the reason, when it was first shown, how it was settled and what the
field held before, so agent-drafted changes can be studied and improved
later. History shows such a line as "Agent, accepted by you".

The tools file a proposal only while an Ask chat is answering (the open Ask
run whose question has no answer yet); in a review session they are refused.
A proposal that repeats an open one in the same conversation is not filed
twice. **At most 100 proposals a day** (`PLANNER_AGENT_ACTIONS_PER_DAY`; 30 until November 2026); the
agent is told when they are used up. A proposal left open for seven days is
expired by the nightly sweep. A task chat and the global chat each list only
their own conversations (`planner_agent_chat.task_id`).

Routes: `GET/POST /ask` take `task` for a task's chat and return `actions`
(`POST /ask` takes `redo` instead of `text` for a redo);
`POST /agent/actions/:id` with `{ state: "accepted" | "dismissed", today, edit? }`;
`POST /agent/actions/:id/revert` with `{ today }` (Undo).

## Undo

Undo on a card puts back what an accepted proposal wrote, as new changes, and
marks it `reverted` (`plannerAgentRevertAction` in `agent-apply.ts`):

- a task change or a comment: every History line the accept wrote is reverted,
  newest first, through the History's own Revert (below), so History shows the
  change and its revert;
- a new task: dropped off the board, never deleted;
- a new entry: archived, never deleted;
- an entry edit: the old text comes back as a new version (upstream keeps each
  version in `memo_revisions`); refused if the entry was edited again since;
- an archive or pin: the entry gets back what it held;
- a place: the column move is reverted through History as above and the old
  `board_rank` is written back (no event; only if the task is back in its old
  column; a same-column place has no History line, only the rank). A place can
  re-spread the whole target column (when the card above has no key), so the
  accept also keeps every card's rank from before (`column_ranks`) and what it
  wrote (`written_ranks`); Undo restores a card's old rank (null included) only
  while the card is still in that column and still holds the rank the accept
  wrote, so a card the owner re-ordered or moved since keeps their change;
- an entry link: only the one link the accept wrote is removed (or the removed
  one added back), refused when it is not there to take away;
- a memory correction or forget: the accept is the owner's own click, with the
  user actor of `memory-api.ts`: `updateMemory` for a correction, `archiveMemory`
  for a forget (never `hardDeleteMemory`); a clash with another memory (same
  words, same fact key) refuses the accept with that message. Undo writes the
  old words back through `updateMemory` (refused if the words changed since) or
  `restoreMemory` (refused if the memory is no longer archived). `updateMemory`
  reads the owner's hand as a confirmation, so a corrected memory reads as
  confirmed by you after the accept, and Undo restores the words but not
  the old confidence level (no owner function lowers it), so the card says
  "Undo puts the words back; the memory stays marked as confirmed by you".
  A correction changes only the words, so tier and fact key never need
  restoring;
- a health row fix: accepted through `healthPatchEntry` (the row becomes
  `edited`, so the nightly re-read keeps it), the full row snapshot kept as
  `before`; Undo (`healthRevertEntry`) writes that snapshot back as a
  `restore` event, `edited` included, so a row the diary had read is read again
  by the next re-read; refused if the row differs from what the accept left;
- a health row remove: `healthDismissEntry` (the row is `dismissed`, which the
  nightly and manual re-reads leave alone, and a `dismiss` event); Undo is
  `healthRevertEntry` with the row snapshot taken before (a `restore` event
  that un-dismisses it), refused if the row changed since. Accept is refused
  when the row no longer matches `was`;
- a health row add: `healthCreateEntry` makes a `manual` row with no memo; Undo
  soft-deletes it (`deleted_at` and a `delete` event, never removed); refused
  if the row was fixed since.
- a weekly goal add: `plannerCreateGoal` as `proposal:<id>` (version `create`);
  Undo soft-deletes it through `plannerDeleteGoal` (version `delete`, never
  removed); refused if the goal's last version is not the accept's or the goal
  differs from what that version left, or if a task was linked to it since;
- a weekly goal edit: `plannerUpdateGoal` as `proposal:<id>` (version
  `update`, `before` the title, lines, note and pillar it held); Undo writes
  those back through the same path (version `restore`); refused if the goal
  changed since the accept, judged against the version row the accept wrote.

The route syncs the task archive before and after, so the lines upstream wrote
for the accept are there to revert and History shows the revert at once.

## Revert

Every History line that can be put back carries **Revert**, agent-drafted or
not: a plan, a drop, an effort, a start date, a goal link, a status change, a
comment, and an upstream edit of the title, notes, priority, due date or
project. A revert is a new change through the same setters, followed by a
`reverted` line naming the line put back; the archive is never rewritten. The
previous value comes from the archive (planner events carry `from`; an
upstream edit's previous value is the latest earlier event that set the
field) or, for an accepted proposal, from what the proposal recorded before
its write. A value the archive never held (notes or a due date set at
creation, which upstream does not log) cannot be put back, and the toast says
so. Reverting an accepted proposal also marks the proposal `reverted`. Route:
`POST /tasks/:id/history/:eventId/revert`; code
`packages/domain/src/planner/history-revert.ts`.

**Its key.** The server takes one key only: a `memos_pat_` token named
"Schizo Diary agent (read-only)", which the Worker makes for the owner, keeps
in the agent's vault on Anthropic's side, and renews before it expires. The
same key is refused everywhere else in the app (`apps/worker/src/fork/agent-key.ts`,
hooked into `context.ts`), and the owner's own tokens and cookies are refused by
the agent's server. The key never enters the agent's sandbox.

**Its sandbox** has no web tools and no package installs; it reaches the app's
MCP server and nothing else.

## Spend

- Each session has a hard cap enforced by Anthropic: `FLAREMO_AGENT_RUN_USD`,
  default $5.
- The month has a cap: `FLAREMO_AGENT_MONTH_USD`, default $30. A session's cap
  is the smaller of the two; with less than $0.50 left in the month, no session
  starts and the page says so (`agent_month_cap`).
- What each session cost is in `planner_agent_run`. Idle sessions are ended
  after 12 hours by the nightly sweep.

## If the agent can't run

The review keeps working. With a review model configured (`FLAREMO_REVIEW_*`),
any step the agent can't take goes to the model as before; without either, the
review works with its drafts. Ask needs the agent and is hidden without it.

## Code

| What                                   | Where                                                                                                                                                                               |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tables (runs, proposals, Ask messages) | `migrations/9014_planner_agent.sql`, `packages/db/src/schema/planner.ts`                                                                                                            |
| Proposed actions, task chats           | `migrations/9015_planner_agent_action.sql`, `packages/domain/src/planner/agent-apply.ts` (the accept), `history-revert.ts` (Revert)                                                  |
| Store, tools, prompts, definition      | `packages/domain/src/planner/agent-store.ts`, `agent-tools.ts`, `agent-prompts.ts`, `agent-definition.ts`                                                                           |
| Skills                                 | `skills/weekly-review`, `period-review`, `ask-my-diary`, `goal-check`                                                                                                               |
| Managed Agents client, key, sweep      | `apps/worker/src/routes/planner-agent.ts`                                                                                                                                           |
| Review and period routes               | `apps/worker/src/routes/planner-goals-api.ts`, `planner-period-review-api.ts`                                                                                                       |
| MCP server, Ask routes, Sunday prep    | `apps/worker/src/routes/planner-agent-mcp.ts`, `planner-agent-api.ts`, `planner-agent-schedule.ts`                                                                                  |
| Hooks into the Worker                  | `apps/worker/src/fork/agent-key.ts`, `agent-schedule.ts`                                                                                                                            |
| Proposals and Ask in the app           | `apps/web/src/planner/review-proposals.tsx`, `ask-api.ts`, `ask-store.ts`, `ask-bubble.tsx`, `ask-window.tsx`, `ask-chat.tsx` (the chat and its cards), `task-agent.tsx` (the task's drawer), `history-timeline.tsx` (Revert) |
| Tests (stub agent)                     | `apps/worker/src/routes/planner-goals-api.test.ts`, `planner-agent-api.test.ts`, `packages/domain/src/planner/agent-tools.test.ts`, `agent-actions.test.ts`, `apps/web/src/planner/review-proposals.test.ts`, `task-panel.test.tsx` |

## Setting it up

```sh
# ANTHROPIC_API_KEY set, or a network secret for api.anthropic.com; prints ids only
pnpm exec tsx scripts/fork/general-agent.ts --owner <first name> --target dev
```

For the target (`dev` or `prod`) it creates or updates the agent "Schizo Diary
agent (<target>)" (Claude Opus, medium effort) with its four skills, the
sandbox `schizo-diary-agent`, the memory store `review-notes-<target>` (the memo
agent's, so its notes carry over) and an empty vault. Dev and prod have their
own agent and skills, so a skill change tried on dev reaches prod only when the
script runs with `--target prod`. Run it again after changing a skill or the
prompt in `agent-prompts.ts`; it uploads only what changed.

Then give the Worker the secret `ANTHROPIC_API_KEY` and the vars it prints:
`FLAREMO_AGENT`, `FLAREMO_AGENT_ENVIRONMENT`, `FLAREMO_AGENT_STORE`,
`FLAREMO_AGENT_VAULT` (plus the two spend caps if not the defaults).

- **Dev:** set `FLAREMO_DEV_AGENT`, `FLAREMO_DEV_AGENT_ENVIRONMENT`,
  `FLAREMO_DEV_AGENT_STORE` and `FLAREMO_DEV_AGENT_VAULT` before
  `node scripts/fork/dev-env.mjs deploy`. Dev's vars come from the generated
  config, so a deploy without them turns the agent off on dev.
- **Live:** run `scripts/fork/prod-deploy.mjs deploy` once with
  `FLAREMO_PROD_AGENT`, `FLAREMO_PROD_AGENT_ENVIRONMENT`, `FLAREMO_PROD_AGENT_STORE`
  and `FLAREMO_PROD_AGENT_VAULT` set to the printed ids; it puts them on the
  Worker, and later deploys keep them (`--keep-vars`). The old `FLAREMO_REVIEW_MEMO_*` vars do nothing now and can
  be removed.
- **The ladder on live:** run the prod deploy with
  `FLAREMO_PROD_REVIEW_CASCADE=ladder` (or `flat` to turn it off again). Unset
  keeps whatever live has. Live never sets `FLAREMO_REVIEW_AS_OF`.

## The eval

The Worker tests run every job against a stub agent. For the real agent on dev:

```sh
FLAREMO_EVAL_TOKEN=<an access token made on dev> \
  pnpm exec tsx scripts/fork/agent-eval.ts [--jobs ask,back,forward,check,period]
```

**In a Claude cloud session** both credentials are network secrets in the
project's environment, never environment variables (those are visible to
anyone using the environment): the Anthropic key for `api.anthropic.com` in the
header `x-api-key` with no prefix, and the dev access token for
`flaremo-dev.ulysse-ha-19.workers.dev` in `Authorization` with the prefix
`Bearer` (which also lets the session reach dev). The scripts then send a
placeholder the proxy replaces. Node's fetch uses the proxy only when asked,
and `api.anthropic.com` skips it by default, so run them as:

```sh
NODE_USE_ENV_PROXY=1 NO_PROXY=localhost,127.0.0.1 no_proxy=localhost,127.0.0.1 \
  pnpm exec tsx scripts/fork/general-agent.ts --owner <first name> --target dev
NODE_USE_ENV_PROXY=1 pnpm exec tsx scripts/fork/agent-eval.ts
```

It runs the jobs through the dev Worker as the app does and checks each
answer's shape: an opening whose claims are all found in the diary, short coach
replies, scores in range, a memo with its sections, proposals within their
limits and each with a reason, a goal check that names the plan's goals, Ask
answers that name real days and say when something is not recorded, and no
proposals from Ask. It prints only checks and sizes; the answers, which hold
diary text, go to a file in the system's temp folder. It leaves what an unsaved
review would: open proposals for next week, notes in dev's memory store, and a
session the nightly sweep ends. It refuses any deployment but dev.

## Turning it off

Remove the four `FLAREMO_AGENT*` vars: reviews go back to the review model,
Ask disappears, and nightly dreaming runs again. The agent's notes can be read,
edited or deleted in the Anthropic Console under Memory stores.
