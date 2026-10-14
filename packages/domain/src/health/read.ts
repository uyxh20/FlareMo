import {
  type HealthEntryDto,
  type HealthEntryKind,
  type HealthGoalProgress,
  type HealthKind,
  type HealthTargetDto,
  type HealthTargetPeriod,
  type HealthTrackerCount,
  type HealthWeekSummary,
  type HealthYearDay,
  type HealthYearResponse,
  healthAddDays,
  healthDayOfYear,
  healthDaysInYear,
  healthDefaultTargets,
  healthIsBuiltinKind,
  healthLocalMoment,
  healthTrackerColors,
} from "@flaremo/contracts";
import type { FlareMoDb } from "@flaremo/db";
import { healthEntry, healthTarget } from "@flaremo/db/src/schema/fork-health";
import { plannerGoal } from "@flaremo/db/src/schema/planner";
import { and, asc, between, eq, inArray, isNull } from "drizzle-orm";
import { parseResourceName } from "../ids";
import { type HealthEntryRow, healthToDto } from "./rows";
import { healthReadTrackerKinds, healthReadTrackerRows } from "./trackers";

// What the health tracker's API reads (fork-owned add-on,
// docs/fork-health-tracker.md). Nothing here writes. A row counts when it is
// neither soft-deleted nor dismissed.

const ID_CHUNK = 50;

/** The local calendar day right now. */
export function healthToday(now: Date = new Date()): string {
  return healthLocalMoment(now).day;
}

function visible(userId: string) {
  return and(
    eq(healthEntry.userId, userId),
    isNull(healthEntry.deletedAt),
    eq(healthEntry.dismissed, false),
  );
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

// --- Targets ---------------------------------------------------------------------

/** The owner's targets, with the default wherever they set none. */
export async function healthReadTargets(
  db: FlareMoDb,
  userId: string,
): Promise<HealthTargetDto[]> {
  const rows = await db
    .select()
    .from(healthTarget)
    .where(eq(healthTarget.userId, userId))
    .all();
  return healthDefaultTargets.map((fallback) => {
    const set = rows.find(
      (row) => row.kind === fallback.kind && row.period === fallback.period,
    );
    return {
      kind: fallback.kind,
      period: fallback.period,
      amount: set?.amount ?? fallback.amount,
      is_default: !set,
    };
  });
}

function targetOf(
  targets: HealthTargetDto[],
  kind: HealthKind,
  period: HealthTargetPeriod,
): number {
  return (
    targets.find((target) => target.kind === kind && target.period === period)
      ?.amount ?? 0
  );
}

// --- Week ------------------------------------------------------------------------

async function readRange(
  db: FlareMoDb,
  userId: string,
  from: string,
  to: string,
): Promise<HealthEntryRow[]> {
  return db
    .select()
    .from(healthEntry)
    .where(and(visible(userId), between(healthEntry.day, from, to)))
    .orderBy(asc(healthEntry.day), asc(healthEntry.createdAt))
    .all();
}

function sumUnits(rows: HealthEntryRow[]): number {
  return rows
    .filter((row) => row.kind === "night_out")
    .reduce((sum, row) => sum + (row.units ?? 0), 0);
}

/** The night-out units used in the year that `day` is in. */
export async function healthReadYearUnits(
  db: FlareMoDb,
  userId: string,
  year: number,
): Promise<number> {
  const rows = await readRange(db, userId, `${year}-01-01`, `${year}-12-31`);
  return round1(sumUnits(rows));
}

function summarise(
  rows: HealthEntryRow[],
  targets: HealthTargetDto[],
  yearUsed: number,
): HealthWeekSummary {
  const training = rows.filter((row) => row.kind === "training");
  const breath = rows.filter((row) => row.kind === "breath");
  const nights = rows.filter((row) => row.kind === "night_out");
  return {
    training: {
      sessions: training.length,
      target: targetOf(targets, "training", "week"),
    },
    breath: {
      days: new Set(breath.map((row) => row.day)).size,
      sessions: breath.length,
      minutes: breath.reduce((sum, row) => sum + (row.minutes ?? 0), 0),
      target: targetOf(targets, "breath", "week"),
    },
    night_out: {
      units: round1(sumUnits(rows)),
      nights: nights.length,
      needs_check: nights.filter((row) => row.needsCheck).length,
      year_target: targetOf(targets, "night_out", "year"),
      year_used: yearUsed,
    },
  };
}

/**
 * Days and minutes per owner tracker over some rows, one count per live
 * tracker in its order (a tracker with nothing yet counts 0). Rows of an
 * archived tracker are not counted.
 */
function countTrackers(
  rows: HealthEntryRow[],
  kinds: HealthEntryKind[],
): HealthTrackerCount[] {
  return kinds.map((kind) => {
    const own = rows.filter((row) => row.kind === kind);
    return {
      kind,
      days: new Set(own.map((row) => row.day)).size,
      minutes: own.reduce((sum, row) => sum + (row.minutes ?? 0), 0),
    };
  });
}

/** Seven days from `start`: the entries and the summary against the targets. */
export async function healthReadWeek(
  db: FlareMoDb,
  input: { userId: string; start?: string; now?: Date },
): Promise<{
  start: string;
  end: string;
  today: string;
  entries: HealthEntryDto[];
  summary: HealthWeekSummary;
  trackers: HealthTrackerCount[];
}> {
  const today = healthToday(input.now);
  const start = input.start ?? healthAddDays(today, -6);
  const end = healthAddDays(start, 6);
  const [rows, targets, yearUsed, kinds] = await Promise.all([
    readRange(db, input.userId, start, end),
    healthReadTargets(db, input.userId),
    healthReadYearUnits(db, input.userId, Number(end.slice(0, 4))),
    healthReadTrackerKinds(db, input.userId),
  ]);
  const shown = rows.filter(
    (row) => healthIsBuiltinKind(row.kind) || kinds.includes(row.kind),
  );
  return {
    start,
    end,
    today,
    entries: shown.map(healthToDto),
    summary: summarise(rows, targets, yearUsed),
    trackers: countTrackers(rows, kinds),
  };
}

// --- Year ------------------------------------------------------------------------

export async function healthReadYear(
  db: FlareMoDb,
  input: { userId: string; year?: number; now?: Date },
): Promise<HealthYearResponse> {
  const today = healthToday(input.now);
  const year = input.year ?? Number(today.slice(0, 4));
  const [rows, targets, kinds] = await Promise.all([
    readRange(db, input.userId, `${year}-01-01`, `${year}-12-31`),
    healthReadTargets(db, input.userId),
    healthReadTrackerKinds(db, input.userId),
  ]);
  const byDay = new Map<string, HealthYearDay>();
  const day = (key: string): HealthYearDay => {
    let entry = byDay.get(key);
    if (!entry) {
      entry = {
        day: key,
        training: 0,
        breath: 0,
        night_out: null,
        has_night: false,
        needs_check: false,
        trackers: {},
      };
      byDay.set(key, entry);
    }
    return entry;
  };
  for (const row of rows) {
    if (!healthIsBuiltinKind(row.kind) && !kinds.includes(row.kind)) continue;
    const entry = day(row.day);
    if (row.kind === "training") entry.training += 1;
    else if (row.kind === "breath") entry.breath += 1;
    else if (row.kind !== "night_out") {
      entry.trackers[row.kind] = (entry.trackers[row.kind] ?? 0) + 1;
    } else {
      entry.has_night = true;
      if (row.needsCheck) entry.needs_check = true;
      if (row.units !== null) {
        entry.night_out = (entry.night_out ?? 0) + row.units;
      }
    }
  }
  const nights = rows.filter((row) => row.kind === "night_out");
  const used = round1(sumUnits(rows));
  const thisYear = Number(today.slice(0, 4));
  const daysElapsed =
    year < thisYear
      ? healthDaysInYear(year)
      : year > thisYear
        ? 1
        : healthDayOfYear(today);
  return {
    year,
    today,
    days: [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : 1)),
    night_out: {
      used,
      target: targetOf(targets, "night_out", "year"),
      days_elapsed: daysElapsed,
      pace: round1((used / daysElapsed) * 365),
      nights: nights.length,
      benders: nights.filter((row) => row.bender).length,
      needs_check: nights.filter((row) => row.needsCheck).length,
    },
    totals: {
      training: rows.filter((row) => row.kind === "training").length,
      breath_days: new Set(
        rows.filter((row) => row.kind === "breath").map((row) => row.day),
      ).size,
    },
    trackers: countTrackers(rows, kinds),
    needs_check_entries: nights
      .filter((row) => row.needsCheck)
      .map(healthToDto),
  };
}

// --- Memos -----------------------------------------------------------------------

/**
 * The entries of several memos in one read, for the timeline's labels. Ids may
 * be bare or `memos/<id>`; the answer is keyed by the id as it was asked for,
 * with `[]` for a memo that has none.
 */
export async function healthReadMemos(
  db: FlareMoDb,
  input: { userId: string; ids: string[] },
): Promise<Record<string, HealthEntryDto[]>> {
  const result: Record<string, HealthEntryDto[]> = {};
  const asked = new Map<string, string[]>();
  for (const id of input.ids) {
    result[id] = [];
    const name = parseResourceName(id, "memos");
    asked.set(name, [...(asked.get(name) ?? []), id]);
  }
  const names = [...asked.keys()];
  for (let start = 0; start < names.length; start += ID_CHUNK) {
    const rows = await db
      .select()
      .from(healthEntry)
      .where(
        and(
          visible(input.userId),
          inArray(healthEntry.memoId, names.slice(start, start + ID_CHUNK)),
        ),
      )
      .orderBy(asc(healthEntry.createdAt))
      .all();
    for (const row of rows) {
      for (const id of asked.get(row.memoId ?? "") ?? []) {
        result[id]?.push(healthToDto(row));
      }
    }
  }
  return result;
}

// --- Goal progress -------------------------------------------------------------

/** The last day of a goal's period, from its first day. */
function periodEnd(level: string, start: string): string | null {
  const [year, month] = start.split("-").map(Number) as [number, number];
  const lastOfMonth = (y: number, m: number) => {
    const date = new Date(Date.UTC(y, m, 0));
    return date.toISOString().slice(0, 10);
  };
  switch (level) {
    case "year":
      return `${year}-12-31`;
    case "quarter":
      return lastOfMonth(year, month + 2);
    case "month":
      return lastOfMonth(year, month);
    case "week":
      return healthAddDays(start, 6);
    default:
      return null;
  }
}

/**
 * Each live tracker linked to a goal, counted over that goal's period up to
 * today. A tracker whose goal is gone, or has no period, is left out.
 */
export async function healthReadGoalProgress(
  db: FlareMoDb,
  input: { userId: string; now?: Date },
): Promise<HealthGoalProgress[]> {
  const linked = (await healthReadTrackerRows(db, input.userId)).filter(
    (row) =>
      !healthIsBuiltinKind(row.kind) &&
      row.archivedAt === null &&
      row.goalId !== null,
  );
  if (linked.length === 0) return [];
  const goalIds = [...new Set(linked.map((row) => row.goalId as string))];
  const goals = await db
    .select({
      id: plannerGoal.id,
      level: plannerGoal.level,
      periodStart: plannerGoal.periodStart,
    })
    .from(plannerGoal)
    .where(
      and(
        eq(plannerGoal.userId, input.userId),
        isNull(plannerGoal.deletedAt),
        inArray(plannerGoal.id, goalIds),
      ),
    )
    .all();
  const today = healthToday(input.now);
  const progress: HealthGoalProgress[] = [];
  for (const row of [...linked].sort(
    (a, b) => a.sortOrder - b.sortOrder || (a.createdAt < b.createdAt ? -1 : 1),
  )) {
    const goal = goals.find((candidate) => candidate.id === row.goalId);
    const from = goal?.periodStart ?? null;
    const to = goal && from ? periodEnd(goal.level, from) : null;
    if (!goal || !from || !to) continue;
    const until = to < today ? to : today;
    const entries =
      from > until
        ? []
        : await db
            .select({ day: healthEntry.day, minutes: healthEntry.minutes })
            .from(healthEntry)
            .where(
              and(
                visible(input.userId),
                eq(healthEntry.kind, row.kind),
                between(healthEntry.day, from, until),
              ),
            )
            .all();
    const timed = entries.filter((entry) => (entry.minutes ?? 0) > 0);
    progress.push({
      goal_id: goal.id,
      level: goal.level as HealthGoalProgress["level"],
      kind: row.kind,
      label: row.label,
      color: (healthTrackerColors as readonly string[]).includes(row.color)
        ? (row.color as HealthGoalProgress["color"])
        : "green",
      measure: row.measure,
      from,
      to,
      days: new Set(entries.map((entry) => entry.day)).size,
      minutes: entries.reduce((sum, entry) => sum + (entry.minutes ?? 0), 0),
      timed: timed.length,
    });
  }
  return progress;
}
