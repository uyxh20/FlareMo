---
name: subtract-before-you-add
description: "Use when planning a refactor, cleanup, rewrite, or a feature that touches existing code in this repo: remove dead code, duplicates, unused strings and stale stubs first, then build on the smaller base."
---

# Subtract Before You Add

## In this repo (Schizo Diary)

- Read [`../pstack-in-this-repo.md`](../pstack-in-this-repo.md) first: it maps the Cursor names this skill uses to Claude Code and lists the repo rules that win over anything below.
- Only fork-owned code is fair game for deletion. In upstream files, leave upstream code alone and keep fork hook-ins minimal (keeps the fork mergeable).
- Anything Anon hid on purpose (Team projects, Projects, Articles, Wander, On this day, project links on tasks) is kept, not deleted. The task history archive (`planner_task_event`) is never weakened.
- Big cleanups need Anon's OK before the code changes.
- Adapted from pstack by poteto, MIT licence: https://github.com/cursor/plugins/tree/main/pstack/skills/principle-subtract-before-you-add


When evolving a system, remove complexity first, then build. Default to subtraction.

Make simplification a continual investment. Leave the design slightly simpler and more capable behind the same or smaller surface than you found it.

- Sequence removal before construction
- Cut before you polish (get to the minimum before investing in quality)
- Design for observed usage, not speculative edge cases
- No speculative validators, parsers, or guards beyond what the spec demands
- Simplify prompts (remove redundant instructions, excessive templates)
- When a reference has no novel content, delete it rather than leaving a stub
