---
name: tdd
description: "Use whenever fixing a bug in this repo: something Anon reports as broken, a failed QA or dev check, a regression, or a red nightly test. Write the smallest test that fails on the current code first, see it fail for the right reason, then fix and see it pass. Skip the new test only when no cheap local test path exists, and say why."
---

# TDD Bug Fix

## In this repo (Schizo Diary)

- Read [`../pstack-in-this-repo.md`](../pstack-in-this-repo.md) first: it maps the Cursor names this skill uses to Claude Code and lists the repo rules that win over anything below.
- Tests are vitest, colocated as `*.test.ts(x)`. Run one file: `pnpm exec vitest run <path> -t "<name>"`. Domain tests with a database use the in-memory D1 helpers already used in `packages/domain/src/**.test.ts`.
- Deterministic only: pin the clock (`vi.useFakeTimers()` / `vi.setSystemTime`) whenever the code reads today's date or week, seed any randomness, no network, sample text only (never diary text).
- Playwright e2e is opt-in: add a case if the bug is a browser-only path, but do not run e2e unless Anon asks (AGENTS.md).
- Adapted from pstack by poteto, MIT licence: https://github.com/cursor/plugins/tree/main/pstack/skills/tdd


When fixing a bug with a clear, cheap test path, make the broken behavior executable before changing production code. The goal is a focused regression test that fails before the fix and passes after it.

Do not force a test when it would be impractical. If the available test would require broad harness setup, brittle mocks, slow end-to-end infrastructure, production-only state, vague reproduction steps, or large unrelated fixture churn, skip adding a new test and use the closest useful verification instead.

## Workflow

1. **Understand the bug.** Identify the intended behavior, current behavior, affected path, and smallest observable reproduction.
2. **Choose the narrowest executable check.** Prefer the closest unit, component, integration, or regression test already used for that codepath. If no practical test path is obvious, do not create one from scratch just to satisfy the workflow.
3. **Write the failing test first.** Add the smallest focused test that would have caught the bug. The test should encode intended behavior, not mirror the current implementation.
4. **Run the new test before fixing.** Confirm it fails for the intended reason. If it passes or fails for an unrelated reason, correct the test or reproduction before editing the implementation.
5. **Fix the bug.** Make the smallest production change that satisfies the intended behavior while preserving nearby contracts.
6. **Rerun the regression test.** Confirm the test now passes.

## If a Failing Test Is Impractical

Use the closest executable regression check instead: a targeted script, manual reproduction command, browser automation, snapshot comparison, log assertion, or focused integration check.

Prefer no new test over a bad test. A bad test is one that mostly tests mocks, encodes current implementation details, depends on timing or unrelated global state, needs expensive infrastructure for a small fix, or would be deleted immediately after proving the fix.

## Guardrails

- Do not change tests merely to match a wrong implementation.
- Do not weaken existing assertions unless the expected behavior has genuinely changed and the reason is clear.
- Keep the regression test focused on the bug. Avoid broad fixture churn or unrelated coverage expansion.
- If the bug is flaky, make the test deterministic where possible and document the signal being locked down.
- If the bug exposes a broader class of failures, first land the focused regression path, then consider additional sibling coverage.

## Final Response

Report the evidence, not just the outcome:

- Name the failing-before test or executable check and the failure it produced.
- Name the passing-after test run and any nearby validation performed.
- If failing-before evidence could not be demonstrated, state why and describe the closest regression check used instead.
