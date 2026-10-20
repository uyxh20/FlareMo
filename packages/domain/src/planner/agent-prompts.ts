import {
  type PlannerHappened,
  plannerPeriodLabel,
  plannerWeekCode,
} from "@flaremo/contracts";
import {
  type PlannerPeriodChatMemoRequest,
  plannerPeriodChatContextBlock,
  plannerPeriodChatMemoParts,
  plannerPeriodCloseMessages,
  plannerPeriodCoachSystem,
  plannerPeriodHappenedLines,
  plannerPeriodOpeningMessages,
  plannerPeriodWord,
} from "./period-review-chat";
import type { PlannerPeriodContext } from "./period-review-context";
import type { PlannerReviewContext } from "./review-context";
import {
  type PlannerChatMessage,
  type PlannerCheckGoal,
  type PlannerCheckSettled,
  type PlannerCoachMode,
  type PlannerMemoRequest,
  type PlannerReviewAnswers,
  plannerCheckMessages,
  plannerCloseMessages,
  plannerCoachSystem,
  plannerMemoParts,
  plannerOpeningMessages,
  plannerReviewContextBlock,
} from "./review-prompts";

// What the general agent is told (fork-owned add-on, docs/fork-general-agent.md).
// The agent's standing instructions (plannerAgentSystem) are stored on the
// agent by scripts/fork/general-agent.ts; how to run each job is in its skills
// (skills/<name>/SKILL.md, uploaded by the same script); and each step of a
// job is one message built here. A step's message is the same prompt the
// review's model gets as a single call, with the material it would have pasted
// in replaced by the tool that reads it, so the answer has the same shape and
// the same parser reads it.

/** The owner's first name, as every prompt addresses them. */
function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || "the owner";
}

/** The file a memo step writes, which the Worker reads back. */
export const PLANNER_AGENT_MEMO_FILE = "/mnt/session/outputs/memo.md";

/**
 * The agent's system prompt, the same for every job. It says who it works
 * for, how to read the record, and what it may change: nothing but proposals.
 */
export function plannerAgentSystem(ownerName: string): string {
  const name = firstName(ownerName);
  return `You are the agent inside ${name}'s diary app, Schizo Diary. ${name} writes diary entries there, sets goals from a north star down to each week, keeps a task board and a health tracker, and reviews each week, month, quarter and year. You help with those reviews and answer ${name}'s questions about their own record. ${name} acts on what you say, so a claim you cannot back is worse than saying less.

## What you can do

You read ${name}'s whole record through your tools, live. You change nothing. The only writes you have are the propose tools, and each proposal waits for ${name}: a memory on the Memory page, a goal or a task on the review page. Never say you saved, changed, added or deleted anything; say you proposed it. The propose tools are on only in a review's steps that ask for proposals.

The tools:
- review_week and review_period: a review's focus, everything it is about, in one read.
- week_diary: one earlier week whole, its entries and its saved summary.
- list_entries: the index, one line per entry with its id, when it was written, who wrote it and its first words.
- read_entries: entries in full, by id.
- search_entries: full-text search over every entry ever written.
- read_goals, read_tasks, read_health, read_memories: goals and recorded weeks, the task board, the health tracker, and what the memory ledger holds.
- propose_memory, propose_goal, propose_task: proposals, only when a step asks for them.

Each job has a skill that says how to run it (weekly-review, period-review, ask-my-diary, goal-check). Read it when the job starts.

## How to read the record

- Focus first, then background. A job names its focus (a week, a period, a question). Read the focus whole. Everything else is background: open it to check something, through the index and search, never whole.
- An event happened only if an entry, a task, a goal result or note, a health row, or ${name}'s own answers say so. A plan, a goal or an intention is not an event.
- When the record does not mention something, it is not recorded. Never say it did not happen; search before saying it never happens.
- An entry is dated when it was written. It can describe an earlier day: use the day it names, or say "that week". ${name}'s day runs in Copenhagen time.
- Entries marked "review memo (a model wrote it)" are summaries a model wrote. They are claims to check against the diary, never evidence, and never quoted as ${name}'s words.
- Copy numbers exactly as written and take totals from the health tracker's own lines. Don't add things up yourself.
- #tags are labels, not people. Tie a person or a company to an event only the way the diary does.
- Quote ${name}'s words exactly, inside quotation marks, with the day. Never put words in their mouth.
- Before you finish anything, check every concrete claim (a day, a number, a name, a quote, an event) against what you read, and remove any you cannot find.

## Your notes

Your memory store holds your own notes from earlier sessions: open threads, what ${name} said they would do, patterns to re-check, mistakes to avoid. Read them when a job starts. Change them only when a step says so. Notes, never a copy of the diary or of a memo.

## How to answer

Plain and direct. No praise, no encouragement, no motivational tone. When a step asks for a format (JSON, a line, a file), give exactly that and nothing around it.`;
}

// ---------------------------------------------------------------------------
// The weekly review
// ---------------------------------------------------------------------------

/** Where a step's prompt pointed at the pasted week: the tool that reads it. */
function weekPointer(weekStart: string): string {
  return `(read it with review_week for the week of ${weekStart}; you may already have it in this session)`;
}

function weekStep(
  context: PlannerReviewContext,
  messages: readonly PlannerChatMessage[],
): string {
  const block = plannerReviewContextBlock(context);
  const pointer = weekPointer(context.weekStart);
  return messages
    .map((message) => message.content.replace(block, pointer))
    .join("\n\n");
}

/** The first message of a weekly review's session: how it runs, then the opening. */
export function plannerAgentOpeningMessage(
  context: PlannerReviewContext,
): string {
  const name = firstName(context.ownerName);
  return `This session is ${name}'s weekly review of the week starting Monday ${context.weekStart} (${plannerWeekCode(context.weekStart)}). Use your weekly-review skill. The review reaches you one step at a time, each as a message: the opening (this message), the coach chat (one message for each of ${name}'s answers), the scores and trajectory, the memo, then your proposals for ${plannerWeekCode(context.planWeek)}, and maybe a goal check. ${name} waits on each reply in the app.

Reply to each step with only what it asks for, in its format: no preamble, no notes, nothing after it. Don't change your memory store before the memo step, and don't propose anything before the propose step.

Before this first reply: read your memory store's notes, then call review_week for ${context.weekStart}. That is the week in focus; it holds the "Context" the step below refers to.

Step 1, the opening:

${weekStep(context, plannerOpeningMessages(context))}`;
}

/** One coach reply: the coach's rules for this reply, then how the chat ends. */
export function plannerAgentCoachMessage(
  context: PlannerReviewContext,
  mode: PlannerCoachMode,
  chat: ReadonlyArray<{ role: "user" | "assistant"; content: string }>,
): string {
  const name = firstName(context.ownerName);
  const recent = chat
    .slice(-6)
    .map(
      (message) =>
        `${message.role === "user" ? name : "Review"}: ${message.content}`,
    )
    .join("\n\n");
  return `Coach step: reply to ${name}'s latest answer.

${weekStep(context, [{ role: "system", content: plannerCoachSystem(context, mode) }])}

The chat ends like this (earlier turns are in this session already; "Review" lines are the app's prompts and your earlier replies):

${recent}`;
}

/** The scores and the trajectory, from the evening's answers. */
export function plannerAgentCloseMessage(
  context: PlannerReviewContext,
  answers: PlannerReviewAnswers,
): string {
  return `Scores step: the chat is over.

${weekStep(context, plannerCloseMessages(context, answers))}`;
}

/**
 * The memo step: the evening's answers, the memo's skeleton and its rules,
 * all in the message. The memo goes to a file the Worker reads back.
 */
export function plannerAgentMemoMessage(
  context: PlannerReviewContext,
  request: PlannerMemoRequest,
): string {
  const name = firstName(context.ownerName);
  const parts = plannerMemoParts(context, request);
  return `Memo step: write ${name}'s summary memo of the week starting Monday ${context.weekStart}. Follow the memo part of your weekly-review skill. If this session has not read the week yet, call review_week for ${context.weekStart} first; if it has, entries may have been written since, so check list_entries for the week and open any you have not read.

${parts.template}

${parts.rules}

The evening's material: ${name}'s answers, the scores they set and the drafts.

${parts.material}

When the memo is checked:
1. Write it to ${PLANNER_AGENT_MEMO_FILE}.
2. Update your memory store: a few short lines for next week. Open threads, what ${name} said they would do, patterns to re-check, and anything you got wrong before. Notes, not a copy of the memo or the diary.
3. Reply with the single word: done.`;
}

/**
 * A review's session that starts at the memo (the opening ran without the
 * agent, or the memo is written again): what the session is, then the step.
 */
export function plannerAgentMemoKickoff(
  context: PlannerReviewContext,
  request: PlannerMemoRequest,
): string {
  const name = firstName(context.ownerName);
  return `This session is ${name}'s weekly review of the week starting Monday ${context.weekStart} (${plannerWeekCode(context.weekStart)}). Use your weekly-review skill. The opening and the chat ran without you; the session starts at the memo, then your proposals for ${plannerWeekCode(context.planWeek)} follow, and maybe a goal check. Reply to each step with only what it asks for. Read your memory store's notes first.

${plannerAgentMemoMessage(context, request)}`;
}

/**
 * The propose step, sent by the Worker once the memo is read: memories, then
 * goals and tasks for the week being planned. The proposals are the answer.
 */
export function plannerAgentProposeMessage(
  context: PlannerReviewContext,
): string {
  const name = firstName(context.ownerName);
  return `Propose step: the memo is written and ${name} is reading it. Now make your proposals, following the propose part of your weekly-review skill. The propose tools are on for this step.

1. Memories: at most three things this week showed about ${name} that will still be true in a month, each with ${name}'s own words as the receipt (propose_memory). Call read_memories first and skip what the ledger already holds.
2. Next week's plan, for the week starting Monday ${context.planWeek} (${plannerWeekCode(context.planWeek)}): at most one weekly goal per objective (propose_goal, week ${context.planWeek}), drawn from the memo's Next Steps, the open threads and the goal cascade, and at most six tasks that move those goals (propose_task, naming the goal they serve). Read read_tasks first: don't propose a task that is already on the board; a backlog task that should be done next week is proposed under its own title.

Propose less rather than more: ${name} will read each one. When everything is proposed, reply with the single word: done.`;
}

/**
 * Look forward's own session, when the review's session is gone or never ran
 * (the look back was written without the agent, or the owner asks again):
 * what the session is, then the propose step, read from the saved summary.
 */
export function plannerAgentProposeKickoff(
  context: PlannerReviewContext,
): string {
  const name = firstName(context.ownerName);
  return `This session is ${name}'s Look forward: planning the week starting Monday ${context.planWeek} (${plannerWeekCode(context.planWeek)}). Use your weekly-review skill. The look back of ${plannerWeekCode(context.weekStart)} is done and its summary memo is saved: it is the latest look back, and its Next Steps are where the plan starts. ${name} is choosing next week's goals in the app and waits on your proposals.

Before you propose: read your memory store's notes, call review_week for ${context.weekStart} (the week just reviewed, with its summary), and read_goals for the goal cascade and ${plannerWeekCode(context.planWeek)}'s goals so far. Don't change your memory store in this session.

${plannerAgentProposeMessage(context).replace(
  `the memo is written and ${name} is reading it`,
  `the memo is written and ${name} is planning from it`,
)}`;
}

/** The goal check of next week's plan, in the review's session. */
export function plannerAgentCheckMessage(
  context: PlannerReviewContext,
  plan: readonly PlannerCheckGoal[],
  settled: readonly PlannerCheckSettled[],
): string {
  return `Goal check step: ${firstName(context.ownerName)} has drafted next week's plan. Use your goal-check skill. You may read anything you need to judge a clash, but flag only what the step below allows.

${weekStep(context, plannerCheckMessages(context, plan, settled))}`;
}

// ---------------------------------------------------------------------------
// Month, quarter and year reviews
// ---------------------------------------------------------------------------

function periodPointer(context: PlannerPeriodContext): string {
  return `(read it with review_period for the ${context.level} starting ${context.periodStart}; you may already have it in this session)`;
}

function periodStep(
  context: PlannerPeriodContext,
  messages: readonly PlannerChatMessage[],
): string {
  const block = plannerPeriodChatContextBlock(context);
  const pointer = periodPointer(context);
  return messages
    .map((message) => message.content.replace(block, pointer))
    .join("\n\n");
}

export function plannerAgentPeriodOpeningMessage(
  context: PlannerPeriodContext,
): string {
  const name = firstName(context.ownerName);
  const word = plannerPeriodWord(context.level);
  const label = plannerPeriodLabel(context.level, context.periodStart);
  return `This session is ${name}'s ${word} review of ${label} (${context.periodStart} to ${context.periodEnd}, ${context.weeks.length} weeks). Use your period-review skill. It runs like the weekly review over the whole ${word}, one step at a time, each as a message: the opening (this message), the coach chat (one message for each of ${name}'s answers), the scores and trajectory, and the memo. ${name} waits on each reply in the app.

Reply to each step with only what it asks for, in its format: no preamble, no notes, nothing after it. Don't change your memory store before the memo step.

Before this first reply: read your memory store's notes, then call review_period for the ${context.level} starting ${context.periodStart}. Every week of the ${word} is in focus; it holds the "Material" the step below refers to.

Step 1, the opening:

${periodStep(context, plannerPeriodOpeningMessages(context))}`;
}

export function plannerAgentPeriodCoachMessage(
  context: PlannerPeriodContext,
  mode: PlannerCoachMode,
  chat: ReadonlyArray<{ role: "user" | "assistant"; content: string }>,
): string {
  const name = firstName(context.ownerName);
  const recent = chat
    .slice(-6)
    .map(
      (message) =>
        `${message.role === "user" ? name : "Review"}: ${message.content}`,
    )
    .join("\n\n");
  return `Coach step: reply to ${name}'s latest answer.

${periodStep(context, [{ role: "system", content: plannerPeriodCoachSystem(context, mode) }])}

The chat ends like this (earlier turns are in this session already; "Review" lines are the app's prompts and your earlier replies):

${recent}`;
}

export function plannerAgentPeriodCloseMessage(
  context: PlannerPeriodContext,
  answers: PlannerReviewAnswers,
): string {
  return `Scores step: the chat is over.

${periodStep(context, plannerPeriodCloseMessages(context, answers))}`;
}

/** A period's session that starts at the memo. */
export function plannerAgentPeriodMemoKickoff(
  context: PlannerPeriodContext,
  request: PlannerPeriodChatMemoRequest,
  happened: readonly PlannerHappened[],
): string {
  const name = firstName(context.ownerName);
  const word = plannerPeriodWord(context.level);
  return `This session is ${name}'s ${word} review of ${plannerPeriodLabel(context.level, context.periodStart)}. Use your period-review skill. The opening and the chat ran without you; the session starts at the memo. Reply with only what the step asks for. Read your memory store's notes first.

${plannerAgentPeriodMemoMessage(context, request, happened)}`;
}

/**
 * The period's memo step. A period proposes memories here, after the memo:
 * it has no propose step of its own.
 */
export function plannerAgentPeriodMemoMessage(
  context: PlannerPeriodContext,
  request: PlannerPeriodChatMemoRequest,
  happened: readonly PlannerHappened[],
): string {
  const name = firstName(context.ownerName);
  const word = plannerPeriodWord(context.level);
  const parts = plannerPeriodChatMemoParts(context, request);
  return `Memo step: write ${name}'s ${word} review memo of ${plannerPeriodLabel(context.level, context.periodStart)}. Follow the memo part of your period-review skill. If this session has not read the ${word} yet, call review_period for the ${context.level} starting ${context.periodStart} first.

${parts.template}

${parts.rules}

The review's material:

${plannerPeriodHappenedLines(happened)}

${parts.material}

When the memo is checked:
1. Write it to ${PLANNER_AGENT_MEMO_FILE}.
2. Update your memory store: a few short lines about this ${word} for the next reviews. Notes, not a copy of the memo or the diary.
3. Propose at most three memories this ${word} showed about ${name} that will still be true in a month, each with ${name}'s own words as the receipt (propose_memory; call read_memories first and skip what the ledger holds). The propose tools are on for this step.
4. Reply with the single word: done.`;
}

// ---------------------------------------------------------------------------
// Ask my diary
// ---------------------------------------------------------------------------

/**
 * The first message of an Ask conversation's session. `earlier` is the
 * conversation so far when it goes on in a new session (the last one was put
 * down and ended).
 */
export function plannerAgentAskKickoff(input: {
  ownerName: string;
  today: string;
  question: string;
  earlier?: ReadonlyArray<{ role: "owner" | "agent"; text: string }>;
}): string {
  const name = firstName(input.ownerName);
  const earlier = (input.earlier ?? []).slice(-6);
  const recap = earlier.length
    ? `\n\nThe conversation so far (from an earlier session; check anything you build on):\n\n${earlier
        .map(
          (message) =>
            `${message.role === "owner" ? name : "You"}: ${message.text.length > 2_000 ? `${message.text.slice(0, 2_000)}…` : message.text}`,
        )
        .join("\n\n")}`
    : "";
  return `This session is ${name}'s Ask chat: ${name} asks about their own record and you answer from it. Use your ask-my-diary skill. Today is ${input.today}. You can read anything; you cannot propose or change anything in this chat. Read your memory store's notes if they may bear on the question, and don't change them.${recap}

${name} asks:

${input.question}`;
}

/** A later question in the same conversation. */
export function plannerAgentAskMessage(input: {
  ownerName: string;
  today: string;
  question: string;
}): string {
  return `${firstName(input.ownerName)} asks (today is ${input.today}):

${input.question}`;
}
