import {
  type HealthEntryDto,
  type HealthKind,
  type HealthWeekSummary,
  healthIsBuiltinKind,
  healthLocalDayStart,
  type PlannerGoalDto,
  type PlannerPillar,
  plannerAddDays,
  plannerIsoWeekOf,
  plannerMemoKeyQuestion,
  plannerMemoNextSteps,
  plannerMonthStartOf,
  plannerQuarterStartOf,
  plannerSummaryMemoClientId,
  plannerSummaryMemoSource,
  plannerSummaryMemoTag,
  plannerWeekMonthOf,
} from "@flaremo/contracts";
import type { FlareMoDb } from "@flaremo/db";
import { memoryItems, memos, memoTags, tasks } from "@flaremo/db";
import { healthEntry } from "@flaremo/db/src/schema/fork-health";
import {
  plannerGoalFlag,
  plannerTaskComment,
  plannerTaskEvent,
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
  or,
  sql,
} from "drizzle-orm";
import { healthReadGoalProgress, healthReadWeek } from "../health/read";
import { healthListTrackers } from "../health/trackers";
import {
  plannerReadGoalsById,
  plannerReadNorthStar,
  plannerReadPeriodGoals,
  plannerReadWeekGoals,
} from "./goals";

// What the weekly review's model reads (fork-owned add-on,
// docs/planning-cockpit-goals-review.md): the goal cascade, recent scores, the
// last summary, the week's tasks, the week's diary entries, the week's health
// tracker rows and the memories made or changed that week, read from the
// owner's own data each time a draft is asked for. The prompts that use it are in
// review-prompts.ts. Nothing here writes.
//
// A week runs from Monday 00:00 to the next Monday 00:00 in the owner's own
// zone (FORK_HEALTH_TIME_ZONE), not in UTC: an entry written at 00:30 on Monday
// in Copenhagen belongs to the new week even though it is still Sunday in UTC.

/**
 * The UTC instants a review week starts and ends at: the owner's local
 * midnight on `weekStart` and seven days later, for comparing with UTC
 * `created_at` and `completed_at` columns.
 */
export function plannerWeekInstants(weekStart: string): {
  from: string;
  to: string;
} {
  return {
    from: healthLocalDayStart(weekStart),
    to: healthLocalDayStart(plannerAddDays(weekStart, 7)),
  };
}

/**
 * What the week's review reads, counted (the Look back shows it before it
 * starts): diary entries, health rows and tasks done in the week. The goals
 * are counted by the caller, which has them.
 */
export async function plannerCountWeekReads(
  db: FlareMoDb,
  input: { userId: string; weekStart: string },
): Promise<{ entries: number; health_rows: number; tasks_done: number }> {
  const week = plannerWeekInstants(input.weekStart);
  const summaries = db
    .select({ id: memoTags.memoId })
    .from(memoTags)
    .where(
      and(
        eq(memoTags.userId, input.userId),
        eq(memoTags.tag, plannerSummaryMemoTag),
      ),
    );
  const [entries, health, done] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)` })
      .from(memos)
      .where(
        and(
          eq(memos.userId, input.userId),
          LIVE_MEMO,
          gte(memos.createdAt, week.from),
          lt(memos.createdAt, week.to),
          ne(memos.source, plannerSummaryMemoSource),
          notInArray(memos.id, summaries),
        ),
      )
      .get(),
    db
      .select({ count: sql<number>`count(*)` })
      .from(healthEntry)
      .where(
        and(
          eq(healthEntry.userId, input.userId),
          gte(healthEntry.day, input.weekStart),
          lt(healthEntry.day, plannerAddDays(input.weekStart, 7)),
        ),
      )
      .get(),
    db
      .select({ count: sql<number>`count(*)` })
      .from(tasks)
      .where(
        and(
          eq(tasks.userId, input.userId),
          isNull(tasks.deletedAt),
          eq(tasks.status, "done"),
          gte(tasks.completedAt, week.from),
          lt(tasks.completedAt, week.to),
        ),
      )
      .get(),
  ]);
  return {
    entries: Number(entries?.count ?? 0),
    health_rows: Number(health?.count ?? 0),
    tasks_done: Number(done?.count ?? 0),
  };
}

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

/** Diary characters a large-context model reads per week (OpenRouter, Anthropic). */
export const PLANNER_DIARY_CHARS = 40_000;
/** Diary characters for a small-context model (Workers AI). */
export const PLANNER_DIARY_CHARS_SMALL = 12_000;

/**
 * Fits the week's entries into `budget` characters. Entries that fit their fair
 * share stay whole and hand what they don't use to the longer ones, which are
 * then cut to the same length, so a long entry cannot crowd out the rest of
 * the week and a short one wastes nothing.
 */
export function plannerFitDiary(
  rows: ReadonlyArray<{ at: string; content: string }>,
  budget: number,
): PlannerDiaryEntry[] {
  const entries = rows
    .map((row) => ({
      at: row.at,
      text: row.content.replace(/\s+/g, " ").trim(),
    }))
    .filter((entry) => entry.text);
  const lengths = entries
    .map((entry) => entry.text.length)
    .sort((a, b) => a - b);
  let left = budget;
  let count = entries.length;
  let cap = Number.POSITIVE_INFINITY;
  for (const length of lengths) {
    const share = Math.floor(left / count);
    if (length > share) {
      cap = share;
      break;
    }
    left -= length;
    count -= 1;
  }
  return entries.map((entry) => {
    if (entry.text.length <= cap) return entry;
    // Never split an emoji's surrogate pair.
    let end = Math.max(0, cap - 1);
    if (/[\uD800-\uDBFF]/.test(entry.text[end - 1] ?? "")) end -= 1;
    return { at: entry.at, text: `${entry.text.slice(0, end)}…` };
  });
}

/**
 * The owner's diary entries written during the week, oldest first, without the
 * weekly summaries, fitted to the budget by `plannerFitDiary`.
 */
export async function plannerReadWeekDiary(
  db: FlareMoDb,
  input: { userId: string; weekStart: string; maxChars?: number },
): Promise<PlannerDiaryEntry[]> {
  const budget = input.maxChars ?? PLANNER_DIARY_CHARS_SMALL;
  const week = plannerWeekInstants(input.weekStart);
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
        gte(memos.createdAt, week.from),
        lt(memos.createdAt, week.to),
        ne(memos.source, plannerSummaryMemoSource),
        notInArray(memos.id, summaries),
      ),
    )
    .orderBy(asc(memos.createdAt))
    .limit(200)
    .all();
  return plannerFitDiary(rows, budget);
}

/** A memory made or changed during the week, as the review reads it. */
export type PlannerWeekMemory = {
  kind: string;
  content: string;
  /** Proposed by the memory layer and not confirmed by the owner yet. */
  unconfirmed: boolean;
};

/** Memories the review reads per week, most important first. */
export const PLANNER_MEMORY_MAX = 25;
const MEMORY_CHARS = 280;

/**
 * The owner's live memories created or updated during the week (local
 * midnight to local midnight), most important first. Rejected, archived,
 * superseded and deleted memories are left out.
 */
export async function plannerReadWeekMemories(
  db: FlareMoDb,
  input: { userId: string; weekStart: string },
): Promise<PlannerWeekMemory[]> {
  const week = plannerWeekInstants(input.weekStart);
  const rows = await db
    .select({
      kind: memoryItems.kind,
      content: memoryItems.content,
      verification: memoryItems.verification,
    })
    .from(memoryItems)
    .where(
      and(
        eq(memoryItems.userId, input.userId),
        eq(memoryItems.status, "active"),
        isNull(memoryItems.deletedAt),
        isNull(memoryItems.rejectedAt),
        or(
          and(
            gte(memoryItems.createdAt, week.from),
            lt(memoryItems.createdAt, week.to),
          ),
          and(
            gte(memoryItems.updatedAt, week.from),
            lt(memoryItems.updatedAt, week.to),
          ),
        ),
      ),
    )
    .orderBy(desc(memoryItems.importance), desc(memoryItems.updatedAt))
    .limit(PLANNER_MEMORY_MAX)
    .all();
  return rows.flatMap((row) => {
    const text = row.content.replace(/\s+/g, " ").trim();
    if (!text) return [];
    return [
      {
        kind: row.kind,
        content:
          text.length > MEMORY_CHARS
            ? `${text.slice(0, MEMORY_CHARS - 1)}…`
            : text,
        unconfirmed: row.verification === "inferred",
      },
    ];
  });
}

/** The week's health tracker rows and how they compare with the targets. */
export type PlannerWeekHealth = {
  entries: Array<
    Pick<
      HealthEntryDto,
      | "kind"
      | "day"
      | "variant"
      | "minutes"
      | "home_at"
      | "units"
      | "bender"
      | "needs_check"
      | "feel"
    >
  >;
  summary: HealthWeekSummary;
  /**
   * The owner's own trackers (fasting, say), each with its week and, when it
   * is linked to a goal, how far it has got in that goal's period.
   */
  trackers: Array<{
    label: string;
    measure: "days" | "minutes" | "hours";
    days: number;
    minutes: number;
    entries: Array<{
      day: string;
      minutes: number | null;
      feel: string | null;
    }>;
    goal: {
      level: string;
      from: string;
      to: string;
      days: number;
      minutes: number;
      timed: number;
    } | null;
  }>;
};

const HEALTH_FEEL_CHARS = 160;

function shortFeel(feel: string | null): string | null {
  return feel
    ? feel.replace(/\s+/g, " ").trim().slice(0, HEALTH_FEEL_CHARS) || null
    : null;
}

function isBuiltinEntry(
  entry: HealthEntryDto,
): entry is HealthEntryDto & { kind: HealthKind } {
  return healthIsBuiltinKind(entry.kind);
}

/** The health tracker's view of the reviewed week (Monday to Sunday, local days). */
export async function plannerReadWeekHealth(
  db: FlareMoDb,
  input: { userId: string; weekStart: string },
): Promise<PlannerWeekHealth> {
  const [week, trackers, progress] = await Promise.all([
    healthReadWeek(db, { userId: input.userId, start: input.weekStart }),
    healthListTrackers(db, input.userId),
    healthReadGoalProgress(db, { userId: input.userId }),
  ]);
  const own = trackers.filter((tracker) => !tracker.builtin);
  return {
    // The built-in kinds here; the owner's own trackers under `trackers`.
    entries: week.entries.filter(isBuiltinEntry).map((entry) => ({
      kind: entry.kind,
      day: entry.day,
      variant: entry.variant,
      minutes: entry.minutes,
      home_at: entry.home_at,
      units: entry.units,
      bender: entry.bender,
      needs_check: entry.needs_check,
      feel: shortFeel(entry.feel),
    })),
    summary: week.summary,
    trackers: own.map((tracker) => {
      const count = week.trackers.find((item) => item.kind === tracker.kind);
      const goal = progress.find((item) => item.kind === tracker.kind);
      return {
        label: tracker.label,
        measure: tracker.measure,
        days: count?.days ?? 0,
        minutes: count?.minutes ?? 0,
        entries: week.entries
          .filter((entry) => entry.kind === tracker.kind)
          .map((entry) => ({
            day: entry.day,
            minutes: entry.minutes,
            feel: shortFeel(entry.feel),
          })),
        goal: goal
          ? {
              level: goal.level,
              from: goal.from,
              to: goal.to,
              days: goal.days,
              minutes: goal.minutes,
              timed: goal.timed,
            }
          : null,
      };
    }),
  };
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
  /**
   * The year, quarter and month goals of the week being planned (`planWeek`),
   * which the look forward check reads. They differ from the ones above when
   * the plan week falls in another month, quarter or year.
   */
  planCascade: {
    year: number;
    quarter: number;
    month: number;
    yearGoals: PlannerGoalDto[];
    quarterGoals: PlannerGoalDto[];
    monthGoals: PlannerGoalDto[];
  };
  /** The weekly goals of the week looked back on, with any result recorded. */
  weekGoals: PlannerGoalDto[];
  /** Up to eight weeks of scores ending with the week before the one reviewed. */
  scores: Array<{ weekStart: string; auth: number | null; ach: number | null }>;
  lastQuestion: string | null;
  /** The previous week's summary, trimmed. */
  previousSummary: string | null;
  /**
   * The previous summary's Next Steps per objective, read from the whole memo:
   * they usually sit past the trimmed part, and they are last week's plan.
   */
  previousSteps: Partial<Record<PlannerPillar, string>>;
  tasks: { done: string[]; doing: string[]; todo: string[] };
  /**
   * The tasks done, worked on or touched this week, and the ones in Doing,
   * with what was written on them: notes, comments and the week's history.
   */
  taskDetails: PlannerReviewTask[];
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
  /** The health tracker's rows for the week, with the targets. */
  health: PlannerWeekHealth | null;
  /** Memories made or changed during the week. */
  memories: PlannerWeekMemory[];
};

/** One task as the review reads it, beyond its title. */
export type PlannerReviewTask = {
  title: string;
  /** todo, in_progress or done; `gone` for a task deleted or purged since. */
  status: string;
  notes: string | null;
  /** Its live comments, oldest first. */
  comments: Array<{ at: string; text: string }>;
  /** What happened to it during the week, oldest first. */
  history: Array<{ at: string; what: string }>;
};

/** At most this many tasks get their details, the most recently touched first. */
const TASK_DETAIL_MAX = 60;
/**
 * Characters of notes and comments per task: small for the chat models' prompt,
 * whole for the review agent, which reads the week as files.
 */
const TASK_DETAIL_CHARS = 600;
const TASK_DETAIL_CHARS_WHOLE = 20_000;

const PREVIOUS_SUMMARY_MAX = 4_000;
const PREVIOUS_STEP_MAX = 600;

/**
 * Reads the review's context for the week that starts on `weekStart`.
 * `diaryChars` is the diary's budget: PLANNER_DIARY_CHARS_SMALL unless the
 * model can read more.
 */
export async function plannerReadReviewContext(
  db: FlareMoDb,
  input: {
    userId: string;
    ownerName: string;
    weekStart: string;
    today: string;
    diaryChars?: number;
  },
): Promise<PlannerReviewContext> {
  const { userId, weekStart } = input;
  const planWeek = plannerAddDays(weekStart, 7);
  const week = plannerWeekInstants(weekStart);
  const anchor = plannerWeekMonthOf(weekStart);
  const thursday = plannerAddDays(weekStart, 3);
  const planAnchor = plannerWeekMonthOf(planWeek);
  const planThursday = plannerAddDays(planWeek, 3);
  const scoresFrom = plannerAddDays(weekStart, -7 * 8);
  // The plan week's cascade is only read again where it differs.
  const samePeriod = <T>(
    reviewed: string,
    planned: string,
    read: (periodStart: string) => Promise<T>,
    already: Promise<T>,
  ): Promise<T> => (reviewed === planned ? already : read(planned));
  const readYear = (start: string) =>
    plannerReadPeriodGoals(db, { userId, level: "year", periodStart: start });
  const readQuarter = (start: string) =>
    plannerReadPeriodGoals(db, {
      userId,
      level: "quarter",
      periodStart: start,
    });
  const readMonth = (start: string) =>
    plannerReadPeriodGoals(db, { userId, level: "month", periodStart: start });
  const yearStart = `${anchor.year}-01-01`;
  const planYearStart = `${planAnchor.year}-01-01`;
  const quarterStart = plannerQuarterStartOf(thursday);
  const planQuarterStart = plannerQuarterStartOf(planThursday);
  const monthStart = plannerMonthStartOf(thursday);
  const planMonthStart = plannerMonthStartOf(planThursday);
  const yearRead = readYear(yearStart);
  const quarterRead = readQuarter(quarterStart);
  const monthRead = readMonth(monthStart);

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
    planYearGoals,
    planQuarterGoals,
    planMonthGoals,
    health,
    memories,
  ] = await Promise.all([
    plannerReadNorthStar(db, userId),
    yearRead,
    quarterRead,
    monthRead,
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
      .select({ id: tasks.id, title: tasks.title })
      .from(tasks)
      .where(
        and(
          eq(tasks.userId, userId),
          isNull(tasks.deletedAt),
          eq(tasks.status, "done"),
          gte(tasks.completedAt, week.from),
          lt(tasks.completedAt, week.to),
        ),
      )
      .orderBy(asc(tasks.completedAt))
      .limit(40)
      .all(),
    db
      .select({
        id: tasks.id,
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
    plannerReadWeekDiary(db, {
      userId,
      weekStart,
      maxChars: input.diaryChars,
    }),
    samePeriod(yearStart, planYearStart, readYear, yearRead),
    samePeriod(quarterStart, planQuarterStart, readQuarter, quarterRead),
    samePeriod(monthStart, planMonthStart, readMonth, monthRead),
    // The tracker is an add-on: a review still works if it cannot be read.
    plannerReadWeekHealth(db, { userId, weekStart }).catch(() => null),
    plannerReadWeekMemories(db, { userId, weekStart }).catch(() => []),
  ]);

  const live = open.filter((row) => !row.droppedAt);
  const recentKept = plannerAddDays(weekStart, -7 * 8);
  // Extra detail: a review still works if it cannot be read.
  const taskDetails = await plannerReadTaskDetails(db, {
    userId,
    from: week.from,
    to: week.to,
    taskIds: [
      ...done.map((row) => row.id),
      ...live
        .filter((row) => row.status === "in_progress")
        .map((row) => row.id),
    ],
    chars:
      (input.diaryChars ?? 0) >= 200_000
        ? TASK_DETAIL_CHARS_WHOLE
        : TASK_DETAIL_CHARS,
  }).catch(() => []);
  return {
    ownerName: input.ownerName.trim().split(/\s+/)[0] || "the owner",
    weekStart,
    planWeek,
    today: input.today,
    northStar,
    yearGoals,
    quarterGoals,
    monthGoals,
    planCascade: {
      year: planAnchor.year,
      quarter: Math.floor(Number(planQuarterStart.slice(5, 7)) / 3) + 1,
      month: Number(planMonthStart.slice(5, 7)) - 1,
      yearGoals: planYearGoals,
      quarterGoals: planQuarterGoals,
      monthGoals: planMonthGoals,
    },
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
    previousSteps: previous
      ? plannerMemoNextSteps(previous.content, PREVIOUS_STEP_MAX)
      : {},
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
    taskDetails,
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
    health,
    memories,
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

function trimTo(text: string, max: number): string {
  const clean = text.trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/** One history event in words: its type, and where it went when it says. */
function taskEventWhat(type: string, data: Record<string, unknown>): string {
  const to = data.to;
  if (typeof data.status === "string") return `${type} to ${data.status}`;
  if (to && typeof to === "object" && "horizon" in to) {
    const horizon = (to as { horizon?: unknown }).horizon;
    if (typeof horizon === "string") return `${type} to ${horizon}`;
  }
  if (type === "updated") {
    const fields = Object.keys(data).filter((key) => key !== "updated_at");
    if (fields.length) return `updated (${fields.join(", ")})`;
  }
  return type;
}

/**
 * The tasks done, worked on or touched in [from, to), plus `taskIds`, with
 * their notes, live comments and the period's history. A task the period
 * touched that is gone since keeps the title its history recorded.
 */
export async function plannerReadTaskDetails(
  db: FlareMoDb,
  input: {
    userId: string;
    from: string;
    to: string;
    taskIds: readonly string[];
    chars: number;
  },
): Promise<PlannerReviewTask[]> {
  const { userId, from, to } = input;
  const [events, weekComments] = await Promise.all([
    db
      .select({
        taskId: plannerTaskEvent.taskId,
        taskTitle: plannerTaskEvent.taskTitle,
        type: plannerTaskEvent.type,
        data: plannerTaskEvent.data,
        at: plannerTaskEvent.occurredAt,
      })
      .from(plannerTaskEvent)
      .where(
        and(
          eq(plannerTaskEvent.userId, userId),
          gte(plannerTaskEvent.occurredAt, from),
          lt(plannerTaskEvent.occurredAt, to),
        ),
      )
      .orderBy(asc(plannerTaskEvent.occurredAt), asc(plannerTaskEvent.id))
      .limit(1_000)
      .all(),
    db
      .select({ taskId: plannerTaskComment.taskId })
      .from(plannerTaskComment)
      .where(
        and(
          eq(plannerTaskComment.userId, userId),
          isNull(plannerTaskComment.deletedAt),
          gte(plannerTaskComment.createdAt, from),
          lt(plannerTaskComment.createdAt, to),
        ),
      )
      .limit(1_000)
      .all(),
  ]);
  // The most recently touched first, then the listed ones.
  const order: string[] = [];
  const add = (id: string) => {
    if (id && !order.includes(id)) order.push(id);
  };
  for (const event of [...events].reverse()) add(event.taskId);
  for (const comment of weekComments) add(comment.taskId);
  for (const id of input.taskIds) add(id);
  const ids = order.slice(0, TASK_DETAIL_MAX);
  if (!ids.length) return [];

  const chunks = (list: readonly string[]) =>
    Array.from({ length: Math.ceil(list.length / 80) }, (_, index) =>
      list.slice(index * 80, index * 80 + 80),
    );
  const [rows, comments] = await Promise.all([
    Promise.all(
      chunks(ids).map((chunk) =>
        db
          .select({
            id: tasks.id,
            title: tasks.title,
            notes: tasks.notes,
            status: tasks.status,
            deletedAt: tasks.deletedAt,
          })
          .from(tasks)
          .where(and(eq(tasks.userId, userId), inArray(tasks.id, chunk)))
          .all(),
      ),
    ).then((lists) => lists.flat()),
    Promise.all(
      chunks(ids).map((chunk) =>
        db
          .select({
            taskId: plannerTaskComment.taskId,
            body: plannerTaskComment.body,
            at: plannerTaskComment.createdAt,
          })
          .from(plannerTaskComment)
          .where(
            and(
              eq(plannerTaskComment.userId, userId),
              inArray(plannerTaskComment.taskId, chunk),
              isNull(plannerTaskComment.deletedAt),
            ),
          )
          .orderBy(asc(plannerTaskComment.createdAt))
          .limit(2_000)
          .all(),
      ),
    ).then((lists) => lists.flat()),
  ]);
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.flatMap((id): PlannerReviewTask[] => {
    const row = byId.get(id);
    const history = events.filter((event) => event.taskId === id);
    const title = row?.title ?? history.find((e) => e.taskTitle)?.taskTitle;
    if (!title) return [];
    // Notes first, then comments, within the task's budget.
    let left = input.chars;
    const take = (text: string) => {
      const kept = trimTo(text, Math.max(left, 0));
      left -= kept.length;
      return kept;
    };
    const notes = row?.notes?.trim() ? take(row.notes) : null;
    return [
      {
        title,
        status: !row || row.deletedAt ? "gone" : row.status,
        notes,
        comments: comments
          .filter((comment) => comment.taskId === id && comment.body.trim())
          .flatMap((comment) => {
            if (left <= 0) return [];
            return [{ at: comment.at, text: take(comment.body) }];
          }),
        history: history.map((event) => ({
          at: event.at,
          what: taskEventWhat(event.type, event.data ?? {}),
        })),
      },
    ];
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
