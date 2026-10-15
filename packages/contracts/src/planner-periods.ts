// The cockpit's period maths (fork-owned add-on,
// docs/planning-cockpit-implementation-plan.md, section 3), shared by the worker
// and the web app so a plan's period means the same thing on both sides:
// - A day is a `YYYY-MM-DD` key, the calendar day as the person sees it. It is
//   parsed as UTC midnight and read back with UTC getters only, so nothing here
//   depends on the machine's time zone or on daylight saving changes.
// - Weeks start on Monday, everywhere.
// - Years run from 0001 to 9999. Every period start of a valid day is valid
//   (0001-01-01 is a Monday); the one result that cannot be written, the period
//   after 9999, throws a RangeError.
//
// Re-exported from planner.ts. It imports nothing, so planner.ts and
// planner-board.ts can both read it.

export const plannerHorizons = ["day", "week", "month"] as const;

export type PlannerHorizon = (typeof plannerHorizons)[number];

const DAY_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;

/** UTC midnight of a real calendar day, or undefined for anything else. */
function parseDayKey(value: unknown): Date | undefined {
  if (typeof value !== "string") return undefined;
  const match = DAY_KEY.exec(value);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1) return undefined;
  // Not Date.UTC, which maps the years 0 to 99 onto 1900 to 1999.
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  // An impossible day (30 February, month 13) rolls over instead of failing, so
  // accept it only when it reads back unchanged.
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return undefined;
  }
  return date;
}

function requireDay(value: unknown): Date {
  const date = parseDayKey(value);
  if (!date) {
    throw new RangeError(`Expected a YYYY-MM-DD day, got ${String(value)}`);
  }
  return date;
}

function formatDayKey(date: Date): string {
  const year = date.getUTCFullYear();
  if (year < 1 || year > 9999) {
    throw new RangeError("The day is outside 0001-01-01 to 9999-12-31");
  }
  return [
    String(year).padStart(4, "0"),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

/** Moves a UTC-midnight date back to the first day of its period, in place. */
function toPeriodStart(horizon: PlannerHorizon, date: Date): Date {
  switch (horizon) {
    case "day":
      return date;
    case "week":
      // getUTCDay is 0 for Sunday, so this counts days since Monday.
      date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
      return date;
    case "month":
      date.setUTCDate(1);
      return date;
    default:
      throw new RangeError(`Unknown planner horizon: ${String(horizon)}`);
  }
}

/** True for a real calendar day written as `YYYY-MM-DD` (years 0001 to 9999). */
export function plannerIsValidDayKey(value: unknown): value is string {
  return parseDayKey(value) !== undefined;
}

/**
 * The first day of the period that contains `dayKey`: the day itself, the
 * Monday on or before it, or the 1st of its month. Throws a RangeError when
 * `dayKey` is not a valid day or `horizon` is unknown, so a bad value can never
 * be written as a period start.
 */
export function plannerPeriodStart(
  horizon: PlannerHorizon,
  dayKey: string,
): string {
  return formatDayKey(toPeriodStart(horizon, requireDay(dayKey)));
}

/**
 * The first day of the period after the one that contains `periodStart`. The
 * input is normally a period start already; any other day is first moved to its
 * own period start. Throws like `plannerPeriodStart`, and for the period after
 * 9999.
 */
export function plannerNextPeriodStart(
  horizon: PlannerHorizon,
  periodStart: string,
): string {
  const next = toPeriodStart(horizon, requireDay(periodStart));
  switch (horizon) {
    case "day":
      next.setUTCDate(next.getUTCDate() + 1);
      break;
    case "week":
      next.setUTCDate(next.getUTCDate() + 7);
      break;
    case "month":
      // Already the 1st, so the month step cannot overflow.
      next.setUTCMonth(next.getUTCMonth() + 1);
      break;
  }
  return formatDayKey(next);
}

/**
 * Whether the client's idea of "today" is plausible: within one day of the
 * server's UTC date. Local dates around the world span UTC-12 to UTC+14, so
 * they are always within a day of the UTC date. Anything else is a wrong clock
 * or a bad request. `serverNow` is a Date or epoch milliseconds.
 */
export function plannerTodayWithinBounds(
  clientToday: unknown,
  serverNow: Date | number,
): boolean {
  const client = parseDayKey(clientToday);
  if (!client) return false;
  const now = serverNow instanceof Date ? serverNow.getTime() : serverNow;
  if (!Number.isFinite(now)) return false;
  const serverDay = Math.floor(now / MS_PER_DAY) * MS_PER_DAY;
  return Math.abs(client.getTime() - serverDay) <= MS_PER_DAY;
}

// A due date is a bare `YYYY-MM-DD`, but a legacy row can carry a time after it
// (upstream's own `nextDayKey` says as much), so the day is read off the front.
const DAY_PREFIX = /^(\d{4}-\d{2}-\d{2})(?:[T ]|$)/;

/**
 * The calendar quarter a task falls in, written like "Q4 2026": the quarter of
 * its start date when it has one, otherwise of its due date, otherwise null. The
 * task panel shows it as a read-only property, so a task that starts or is due
 * in a quarter is grouped that way without anyone filling it in.
 *
 * Quarters are calendar quarters (January to March is Q1) and the maths is
 * UTC-only, like every other day maths here. A value that is not a real day (an
 * empty string, 30 February, a bare month) counts as absent, so a damaged start
 * date falls back to the due date instead of producing a wrong label.
 */
export function plannerQuarterLabel(input: {
  startDate?: string | null;
  dueAt?: string | null;
}): string | null {
  for (const value of [input.startDate, input.dueAt]) {
    const key = typeof value === "string" ? DAY_PREFIX.exec(value)?.[1] : null;
    const date = key ? parseDayKey(key) : undefined;
    if (date) {
      const quarter = Math.floor(date.getUTCMonth() / 3) + 1;
      return `Q${quarter} ${String(date.getUTCFullYear()).padStart(4, "0")}`;
    }
  }
  return null;
}
