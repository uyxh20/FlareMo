import { plannerAddDays } from "@flaremo/contracts";
import type { FlareMoDb } from "@flaremo/db";
import {
  type PlannerDiaryEntry,
  type PlannerReviewContext,
  plannerFindSummaryMemo,
  plannerReadWeekDiary,
} from "./review-context";
import {
  type PlannerMemoRequest,
  plannerMemoParts,
  plannerReviewContextBlock,
} from "./review-prompts";

// The weekly memo agent (fork-owned, docs/fork-review-memo-agent.md): a Claude
// Managed Agent that writes the Sunday summary memo in place of a single model
// call. It reads the whole week and the weeks before it as files, and keeps its
// own notes from one review to the next. This module builds what it reads; the
// Worker (routes/planner-memo-agent.ts) sends it.

/** Earlier weeks the agent can open to check a pattern before claiming it. */
export const PLANNER_MEMO_AGENT_HISTORY_WEEKS = 8;
/** A whole week of diary: the agent reads files, so nothing is cut. */
export const PLANNER_MEMO_AGENT_DIARY_CHARS = 1_000_000;

/**
 * The agent's system prompt, stored on the agent when it is set up
 * (scripts/fork/review-memo-agent.ts). It stays the same every week; what
 * changes is in the files and the kickoff message. Tested against today's memo
 * on four past weeks in October 2026 (weekly-review-ab/memo-agent-runs).
 */
export function plannerMemoAgentSystem(ownerName: string): string {
  const name = ownerName.trim().split(/\s+/)[0] || "the owner";
  return `You write ${name}'s weekly summary memo for their diary app, Schizo Diary. ${name} reads it on Sunday evening, keeps it next to every earlier summary, and uses it to decide next week. A memo that invents something is worse than one that says less, because ${name} acts on it.

## What you have

The kickoff message tells you which week this is and where its files are. Expect:

- \`/data/this-week.md\`: the goal cascade (north star, year, quarter, month and week goals by pillar), recent Authenticity and Achievement scores, last week's key question and Next Steps, the task board, health tracker totals, and every diary entry of the week with the day it was written.
- \`/data/review.md\`: what ${name} answered in the interactive review this evening, the scores they set, and the drafted Pattern, Risk and Opportunity.
- \`/data/template.md\`: the memo's exact skeleton for this week. Text in parentheses is an instruction to you, not text to copy.
- \`/data/history/\`: the diary and saved summary of earlier weeks, one file per week, named by the Monday.
- Your memory store: notes you wrote at earlier reviews of ${name}. Read it before anything else.

Read all of this week's material before you write. Open history files when you are about to say something repeats, changed, or was promised earlier: check it there rather than relying on memory or on an earlier summary.

## How to read the material

- An event happened this week only if this week's diary entries, tasks, goal results or notes, or ${name}'s answers this evening say so. A plan, goal or intention is not an event. Last week's summary is about last week.
- When the material doesn't mention something, it isn't recorded. Don't say it didn't happen.
- The day in brackets is when an entry was written. An entry can describe an earlier day: use the day it names, or say "this week".
- Copy numbers exactly as written, and take totals from the health tracker lines. Don't add things up yourself.
- #tags are labels, not people. Tie a person or company to an event only the way the diary does.
- Earlier summaries were written by a model, sometimes from a cut-down diary. Treat them as claims to check against that week's diary, not as facts.

## What to write

Fill \`/data/template.md\` exactly: its headings in order, its bullet labels, the scores table, and the lines it says to copy unchanged. Keep ${name}'s own words for their reflection answers, fixing typos only. Under 900 words.

- Be specific. In the Executive Summary, Evidence and Learnings, name the days, people and numbers the diary gives, and quote ${name}'s own words exactly, inside quotation marks, at least once for each objective the diary covers.
- The Pattern must be something you can point to in at least two weeks, with the weeks named. If you only see it this week, call it a signal, not a pattern.
- Say where two goals, or a goal and how the week was actually spent, pull against each other, and which one is losing.
- If the material is thin for an objective, write "None stated." or say in one sentence what is missing. Don't fill the gap.
- Each Next Steps bullet is one concrete step for next week in at most 15 words, tied to a goal above it.
- Plain and direct. No praise, no encouragement, no motivational tone. Address ${name} as "you" only where the template's own sections speak to them.

When ${name} changed a drafted score, write that score's basis afresh from the evidence and keep nothing from the draft that contradicts it.

## Before you finish

Check every concrete claim (a day, number, name, quote, event) against this week's files once more and remove any you can't find. Then:

1. Write the memo to \`/mnt/session/outputs/memo.md\`.
2. Update your memory store: a few short lines for next week. Open threads, what ${name} said they would do, patterns to re-check, and anything you got wrong before and should watch for. Notes, not a copy of the memo or the diary.
3. Reply with the single word: done.`;
}

export type PlannerMemoHistoryWeek = {
  weekStart: string;
  diary: PlannerDiaryEntry[];
  summary: string | null;
};

/** The diary and saved summary of each of the weeks before `weekStart`, oldest first. */
export async function plannerReadMemoHistory(
  db: FlareMoDb,
  input: { userId: string; weekStart: string; weeks?: number },
): Promise<PlannerMemoHistoryWeek[]> {
  const count = input.weeks ?? PLANNER_MEMO_AGENT_HISTORY_WEEKS;
  const starts = Array.from({ length: count }, (_, index) =>
    plannerAddDays(input.weekStart, -7 * (count - index)),
  );
  return Promise.all(
    starts.map(async (weekStart) => {
      const [diary, summary] = await Promise.all([
        plannerReadWeekDiary(db, {
          userId: input.userId,
          weekStart,
          maxChars: PLANNER_MEMO_AGENT_DIARY_CHARS,
        }),
        plannerFindSummaryMemo(db, { userId: input.userId, weekStart }),
      ]);
      return { weekStart, diary, summary: summary?.content ?? null };
    }),
  );
}

function historyFile(week: PlannerMemoHistoryWeek): string {
  return [
    `# Week of Monday ${week.weekStart}`,
    "",
    "## Saved weekly summary (written by a model; check it against the diary)",
    "",
    week.summary ?? "No summary was saved for this week.",
    "",
    "## Diary entries, oldest first",
    "",
    ...(week.diary.length
      ? week.diary.map((entry) => `[${entry.at.slice(0, 10)}] ${entry.text}\n`)
      : ["No diary entries were written this week."]),
  ].join("\n");
}

/**
 * The files mounted into the agent's session, by path. `context` is read with
 * the whole week's diary (PLANNER_MEMO_AGENT_DIARY_CHARS).
 */
export function plannerMemoAgentFiles(
  context: PlannerReviewContext,
  request: PlannerMemoRequest,
  history: readonly PlannerMemoHistoryWeek[],
): Record<string, string> {
  const parts = plannerMemoParts(context, request);
  const files: Record<string, string> = {
    "/data/this-week.md": plannerReviewContextBlock(context),
    "/data/review.md": [
      `# ${context.ownerName}'s review of the week, this evening`,
      "",
      parts.material,
    ].join("\n"),
    "/data/template.md": parts.template,
  };
  for (const week of history) {
    files[`/data/history/${week.weekStart}.md`] = historyFile(week);
  }
  return files;
}

/** The first message of each session. */
export function plannerMemoAgentKickoff(weekStart: string): string {
  return `This is the review of the week starting Monday ${weekStart}. Its files are in /data: this-week.md, review.md, template.md and history/ (the weeks before it). Your memory store is mounted under /mnt/memory/.`;
}
