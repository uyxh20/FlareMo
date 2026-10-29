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
  `read_memories`;
- proposals: `propose_memory`, `propose_goal`, `propose_task`. A proposal is
  refused unless a review session is at its memo or propose step, and a quote
  it gives must be found word for word in the owner's entry.

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
- `propose_entry` proposes a new diary entry. The agent never edits an
  existing entry; the diary only grows by new entries the owner accepted.

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
twice. **At most 30 proposals a day** (`PLANNER_AGENT_ACTIONS_PER_DAY`); the
agent is told when they are used up. A proposal left open for seven days is
expired by the nightly sweep. A task chat and the global chat each list only
their own conversations (`planner_agent_chat.task_id`).

Routes: `GET/POST /ask` take `task` for a task's chat and return `actions`;
`POST /agent/actions/:id` with `{ state: "accepted" | "dismissed", today }`.

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
agent (<target>)" (Claude Opus, high effort) with its four skills, the
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
