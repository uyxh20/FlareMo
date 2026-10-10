import {
  type PlannerGoalDto,
  type PlannerPillar,
  plannerAddDays,
  plannerIsoWeekOf,
  plannerMemoKeyQuestion,
  plannerMonthStartOf,
  plannerQuarterStartOf,
  plannerSummaryMemoClientId,
  plannerSummaryMemoSource,
  plannerSummaryMemoTag,
  plannerWeekMonthOf,
} from "@flaremo/contracts";
import type { FlareMoDb } from "@flaremo/db";
import { memos, memoTags, tasks } from "@flaremo/db";
import {
  plannerGoalFlag,
  plannerTaskPlan,
  plannerWeek,
} from "@flaremo/db/src/schema/planner";
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  notInArray,
  sql,
} from "drizzle-orm";
import {
  plannerReadGoalsById,
  plannerReadNorthStar,
  plannerReadPeriodGoals,
  plannerReadWeekGoals,
} from "./goals";

// What the weekly review's model reads (fork-owned add-on,
// docs/planning-cockpit-goals-review.md): the goal cascade, recent scores, the
// last summary, the week's tasks and the week's diary entries, read from the
// owner's own data each time a draft is asked for. The prompts that use it are in
// review-prompts.ts. Nothing here writes.

/** A live memo's id and text. */
export type PlannerMemoText = { id: string; content: string };

const LIVE_MEMO = and(
  isNull(memos.deletedAt),
  inArray(memos.status, ["normal", "archived"]),
);

async function readMemo(
  db: FlareMoDb,
  userId: string,
  memoId: string,
): Promise<PlannerMemoText | null> {
  const row = await db
    .select({ id: memos.id, content: memos.content })
    .from(memos)
    .where(and(eq(memos.id, memoId), eq(memos.userId, userId), LIVE_MEMO))
    .get();
  return row ?? null;
}

/**
 * The summary memo of a week: the one the week's record names, else the one the
 * weekly review wrote for it, else an imported summary whose title names the
 * same ISO week ("# Week 40: September 28 - October 4, 2026"). Null when the week
 * has none.
 */
export async function plannerFindSummaryMemo(
  db: FlareMoDb,
  input: { userId: string; weekStart: string },
): Promise<PlannerMemoText | null> {
  const record = await db
    .select({ memoId: plannerWeek.memoId })
    .from(plannerWeek)
    .where(
      and(
        eq(plannerWeek.userId, input.userId),
        eq(plannerWeek.weekStart, input.weekStart),
      ),
    )
    .get();
  if (record?.memoId) {
    const memo = await readMemo(db, input.userId, record.memoId);
    if (memo) return memo;
  }
  const written = await db
    .select({ id: memos.id, content: memos.content })
    .from(memos)
    .where(
      and(
        eq(memos.userId, input.userId),
        eq(memos.clientId, plannerSummaryMemoClientId(input.weekStart)),
        LIVE_MEMO,
      ),
    )
    .get();
  if (written) return written;

  const target = plannerIsoWeekOf(input.weekStart);
  const heads = await db
    .select({
      id: memos.id,
      head: sql<string>`substr(${memos.content}, 1, 200)`,
    })
    .from(memoTags)
    .innerJoin(memos, eq(memos.id, memoTags.memoId))
    .where(
      and(
        eq(memoTags.userId, input.userId),
        eq(memoTags.tag, plannerSummaryMemoTag),
        eq(memos.userId, input.userId),
        LIVE_MEMO,
      ),
    )
    .orderBy(desc(memos.updatedAt))
    .limit(400)
    .all();
  const match = heads.find((row) => {
    const firstLine =
      row.head
        .split("\n")
        .find((line) => line.trim())
        ?.trim() ?? "";
    const found = /^#\s*Week\s+(\d{1,2})\b(.*)$/i.exec(firstLine);
    if (!found?.[1] || Number(found[1]) !== target.week) return false;
    const years = [...(found[2] ?? "").matchAll(/\b(\d{4})\b/g)].map((year) =>
      Number(year[1]),
    );
    return years.at(-1) === target.year;
  });
  return match ? readMemo(db, input.userId, match.id) : null;
}

/**
 * The key question the review of the week before `weekStart` left for this one:
 * its record's `question`, else the "Key question for W..." line of its summary.
 */
export async function plannerReadLastQuestion(
  db: FlareMoDb,
  input: { userId: string; weekStart: string },
): Promise<string | null> {
  const previous = plannerAddDays(input.weekStart, -7);
  const record = await db
    .select({ question: plannerWeek.question })
    .from(plannerWeek)
    .where(
      and(
        eq(plannerWeek.userId, input.userId),
        eq(plannerWeek.weekStart, previous),
      ),
    )
    .get();
  if (record?.question?.trim()) return record.question.trim();
  const memo = await plannerFindSummaryMemo(db, {
    userId: input.userId,
    weekStart: previous,
  });
  return memo ? plannerMemoKeyQuestion(memo.content) : null;
}

/** One diary entry of the week, trimmed to fit the model's budget. */
export type PlannerDiaryEntry = { at: string; text: string };

/**
 * The owner's diary entries written during the week, oldest first, without the
 * weekly summaries. The budget is shared evenly, so a long entry cannot crowd out
 * the rest of the week.
 */
export async function plannerReadWeekDiary(
  db: FlareMoDb,
  input: { userId: string; weekStart: string; maxChars?: number },
): Promise<PlannerDiaryEntry[]> {
  const budget = input.maxChars ?? 12_000;
  const summaries = db
    .select({ id: memoTags.memoId })
    .from(memoTags)
    .where(
      and(
        eq(memoTags.userId, input.userId),
        eq(memoTags.tag, plannerSummaryMemoTag),
      ),
    );
  const rows = await db
    .select({ at: memos.createdAt, content: memos.content })
    .from(memos)
    .where(
      and(
        eq(memos.userId, input.userId),
        LIVE_MEMO,
        gte(memos.createdAt, input.weekStart),
        lt(memos.createdAt, plannerAddDays(input.weekStart, 7)),
        ne(memos.source, plannerSummaryMemoSource),
        notInArray(memos.id, summaries),
      ),
    )
    .orderBy(asc(memos.createdAt))
    .limit(200)
    .all();
  if (rows.length === 0) return [];
  const each = Math.max(240, Math.floor(budget / rows.length));
  const out: PlannerDiaryEntry[] = [];
  let used = 0;
  for (const row of rows) {
    const clean = row.content.replace(/\s+/g, " ").trim();
    if (!clean) continue;
    const text = clean.length > each ? `${clean.slice(0, each - 1)}…` : clean;
    if (used + text.length > budget) break;
    used += text.length;
    out.push({ at: row.at, text });
  }
  return out;
}

/** Everything the review's model reads about one week. */
export type PlannerReviewContext = {
  /** The owner's first name, as the prompts address them. */
  ownerName: string;
  weekStart: string;
  planWeek: string;
  today: string;
  northStar: PlannerGoalDto | null;
  yearGoals: PlannerGoalDto[];
  quarterGoals: PlannerGoalDto[];
  monthGoals: PlannerGoalDto[];
  /** The weekly goals of the week looked back on, with any result recorded. */
  weekGoals: PlannerGoalDto[];
  /** Up to eight weeks of scores ending with the week before the one reviewed. */
  scores: Array<{ weekStart: string; auth: number | null; ach: number | null }>;
  lastQuestion: string | null;
  /** The previous week's summary, trimmed. */
  previousSummary: string | null;
  tasks: { done: string[]; doing: string[]; todo: string[] };
  /** Clashes flagged by earlier checks and not settled. */
  openFlags: Array<{
    pillar: PlannerPillar | null;
    label: string;
    why: string;
  }>;
  /** Clashes the owner kept in the last eight weeks, which a check should not raise again. */
  keptFlags: Array<{
    pillar: PlannerPillar | null;
    label: string;
    why: string;
  }>;
  diary: PlannerDiaryEntry[];
};

const PREVIOUS_SUMMARY_MAX = 4_000;

/** Reads the review's context for the week that starts on `weekStart`. */
export async function plannerReadReviewContext(
  db: FlareMoDb,
  input: {
    userId: string;
    ownerName: string;
    weekStart: string;
    today: string;
  },
): Promise<PlannerReviewContext> {
  const { userId, weekStart } = input;
  const planWeek = plannerAddDays(weekStart, 7);
  const weekEnd = plannerAddDays(weekStart, 7);
  const anchor = plannerWeekMonthOf(weekStart);
  const thursday = plannerAddDays(weekStart, 3);
  const scoresFrom = plannerAddDays(weekStart, -7 * 8);

  const [
    northStar,
    yearGoals,
    quarterGoals,
    monthGoals,
    weekGoals,
    scoreRows,
    lastQuestion,
    previous,
    done,
    open,
    flags,
    diary,
  ] = await Promise.all([
    plannerReadNorthStar(db, userId),
    plannerReadPeriodGoals(db, {
      userId,
      level: "year",
      periodStart: `${anchor.year}-01-01`,
    }),
    plannerReadPeriodGoals(db, {
      userId,
      level: "quarter",
      periodStart: plannerQuarterStartOf(thursday),
    }),
    plannerReadPeriodGoals(db, {
      userId,
      level: "month",
      periodStart: plannerMonthStartOf(thursday),
    }),
    plannerReadWeekGoals(db, { userId, weekStart }),
    db
      .select({
        weekStart: plannerWeek.weekStart,
        auth: plannerWeek.auth,
        ach: plannerWeek.ach,
      })
      .from(plannerWeek)
      .where(
        and(
          eq(plannerWeek.userId, userId),
          gte(plannerWeek.weekStart, scoresFrom),
          lt(plannerWeek.weekStart, weekStart),
        ),
      )
      .orderBy(asc(plannerWeek.weekStart))
      .all(),
    plannerReadLastQuestion(db, { userId, weekStart }),
    plannerFindSummaryMemo(db, {
      userId,
      weekStart: plannerAddDays(weekStart, -7),
    }),
    db
      .select({ title: tasks.title })
      .from(tasks)
      .where(
        and(
          eq(tasks.userId, userId),
          isNull(tasks.deletedAt),
          eq(tasks.status, "done"),
          gte(tasks.completedAt, weekStart),
          lt(tasks.completedAt, weekEnd),
        ),
      )
      .orderBy(asc(tasks.completedAt))
      .limit(40)
      .all(),
    db
      .select({
        title: tasks.title,
        status: tasks.status,
        horizon: plannerTaskPlan.horizon,
        droppedAt: plannerTaskPlan.droppedAt,
      })
      .from(tasks)
      .leftJoin(plannerTaskPlan, eq(plannerTaskPlan.taskId, tasks.id))
      .where(
        and(
          eq(tasks.userId, userId),
          isNull(tasks.deletedAt),
          inArray(tasks.status, ["todo", "in_progress"]),
        ),
      )
      .orderBy(asc(tasks.createdAt))
      .limit(400)
      .all(),
    db
      .select()
      .from(plannerGoalFlag)
      .where(eq(plannerGoalFlag.userId, userId))
      .orderBy(asc(plannerGoalFlag.createdAt))
      .limit(200)
      .all(),
    plannerReadWeekDiary(db, { userId, weekStart }),
  ]);

  const live = open.filter((row) => !row.droppedAt);
  const recentKept = plannerAddDays(weekStart, -7 * 8);
  return {
    ownerName: input.ownerName.trim().split(/\s+/)[0] || "the owner",
    weekStart,
    planWeek,
    today: input.today,
    northStar,
    yearGoals,
    quarterGoals,
    monthGoals,
    weekGoals,
    scores: scoreRows.map((row) => ({
      weekStart: row.weekStart,
      auth: row.auth ?? null,
      ach: row.ach ?? null,
    })),
    lastQuestion,
    previousSummary: previous
      ? previous.content.length > PREVIOUS_SUMMARY_MAX
        ? `${previous.content.slice(0, PREVIOUS_SUMMARY_MAX)}…`
        : previous.content
      : null,
    tasks: {
      done: done.map((row) => row.title),
      doing: live
        .filter((row) => row.status === "in_progress")
        .map((row) => row.title)
        .slice(0, 30),
      todo: live
        .filter((row) => row.status === "todo" && row.horizon !== null)
        .map((row) => row.title)
        .slice(0, 30),
    },
    openFlags: flags
      .filter((flag) => flag.state === "open" && flag.weekStart <= weekStart)
      .map((flag) => ({
        pillar: flag.pillar ?? null,
        label: flag.withLabel,
        why: flag.why,
      })),
    keptFlags: flags
      .filter((flag) => flag.state === "kept" && flag.weekStart >= recentKept)
      .map((flag) => ({
        pillar: flag.pillar ?? null,
        label: flag.withLabel,
        why: flag.why,
      })),
    diary,
  };
}

/** The goals a set of flags names, for showing them in Check goals. */
export async function plannerReadFlagGoals(
  db: FlareMoDb,
  input: {
    userId: string;
    flags: ReadonlyArray<{ goalId: string | null; withGoalId: string | null }>;
  },
): Promise<PlannerGoalDto[]> {
  return plannerReadGoalsById(db, {
    userId: input.userId,
    ids: input.flags.flatMap((flag) =>
      [flag.goalId, flag.withGoalId].filter(
        (id): id is string => typeof id === "string",
      ),
    ),
  });
}

/** Whether any task is linked to a goal (used by tests and the seed check). */
export async function plannerCountLinkedTasks(
  db: FlareMoDb,
  userId: string,
): Promise<number> {
  const row = await db
    .select({ count: sql<number>`count(*)` })
    .from(plannerTaskPlan)
    .where(
      and(
        eq(plannerTaskPlan.userId, userId),
        isNotNull(plannerTaskPlan.goalId),
      ),
    )
    .get();
  return row?.count ?? 0;
}
