import { type PlannerHorizon, plannerPeriodStart } from "@flaremo/contracts";
import { todayKey } from "@/lib/calendar-date";
import type { PlannerStrings } from "./strings";

// Day maths and date wording for the planning cockpit (fork-owned add-on,
// docs/planning-cockpit-implementation-plan.md, sections 4 and 5).
//
// Every day is a `YYYY-MM-DD` key, the calendar day as the person sees it. A key
// is turned into UTC noon and read back with UTC getters and `timeZone: "UTC"`
// formatters only, so the machine's zone and daylight saving can never move a
// plan to another day (the same rule as the contracts' period helpers).

const MS_PER_DAY = 86_400_000;

/** A day key as UTC noon. Noon, not midnight, keeps every zone offset on the day. */
export function plannerDayToDate(key: string): Date {
  return new Date(`${key}T12:00:00.000Z`);
}

/** Whole days from `from` to `to`: positive when `to` is later. */
export function plannerDayDiff(from: string, to: string): number {
  return Math.round(
    (plannerDayToDate(to).getTime() - plannerDayToDate(from).getTime()) /
      MS_PER_DAY,
  );
}

/** The local calendar day an instant falls on (what the person's clock said). */
export function plannerLocalDayOf(value: string | number | Date): string {
  return todayKey(new Date(value));
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function utcFormat(
  key: string,
  locale: string,
  options: Intl.DateTimeFormatOptions,
): string {
  const cacheKey = `${locale}|${JSON.stringify(options)}`;
  let formatter = formatters.get(cacheKey);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, {
      ...options,
      timeZone: "UTC",
    });
    formatters.set(cacheKey, formatter);
  }
  return formatter.format(plannerDayToDate(key));
}

const sameYear = (a: string, b: string) => a.slice(0, 4) === b.slice(0, 4);

/** "Wed" / "周三". */
export function plannerWeekdayShort(key: string, locale: string): string {
  return utcFormat(key, locale, { weekday: "short" });
}

/** "Oct 14" / "10月14日", with the year ("Oct 14, 2027") when asked. */
export function plannerMonthDay(
  key: string,
  locale: string,
  withYear = false,
): string {
  return utcFormat(key, locale, {
    month: "short",
    day: "numeric",
    ...(withYear ? { year: "numeric" } : {}),
  });
}

/** "Oct" / "10月", with the year ("Oct 2027") when asked. */
export function plannerMonthShort(
  key: string,
  locale: string,
  withYear = false,
): string {
  return utcFormat(key, locale, {
    month: "short",
    ...(withYear ? { year: "numeric" } : {}),
  });
}

/** "Wed, Oct 7, 2026": the tooltip for a day chip. */
export function plannerDayLong(key: string, locale: string): string {
  return utcFormat(key, locale, {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** "October 2026": the tooltip for a month chip. */
export function plannerMonthLong(key: string, locale: string): string {
  return utcFormat(key, locale, { year: "numeric", month: "long" });
}

/** Where a task is planned: the shape of a board card's plan and of event data. */
export type PlannerPlanPoint = {
  horizon: PlannerHorizon | null;
  period_start: string | null;
};

export type PlannerPlanLabel = {
  /** What the chip or phrase says. */
  label: string;
  /** The exact period, for a tooltip. */
  title: string;
};

/**
 * Words for a plan, relative to `today`, or null for no plan. In `chip` style
 * ("Today", "Tomorrow", "Wed 8", "This week", "Next week", "Oct") it is a card's
 * horizon chip; in `phrase` style it reads inside a sentence ("today", "this
 * week"). A history event passes the day it happened as `today`, so "Planned for
 * this week" keeps meaning the week it was planned in.
 *
 * - day: today, tomorrow and yesterday by name; the next few days by weekday and
 *   date ("Wed 8"); anything else by month and day ("Oct 14"). A past day is
 *   never called by its weekday, which would read as an upcoming one.
 * - week: this, next and last week by name, otherwise "Week of Oct 19".
 * - month: the month's short name ("Oct"), with the year when it is not this one.
 */
export function plannerPlanLabel(
  plan: PlannerPlanPoint,
  today: string,
  strings: PlannerStrings,
  style: "chip" | "phrase" = "chip",
): PlannerPlanLabel | null {
  if (plan.horizon === null || plan.period_start === null) return null;
  const locale = strings.intlLocale;
  const words = strings.plan[style];
  const start = plan.period_start;
  const otherYear = !sameYear(start, today);

  switch (plan.horizon) {
    case "day": {
      const diff = plannerDayDiff(today, start);
      let label: string;
      if (diff === 0) label = words.today;
      else if (diff === 1) label = words.tomorrow;
      else if (diff === -1) label = words.yesterday;
      else if (diff >= 2 && diff <= 6) {
        label = strings.plan.dayChip(
          plannerWeekdayShort(start, locale),
          plannerDayToDate(start).getUTCDate(),
        );
      } else label = plannerMonthDay(start, locale, otherYear);
      return { label, title: plannerDayLong(start, locale) };
    }
    case "week": {
      const diff = plannerDayDiff(plannerPeriodStart("week", today), start);
      const label =
        diff === 0
          ? words.thisWeek
          : diff === 7
            ? words.nextWeek
            : diff === -7
              ? words.lastWeek
              : words.weekOf(plannerMonthDay(start, locale, otherYear));
      return {
        label,
        title: strings.plan.chip.weekOf(plannerMonthDay(start, locale, true)),
      };
    }
    case "month":
      return {
        label: plannerMonthShort(start, locale, otherYear),
        title: plannerMonthLong(start, locale),
      };
    default:
      return null;
  }
}

/** A due date as a chip: month and day, with the year when it is not this one. */
export function plannerDueLabel(
  due: string,
  today: string,
  strings: PlannerStrings,
): string {
  return plannerMonthDay(due, strings.intlLocale, !sameYear(due, today));
}

/** A start date as a chip: "Oct 8", with the year when it is not this one. */
export function plannerStartLabel(
  start: string,
  today: string,
  strings: PlannerStrings,
): string {
  return plannerMonthDay(start, strings.intlLocale, !sameYear(start, today));
}

/** A task's time range, "Oct 8 → Oct 12": the start date, then the due date. */
export function plannerRangeLabel(
  start: string,
  due: string,
  today: string,
  strings: PlannerStrings,
): string {
  return `${plannerStartLabel(start, today, strings)} → ${plannerDueLabel(due, today, strings)}`;
}

const relativeFormatters = new Map<string, Intl.RelativeTimeFormat>();

/**
 * How long ago something happened, in words: "now", "5 minutes ago", "3 hours
 * ago", "yesterday", "4 days ago", then a plain date ("Oct 2", with the year when
 * it is not this one). A time ahead of `nowMs` (a clock a little off) reads as now.
 */
export function plannerRelativeTime(
  value: string | number | Date,
  nowMs: number,
  locale: string,
): string {
  const at = new Date(value).getTime();
  if (!Number.isFinite(at)) return "";
  let formatter = relativeFormatters.get(locale);
  if (!formatter) {
    formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
    relativeFormatters.set(locale, formatter);
  }
  const elapsed = Math.max(0, nowMs - at);
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return formatter.format(0, "second");
  if (minutes < 60) return formatter.format(-minutes, "minute");
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return formatter.format(-hours, "hour");
  const days = Math.floor(hours / 24);
  if (days < 7) return formatter.format(-days, "day");
  const day = plannerLocalDayOf(at);
  return plannerMonthDay(day, locale, !sameYear(day, plannerLocalDayOf(nowMs)));
}
