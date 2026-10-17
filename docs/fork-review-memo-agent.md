# Weekly memo agent

Fork-owned. The Sunday summary memo of the weekly review can be written by a
Claude Managed Agent instead of a single model call. The agent reads the whole
week and the eight weeks before it as files, checks a pattern in the history
before claiming it, and keeps short notes from one review to the next in a
memory store. The other review steps (opening, coach, close, clash check) stay
plain model calls, because they need answers in seconds.

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

| Step                                                                                                                                                                                                                                            | Where                                                                                            |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| What the agent reads: `this-week.md` (the review's context block, whole diary), `review.md` (the evening's answers, scores and drafts), `template.md` (the memo skeleton), `history/<monday>.md` (eight earlier weeks: diary and saved summary) | `plannerMemoAgentFiles`, `plannerReadMemoHistory` in `packages/domain/src/planner/memo-agent.ts` |
| Its system prompt (stored on the agent) and the kickoff message                                                                                                                                                                                 | `plannerMemoAgentSystem`, `plannerMemoAgentKickoff`, same file                                   |
| `POST /review/:week/ai/memo` uploads the files, starts a session with the memory store and a hard budget, sends the kickoff, and answers one `{"agent":"sesn_…"}` line                                                                          | `apps/worker/src/routes/planner-goals-api.ts`, client in `planner-memo-agent.ts`                 |
| `GET /review/:week/ai/memo/:session?today=` says `running`, `failed`, or `done` with the memo. When it is done, the session and every file are deleted. A session made for another user or week is a 404                                        | same                                                                                             |
| The page asks every 5 seconds for up to 15 minutes, saying "Reading your whole week · this takes a few minutes", then shows the memo whole. If the agent fails, it uses the template, as it does when a model fails                             | `plannerStreamMemo` in `apps/web/src/planner/goals-api.ts`                                       |

The session runs in an environment with no network and no package installs, its
web tools are off, and nothing waits for approval (`always_allow`), because
nobody watches it. The budget is a platform-enforced cap
(`FLAREMO_REVIEW_MEMO_BUDGET_USD`, default 3 dollars at list price).

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
config, so a deploy without them turns the agent off again (the memo then goes
back to one model call). On live, the prod deploy keeps the vars set on the
Worker (`--keep-vars`).

## Turning it off

Remove the three vars: the memo goes back to a single call. Remove
`ANTHROPIC_API_KEY` as well to go back to OpenRouter (if its key is still set)
or Workers AI. The agent's notes can be read, edited or deleted in the Anthropic
Console under Memory stores.
