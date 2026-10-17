# Weekly review agent

Fork-owned. A Claude Managed Agent runs the Look back part of the weekly
review: the opening drafts, every coach reply, the scores and trajectory, and
the Sunday summary memo. One agent session carries the whole evening. The
opening starts it on the whole week and the eight weeks before it as files;
every later step is one message to the same session, so the agent remembers
what was said and can check a pattern in the history before claiming it. It
keeps short notes from one review to the next in a memory store. Look
forward's clash check stays a single call, to Claude Sonnet 5.5 at medium
effort. The agent was first set up for the memo alone (October 2026), hence the
names of its files and settings.

## Why

A blind test on four past weeks (17 Aug, 14, 21 and 28 Sep 2026, dev copy),
against what prod used then (GPT-6.1 Sol through OpenRouter, diary capped at
40,000 characters): four Claude Opus checkers, one per week, preferred the
agent's memo every week. It scored about twice as high on "told me something
new" (4.1 against 2.0) and on naming which goal is losing (4.6 against 2.4).
Neither misquoted, and both had two or three minor slips. The agent cost $0.61 to
$1.00 a memo (about $0.80) against $0.04 to $0.09, and took 3 to 4.5 minutes.
Results and blind memos: the project's shared folder,
`weekly-review-ab/memo-agent-runs/2026-10-17T05-04-02/`. The test script is
`scripts/fork/review-memo-ab/` there too (not in the repo).

## How it runs

| Step | Where |
| --- | --- |
| `POST /review/:week/ai/opening` reads the week with its whole diary and task details, uploads `this-week.md` (the review's context block) and `history/<monday>.md` (eight earlier weeks: diary and saved summary), starts a session with the memory store and a hard budget, sends the opening step, and answers `{"agent":"sesn_…"}`. A session the page names in `session` is deleted first (the opening run again). If the agent cannot start, the review's model drafts the opening instead | `plannerReviewAgentFiles`, `plannerAgentOpeningMessage` in `packages/domain/src/planner/memo-agent.ts`; `apps/worker/src/routes/planner-goals-api.ts`, client in `planner-memo-agent.ts` |
| Coach replies (`/ai/coach`) and the scores (`/ai/close`) with the page's `session`: each sends its step (the same prompt as the single call, pointing at `this-week.md` instead of repeating it) and answers `{"agent"}`. Without a session, or when it is gone, the review's model answers as before | `plannerAgentCoachMessage`, `plannerAgentCloseMessage`, same files |
| The memo (`/ai/memo`) with the session adds `review.md` (the evening's answers, scores and drafts) and `template.md` (the memo skeleton) to it and sends the memo step; the agent writes `/mnt/session/outputs/memo.md`. Without a session it starts one for the memo alone, as before | `plannerMemoAgentStepFiles`, `plannerMemoAgentKickoff` |
| `GET /review/:week/ai/agent/:session?today=&step=opening\|coach\|close\|memo[&mode=]` says `running`, `failed`, or `done` with that step's answer, read and parsed as the single call's would be. After the memo, the session and every file are deleted. A session made for another user or week is a 404 | `plannerPollMemoAgent`, `plannerReadMemoAgentMemo`, `plannerEndMemoAgent` |
| The page keeps the session in the review's saved state (`back.agent`) and asks every 4 seconds for up to 15 minutes. The opening says "Reading your whole week · this takes a few minutes"; coach replies show the usual typing dots and appear whole. A failed step falls back as a failed model call does (drafts, the template) | `plannerWaitForAgent` and friends in `apps/web/src/planner/goals-api.ts`, `review-page.tsx` |

The agent's stored system prompt is still the memo prompt (tested in the A/B
run). The opening message tells it the session is the whole review, that each
step's message decides the reply's format until the memo step, and not to touch
its memory store before then; so no prompt update was needed for the change.

The session runs in an environment with no network and no package installs, its
web tools are off, and nothing waits for approval (`always_allow`), because
nobody watches it. The budget is a platform-enforced cap
(`FLAREMO_REVIEW_MEMO_BUDGET_USD`, default 5 dollars at list price for the whole review).

## Setting it up

```sh
# ANTHROPIC_API_KEY (or Anthropic_API) set; prints ids only
pnpm exec tsx scripts/fork/review-memo-agent.ts --owner <first name> --store dev
```

It creates (or finds by name) the agent "Schizo Diary weekly memo" on Claude
Opus 5.5 at high effort, the environment `schizo-diary-memo`, and a memory store
`review-notes-<store>`, and it updates the agent's prompt when the code's prompt
changed. Use one store per deployment (`dev`, `prod`), so notes drawn from the
dev copy never reach live. Then give the Worker:

- the secret `ANTHROPIC_API_KEY`,
- the vars `FLAREMO_REVIEW_MEMO_AGENT`, `FLAREMO_REVIEW_MEMO_ENVIRONMENT`,
  `FLAREMO_REVIEW_MEMO_STORE` that the script prints.

On dev, set `FLAREMO_DEV_REVIEW_MEMO_AGENT`, `_ENVIRONMENT` and `_STORE` before
`node scripts/fork/dev-env.mjs deploy`: dev's vars come from the generated
config, so a deploy without them turns the agent off again (every step then
goes back to one model call). On live, the prod deploy keeps the vars set on the
Worker (`--keep-vars`).

## Turning it off

Remove the three vars: every step goes back to a single call. Remove
`ANTHROPIC_API_KEY` as well to go back to OpenRouter (if its key is still set)
or Workers AI. The agent's notes can be read, edited or deleted in the Anthropic
Console under Memory stores.
