import {
  type HealthEntryDto,
  type HealthEntryKind,
  type HealthGoalProgress,
  type HealthTrackerDto,
  healthAddDays,
  healthIsBuiltinKind,
  healthWeekdayOf,
  healthWeekStartOf,
} from "@flaremo/contracts";
import { healthStrings } from "./strings";

// The health tracker's pure view logic (fork-owned add-on,
// docs/fork-health-tracker.md): the words on a label, the state of a strip dot,
// the cells of the year grid. No React and no fetching, so the rules can be read
// and tested on their own.

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

export function healthWeekdayShort(day: string): string {
  return WEEKDAYS[healthWeekdayOf(day)] ?? "";
}

/** "5 Oct" */
export function healthDayShort(day: string): string {
  const month = MONTHS[Number(day.slice(5, 7)) - 1] ?? "";
  return `${Number(day.slice(8, 10))} ${month}`;
}

/** Units as people write them: 0, ½, 1, 1½, 2.5 stays 2.5 for odd values. */
export function healthFormatUnits(units: number): string {
  if (Number.isInteger(units)) return String(units);
  const whole = Math.floor(units);
  if (units - whole === 0.5) return whole === 0 ? "½" : `${whole}½`;
  return String(Math.round(units * 10) / 10);
}

export function healthVariantLabel(variant: string | null): string {
  return (variant && healthStrings.variant[variant]) || "";
}

/** The words on a label chip: "Gym · Back", "Wim Hof · 10 min", "Night out · Fri · home 03:30 · 1". */
export function healthChipText(
  entry: HealthEntryDto,
  trackers?: readonly HealthTrackerDto[],
): string {
  const s = healthStrings;
  if (!healthIsBuiltinKind(entry.kind)) {
    const tracker = trackers?.find((t) => t.kind === entry.kind);
    const parts = [tracker?.label ?? s.trackers.unknown];
    if (entry.minutes) {
      parts.push(
        tracker?.measure === "hours"
          ? s.trackers.hours(entry.minutes)
          : s.chip.minutes(entry.minutes),
      );
    }
    return parts.join(" · ");
  }
  if (entry.kind === "training") {
    const variant = entry.variant ?? "gym";
    const parts =
      variant === "gym" || variant === "crossfit" || variant === "cardio"
        ? [healthVariantLabel(variant)]
        : [s.variant.gym, healthVariantLabel(variant)];
    if (variant === "cardio" && entry.minutes) {
      parts.push(s.chip.minutes(entry.minutes));
    }
    return parts.join(" · ");
  }
  if (entry.kind === "breath") {
    return [
      healthVariantLabel(entry.variant ?? "wim_hof"),
      entry.minutes ? s.chip.minutes(entry.minutes) : "",
    ]
      .filter(Boolean)
      .join(" · ");
  }
  const parts: string[] = [s.chip.nightOut, healthWeekdayShort(entry.day)];
  if (entry.needs_check) {
    parts.push(s.chip.homeWhen);
  } else {
    if (entry.home_at) parts.push(s.chip.home(entry.home_at));
    else if (entry.bender) parts.push(s.chip.bender);
    if (entry.units !== null) parts.push(healthFormatUnits(entry.units));
  }
  return parts.join(" · ");
}

/** A tooltip for a chip: the feeling, when the diary gave one. */
export function healthChipTitle(entry: HealthEntryDto): string | undefined {
  return entry.feel ? `Felt ${entry.feel}` : undefined;
}

// --- The week strip ----------------------------------------------------------

export type HealthDotState = "none" | "done" | "half" | "check" | "zero";

export type HealthStripDay = {
  day: string;
  weekday: string;
  isToday: boolean;
};

/** Seven days from `start`, marking today. */
export function healthStripDays(
  start: string,
  today: string,
): HealthStripDay[] {
  return Array.from({ length: 7 }, (_, index) => {
    const day = healthAddDays(start, index);
    return { day, weekday: healthWeekdayShort(day), isToday: day === today };
  });
}

/**
 * How one kind looks on one day: a filled dot for something done, a half dot
 * for half a unit, a dashed ring for a night that needs a home time, a hairline
 * ring for a night home before midnight (not counted).
 */
export function healthDotState(
  entries: readonly HealthEntryDto[],
  kind: HealthEntryKind,
  day: string,
): { state: HealthDotState; count: number } {
  const here = entries.filter((e) => e.kind === kind && e.day === day);
  if (here.length === 0) return { state: "none", count: 0 };
  if (kind !== "night_out") return { state: "done", count: here.length };
  if (here.some((e) => e.needs_check)) {
    return { state: "check", count: here.length };
  }
  const units = here.reduce((sum, e) => sum + (e.units ?? 0), 0);
  if (units >= 1) return { state: "done", count: here.length };
  if (units > 0) return { state: "half", count: here.length };
  return { state: "zero", count: here.length };
}

// --- The year grid -------------------------------------------------------------

export type HealthYearWeek = {
  /** The Monday. */
  start: string;
  training: number;
  breath: number;
  out: number;
  /** Days with an entry, per owner tracker kind. */
  trackers: Record<string, number>;
  /** After today: drawn as an empty outline. */
  future: boolean;
};

type YearDay = {
  day: string;
  training: number;
  breath: number;
  night_out: number | null;
  trackers?: Record<string, number>;
};

/** The weeks of a year, Monday to Sunday, each with what its days hold. */
export function healthYearWeeks(
  year: number,
  days: readonly YearDay[],
  today: string,
): HealthYearWeek[] {
  const byWeek = new Map<string, HealthYearWeek>();
  const first = healthWeekStartOf(`${year}-01-01`);
  const last = `${year}-12-31`;
  for (let start = first; start <= last; start = healthAddDays(start, 7)) {
    byWeek.set(start, {
      start,
      training: 0,
      breath: 0,
      out: 0,
      trackers: {},
      future: start > today,
    });
  }
  for (const day of days) {
    const week = byWeek.get(healthWeekStartOf(day.day));
    if (!week) continue;
    week.training += day.training;
    if (day.breath > 0) week.breath += 1;
    week.out += day.night_out ?? 0;
    for (const [kind, count] of Object.entries(day.trackers ?? {})) {
      if (count > 0) week.trackers[kind] = (week.trackers[kind] ?? 0) + 1;
    }
  }
  return [...byWeek.values()];
}

/** 0 (nothing) to 4 (a full week), from a value against what a week can hold. */
export function healthLevel(value: number, full: number): 0 | 1 | 2 | 3 | 4 {
  if (value <= 0) return 0;
  const share = Math.min(1, value / full);
  if (share <= 0.25) return 1;
  if (share <= 0.5) return 2;
  if (share < 1) return 3;
  return 4;
}

/** The month names to put above a grid of weeks: where each month's first week sits. */
export function healthMonthMarks(
  weeks: readonly HealthYearWeek[],
): Array<{ index: number; label: string }> {
  const marks: Array<{ index: number; label: string }> = [];
  let seen = -1;
  weeks.forEach((week, index) => {
    // A week belongs to the month its Thursday is in (the ISO rule).
    const month = Number(healthAddDays(week.start, 3).slice(5, 7)) - 1;
    if (month !== seen) {
      seen = month;
      marks.push({ index, label: MONTHS[month] ?? "" });
    }
  });
  return marks;
}

/**
 * A linked tracker's line on a goal card: "Fasting · 9 days so far · avg 16 h".
 * The average is over the entries a length was read for, and only for a tracker that
 * reads lengths.
 */
export function healthGoalProgressText(progress: HealthGoalProgress): string {
  const s = healthStrings.trackers;
  const parts = [progress.label, s.goalDays(progress.days)];
  if (progress.measure !== "days" && progress.timed > 0) {
    const average = Math.round(progress.minutes / progress.timed);
    parts.push(
      s.goalAverage(
        progress.measure === "hours"
          ? s.hours(average)
          : healthStrings.chip.minutes(average),
      ),
    );
  }
  return parts.join(" · ");
}
