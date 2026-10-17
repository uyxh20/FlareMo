import {
  type PlannerEvidenceDto,
  type PlannerEvidenceSource,
  type PlannerGoalDto,
  type PlannerPeriodGoal,
  type PlannerPeriodLevel,
  type PlannerPeriodWeek,
  plannerAddDays,
  plannerIsoWeekOf,
  plannerPeriodEndOf,
  plannerPeriodMemoSource,
  plannerPeriodWeeks,
  plannerSummaryMemoClientId,
  plannerSummaryMemoSource,
  plannerSummaryMemoTag,
} from "@flaremo/contracts";
import type { FlareMoDb } from "@flaremo/db";
import { memoryItems, memos, memoTags, tasks } from "@flaremo/db";
import { healthEntry } from "@flaremo/db/src/schema/fork-health";
import {
  type PlannerEvidenceRow,
  type PlannerPeriodReviewRow,
  plannerEvidence,
  plannerPeriodReview,
  plannerTaskComment,
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
  isNull,
  lt,
  lte,
  ne,
  notInArray,
  sql,
} from "drizzle-orm";
import {
  plannerReadNorthStar,
  plannerReadPeriodGoals,
  plannerReadWeekGoals,
} from "./goals";
import {
  type PlannerDiaryEntry,
  plannerFitDiary,
  plannerWeekInstants,
} from "./review-context";

// What a month, quarter or year review reads (fork-owned add-on,
// docs/planning-cockpit-period-review.md): the period's weeks with their
// records and raw counts, the raw rows themselves (diary entries, health rows,
// done tasks) for the prompts and for checking receipts word for word, the
// goals of the level and the level below, the memories made and revised, and
// the last period's review. Nothing here writes.
//
// The raw rows are read whole once, grouped by week in the owner's own zone
// (plannerWeekInstants), and fitted to the model's budget per week; the whole
// text stays in memory for the receipt check (plannerVerifyQuote), which is
// what makes "verified" mean "these words exist in a row".

const LIVE_MEMO = and(
  isNull(memos.deletedAt),
  inArray(memos.status, ["normal", "archived"]),
);

/** Diary characters a large-context model reads per period review. */
export const PLANNER_PERIOD_DIARY_CHARS = 60_000;
/** Diary characters for a small-context model (Workers AI). */
export const PLANNER_PERIOD_DIARY_CHARS_SMALL = 9_000;

const FIRST_LINE_CHARS = 120;
const MEMORY_LINE_CHARS = 160;
const MEMORY_LINES_MAX = 16;
const SUMMARY_CHARS = 3_000;

/** One raw row a receipt can rest on. */
export type PlannerRawRow = {
  source: PlannerEvidenceSource;
  id: string;
  day: string;
  text: string;
};

export type PlannerPeriodWeekContext = PlannerPeriodWeek & {
  /** The week's summary memo, trimmed, when it has one. */
  summary: string | null;
  /** The week's diary entries fitted to this week's share of the budget. */
  diary: PlannerDiaryEntry[];
  /** The week's goals, with results. */
  goals: PlannerGoalDto[];
  /** Health rows of the week, one line each. */
  health: string[];
  /**
   * The tasks done in the week: the title, then the task's notes and its
   * comments (the owner's receipts on the task), trimmed.
   */
  done: string[];
};

/** Characters of a done task's notes and comments shown per task. */
const TASK_RECEIPT_CHARS = 240;

export type PlannerPeriodContext = {
  ownerName: string;
  level: PlannerPeriodLevel;
  periodStart: string;
  periodEnd: string;
  today: string;
  weeks: PlannerPeriodWeekContext[];
  goals: PlannerPeriodGoal[];
  childGoals: PlannerPeriodGoal[];
  northStar: PlannerPeriodGoal | null;
  previous: {
    periodStart: string;
    verdict: string | null;
    forecast: string | null;
    forecastGrade: "held" | "partly" | "missed" | null;
    memo: string | null;
  } | null;
  memories: {
    created: number;
    revised: number;
    createdLines: string[];
    revisedLines: string[];
  };
  /** Every raw row of the period, for the receipt check. */
  raw: PlannerRawRow[];
  row: PlannerPeriodReviewRow | null;
  evidence: PlannerEvidenceRow[];
  memo: { id: string; content: string } | null;
};

function weekOf(weeks: readonly string[], at: string): string | null {
  for (const monday of weeks) {
    const { from, to } = plannerWeekInstants(monday);
    if (at >= from && at < to) return monday;
  }
  return null;
}

function weekOfDay(weeks: readonly string[], day: string): string | null {
  for (const monday of weeks) {
    if (day >= monday && day <= plannerAddDays(monday, 6)) return monday;
  }
  return null;
}

function firstLine(text: string): string {
  const line =
    text
      .split("\n")
      .map((part) => part.trim())
      .find((part) => part && !part.startsWith("#")) ?? "";
  return line.length > FIRST_LINE_CHARS
    ? `${line.slice(0, FIRST_LINE_CHARS - 1)}…`
    : line;
}

function trimTo(text: string, max: number): string {
  const clean = text.trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** Ids per query: D1 binds at most 100 values. */
const CHUNK = 50;

async function readMemosById(
  db: FlareMoDb,
  userId: string,
  ids: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const unique = [...new Set(ids)];
  for (let start = 0; start < unique.length; start += CHUNK) {
    const rows = await db
      .select({ id: memos.id, content: memos.content })
      .from(memos)
      .where(
        and(
          eq(memos.userId, userId),
          inArray(memos.id, unique.slice(start, start + CHUNK)),
          LIVE_MEMO,
        ),
      )
      .all();
    for (const row of rows) out.set(row.id, row.content);
  }
  return out;
}

/**
 * The summary memo of each week, by Monday: the week record's memo, else the
 * one the weekly review wrote (client id), else an imported summary whose
 * title names the ISO week. Three queries for the whole period.
 */
async function readSummaries(
  db: FlareMoDb,
  userId: string,
  weeks: readonly string[],
  records: ReadonlyMap<string, { memoId: string | null }>,
): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const clientIds = weeks.map(plannerSummaryMemoClientId);
  for (let start = 0; start < clientIds.length; start += CHUNK) {
    const rows = await db
      .select({ id: memos.id, clientId: memos.clientId })
      .from(memos)
      .where(
        and(
          eq(memos.userId, userId),
          inArray(memos.clientId, clientIds.slice(start, start + CHUNK)),
          LIVE_MEMO,
        ),
      )
      .all();
    for (const row of rows) {
      const monday = weeks.find(
        (week) => plannerSummaryMemoClientId(week) === row.clientId,
      );
      if (monday) found.set(monday, row.id);
    }
  }
  for (const monday of weeks) {
    const record = records.get(monday);
    if (record?.memoId) found.set(monday, record.memoId);
  }
  const missing = weeks.filter((monday) => !found.has(monday));
  if (missing.length > 0) {
    const heads = await db
      .select({
        id: memos.id,
        head: sql<string>`substr(${memos.content}, 1, 200)`,
      })
      .from(memoTags)
      .innerJoin(memos, eq(memos.id, memoTags.memoId))
      .where(
        and(
          eq(memoTags.userId, userId),
          eq(memoTags.tag, plannerSummaryMemoTag),
          eq(memos.userId, userId),
          LIVE_MEMO,
        ),
      )
      .orderBy(desc(memos.updatedAt))
      .limit(400)
      .all();
    const titled = heads.flatMap((row) => {
      const line =
        row.head
          .split("\n")
          .find((part) => part.trim())
          ?.trim() ?? "";
      const match = /^#\s*Week\s+(\d{1,2})\b(.*)$/i.exec(line);
      if (!match?.[1]) return [];
      const years = [...(match[2] ?? "").matchAll(/\b(\d{4})\b/g)].map((y) =>
        Number(y[1]),
      );
      const year = years.at(-1);
      return year ? [{ id: row.id, week: Number(match[1]), year }] : [];
    });
    for (const monday of missing) {
      const target = plannerIsoWeekOf(monday);
      const hit = titled.find(
        (entry) => entry.week === target.week && entry.year === target.year,
      );
      if (hit) found.set(monday, hit.id);
    }
  }
  return found;
}

/**
 * Reads everything a period review's prompts and page need. `diaryChars` is
 * the whole period's diary budget for the model; the raw text is kept whole
 * for the receipt check either way.
 */
export async function plannerReadPeriodContext(
  db: FlareMoDb,
  input: {
    userId: string;
    ownerName: string;
    level: PlannerPeriodLevel;
    periodStart: string;
    today: string;
    diaryChars?: number;
  },
): Promise<PlannerPeriodContext> {
  const { userId, level, periodStart } = input;
  const periodEnd = plannerPeriodEndOf(level, periodStart);
  const weeks = plannerPeriodWeeks(level, periodStart);
  const first = weeks[0] ?? periodStart;
  const last = weeks.at(-1) ?? periodStart;
  const from = plannerWeekInstants(first).from;
  const to = plannerWeekInstants(last).to;
  const budget = input.diaryChars ?? PLANNER_PERIOD_DIARY_CHARS_SMALL;
  const perWeek = Math.max(600, Math.floor(budget / Math.max(1, weeks.length)));

  const summariesByTag = db
    .select({ id: memoTags.memoId })
    .from(memoTags)
    .where(
      and(eq(memoTags.userId, userId), eq(memoTags.tag, plannerSummaryMemoTag)),
    );

  const [
    weekRows,
    diaryRows,
    healthRows,
    doneRows,
    goals,
    childGoals,
    northStar,
    createdMemories,
    revisedMemories,
    row,
    evidenceRows,
    previousRows,
  ] = await Promise.all([
    db
      .select()
      .from(plannerWeek)
      .where(
        and(
          eq(plannerWeek.userId, userId),
          gte(plannerWeek.weekStart, first),
          lte(plannerWeek.weekStart, last),
        ),
      )
      .all(),
    db
      .select({ id: memos.id, at: memos.createdAt, content: memos.content })
      .from(memos)
      .where(
        and(
          eq(memos.userId, userId),
          LIVE_MEMO,
          gte(memos.createdAt, from),
          lt(memos.createdAt, to),
          ne(memos.source, plannerSummaryMemoSource),
          ne(memos.source, plannerPeriodMemoSource),
          notInArray(memos.id, summariesByTag),
        ),
      )
      .orderBy(asc(memos.createdAt))
      .limit(2_000)
      .all(),
    db
      .select({
        id: healthEntry.id,
        kind: healthEntry.kind,
        day: healthEntry.day,
        variant: healthEntry.variant,
        minutes: healthEntry.minutes,
        units: healthEntry.units,
        feel: healthEntry.feel,
      })
      .from(healthEntry)
      .where(
        and(
          eq(healthEntry.userId, userId),
          isNull(healthEntry.deletedAt),
          eq(healthEntry.dismissed, false),
          gte(healthEntry.day, first),
          lte(healthEntry.day, plannerAddDays(last, 6)),
        ),
      )
      .orderBy(asc(healthEntry.day))
      .limit(2_000)
      .all(),
    db
      .select({
        id: tasks.id,
        title: tasks.title,
        notes: tasks.notes,
        completedAt: tasks.completedAt,
      })
      .from(tasks)
      .where(
        and(
          eq(tasks.userId, userId),
          eq(tasks.status, "done"),
          isNull(tasks.deletedAt),
          gte(tasks.completedAt, from),
          lt(tasks.completedAt, to),
        ),
      )
      .orderBy(asc(tasks.completedAt))
      .limit(2_000)
      .all(),
    plannerReadPeriodGoals(db, { userId, level, periodStart }),
    readChildGoals(db, userId, level, periodStart),
    plannerReadNorthStar(db, userId),
    db
      .select({ content: memoryItems.content })
      .from(memoryItems)
      .where(
        and(
          eq(memoryItems.userId, userId),
          eq(memoryItems.status, "active"),
          isNull(memoryItems.deletedAt),
          isNull(memoryItems.rejectedAt),
          gte(memoryItems.createdAt, from),
          lt(memoryItems.createdAt, to),
        ),
      )
      .orderBy(desc(memoryItems.importance))
      .limit(200)
      .all(),
    db
      .select({ content: memoryItems.content })
      .from(memoryItems)
      .where(
        and(
          eq(memoryItems.userId, userId),
          eq(memoryItems.status, "active"),
          isNull(memoryItems.deletedAt),
          isNull(memoryItems.rejectedAt),
          lt(memoryItems.createdAt, from),
          gte(memoryItems.updatedAt, from),
          lt(memoryItems.updatedAt, to),
        ),
      )
      .orderBy(desc(memoryItems.importance))
      .limit(200)
      .all(),
    db
      .select()
      .from(plannerPeriodReview)
      .where(
        and(
          eq(plannerPeriodReview.userId, userId),
          eq(plannerPeriodReview.level, level),
          eq(plannerPeriodReview.periodStart, periodStart),
        ),
      )
      .get(),
    db
      .select()
      .from(plannerEvidence)
      .where(
        and(
          eq(plannerEvidence.userId, userId),
          eq(plannerEvidence.level, level),
          eq(plannerEvidence.periodStart, periodStart),
        ),
      )
      .orderBy(asc(plannerEvidence.createdAt))
      .all(),
    db
      .select()
      .from(plannerPeriodReview)
      .where(
        and(
          eq(plannerPeriodReview.userId, userId),
          eq(plannerPeriodReview.level, level),
          lt(plannerPeriodReview.periodStart, periodStart),
        ),
      )
      .orderBy(desc(plannerPeriodReview.periodStart))
      .limit(1)
      .all(),
  ]);

  const records = new Map(weekRows.map((week) => [week.weekStart, week]));
  const summaryIds = await readSummaries(db, userId, weeks, records);
  const previous = previousRows[0] ?? null;
  const memoIds = [
    ...summaryIds.values(),
    ...(row?.memoId ? [row.memoId] : []),
    ...(previous?.memoId ? [previous.memoId] : []),
  ];
  const memoText = await readMemosById(db, userId, memoIds);

  const weekGoals = new Map<string, PlannerGoalDto[]>();
  await Promise.all(
    weeks.map(async (monday) => {
      weekGoals.set(
        monday,
        await plannerReadWeekGoals(db, { userId, weekStart: monday }),
      );
    }),
  );

  const linked = await readLinkedTasks(db, userId, [
    ...goals.map((goal) => goal.id),
    ...childGoals.map((goal) => goal.id),
    ...(northStar ? [northStar.id] : []),
  ]);

  const raw: PlannerRawRow[] = [];
  const byWeek = new Map<
    string,
    {
      diary: Array<{ at: string; content: string }>;
      health: typeof healthRows;
      done: string[];
    }
  >(weeks.map((monday) => [monday, { diary: [], health: [], done: [] }]));
  for (const entry of diaryRows) {
    raw.push({
      source: "memo",
      id: entry.id,
      day: entry.at.slice(0, 10),
      text: entry.content,
    });
    const monday = weekOf(weeks, entry.at);
    if (monday) byWeek.get(monday)?.diary.push(entry);
  }
  for (const entry of healthRows) {
    if (entry.feel?.trim()) {
      raw.push({
        source: "health",
        id: entry.id,
        day: entry.day,
        text: entry.feel,
      });
    }
    const monday = weekOfDay(weeks, entry.day);
    if (monday) byWeek.get(monday)?.health.push(entry);
  }
  // The owner's receipts on a task: its notes and its comments. Each is a raw
  // row of its own, so a receipt can quote it, and the week's done line carries
  // them trimmed.
  const comments = await readTaskComments(
    db,
    userId,
    doneRows.map((task) => task.id),
  );
  for (const task of doneRows) {
    const day = (task.completedAt ?? "").slice(0, 10);
    raw.push({ source: "task_event", id: task.id, day, text: task.title });
    const receipts: string[] = [];
    if (task.notes?.trim()) {
      raw.push({ source: "task_event", id: task.id, day, text: task.notes });
      receipts.push(task.notes.trim());
    }
    for (const comment of comments.get(task.id) ?? []) {
      raw.push({
        source: "task_event",
        id: task.id,
        day: comment.createdAt.slice(0, 10),
        text: comment.body,
      });
      receipts.push(comment.body.trim());
    }
    const line = receipts.length
      ? `${task.title} (${trimTo(receipts.join(" / "), TASK_RECEIPT_CHARS)})`
      : task.title;
    const monday = task.completedAt ? weekOf(weeks, task.completedAt) : null;
    if (monday) byWeek.get(monday)?.done.push(line);
  }
  for (const week of weekRows) {
    for (const text of [week.question, week.verdict, week.note]) {
      if (text?.trim()) {
        raw.push({
          source: "week",
          id: week.weekStart,
          day: week.weekStart,
          text,
        });
      }
    }
  }

  const weekContexts: PlannerPeriodWeekContext[] = weeks.map((monday) => {
    const record = records.get(monday);
    const bucket = byWeek.get(monday) ?? { diary: [], health: [], done: [] };
    const goalsOfWeek = weekGoals.get(monday) ?? [];
    const summaryId = summaryIds.get(monday) ?? null;
    const summary = summaryId ? (memoText.get(summaryId) ?? null) : null;
    const trainingDays = new Set(
      bucket.health
        .filter((entry) => entry.kind === "training")
        .map((entry) => entry.day),
    );
    const breathDays = new Set(
      bucket.health
        .filter((entry) => entry.kind === "breath")
        .map((entry) => entry.day),
    );
    const nightsOut = bucket.health.filter(
      (entry) => entry.kind === "night_out",
    ).length;
    return {
      week_start: monday,
      number: plannerIsoWeekOf(monday).week,
      auth: record?.auth ?? null,
      ach: record?.ach ?? null,
      question: record?.question ?? null,
      verdict: record?.verdict ?? null,
      memo_id: summaryId,
      entries: bucket.diary.length,
      entry_chars: bucket.diary.reduce(
        (sum, entry) => sum + entry.content.length,
        0,
      ),
      health_rows: bucket.health.length,
      training: trainingDays.size,
      breath_days: breathDays.size,
      nights_out: nightsOut,
      tasks_done: bucket.done.length,
      goal_results: {
        met: goalsOfWeek.filter((goal) => goal.result === "met").length,
        partial: goalsOfWeek.filter((goal) => goal.result === "partial").length,
        missed: goalsOfWeek.filter((goal) => goal.result === "missed").length,
        open: goalsOfWeek.filter((goal) => !goal.result).length,
      },
      first_lines: bucket.diary.map((entry) => firstLine(entry.content)),
      summary: summary ? trimTo(summary, SUMMARY_CHARS) : null,
      diary: plannerFitDiary(bucket.diary, perWeek),
      goals: goalsOfWeek,
      health: bucket.health.map((entry) =>
        [
          entry.day,
          entry.kind,
          entry.variant ?? "",
          entry.minutes ? `${entry.minutes} min` : "",
          entry.units ? `${entry.units} units` : "",
          entry.feel ? trimTo(entry.feel, 120) : "",
        ]
          .filter(Boolean)
          .join(" · "),
      ),
      done: bucket.done,
    };
  });

  const toPeriodGoal = (goal: PlannerGoalDto): PlannerPeriodGoal => ({
    id: goal.id,
    level: goal.level,
    period_start: goal.period_start,
    pillar: goal.pillar,
    title: goal.title,
    lines: goal.lines,
    status: goal.status,
    note: goal.note,
    result: goal.result,
    tasks_linked: linked.get(goal.id)?.linked ?? 0,
    tasks_done: linked.get(goal.id)?.done ?? 0,
  });

  return {
    ownerName: input.ownerName,
    level,
    periodStart,
    periodEnd,
    today: input.today,
    weeks: weekContexts,
    goals: goals.map(toPeriodGoal),
    childGoals: childGoals.map(toPeriodGoal),
    northStar: northStar ? toPeriodGoal(northStar) : null,
    previous: previous
      ? {
          periodStart: previous.periodStart,
          verdict: previous.verdict,
          forecast: previous.forecast,
          forecastGrade: previous.forecastGrade,
          memo: previous.memoId
            ? trimTo(memoText.get(previous.memoId) ?? "", SUMMARY_CHARS) || null
            : null,
        }
      : null,
    memories: {
      created: createdMemories.length,
      revised: revisedMemories.length,
      createdLines: createdMemories
        .slice(0, MEMORY_LINES_MAX)
        .map((memory) => trimTo(memory.content, MEMORY_LINE_CHARS)),
      revisedLines: revisedMemories
        .slice(0, MEMORY_LINES_MAX)
        .map((memory) => trimTo(memory.content, MEMORY_LINE_CHARS)),
    },
    raw,
    row: row ?? null,
    evidence: evidenceRows,
    memo:
      row?.memoId && memoText.has(row.memoId)
        ? { id: row.memoId, content: memoText.get(row.memoId) as string }
        : null,
  };
}

/** The goals of the level below inside the period: a quarter's months, a year's quarters. */
async function readChildGoals(
  db: FlareMoDb,
  userId: string,
  level: PlannerPeriodLevel,
  periodStart: string,
): Promise<PlannerGoalDto[]> {
  if (level === "month") return [];
  const year = periodStart.slice(0, 4);
  const month = Number(periodStart.slice(5, 7));
  const starts =
    level === "quarter"
      ? [month, month + 1, month + 2].map(
          (m) => `${year}-${String(m).padStart(2, "0")}-01`,
        )
      : ["01", "04", "07", "10"].map((m) => `${year}-${m}-01`);
  const childLevel = level === "quarter" ? "month" : "quarter";
  const lists = await Promise.all(
    starts.map((start) =>
      plannerReadPeriodGoals(db, {
        userId,
        level: childLevel,
        periodStart: start,
      }),
    ),
  );
  return lists.flat();
}

/** The live comments on the given tasks, oldest first, by task id. */
async function readTaskComments(
  db: FlareMoDb,
  userId: string,
  taskIds: readonly string[],
): Promise<Map<string, Array<{ body: string; createdAt: string }>>> {
  const out = new Map<string, Array<{ body: string; createdAt: string }>>();
  const ids = [...new Set(taskIds)].filter(Boolean);
  for (let start = 0; start < ids.length; start += CHUNK) {
    const rows = await db
      .select({
        taskId: plannerTaskComment.taskId,
        body: plannerTaskComment.body,
        createdAt: plannerTaskComment.createdAt,
      })
      .from(plannerTaskComment)
      .where(
        and(
          eq(plannerTaskComment.userId, userId),
          inArray(plannerTaskComment.taskId, ids.slice(start, start + CHUNK)),
          isNull(plannerTaskComment.deletedAt),
        ),
      )
      .orderBy(asc(plannerTaskComment.createdAt))
      .limit(2_000)
      .all();
    for (const row of rows) {
      if (!row.body.trim()) continue;
      const list = out.get(row.taskId) ?? [];
      list.push({ body: row.body, createdAt: row.createdAt });
      out.set(row.taskId, list);
    }
  }
  return out;
}

/** How many tasks each goal has linked, and how many of those are done. */
async function readLinkedTasks(
  db: FlareMoDb,
  userId: string,
  goalIds: readonly string[],
): Promise<Map<string, { linked: number; done: number }>> {
  const out = new Map<string, { linked: number; done: number }>();
  const ids = [...new Set(goalIds)].filter(Boolean);
  for (let start = 0; start < ids.length; start += CHUNK) {
    const rows = await db
      .select({ goalId: plannerTaskPlan.goalId, status: tasks.status })
      .from(plannerTaskPlan)
      .innerJoin(tasks, eq(tasks.id, plannerTaskPlan.taskId))
      .where(
        and(
          eq(plannerTaskPlan.userId, userId),
          inArray(plannerTaskPlan.goalId, ids.slice(start, start + CHUNK)),
          isNull(tasks.deletedAt),
        ),
      )
      .all();
    for (const row of rows) {
      if (!row.goalId) continue;
      const count = out.get(row.goalId) ?? { linked: 0, done: 0 };
      count.linked += 1;
      if (row.status === "done") count.done += 1;
      out.set(row.goalId, count);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Receipts
// ---------------------------------------------------------------------------

function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/[.,;:!?"'()[\]*_`~#>-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The shortest quote the check accepts, in characters after normalising. */
const QUOTE_MIN = 12;

/**
 * Whether `quote` exists word for word in one of the period's raw rows. Case,
 * punctuation and spacing are ignored; the words and their order are not. The
 * first row that holds it is the receipt's source.
 */
export function plannerVerifyQuote(
  quote: string,
  raw: readonly PlannerRawRow[],
): { verified: boolean; source: PlannerRawRow | null } {
  const needle = normalise(quote);
  if (needle.length < QUOTE_MIN) return { verified: false, source: null };
  for (const row of raw) {
    if (normalise(row.text).includes(needle)) {
      return { verified: true, source: row };
    }
  }
  return { verified: false, source: null };
}

export function plannerEvidenceToDto(
  row: PlannerEvidenceRow,
): PlannerEvidenceDto {
  return {
    id: row.id,
    pillar: row.pillar,
    claim: row.claim,
    quote: row.quote,
    source: row.source,
    source_id: row.sourceId,
    source_day: row.sourceDay,
    verified: row.verified === 1,
  };
}
