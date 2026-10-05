import { describe, expect, it } from "vitest";
import {
  plannerDayDiff,
  plannerDayLong,
  plannerDayToDate,
  plannerDueLabel,
  plannerLocalDayOf,
  plannerMonthDay,
  plannerMonthLong,
  plannerMonthShort,
  plannerPlanLabel,
  plannerRelativeTime,
  plannerWeekdayShort,
} from "./dates";
import { plannerStringsFor } from "./strings";

const en = plannerStringsFor("en-US");
const zh = plannerStringsFor("zh-CN");

// Wednesday 7 October 2026; its week starts on Monday the 5th.
const TODAY = "2026-10-07";

describe("day maths", () => {
  it("reads a day key as UTC noon and counts whole days between two keys", () => {
    expect(plannerDayToDate("2026-10-07").toISOString()).toBe(
      "2026-10-07T12:00:00.000Z",
    );
    expect(plannerDayDiff("2026-10-07", "2026-10-07")).toBe(0);
    expect(plannerDayDiff("2026-10-07", "2026-10-14")).toBe(7);
    expect(plannerDayDiff("2026-10-07", "2026-10-01")).toBe(-6);
  });

  it("is not thrown off by a daylight saving change", () => {
    // Europe and the US both change the clocks across these dates.
    expect(plannerDayDiff("2026-03-28", "2026-03-30")).toBe(2);
    expect(plannerDayDiff("2026-10-24", "2026-11-02")).toBe(9);
    expect(plannerDayDiff("2028-02-28", "2028-03-01")).toBe(2);
  });

  it("names the local calendar day an instant falls on", () => {
    expect(plannerLocalDayOf(new Date(2026, 9, 5, 23, 59))).toBe("2026-10-05");
    expect(plannerLocalDayOf(new Date(2026, 9, 6, 0, 1))).toBe("2026-10-06");
  });
});

describe("date wording", () => {
  it("formats days and months in English from a key, whatever the machine's zone", () => {
    expect(plannerWeekdayShort("2026-10-07", "en-US")).toBe("Wed");
    expect(plannerMonthDay("2026-10-14", "en-US")).toBe("Oct 14");
    expect(plannerMonthDay("2027-01-05", "en-US", true)).toBe("Jan 5, 2027");
    expect(plannerMonthShort("2026-10-01", "en-US")).toBe("Oct");
    expect(plannerMonthShort("2027-01-01", "en-US", true)).toBe("Jan 2027");
    expect(plannerDayLong("2026-10-07", "en-US")).toBe("Wed, Oct 7, 2026");
    expect(plannerMonthLong("2026-10-01", "en-US")).toBe("October 2026");
  });

  it("formats days and months in Chinese", () => {
    expect(plannerWeekdayShort("2026-10-07", "zh-CN")).toBe("周三");
    expect(plannerMonthDay("2026-10-14", "zh-CN")).toBe("10月14日");
    expect(plannerMonthShort("2026-10-01", "zh-CN")).toBe("10月");
  });

  it("words a due date as month and day, with the year only when it is another year", () => {
    expect(plannerDueLabel("2026-10-17", TODAY, en)).toBe("Oct 17");
    expect(plannerDueLabel("2027-02-01", TODAY, en)).toBe("Feb 1, 2027");
    expect(plannerDueLabel("2026-10-17", TODAY, zh)).toBe("10月17日");
  });
});

describe("plannerPlanLabel", () => {
  const chip = (horizon: "day" | "week" | "month", start: string) =>
    plannerPlanLabel({ horizon, period_start: start }, TODAY, en)?.label;

  it("has nothing to say about no plan", () => {
    expect(
      plannerPlanLabel({ horizon: null, period_start: null }, TODAY, en),
    ).toBeNull();
    expect(
      plannerPlanLabel({ horizon: "day", period_start: null }, TODAY, en),
    ).toBeNull();
  });

  it("calls a day plan Today, Tomorrow or Yesterday by name", () => {
    expect(chip("day", "2026-10-07")).toBe("Today");
    expect(chip("day", "2026-10-08")).toBe("Tomorrow");
    expect(chip("day", "2026-10-06")).toBe("Yesterday");
  });

  it("calls the next few days by weekday and date, and never a past day by weekday", () => {
    expect(chip("day", "2026-10-09")).toBe("Fri 9");
    expect(chip("day", "2026-10-13")).toBe("Tue 13");
    // A week ahead is a plain date, not a weekday that could mean today's.
    expect(chip("day", "2026-10-14")).toBe("Oct 14");
    // A past day (a plan that missed its rollover) reads as a date.
    expect(chip("day", "2026-10-02")).toBe("Oct 2");
    expect(chip("day", "2027-01-05")).toBe("Jan 5, 2027");
  });

  it("calls a week plan This week, Next week or Last week, else Week of <Monday>", () => {
    expect(chip("week", "2026-10-05")).toBe("This week");
    expect(chip("week", "2026-10-12")).toBe("Next week");
    expect(chip("week", "2026-09-28")).toBe("Last week");
    expect(chip("week", "2026-10-26")).toBe("Week of Oct 26");
  });

  it("names a month plan by its month, with the year when it is not this one", () => {
    expect(chip("month", "2026-10-01")).toBe("Oct");
    expect(chip("month", "2026-11-01")).toBe("Nov");
    expect(chip("month", "2027-01-01")).toBe("Jan 2027");
  });

  it("keeps the week boundary on Monday across a month and a year", () => {
    // Thursday 31 December 2026: its week started Monday 28 December.
    const newYearsEve = "2026-12-31";
    const label = (start: string) =>
      plannerPlanLabel(
        { horizon: "week", period_start: start },
        newYearsEve,
        en,
      )?.label;
    expect(label("2026-12-28")).toBe("This week");
    expect(label("2027-01-04")).toBe("Next week");
  });

  it("words the same plans inside a sentence in the phrase style", () => {
    const phrase = (horizon: "day" | "week" | "month", start: string) =>
      plannerPlanLabel({ horizon, period_start: start }, TODAY, en, "phrase")
        ?.label;
    expect(phrase("day", "2026-10-07")).toBe("today");
    expect(phrase("day", "2026-10-08")).toBe("tomorrow");
    expect(phrase("week", "2026-10-05")).toBe("this week");
    expect(phrase("week", "2026-10-26")).toBe("the week of Oct 26");
    // Days and months read the same either way.
    expect(phrase("day", "2026-10-09")).toBe("Fri 9");
    expect(phrase("month", "2026-11-01")).toBe("Nov");
  });

  it("gives the exact period as the tooltip", () => {
    const title = (horizon: "day" | "week" | "month", start: string) =>
      plannerPlanLabel({ horizon, period_start: start }, TODAY, en)?.title;
    expect(title("day", "2026-10-08")).toBe("Thu, Oct 8, 2026");
    expect(title("week", "2026-10-05")).toBe("Week of Oct 5, 2026");
    expect(title("month", "2026-10-01")).toBe("October 2026");
  });

  it("speaks Chinese for zh-CN", () => {
    const label = (horizon: "day" | "week" | "month", start: string) =>
      plannerPlanLabel({ horizon, period_start: start }, TODAY, zh)?.label;
    expect(label("day", "2026-10-07")).toBe("今天");
    expect(label("day", "2026-10-08")).toBe("明天");
    expect(label("day", "2026-10-09")).toBe("周五 9日");
    expect(label("week", "2026-10-05")).toBe("本周");
    expect(label("week", "2026-10-12")).toBe("下周");
    expect(label("month", "2026-11-01")).toBe("11月");
  });
});

describe("plannerRelativeTime", () => {
  const now = new Date(2026, 9, 7, 12, 0, 0).getTime();
  const ago = (ms: number) => now - ms;
  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;

  it("says now for the last minute, and for a time slightly ahead of the clock", () => {
    expect(plannerRelativeTime(ago(20_000), now, "en-US")).toBe("now");
    expect(plannerRelativeTime(now + 5_000, now, "en-US")).toBe("now");
  });

  it("counts minutes, hours and days back", () => {
    expect(plannerRelativeTime(ago(MINUTE), now, "en-US")).toBe("1 minute ago");
    expect(plannerRelativeTime(ago(5 * MINUTE), now, "en-US")).toBe(
      "5 minutes ago",
    );
    expect(plannerRelativeTime(ago(3 * HOUR), now, "en-US")).toBe(
      "3 hours ago",
    );
    expect(plannerRelativeTime(ago(26 * HOUR), now, "en-US")).toBe("yesterday");
    expect(plannerRelativeTime(ago(3 * DAY), now, "en-US")).toBe("3 days ago");
  });

  it("switches to a plain date after a week, with the year when it is not this one", () => {
    expect(plannerRelativeTime(ago(10 * DAY), now, "en-US")).toBe("Sep 27");
    expect(
      plannerRelativeTime(new Date(2025, 11, 20, 12).getTime(), now, "en-US"),
    ).toBe("Dec 20, 2025");
  });

  it("returns nothing for a value that is not a time", () => {
    expect(plannerRelativeTime("not a time", now, "en-US")).toBe("");
  });

  it("speaks Chinese for zh-CN", () => {
    expect(plannerRelativeTime(ago(5 * MINUTE), now, "zh-CN")).toBe("5分钟前");
    expect(plannerRelativeTime(ago(3 * HOUR), now, "zh-CN")).toBe("3小时前");
  });
});
