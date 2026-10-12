# Weekly review model eval

A script that sends the weekly review's five model calls (opening, coach, close, memo, clash check) to several models through OpenRouter, for past weeks of the dev database, and scores what code can score. It does not change the app.

- Prompts, temperatures and token limits are the app's own (`packages/domain/src/planner/review-prompts.ts`), with 4,000 extra tokens of room for hidden reasoning.
- Every request requires zero data retention (`provider: {zdr: true, data_collection: "deny"}`).
- It reads the dev database only, through the A/B test's read-only adapter (`scripts/fork/review-ab/d1-http.ts`).
- The eval set and plan live in the project's shared folder (`weekly-review-eval/`); the weeks and the owner's recorded scores are also inlined in `run.ts`.

## Run it

```sh
# OPENROUTER_API_KEY, CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID must be set
pnpm exec tsx scripts/fork/review-eval/run.ts --out <dir>
```

- `--dry-run` reads the data and prints its size, with no model calls.
- `--models a,b` and `--weeks 2026-09-28,...` run a subset.
- `--resume <run dir>` reuses the answers already saved there and only makes the missing calls.
- `--judge` also asks a judge model (Claude Opus 5.5) to count invented facts. It's off by default; the owner prefers to judge in Claude Code.
- `--budget-usd 9` stops the run at that spend.

## Output

`<out>/<timestamp>/`: `raw/<model>/<week>/<call>.txt` (each answer, and the opening and memo prompts as sent), `results.json` and `results.jsonl` (checks, cost, tokens, provider per call), `summary.md`, and `blind/<week>/A.md` to `E.md` with `blind/.key.json`.

## Checks

```sh
pnpm exec tsc -p scripts/fork/review-eval/tsconfig.json
```
