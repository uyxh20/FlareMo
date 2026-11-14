---
name: interrogate
description: "Use only for big or risky changes before release (migrations, flows that write or delete data, agent Accept / Undo, uploads and sync queues, deploy scripts), or when Anon asks for an adversarial or stress review. A few agents try to break the change and only findings proven by a run survive. Costly: never for small fixes."
---

# Interrogate

## In this repo (Schizo Diary)

- Read [`../pstack-in-this-repo.md`](../pstack-in-this-repo.md) first: it maps the Cursor names this skill uses to Claude Code and lists the repo rules that win over anything below.
- The arena steps it relies on are in `references/arena.md`. Use at most 3 adversaries, each an `Agent` with `subagent_type: "general-purpose"` and `isolation: "worktree"`, on Opus (project rule: Opus for audits). Ignore the Grok and cross-family model rules.
- Adversaries run against the local stack or vitest only. No dev or live writes, no `pnpm verify`, no e2e unless Anon asked.
- Adapted from pstack by poteto, MIT licence: https://github.com/cursor/plugins/tree/main/pstack/skills/interrogate


Adversaries try to break a change or a design. A finding survives only when a run proves it. Report the findings. Do not apply fixes.

## Frame

The scope is what the user names. Otherwise it is the branch diff from its merge base with the base branch, through the working tree. State the intent with the **in-your-own-words** skill, from the user's message, the commits, and the PR description. Ask the user when the intent is unclear.

## Fan out

Run Phase A steps 3 and 4 and Phase B of the **arena** skill, with four changes. Read the `interrogate reviewers` line in place of `arena runners`. Copy the scope's uncommitted changes into each worktree. Spawn each adversary as `generalPurpose`. In place of the arena task and rationale, give each adversary the scope, the intent, and this brief:

> Break this change. Prove each finding with a run against the real code, such as a failing test, a repro script, or command output that shows the wrong behavior. For a design or plan, run a prototype or probe the current tree. Keep repros in your own worktree. Report each finding with a title, the exact command, the output it printed, and the output the intent requires. Leave out anything you did not run. That covers style, naming, structure, and risks that need a future change to matter. No findings is a valid result.

## Verify

Verify each finding per arena Phase F by rerunning its command. Keep a finding when the output shows the failure and the failure breaks the intent. Drop the rest. Merge findings that share a root cause.

Skip arena Phases C, D, and E. Adversaries find different failures, so the verdict keeps every verified finding, not one adversary's list.

## Output

- **Intent**: the restatement.
- **Findings**: for each verified finding, the command, its output, how it breaks the intent, and the adversaries that found it. Say "no verified findings" when none survive.
- **Dropped**: for each adversary, the count of dropped findings and why.
