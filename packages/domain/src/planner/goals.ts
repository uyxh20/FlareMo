import {
  type PlannerCockpitWeek,
  type PlannerGoalDto,
  type PlannerGoalLevel,
  type PlannerGoalLine,
  type PlannerGoalResult,
  type PlannerGoalStatus,
  type PlannerGoalsYearResponse,
  type PlannerPillar,
  type PlannerWeekDto,
  plannerAddDays,
  plannerIsMonday,
  plannerIsoYearMondays,
  plannerMonthStartOf,
  plannerPillars,
  plannerQuarterStartOf,
  plannerWeekday,
  plannerWeekStartOf,
} from "@flaremo/contracts";
import type { FlareMoDb, UserRow } from "@flaremo/db";
import {
  type PlannerGoalRow,
  type PlannerWeekRow,
  plannerGoal,
  plannerTaskPlan,
  plannerWeek,
} from "@flaremo/db/src/schema/planner";
import { and, eq, gte, inArray, isNull, lte, or } from "drizzle-orm";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import {
  type PlannerActor,
  plannerEventStatement,
  plannerLoadLiveTask,
  plannerLoadPlan,
  plannerNormalizeTaskId,
  plannerNow,
  plannerRequireDay,
  plannerRunBatch,
} from "./shared";

// Goals, from the north star down to a week, and the record of each reviewed
// week (fork-owned add-on, docs/planning-cockpit-goals-review.md; migration 9005).
//
// Goals are the owner's own words: a title, lines under it, an objective tag, a
// status and, once judged, a result. They are soft-deleted, so a task's link and
// a conflict flag can still name a goal that was removed. A task serves a weekly
// goal through `planner_task_plan.goal_id`, written with a `goal_changed` event in
// the same batch, like the effort and the start date.

const LEVEL_ORDER: Record<PlannerGoalLevel, number> = {
  north_star: 0,
  year: 1,
  quarter: 2,
  month: 3,
  week: 4,
};

/** A period's theme line (no objective) first, then the objectives in order. */
function pillarOrder(pillar: PlannerPillar | null): number {
  return pillar === null ? -1 : plannerPillars.indexOf(pillar);
}

/** Level, period, objective, the owner's order, then creation. */
export function plannerCompareGoals(
  left: PlannerGoalDto,
  right: PlannerGoalDto,
): number {
  return (
    LEVEL_ORDER[left.level] - LEVEL_ORDER[right.level] ||
    (left.period_start ?? "").localeCompare(right.period_start ?? "") ||
    pillarOrder(left.pillar) - pillarOrder(right.pillar) ||
    left.sort_order - right.sort_order ||
    left.created_at.localeCompare(right.created_at) ||
    left.id.localeCompare(right.id)
  );
}

function cleanLines(lines: unknown): PlannerGoalLine[] {
  if (!Array.isArray(lines)) return [];
  return lines.flatMap((line) => {
    if (!line || typeof line !== "object") return [];
    const { text, note, struck } = line as Record<string, unknown>;
    if (typeof text !== "string" || !text.trim()) return [];
    return [
      {
        text: text.trim(),
        ...(typeof note === "string" && note.trim()
          ? { note: note.trim() }
          : {}),
        ...(struck === true ? { struck: true } : {}),
      },
    ];
  });
}

export function plannerGoalToDto(row: PlannerGoalRow): PlannerGoalDto {
  return {
    id: row.id,
    level: row.level,
    period_start: row.periodStart ?? null,
    pillar: row.pillar ?? null,
    title: row.title,
    lines: cleanLines(row.lines),
    status: row.status,
    note: row.note ?? null,
    result: row.result ?? null,
    sort_order: row.sortOrder,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

export function plannerWeekToDto(row: PlannerWeekRow): PlannerWeekDto {
  return {
    week_start: row.weekStart,
    auth: row.auth ?? null,
    ach: row.ach ?? null,
    note: row.note ?? null,
    question: row.question ?? null,
    verdict: row.verdict ?? null,
    memo_id: row.memoId ?? null,
    source: row.source,
    reviewed_at: row.reviewedAt ?? null,
  };
}

/**
 * The first day of the period of `level` that holds `day`: 1 January, the
 * quarter's or month's first day, or the Monday. Null for the north star.
 */
export function plannerGoalPeriodStart(
  level: PlannerGoalLevel,
  day: string | null | undefined,
): string | null {
  if (level === "north_star") return null;
  const valid = plannerRequireDay(day, "period_start");
  switch (level) {
    case "year":
      return `${valid.slice(0, 4)}-01-01`;
    case "quarter":
      return plannerQuarterStartOf(valid);
    case "month":
      return plannerMonthStartOf(valid);
    case "week":
      return plannerWeekStartOf(valid);
    default:
      throw new ValidationError(`Unknown goal level: ${String(level)}`);
  }
}

/** One of the caller's live goals, or a 404. */
async function loadGoal(
  db: FlareMoDb,
  userId: string,
  goalId: string,
): Promise<PlannerGoalRow> {
  const row = await db
    .select()
    .from(plannerGoal)
    .where(
      and(
        eq(plannerGoal.id, goalId),
        eq(plannerGoal.userId, userId),
        isNull(plannerGoal.deletedAt),
      ),
    )
    .get();
  if (!row) throw new NotFoundError(`Goal not found: ${goalId}`);
  return row;
}

export type PlannerGoalInput = {
  id?: string;
  level: PlannerGoalLevel;
  periodStart?: string | null;
  pillar?: PlannerPillar | null;
  title?: string;
  lines?: PlannerGoalLine[];
  status?: PlannerGoalStatus;
  note?: string | null;
  result?: PlannerGoalResult | null;
  sortOrder?: number;
};

/**
 * Creates a goal. A client may name it with its own UUID: creating the same id
 * again returns the goal as it is, so a retried request is harmless. The period
 * is moved to its first day.
 */
export async function plannerCreateGoal(
  db: FlareMoDb,
  input: { userId: string; goal: PlannerGoalInput; now?: Date },
): Promise<PlannerGoalDto> {
  const { goal } = input;
  const title = (goal.title ?? "").trim();
  const lines = cleanLines(goal.lines ?? []);
  if (!title && lines.length === 0) {
    throw new ValidationError("A goal needs a title or a line.");
  }
  const periodStart = plannerGoalPeriodStart(goal.level, goal.periodStart);
  const id = goal.id ?? crypto.randomUUID();
  const nowIso = plannerNow(input.now).toISOString();
  await plannerRunBatch(db, [
    db
      .insert(plannerGoal)
      .values({
        id,
        userId: input.userId,
        level: goal.level,
        periodStart,
        pillar: goal.pillar ?? null,
        title,
        lines,
        status: goal.status ?? "active",
        note: goal.note?.trim() || null,
        result: goal.result ?? null,
        sortOrder: goal.sortOrder ?? 0,
        createdAt: nowIso,
        updatedAt: nowIso,
      })
      .onConflictDoNothing(),
  ]);
  const row = await db
    .select()
    .from(plannerGoal)
    .where(eq(plannerGoal.id, id))
    .get();
  if (!row || row.userId !== input.userId) {
    throw new ConflictError("That goal id is already in use.");
  }
  if (row.deletedAt) throw new NotFoundError(`Goal not found: ${id}`);
  return plannerGoalToDto(row);
}

export type PlannerGoalPatch = {
  pillar?: PlannerPillar | null;
  title?: string;
  lines?: PlannerGoalLine[];
  status?: PlannerGoalStatus;
  note?: string | null;
  result?: PlannerGoalResult | null;
  sortOrder?: number;
};

/** Changes a goal's fields; an omitted field is unchanged and null clears one. */
export async function plannerUpdateGoal(
  db: FlareMoDb,
  input: {
    userId: string;
    goalId: string;
    patch: PlannerGoalPatch;
    now?: Date;
  },
): Promise<PlannerGoalDto> {
  const existing = await loadGoal(db, input.userId, input.goalId);
  const { patch } = input;
  const title = patch.title !== undefined ? patch.title.trim() : existing.title;
  const lines =
    patch.lines !== undefined
      ? cleanLines(patch.lines)
      : cleanLines(existing.lines);
  if (!title && lines.length === 0) {
    throw new ValidationError("A goal needs a title or a line.");
  }
  const nowIso = plannerNow(input.now).toISOString();
  await plannerRunBatch(db, [
    db
      .update(plannerGoal)
      .set({
        ...(patch.pillar !== undefined ? { pillar: patch.pillar } : {}),
        title,
        lines,
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.note !== undefined
          ? { note: patch.note?.trim() || null }
          : {}),
        ...(patch.result !== undefined ? { result: patch.result } : {}),
        ...(patch.sortOrder !== undefined
          ? { sortOrder: patch.sortOrder }
          : {}),
        updatedAt: nowIso,
      })
      .where(
        and(
          eq(plannerGoal.id, existing.id),
          eq(plannerGoal.userId, input.userId),
        ),
      ),
  ]);
  return plannerGoalToDto(await loadGoal(db, input.userId, existing.id));
}

/** Removes a goal (soft delete). Tasks and flags that name it keep the id. */
export async function plannerDeleteGoal(
  db: FlareMoDb,
  input: { userId: string; goalId: string; now?: Date },
): Promise<void> {
  const existing = await loadGoal(db, input.userId, input.goalId);
  const nowIso = plannerNow(input.now).toISOString();
  await plannerRunBatch(db, [
    db
      .update(plannerGoal)
      .set({ deletedAt: nowIso, updatedAt: nowIso })
      .where(
        and(
          eq(plannerGoal.id, existing.id),
          eq(plannerGoal.userId, input.userId),
        ),
      ),
  ]);
}

/** The newest live north star, or null. */
export async function plannerReadNorthStar(
  db: FlareMoDb,
  userId: string,
): Promise<PlannerGoalDto | null> {
  const rows = await db
    .select()
    .from(plannerGoal)
    .where(
      and(
        eq(plannerGoal.userId, userId),
        eq(plannerGoal.level, "north_star"),
        isNull(plannerGoal.deletedAt),
      ),
    )
    .all();
  const newest = rows.sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  )[0];
  return newest ? plannerGoalToDto(newest) : null;
}

/** The live goals of one level and period, in display order. */
export async function plannerReadPeriodGoals(
  db: FlareMoDb,
  input: { userId: string; level: PlannerGoalLevel; periodStart: string },
): Promise<PlannerGoalDto[]> {
  const rows = await db
    .select()
    .from(plannerGoal)
    .where(
      and(
        eq(plannerGoal.userId, input.userId),
        eq(plannerGoal.level, input.level),
        eq(plannerGoal.periodStart, input.periodStart),
        isNull(plannerGoal.deletedAt),
      ),
    )
    .all();
  return rows.map(plannerGoalToDto).sort(plannerCompareGoals);
}

/** The weekly goals of the week that starts on `weekStart`. */
export function plannerReadWeekGoals(
  db: FlareMoDb,
  input: { userId: string; weekStart: string },
): Promise<PlannerGoalDto[]> {
  return plannerReadPeriodGoals(db, {
    userId: input.userId,
    level: "week",
    periodStart: input.weekStart,
  });
}

/** Goals by id, removed ones included (a flag can name a goal that is gone). */
export async function plannerReadGoalsById(
  db: FlareMoDb,
  input: { userId: string; ids: readonly string[] },
): Promise<PlannerGoalDto[]> {
  const ids = [...new Set(input.ids)].filter(Boolean);
  if (ids.length === 0) return [];
  const rows = await db
    .select()
    .from(plannerGoal)
    .where(
      and(eq(plannerGoal.userId, input.userId), inArray(plannerGoal.id, ids)),
    )
    .all();
  return rows.map(plannerGoalToDto).sort(plannerCompareGoals);
}

/**
 * Everything the Goals page draws for one ISO year: the north star, the year,
 * quarter and month goals of the calendar year, the weekly goals of the ISO
 * year's weeks, and every recorded week of those weeks.
 */
export async function plannerReadGoalsYear(
  db: FlareMoDb,
  input: { userId: string; year: number; today: string },
): Promise<PlannerGoalsYearResponse> {
  const today = plannerRequireDay(input.today, "today");
  if (!Number.isInteger(input.year) || input.year < 1000 || input.year > 9998) {
    throw new ValidationError("year must be a four-digit year.");
  }
  const mondays = plannerIsoYearMondays(input.year);
  const firstWeek = mondays[0] as string;
  const lastWeek = mondays.at(-1) as string;
  const yearFrom = `${input.year}-01-01`;
  const yearTo = `${input.year}-12-31`;

  const [goalRows, weekRows, northStar] = await Promise.all([
    db
      .select()
      .from(plannerGoal)
      .where(
        and(
          eq(plannerGoal.userId, input.userId),
          isNull(plannerGoal.deletedAt),
          or(
            and(
              inArray(plannerGoal.level, ["year", "quarter", "month"]),
              gte(plannerGoal.periodStart, yearFrom),
              lte(plannerGoal.periodStart, yearTo),
            ),
            and(
              eq(plannerGoal.level, "week"),
              gte(plannerGoal.periodStart, firstWeek),
              lte(plannerGoal.periodStart, lastWeek),
            ),
          ),
        ),
      )
      .all(),
    db
      .select()
      .from(plannerWeek)
      .where(
        and(
          eq(plannerWeek.userId, input.userId),
          gte(plannerWeek.weekStart, firstWeek),
          lte(plannerWeek.weekStart, lastWeek),
        ),
      )
      .all(),
    plannerReadNorthStar(db, input.userId),
  ]);

  return {
    year: input.year,
    today,
    current_week: plannerWeekStartOf(today),
    north_star: northStar,
    goals: goalRows.map(plannerGoalToDto).sort(plannerCompareGoals),
    weeks: weekRows
      .map(plannerWeekToDto)
      .sort((left, right) => left.week_start.localeCompare(right.week_start)),
  };
}

/**
 * The week the cockpit's goal cards show, with its weekly goals: the current
 * week, except at the weekend once the next week has been planned, so saving the
 * plan on Sunday refills the cockpit at once.
 */
export async function plannerReadCockpitWeek(
  db: FlareMoDb,
  input: { userId: string; today: string },
): Promise<PlannerCockpitWeek> {
  const today = plannerRequireDay(input.today, "today");
  const current = plannerWeekStartOf(today);
  const weekday = plannerWeekday(today);
  if (weekday === 0 || weekday === 6) {
    const next = plannerAddDays(current, 7);
    const goals = await plannerReadWeekGoals(db, {
      userId: input.userId,
      weekStart: next,
    });
    if (goals.length > 0) return { start: next, goals };
  }
  return {
    start: current,
    goals: await plannerReadWeekGoals(db, {
      userId: input.userId,
      weekStart: current,
    }),
  };
}

/** A Monday, or a 400. */
export function plannerRequireMonday(value: unknown, label: string): string {
  if (!plannerIsMonday(value)) {
    throw new ValidationError(`${label} must be the Monday of a week.`);
  }
  return value;
}

export type PlannerWeekPatch = {
  auth?: number | null;
  ach?: number | null;
  note?: string | null;
  question?: string | null;
  verdict?: string | null;
  memoId?: string | null;
  source?: "review" | "import";
  reviewedAt?: string | null;
};

/** The record of one week, or null when nothing was recorded. */
export async function plannerReadWeek(
  db: FlareMoDb,
  input: { userId: string; weekStart: string },
): Promise<PlannerWeekDto | null> {
  const row = await db
    .select()
    .from(plannerWeek)
    .where(
      and(
        eq(plannerWeek.userId, input.userId),
        eq(plannerWeek.weekStart, input.weekStart),
      ),
    )
    .get();
  return row ? plannerWeekToDto(row) : null;
}

/** The statement that writes a week's record; only the fields given change. */
export function plannerWeekUpsertStatement(
  db: FlareMoDb,
  input: {
    userId: string;
    weekStart: string;
    patch: PlannerWeekPatch;
    nowIso: string;
  },
) {
  const { patch } = input;
  const set = {
    ...(patch.auth !== undefined ? { auth: patch.auth } : {}),
    ...(patch.ach !== undefined ? { ach: patch.ach } : {}),
    ...(patch.note !== undefined ? { note: patch.note?.trim() || null } : {}),
    ...(patch.question !== undefined
      ? { question: patch.question?.trim() || null }
      : {}),
    ...(patch.verdict !== undefined
      ? { verdict: patch.verdict?.trim() || null }
      : {}),
    ...(patch.memoId !== undefined ? { memoId: patch.memoId } : {}),
    ...(patch.source !== undefined ? { source: patch.source } : {}),
    ...(patch.reviewedAt !== undefined ? { reviewedAt: patch.reviewedAt } : {}),
    updatedAt: input.nowIso,
  };
  return db
    .insert(plannerWeek)
    .values({
      userId: input.userId,
      weekStart: input.weekStart,
      auth: patch.auth ?? null,
      ach: patch.ach ?? null,
      note: patch.note?.trim() || null,
      question: patch.question?.trim() || null,
      verdict: patch.verdict?.trim() || null,
      memoId: patch.memoId ?? null,
      source: patch.source ?? "review",
      reviewedAt: patch.reviewedAt ?? null,
      createdAt: input.nowIso,
      updatedAt: input.nowIso,
    })
    .onConflictDoUpdate({
      target: [plannerWeek.userId, plannerWeek.weekStart],
      set,
    });
}

/** Writes a week's record (scores, the next review's question, the memo). */
export async function plannerUpsertWeek(
  db: FlareMoDb,
  input: {
    userId: string;
    weekStart: string;
    patch: PlannerWeekPatch;
    now?: Date;
  },
): Promise<PlannerWeekDto> {
  const weekStart = plannerRequireMonday(input.weekStart, "The week");
  await plannerRunBatch(db, [
    plannerWeekUpsertStatement(db, {
      userId: input.userId,
      weekStart,
      patch: input.patch,
      nowIso: plannerNow(input.now).toISOString(),
    }),
  ]);
  const week = await plannerReadWeek(db, { userId: input.userId, weekStart });
  if (!week) throw new NotFoundError("The week could not be read back.");
  return week;
}

/**
 * Links a task to a weekly goal (`goalId`) or unlinks it (null), with a
 * `goal_changed` event `{from, to}` in the same batch. A task with no plan row
 * gets one with a NULL horizon, which plans nothing. Returns whether anything
 * changed. The goal must be one of the caller's live goals.
 */
export async function plannerSetTaskGoal(
  db: FlareMoDb,
  input: {
    user: UserRow;
    actor: PlannerActor;
    taskId: string;
    goalId: string | null;
    now?: Date;
  },
): Promise<boolean> {
  const taskId = plannerNormalizeTaskId(input.taskId);
  const task = await plannerLoadLiveTask(db, input.user.id, taskId);
  if (input.goalId !== null) await loadGoal(db, input.user.id, input.goalId);
  const existing = await plannerLoadPlan(db, input.user.id, taskId);
  const from = existing?.goalId ?? null;
  if (from === input.goalId) return false;
  const nowIso = plannerNow(input.now).toISOString();
  await plannerRunBatch(db, [
    db
      .insert(plannerTaskPlan)
      .values({
        taskId,
        userId: input.user.id,
        horizon: null,
        periodStart: null,
        carryCount: 0,
        droppedAt: null,
        goalId: input.goalId,
        createdAt: nowIso,
        updatedAt: nowIso,
      })
      .onConflictDoUpdate({
        target: plannerTaskPlan.taskId,
        set: { goalId: input.goalId, updatedAt: nowIso },
      }),
    plannerEventStatement(db, {
      userId: input.user.id,
      taskId,
      taskTitle: task.title,
      type: "goal_changed",
      data: { from, to: input.goalId },
      actor: input.actor,
      occurredAt: nowIso,
    }),
  ]);
  return true;
}
