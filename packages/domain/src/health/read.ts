import {
  type HealthEntryDto,
  type HealthKind,
  type HealthTargetDto,
  type HealthTargetPeriod,
  type HealthWeekSummary,
  type HealthYearDay,
  type HealthYearResponse,
  healthAddDays,
  healthDayOfYear,
  healthDaysInYear,
  healthDefaultTargets,
  healthLocalMoment,
} from "@flaremo/contracts";
import type { FlareMoDb } from "@flaremo/db";
import { healthEntry, healthTarget } from "@flaremo/db/src/schema/fork-health";
import { and, asc, between, eq, inArray, isNull } from "drizzle-orm";
import { parseResourceName } from "../ids";
import { type HealthEntryRow, healthToDto } from "./rows";

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
}> {
  const today = healthToday(input.now);
  const start = input.start ?? healthAddDays(today, -6);
  const end = healthAddDays(start, 6);
  const [rows, targets, yearUsed] = await Promise.all([
    readRange(db, input.userId, start, end),
    healthReadTargets(db, input.userId),
    healthReadYearUnits(db, input.userId, Number(end.slice(0, 4))),
  ]);
  return {
    start,
    end,
    today,
    entries: rows.map(healthToDto),
    summary: summarise(rows, targets, yearUsed),
  };
}

// --- Year ------------------------------------------------------------------------

export async function healthReadYear(
  db: FlareMoDb,
  input: { userId: string; year?: number; now?: Date },
): Promise<HealthYearResponse> {
  const today = healthToday(input.now);
  const year = input.year ?? Number(today.slice(0, 4));
  const [rows, targets] = await Promise.all([
    readRange(db, input.userId, `${year}-01-01`, `${year}-12-31`),
    healthReadTargets(db, input.userId),
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
      };
      byDay.set(key, entry);
    }
    return entry;
  };
  for (const row of rows) {
    const entry = day(row.day);
    if (row.kind === "training") entry.training += 1;
    else if (row.kind === "breath") entry.breath += 1;
    else {
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
