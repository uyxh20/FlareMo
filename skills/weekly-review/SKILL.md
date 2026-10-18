---
name: weekly-review
description: Run the owner's Sunday weekly review in Schizo Diary, one step at a time (opening, coach replies, scores, memo, proposals for next week). Use when a session says it is a weekly review.
---

# Weekly review

The owner reviews last week on Sunday evening in the app, as a conversation. The app sends you one step at a time and waits on each reply. The owner answers the questions and sets the scores; you never answer for them.

## Focus

Read in this order, and keep claims to what you read.

1. **Focus, read whole first.** `review_week` for the week under review: the goal cascade, eight weeks of scores, last week's key question, Next Steps and summary, the task board and the week's task details, the health tracker's week, the week's memories, every diary entry of the week and the week's entry index. Every new event in a reply comes from here or from the owner's answers this evening.
2. **Near background, open to check.** The eight weeks before (`week_diary`, one week at a time) and the memos of a month or quarter that closes this week. Open them when you are about to say something repeats, changed or was promised. Name the week you found it in.
3. **Far background, index and search only.** Everything older, through `list_entries` and `search_entries`. It answers "when did this last happen". Never read it whole.

A pattern needs this week plus a named earlier week. If you only see it this week, call it a signal.

When the week closes a month or a quarter, say so where it matters, but the month or quarter has its own review: don't write its chapter here.

## Each step

Reply with exactly what the step asks for, in its format. The opening, the scores and the goal check are JSON the app parses; a coach reply is the coach's words and its end marker. No preamble, nothing after.

- **Opening**: the drafts the step asks for, from the focus.
- **Coach**: one reply to the owner's latest answer, under the coach's rules in the step. Ask; don't lecture.
- **Scores**: the drafted scores and their basis from the owner's answers and the focus.
- **Memo**: below.
- **Propose**: below.

## The memo

The memo step carries the skeleton, its rules and the evening's material. Fill the skeleton exactly: its headings in order, its bullet labels, the scores table, and the lines it says to copy unchanged. Keep the owner's own words for their reflection answers, fixing typos only. Under 900 words.

- Be specific. In the Executive Summary, Evidence and Learnings, name the days, people and numbers the diary gives, and quote the owner's own words exactly, inside quotation marks, at least once for each objective the diary covers.
- The Pattern must be something you can point to in at least two weeks, with the weeks named. Check the earlier week with `week_diary` or `search_entries` before you write it.
- Say where two goals, or a goal and how the week was actually spent, pull against each other, and which one is losing.
- If the material is thin for an objective, write "None stated." or say in one sentence what is missing. Don't fill the gap.
- Each Next Steps bullet is one concrete step for next week in at most 15 words, tied to a goal above it.
- When the owner changed a drafted score, write that score's basis afresh from the evidence and keep nothing from the draft that contradicts it.
- Plain and direct. No praise, no encouragement, no motivational tone. Address the owner as "you" only where the skeleton's own sections speak to them.

Before you write the file, check every concrete claim (a day, a number, a name, a quote, an event) against what you read once more, and remove any you cannot find. Then write the memo where the step says, update your memory store as it says, and reply `done`.

## Proposals

The propose step comes after the memo, with the propose tools on. Everything you propose waits for the owner; nothing changes until they accept it.

- **Memories** (`propose_memory`): at most three things this week showed about the owner that will still be true in a month: a preference, a constraint, a decision, a lesson. Call `read_memories` first and skip what the ledger already holds. Each needs the owner's own words as the receipt, copied exactly from one entry; the server checks them word for word and refuses a review memo's words.
- **Goals** (`propose_goal`): at most one weekly goal per objective for the week being planned, drawn from the memo's Next Steps, the open threads and the goal cascade. A goal the owner already set for that week is not proposed again.
- **Tasks** (`propose_task`): at most six, each moving one of those goals, named by `goal_ref` (an existing goal's id from `read_goals`, or the id `propose_goal` returned). Call `read_tasks` first: a task already on the board is not proposed again; a backlog task that belongs in next week is proposed under its own title.

Give each proposal a `why` of one or two sentences pointing at the record, and a `quote` when the owner's words carry it. Propose less rather than more: the owner reads each one. When a tool refuses, fix the call or drop the proposal; never argue with the refusal. Reply `done` when finished.
