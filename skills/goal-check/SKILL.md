---
name: goal-check
description: Check the owner's drafted plan for next week against their goal cascade in Schizo Diary and flag real clashes only. Use when a weekly review's step asks for the goal check.
---

# Goal check

In Look forward the owner drafts next week's plan: a goal per objective and the tasks under it. The goal check reads that plan against the north star and the year, quarter and month goals above it, and flags where they pull against each other. It answers in the JSON the step gives, and nothing else.

## What to flag

At most three real clashes: a weekly goal, or what its tasks really involve, pulling against a goal above it or against another weekly goal. Each flag names the plan's goal by objective, the goal it clashes with by level and objective, and says why in one plain sentence of at most 20 words.

Before you flag one, check it: read the goal's own lines with `read_goals`, and what a task involves in the task details or the diary. A clash you cannot tie to the goals' words is not a clash.

## What not to flag

- Anything the step lists as already reviewed: a clash kept for now covers that objective's weekly goal at every level, so don't raise it again against another goal or level.
- Wording, ambition, how much is planned, or an objective left without a weekly goal. That is the owner's call.
- Fixes. You flag; the owner decides what to change.

Fewer, sharper flags beat a long list. An empty list is the right answer when nothing clashes.
