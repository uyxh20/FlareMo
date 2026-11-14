---
name: correct
description: "Use when a mistake shows up a second time in this repo: a repeat bug, a correction Anon has had to give before, a reverted or re-fixed change, or a QA / failure-pattern review. Groups repeated mistakes into classes and makes each impossible (structure, then types, then a check, then a test, docs last), proving each guard fails on the real past mistake, and keeps the rule table in AGENTS.md."
---

# Correct

## In this repo (Schizo Diary)

- Read [`../pstack-in-this-repo.md`](../pstack-in-this-repo.md) first: it maps the Cursor names this skill uses to Claude Code and lists the repo rules that win over anything below.
- Evidence lives in: `git log` (look for fix / revert / re-fix pairs), `/mnt/project-files/` QA and review reports (code-review-*, flywheel-qa, media-qa, dev-test-*, docs-audit), project threads when your tools can read them, and the nightly `checks` runs (`gh run list -R uyxh20/FlareMo`).
- The agent instruction file is `AGENTS.md`. The rule table goes in its section "Fork: QA rules and what enforces them". Upstream sections of AGENTS.md stay untouched.
- A guard that lives in code goes in a fork-owned path (see `docs/fork-customizations.md`). Existing structural guards to copy from: `packages/domain/src/fork/data-sources.test.ts` (every table registered), `guards.test.ts`, `upstream-hookins.test.ts`.
- Run only the targeted tests for each guard (AGENTS.md). The "same command in CI" step means: make sure the test file is picked up by `pnpm test`, which the nightly `checks` workflow runs.
- Adapted from pstack by poteto, MIT licence: https://github.com/cursor/plugins/tree/main/pstack/skills/correct


The operator keeps correcting agents in this repo for the same mistakes. Change the repo so the next agent can't make them.

Assume every contributor is an agent that sees only the files it opened, copies the nearest example, and takes the shortest path that compiles. Design the repo so a change that looks right from one file is right for the whole repo.

## Find the mistake classes

First, read recent commits, reverts, review comments, agent instruction files, and comments that explain workarounds. Group the mistakes into classes. A class counts once it has happened twice.

## Fix each class at the highest level that works

1. **Eliminate it with architecture.** Give each piece of state one owner and each task one supported way. Hide internals so the wrong import fails. Replace hand-synced lists with one source of truth. Delete old ways and dead code an agent would copy.
2. **Enforce it with types so the bad state can't be written.** If bad code still compiles, add a lint or CI check whose error names the file, type, or function to use instead. If the pattern is already common, fail only when a change adds more.
3. **Test the behavior.** Fix or delete any test that still passes when the behavior it checks breaks, or that fails when only the internals change.
4. **Write docs or agent rules last, only for judgment calls.** Nothing fails when an agent skips them.

## Fix and prove

Then fix the most frequent classes now, one commit each. Prove each new check fails on a real past mistake. Run the same command locally and in CI. Exceptions go on the offending line with a reason, an expiry date, and a human's approval.

## Keep the rule table

Last, keep a table in the agent instruction file that pairs each rule with what enforces it. When the operator corrects you, fix the mistake and add the rule. If the rule was already there and nothing enforces it, that's a repeat, so fix it at the highest level in the same change. Drop a rule once its mistake can't happen.

**Reply:** each class with its evidence, the level you picked, and why a higher level didn't work.
