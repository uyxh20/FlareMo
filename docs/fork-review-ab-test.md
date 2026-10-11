# Weekly review A/B test

A script that writes the same weekly review three ways, so the owner can score them blind and decide whether Managed Agents is worth it for the review. It does not change the app, and it reads the dev database only.

| Version | What it sees | How it runs |
| --- | --- | --- |
| A | What the app sends today: goals, scores, tasks, last summary, and the diary capped at 12,000 characters | One Messages API call |
| A+ | The same, with the whole week's diary | One Messages API call |
| B | The whole week, plus the diary of the 8 weeks before it as files, plus a memory store that carries its own notes from one reviewed week to the next | A Managed Agents session with the standard agent toolset, web off |

All three get the same task text and run on the same model (default `claude-sonnet-5-5`, the app's Anthropic default). A+ is there to tell "more data" apart from "better harness".

## Run it

```sh
export ANTHROPIC_API_KEY=...        # the owner's key, never committed
# CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID must be set to read dev D1
pnpm exec tsx scripts/fork/review-ab/run.ts \
  --weeks 2026-09-07,2026-09-14,2026-09-21,2026-09-28 \
  --out /mnt/project-files/weekly-review-ab/runs
```

- `--dry-run` reads the data and prints its size, with no model calls and no key needed.
- `--model claude-opus-5-5` repeats the test on Opus.
- `--arms A,B` runs a subset.
- `--budget-usd 3` caps each agent session (a hard, platform-enforced limit).
- `--keep-memory` keeps the agent's memory store after the run (deleted by default).

Weeks run oldest first, so the agent's memory builds up in order.

## Output

In `<out>/<timestamp>/`:

- `<week>/X.md`, `Y.md`, `Z.md`: the three reviews, shuffled per week.
- `scorecard.md`: five 1 to 5 criteria per review, plus a favourite.
- `.key.json`: which letter was which version. Open it after scoring.
- `.costs.json`: dollars, seconds and tokens per review. Agent cost is the session's list cost as Anthropic reports it; plain-call cost is computed from token usage at list price.

## Safety

- The D1 adapter (`d1-http.ts`) sends only `SELECT`, `WITH` and `PRAGMA` statements, and only to a database named `flaremo-dev`.
- Agent sessions and the uploaded files are deleted after each week; the memory store after the run; the agent is archived and the environment deleted.
- The agent's environment has no network access, and its web tools are off.

## Checks

```sh
pnpm exec tsc -p scripts/fork/review-ab/tsconfig.json
```
