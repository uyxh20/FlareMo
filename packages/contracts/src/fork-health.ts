// Health tracker contracts: a fork-owned add-on (docs/fork-health-tracker.md).
// The Worker and the web app share this file: the constants and rules that mean
// the same thing on both sides, the date helpers (UTC maths on `YYYY-MM-DD` keys,
// weeks start on Monday) and the HTTP schemas of `/api/app/health`.
//
// It is re-exported from ./planner.ts (also fork-owned), so the package index,
// an upstream file, stays untouched. It must not import ./planner back.
//
// Every export is prefixed health/Health or FORK_HEALTH.

import { z } from "zod";

/**
 * The time zone the diary is read in. A memo's `created_at` is UTC; the day a
 * session or a night belongs to is the local day in this zone. It is a constant
 * on purpose: one owner, one zone, and the parser stays deterministic.
 */
export const FORK_HEALTH_TIME_ZONE = "Europe/Copenhagen";

export const healthKinds = ["training", "breath", "night_out"] as const;
export type HealthKind = (typeof healthKinds)[number];

export const healthTrainingVariants = [
  "crossfit",
  "push",
  "pull",
  "back",
  "chest",
  "legs",
  "upper",
  "cardio",
  "gym",
] as const;
export type HealthTrainingVariant = (typeof healthTrainingVariants)[number];

export const healthBreathVariants = ["wim_hof", "meditation"] as const;
export type HealthBreathVariant = (typeof healthBreathVariants)[number];

export const healthEntrySources = ["memo", "manual", "import"] as const;
export type HealthEntrySource = (typeof healthEntrySources)[number];

export const healthTargetPeriods = ["week", "year"] as const;
export type HealthTargetPeriod = (typeof healthTargetPeriods)[number];

/** Minutes a breath session gets when the diary gives none. */
export const healthDefaultBreathMinutes = 10;

/** A memo longer than this is a summary or an essay, never a log line. */
export const healthMaxMemoChars = 1500;
/** From here a memo needs an explicit tag or a "done" word near the keyword. */
export const healthLongMemoChars = 300;

/** Memos carrying one of these tags are never read. */
export const healthSkipTags = [
  "vault-summary",
  "vault-theme",
  "vault-thinking",
  "vault-tracker",
  "seed",
  "agent-memory",
] as const;

/** Memos written by the weekly review are never read either. */
export const healthSkipSources = ["weekly-review"] as const;

/** What a target is when the owner has not set one. */
export const healthDefaultTargets: ReadonlyArray<{
  kind: HealthKind;
  period: HealthTargetPeriod;
  amount: number;
}> = [
  { kind: "training", period: "week", amount: 3 },
  { kind: "breath", period: "week", amount: 7 },
  { kind: "night_out", period: "year", amount: 12 },
];

/** The kind and period pairs a target can be set for. */
export function healthIsTargetPair(
  kind: HealthKind,
  period: HealthTargetPeriod,
): boolean {
  return healthDefaultTargets.some(
    (target) => target.kind === kind && target.period === period,
  );
}

// --- Night units -----------------------------------------------------------

export type HealthNightUnits = {
  units: number;
  bender: boolean;
};

/**
 * What a night out counts for, from the time the owner got home (`HH:MM`).
 * Before midnight (17:00 to 23:59) it is a social evening and counts 0;
 * 00:00 to 02:59 is half a unit; 03:00 to 05:59 is one; 06:00 or later is one
 * and a bender.
 */
export function healthNightUnitsFor(homeAt: string): HealthNightUnits | null {
  const match = /^(\d{2}):(\d{2})$/.exec(homeAt);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  if (hour >= 17) return { units: 0, bender: false };
  if (hour < 3) return { units: 0.5, bender: false };
  if (hour < 6) return { units: 1, bender: false };
  return { units: 1, bender: true };
}

// --- Dates -----------------------------------------------------------------

const DAY_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;

/** UTC midnight of a real calendar day, or undefined for anything else. */
export function healthParseDay(value: unknown): Date | undefined {
  if (typeof value !== "string") return undefined;
  const match = DAY_KEY.exec(value);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1) return undefined;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return undefined;
  }
  return date;
}

export function healthIsDay(value: unknown): value is string {
  return healthParseDay(value) !== undefined;
}

function dayKeyOf(date: Date): string {
  const year = String(date.getUTCFullYear()).padStart(4, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function requireDay(value: string): Date {
  const date = healthParseDay(value);
  if (!date) throw new RangeError(`Not a calendar day: ${value}`);
  return date;
}

/** `day` moved by `days` calendar days (negative goes back). */
export function healthAddDays(day: string, days: number): string {
  return dayKeyOf(new Date(requireDay(day).getTime() + days * MS_PER_DAY));
}

/** Whole days from `from` to `to` (positive when `to` is later). */
export function healthDaysBetween(from: string, to: string): number {
  return Math.round(
    (requireDay(to).getTime() - requireDay(from).getTime()) / MS_PER_DAY,
  );
}

/** 0 for Monday through 6 for Sunday. */
export function healthWeekdayOf(day: string): number {
  return (requireDay(day).getUTCDay() + 6) % 7;
}

/** The Monday of the week `day` is in. */
export function healthWeekStartOf(day: string): string {
  return healthAddDays(day, -healthWeekdayOf(day));
}

export function healthDaysInYear(year: number): number {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 366 : 365;
}

/** 1 for 1 January. */
export function healthDayOfYear(day: string): number {
  const year = requireDay(day).getUTCFullYear();
  return healthDaysBetween(`${String(year).padStart(4, "0")}-01-01`, day) + 1;
}

export type HealthLocalMoment = {
  /** The local calendar day, `YYYY-MM-DD`. */
  day: string;
  /** 0 to 23. */
  hour: number;
  minute: number;
};

let localFormatter: Intl.DateTimeFormat | undefined;

/**
 * The wall-clock day and time of an instant in FORK_HEALTH_TIME_ZONE. Intl is
 * available in Workers and browsers alike; nothing depends on the machine's
 * own zone.
 */
export function healthLocalMoment(
  instant: Date | string,
  timeZone: string = FORK_HEALTH_TIME_ZONE,
): HealthLocalMoment {
  const date = typeof instant === "string" ? new Date(instant) : instant;
  if (Number.isNaN(date.getTime())) {
    throw new RangeError(`Not a timestamp: ${String(instant)}`);
  }
  const formatter =
    timeZone === FORK_HEALTH_TIME_ZONE && localFormatter
      ? localFormatter
      : new Intl.DateTimeFormat("en-CA", {
          timeZone,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          hourCycle: "h23",
        });
  if (timeZone === FORK_HEALTH_TIME_ZONE) localFormatter = formatter;
  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(date)) {
    parts[part.type] = part.value;
  }
  return {
    day: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
  };
}

/**
 * The instant local midnight starts `day` in FORK_HEALTH_TIME_ZONE, as an ISO
 * timestamp (`2026-09-27T22:00:00.000Z` for 28 September in Copenhagen). It is
 * how a local week or day is cut out of UTC `created_at` columns. Daylight
 * saving is handled by checking the zone's offset at the guess and again at the
 * answer.
 */
export function healthLocalDayStart(
  day: string,
  timeZone: string = FORK_HEALTH_TIME_ZONE,
): string {
  const midnightUtc = requireDay(day).getTime();
  const offsetAt = (instant: number) => {
    const local = healthLocalMoment(new Date(instant), timeZone);
    const wall = Date.UTC(
      Number(local.day.slice(0, 4)),
      Number(local.day.slice(5, 7)) - 1,
      Number(local.day.slice(8, 10)),
      local.hour,
      local.minute,
    );
    // Seconds are not in the formatter's parts; zones have whole-minute offsets.
    return wall - Math.floor(instant / 60_000) * 60_000;
  };
  let instant = midnightUtc - offsetAt(midnightUtc);
  const second = midnightUtc - offsetAt(instant);
  if (second !== instant) instant = second;
  return new Date(instant).toISOString();
}

// --- HTTP API --------------------------------------------------------------

export const healthKindSchema = z.enum(healthKinds);
export const healthDaySchema = z
  .string()
  .refine(healthIsDay, "Expected a calendar day as YYYY-MM-DD.");
export const healthHomeAtSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Expected HH:MM.");

export const healthEntryDtoSchema = z.object({
  id: z.string(),
  kind: healthKindSchema,
  day: healthDaySchema,
  variant: z.string().nullable(),
  minutes: z.number().int().nullable(),
  home_at: z.string().nullable(),
  units: z.number().nullable(),
  bender: z.boolean(),
  needs_check: z.boolean(),
  feel: z.string().nullable(),
  source: z.enum(healthEntrySources),
  memo_id: z.string().nullable(),
  /** The owner changed it by hand; a re-read of the diary leaves it alone. */
  edited: z.boolean(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type HealthEntryDto = z.infer<typeof healthEntryDtoSchema>;

export const healthTargetDtoSchema = z.object({
  kind: healthKindSchema,
  period: z.enum(healthTargetPeriods),
  amount: z.number().min(0).max(9999),
  /** True while the owner has set nothing and the default applies. */
  is_default: z.boolean(),
});
export type HealthTargetDto = z.infer<typeof healthTargetDtoSchema>;

export const healthTargetsResponseSchema = z.object({
  targets: z.array(healthTargetDtoSchema),
});
export type HealthTargetsResponse = z.infer<typeof healthTargetsResponseSchema>;

export const healthSetTargetsSchema = z.object({
  targets: z
    .array(
      z.object({
        kind: healthKindSchema,
        period: z.enum(healthTargetPeriods),
        amount: z.number().min(0).max(9999),
      }),
    )
    .min(1)
    .max(9)
    .refine(
      (targets) =>
        targets.every((target) =>
          healthIsTargetPair(target.kind, target.period),
        ),
      "Targets exist for training and breath per week and night_out per year.",
    ),
});
export type HealthSetTargetsInput = z.infer<typeof healthSetTargetsSchema>;

export const healthWeekQuerySchema = z.object({
  /** First of the seven days; the last seven days ending today when absent. */
  start: healthDaySchema.optional(),
});

export const healthWeekSummarySchema = z.object({
  training: z.object({
    sessions: z.number().int(),
    target: z.number(),
  }),
  breath: z.object({
    /** Days with at least one session. */
    days: z.number().int(),
    sessions: z.number().int(),
    minutes: z.number().int(),
    target: z.number(),
  }),
  night_out: z.object({
    /** Units counted in the seven days. */
    units: z.number(),
    nights: z.number().int(),
    /** Nights still waiting for a home time. */
    needs_check: z.number().int(),
    /** The yearly target and what the year has used so far. */
    year_target: z.number(),
    year_used: z.number(),
  }),
});
export type HealthWeekSummary = z.infer<typeof healthWeekSummarySchema>;

export const healthWeekResponseSchema = z.object({
  start: healthDaySchema,
  end: healthDaySchema,
  today: healthDaySchema,
  entries: z.array(healthEntryDtoSchema),
  summary: healthWeekSummarySchema,
});
export type HealthWeekResponse = z.infer<typeof healthWeekResponseSchema>;

export const healthYearQuerySchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100).optional(),
});

export const healthYearDaySchema = z.object({
  day: healthDaySchema,
  training: z.number().int(),
  breath: z.number().int(),
  /** Units of the night that started this day; null when it needs a check. */
  night_out: z.number().nullable(),
  /** Whether a night this day is a night out at all (units may be 0). */
  has_night: z.boolean(),
  needs_check: z.boolean(),
});
export type HealthYearDay = z.infer<typeof healthYearDaySchema>;

export const healthYearResponseSchema = z.object({
  year: z.number().int(),
  today: healthDaySchema,
  /** Only the days that have something; the rest of the grid is empty. */
  days: z.array(healthYearDaySchema),
  night_out: z.object({
    used: z.number(),
    target: z.number(),
    days_elapsed: z.number().int(),
    /** used / days_elapsed * 365: where the year ends at this rate. */
    pace: z.number(),
    nights: z.number().int(),
    benders: z.number().int(),
    needs_check: z.number().int(),
  }),
  totals: z.object({
    training: z.number().int(),
    breath_days: z.number().int(),
  }),
  /** The nights of the year still waiting for a home time, oldest first. */
  needs_check_entries: z.array(healthEntryDtoSchema),
});
export type HealthYearResponse = z.infer<typeof healthYearResponseSchema>;

export const healthMemosQuerySchema = z.object({
  ids: z
    .string()
    .min(1)
    .transform((value) =>
      [
        ...new Set(
          value
            .split(",")
            .map((id) => id.trim())
            .filter(Boolean),
        ),
      ].slice(0, 100),
    ),
});

export const healthMemosResponseSchema = z.object({
  /** Entries per memo id as the client sent it; a memo with none has `[]`. */
  memos: z.record(z.string(), z.array(healthEntryDtoSchema)),
});
export type HealthMemosResponse = z.infer<typeof healthMemosResponseSchema>;

export const healthPatchEntrySchema = z
  .object({
    home_at: healthHomeAtSchema.nullable().optional(),
    variant: z.string().min(1).max(32).nullable().optional(),
    minutes: z.number().int().min(1).max(600).nullable().optional(),
    day: healthDaySchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "Nothing to change.");
export type HealthPatchEntryInput = z.infer<typeof healthPatchEntrySchema>;

export const healthEntryResponseSchema = z.object({
  entry: healthEntryDtoSchema,
});
export type HealthEntryResponse = z.infer<typeof healthEntryResponseSchema>;

export const healthRescanResponseSchema = z.object({
  memos: z.number().int(),
  created: z.number().int(),
  updated: z.number().int(),
  removed: z.number().int(),
});
export type HealthRescanResponse = z.infer<typeof healthRescanResponseSchema>;
