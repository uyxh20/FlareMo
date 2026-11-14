# pstack skills in this repo

Twelve skills in this folder are adapted from [pstack](https://github.com/cursor/plugins/tree/main/pstack) by poteto (MIT licence). They were written for Cursor. This page maps their Cursor wording to Claude Code and lists the repo rules that win over anything a skill says.

Each skill starts by itself when its situation comes up (its `description` says when). Anon does not need to name them. The table "Fork: QA rules and what enforces them" in `AGENTS.md` says which skill runs at which moment.

## Repo rules that win

- Follow `AGENTS.md` and the project instructions first. Where a skill disagrees, they win.
- No writes to live (prod D1, R2, the `flaremo` Worker) except deploys and actions Anon asked for, through `scripts/fork/prod-deploy.mjs` or the app API. Proofs and repros run in vitest or on the local stack.
- No diary, task or memory text in tests, docs, skills, commits or reports. Use made-up sample text.
- Targeted checks only: the related vitest files, typecheck of touched packages, `pnpm format`. Never `pnpm verify`, and never run Playwright e2e unless Anon asks (adding e2e cases is fine).
- Branch per thread, push the branch, no PR unless asked.
- Keep fan-out small: at most 3 subagents per skill run. Models: Haiku to explore, Sonnet to change code, Opus for audits and judgment. Never Grok or other non-Claude slugs: omit `model` or use the role above.
- Write for Anon in plain English. Anon is not a developer.

## Cursor names to Claude Code

| In a skill | Here |
| --- | --- |
| `Task` tool | `Agent` tool |
| `subagent_type: generalPurpose` | `subagent_type: "general-purpose"` |
| `readonly: true` | `subagent_type: "Explore"`, and say "do not edit files" in the brief |
| `environment: "cloud"` or "its own worktree" | `isolation: "worktree"` |
| `run_in_background: true` | omit (agents run in the background by default) |
| `AskQuestion` | ask in the thread, one question with a recommendation |
| `.cursor/skills/` | `.claude/skills/` |
| `.cursor/rules/*.mdc`, always-applied rules | `AGENTS.md` |
| `pstack-models.mdc` role lines, Grok or Cursor model slugs | the model roles above |
| Bugbot, Cursor automations | not available: skip that step and say so |
| "list the MCPs" | use the tools this session actually has |

## Other pstack skills a skill mentions

Only the twelve are installed. When a skill says to run one of these, apply the one-line meaning instead.

| Mentioned | Means |
| --- | --- |
| `arena` | Copy kept in `interrogate/references/arena.md`. |
| `how` | Copy kept in `teach/references/how/how.md`. |
| `in-your-own-words` | Restate the goal of the change in two or three plain sentences before starting. |
| `unslop` | Plain, short sentences. No filler, no em dashes, no hype. |
| `prove-it-works` | Check the real result (run it, read the value, look at the screen), not "it compiles". |
| `separate-before-serializing-shared-state` | Each agent gets its own worktree or folder, never a shared file. |
| `redesign-from-first-principles` | Fold a graft in by hand so the result reads as one design. |
| `poteto-mode` Subagents section | Pick each agent's effort for its job; keep briefs short and specific. |
| Laziness Protocol | Prefer the smaller change and the smaller API. |
