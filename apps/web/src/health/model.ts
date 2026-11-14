import {
  type HealthEntryDto,
  type HealthEntryKind,
  type HealthFamily,
  type HealthGoalProgress,
  type HealthTrackerDto,
  healthAddDays,
  healthFamilyKinds,
  healthFamilyOf,
  healthIsBuiltinKind,
  healthSubtypesOf,
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

/** A family's name: Fitness, Breath, Out, or the tracker's own. */
export function healthFamilyLabel(
  family: HealthFamily,
  trackers?: readonly HealthTrackerDto[],
): string {
  return (
    healthStrings.family[family] ??
    trackers?.find((t) => t.kind === family)?.label ??
    healthStrings.trackers.unknown
  );
}

/** A sub-type's name: "Gym", "Big night", or an owner's sub-type's label. */
export function healthSubtypeLabel(
  family: HealthFamily,
  key: string,
  trackers?: readonly HealthTrackerDto[],
): string {
  return (
    healthStrings.subtype[`${family}:${key}`] ??
    trackers
      ?.find((t) => t.kind === family)
      ?.subtypes.find((sub) => sub.id === key)?.label ??
    healthStrings.breakdown.noSubtype
  );
}

/**
 * The words on a label chip, family first: "Fitness · Gym · Back",
 * "Fitness · Sauna · 20 min", "Breath · Wim Hof · 10 min",
 * "Out · Fri · Big night · home 03:30", "Fast · 16:8 · 16 h".
 */
export function healthChipText(
  entry: HealthEntryDto,
  trackers?: readonly HealthTrackerDto[],
): string {
  const s = healthStrings;
  const family = healthFamilyOf(entry.kind);
  const parts: string[] = [healthFamilyLabel(family, trackers)];
  const minutes = entry.minutes ? s.chip.minutes(entry.minutes) : "";
  if (!healthIsBuiltinKind(entry.kind)) {
    const tracker = trackers?.find((t) => t.kind === entry.kind);
    const sub = entry.variant
      ? tracker?.subtypes.find((item) => item.id === entry.variant)?.label
      : undefined;
    if (sub) parts.push(sub);
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
    const [sub = "gym"] = healthSubtypesOf(entry);
    parts.push(healthSubtypeLabel(family, sub));
    const variant = entry.variant ?? "gym";
    // A split (Back, Push…) is the detail of a gym session.
    if (sub === "gym" && variant !== "gym") {
      parts.push(healthVariantLabel(variant));
    }
    parts.push(minutes);
    return parts.filter(Boolean).join(" · ");
  }
  if (entry.kind === "wellness") {
    parts.push(healthVariantLabel(entry.variant) || s.kind.wellness, minutes);
    return parts.filter(Boolean).join(" · ");
  }
  if (entry.kind === "breath") {
    parts.push(
      healthSubtypesOf(entry)
        .map((sub) => healthSubtypeLabel(family, sub))
        .join(" + "),
      minutes,
    );
    return parts.filter(Boolean).join(" · ");
  }
  parts.push(healthWeekdayShort(entry.day));
  if (entry.needs_check) {
    parts.push(s.chip.homeWhen);
  } else {
    const [sub = "social"] = healthSubtypesOf(entry);
    parts.push(healthSubtypeLabel(family, sub));
    if (entry.home_at) parts.push(s.chip.home(entry.home_at));
  }
  return parts.join(" · ");
}

// --- Families: the four rows and what opens under them --------------------------

export type HealthFamilyRow = {
  family: HealthFamily;
  label: string;
  kinds: HealthEntryKind[];
  kindClass: string;
};

/** The rows everywhere: Fitness, Breath, Out, then the owner's own trackers. */
export function healthFamilyRows(
  trackers: readonly HealthTrackerDto[] | undefined,
): HealthFamilyRow[] {
  const builtin: HealthFamilyRow[] = (
    ["fitness", "breath", "night_out"] as const
  ).map((family) => ({
    family,
    label: healthFamilyLabel(family),
    kinds: healthFamilyKinds(family),
    kindClass: `health-kind-${family === "fitness" ? "training" : family}`,
  }));
  const own = (trackers ?? [])
    .filter((tracker) => !tracker.builtin)
    .map((tracker) => ({
      family: tracker.kind as HealthFamily,
      label: tracker.label,
      kinds: [tracker.kind],
      kindClass: `health-kind-t-${tracker.color ?? "slate"}`,
    }));
  return [...builtin, ...own];
}

export type HealthBreakdownRow = { key: string; label: string; count: number };

function breakdownRows(
  family: HealthFamily,
  counts: Map<string, number>,
  trackers?: readonly HealthTrackerDto[],
): HealthBreakdownRow[] {
  return [...counts]
    .filter(([, count]) => count > 0)
    .map(([key, count]) => ({
      key,
      label: key
        ? healthSubtypeLabel(family, key, trackers)
        : healthStrings.breakdown.noSubtype,
      count,
    }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

/** A family's entries split by sub-type, most first: sessions per sub-type. */
export function healthBreakdownOfEntries(
  entries: readonly HealthEntryDto[],
  family: HealthFamily,
  trackers?: readonly HealthTrackerDto[],
): HealthBreakdownRow[] {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    if (healthFamilyOf(entry.kind) !== family) continue;
    const subs = healthSubtypesOf(entry);
    for (const sub of subs.length ? subs : [""]) {
      counts.set(sub, (counts.get(sub) ?? 0) + 1);
    }
  }
  return breakdownRows(family, counts, trackers);
}

/**
 * The same, from the year's days, between two days (inclusive), with the
 * family's count over the range (see healthFamilyCount).
 */
export function healthBreakdownOfDays(
  days: readonly YearDay[],
  family: HealthFamily,
  range: { from: string; to: string },
  trackers?: readonly HealthTrackerDto[],
): { total: number; rows: HealthBreakdownRow[] } {
  const counts = new Map<string, number>();
  let nights = 0;
  let sessions = 0;
  for (const day of days) {
    if (day.day < range.from || day.day > range.to) continue;
    let rows = 0;
    for (const [key, count] of Object.entries(day.subtypes ?? {})) {
      const cut = key.lastIndexOf(":");
      if (key.slice(0, cut) !== family) continue;
      const sub = key.slice(cut + 1);
      counts.set(sub, (counts.get(sub) ?? 0) + count);
      rows += count;
    }
    if (rows > 0) nights += 1;
    // A breath row with two sub-types (Wim Hof + Meditation) is one session.
    sessions += family === "breath" ? day.breath : rows;
  }
  return {
    total: family === "night_out" ? nights : sessions,
    rows: breakdownRows(family, counts, trackers),
  };
}

/**
 * The number a family's row shows: sessions (rows) for Fitness, Breath and the
 * owner's trackers, so a gym session and a sauna on one day count as two;
 * nights for Out, so two notes about one night count once.
 */
export function healthFamilyCount(
  entries: readonly HealthEntryDto[],
  family: HealthFamily,
): number {
  const own = entries.filter((entry) => healthFamilyOf(entry.kind) === family);
  return family === "night_out"
    ? new Set(own.map((entry) => entry.day)).size
    : own.length;
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

/** Days this week with a Fitness entry of either kind (gym or wellness). */
export function healthFitnessDays(entries: readonly HealthEntryDto[]): number {
  return new Set(
    entries
      .filter((e) => e.kind === "training" || e.kind === "wellness")
      .map((e) => e.day),
  ).size;
}

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
  kind: HealthEntryKind | readonly HealthEntryKind[],
  day: string,
): { state: HealthDotState; count: number } {
  const kinds: readonly HealthEntryKind[] = Array.isArray(kind)
    ? kind
    : [kind as HealthEntryKind];
  const here = entries.filter((e) => kinds.includes(e.kind) && e.day === day);
  if (here.length === 0) return { state: "none", count: 0 };
  if (!kinds.includes("night_out")) {
    return { state: "done", count: here.length };
  }
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
  /** Days with a sauna, cold plunge, massage and the like. */
  wellness: number;
  /** Days with any Fitness row (a session or wellness). */
  fitness: number;
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
  wellness?: number;
  night_out: number | null;
  trackers?: Record<string, number>;
  subtypes?: Record<string, number>;
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
      wellness: 0,
      fitness: 0,
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
    if ((day.wellness ?? 0) > 0) week.wellness += 1;
    if (day.training > 0 || (day.wellness ?? 0) > 0) week.fitness += 1;
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
