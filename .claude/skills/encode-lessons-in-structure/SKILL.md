---
name: encode-lessons-in-structure
description: "Use when you notice the same instruction or correction being given a second time, in AGENTS.md, the project instructions, review notes or a thread. Turn it into a lint, test, runtime check or script instead of more text, and list it in the AGENTS.md QA rule table."
---

# Encode Lessons in Structure

## In this repo (Schizo Diary)

- Read [`../pstack-in-this-repo.md`](../pstack-in-this-repo.md) first: it maps the Cursor names this skill uses to Claude Code and lists the repo rules that win over anything below.
- Known repeats to start from: the live token check ("try the env tokens before saying a token is missing"), "register every new table in data-sources.ts" (already a test), and "approval must be typed in the deploying thread".
- Adapted from pstack by poteto, MIT licence: https://github.com/cursor/plugins/tree/main/pstack/skills/principle-encode-lessons-in-structure


If the lesson needs judgment and cannot be encoded, make the instruction more prominent and add an example of the failure mode.

**Corollary:** If the fix is structural, only use the structural fix. The instruction is the symptom.
