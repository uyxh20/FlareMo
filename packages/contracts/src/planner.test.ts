import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type PlannerHorizon,
  plannerHorizons,
  plannerIsValidDayKey,
  plannerIsValidLevel,
  plannerLevelPattern,
  plannerNextPeriodStart,
  plannerPeriodStart,
  plannerQuarterLabel,
  plannerTodayWithinBounds,
} from "./planner";

type PeriodCase = {
  name: string;
  day: string;
  weekStart: string;
  nextWeek: string;
  monthStart: string;
  nextMonth: string;
  nextDay: string;
};

// Every date is a real weekday written out by hand; the tests below also check
// that each expected week start is a Monday, so a typo here cannot pass quietly.
const PERIOD_CASES: PeriodCase[] = [
  {
    name: "EU spring forward, a Sunday",
    day: "2026-03-29",
    weekStart: "2026-03-23",
    nextWeek: "2026-03-30",
    monthStart: "2026-03-01",
    nextMonth: "2026-04-01",
    nextDay: "2026-03-30",
  },
  {
    name: "EU fall back, a Sunday",
    day: "2026-10-25",
    weekStart: "2026-10-19",
    nextWeek: "2026-10-26",
    monthStart: "2026-10-01",
    nextMonth: "2026-11-01",
    nextDay: "2026-10-26",
  },
  {
    name: "US spring forward, a Sunday",
    day: "2026-03-08",
    weekStart: "2026-03-02",
    nextWeek: "2026-03-09",
    monthStart: "2026-03-01",
    nextMonth: "2026-04-01",
    nextDay: "2026-03-09",
  },
  {
    name: "US fall back, a Sunday on the 1st",
    day: "2026-11-01",
    weekStart: "2026-10-26",
    nextWeek: "2026-11-02",
    monthStart: "2026-11-01",
    nextMonth: "2026-12-01",
    nextDay: "2026-11-02",
  },
  {
    name: "an ordinary Sunday belongs to the week before it",
    day: "2026-10-04",
    weekStart: "2026-09-28",
    nextWeek: "2026-10-05",
    monthStart: "2026-10-01",
    nextMonth: "2026-11-01",
    nextDay: "2026-10-05",
  },
  {
    name: "a Monday starts its own week",
    day: "2026-10-05",
    weekStart: "2026-10-05",
    nextWeek: "2026-10-12",
    monthStart: "2026-10-01",
    nextMonth: "2026-11-01",
    nextDay: "2026-10-06",
  },
  {
    name: "31-day month end",
    day: "2026-01-31",
    weekStart: "2026-01-26",
    nextWeek: "2026-02-02",
    monthStart: "2026-01-01",
    nextMonth: "2026-02-01",
    nextDay: "2026-02-01",
  },
  {
    name: "28-day February end",
    day: "2026-02-28",
    weekStart: "2026-02-23",
    nextWeek: "2026-03-02",
    monthStart: "2026-02-01",
    nextMonth: "2026-03-01",
    nextDay: "2026-03-01",
  },
  {
    name: "30-day month end",
    day: "2026-04-30",
    weekStart: "2026-04-27",
    nextWeek: "2026-05-04",
    monthStart: "2026-04-01",
    nextMonth: "2026-05-01",
    nextDay: "2026-05-01",
  },
  {
    name: "leap day, 29 Feb 2028",
    day: "2028-02-29",
    weekStart: "2028-02-28",
    nextWeek: "2028-03-06",
    monthStart: "2028-02-01",
    nextMonth: "2028-03-01",
    nextDay: "2028-03-01",
  },
  {
    name: "the day before a leap day",
    day: "2028-02-28",
    weekStart: "2028-02-28",
    nextWeek: "2028-03-06",
    monthStart: "2028-02-01",
    nextMonth: "2028-03-01",
    nextDay: "2028-02-29",
  },
  {
    name: "28 Feb of a common year, a Sunday",
    day: "2027-02-28",
    weekStart: "2027-02-22",
    nextWeek: "2027-03-01",
    monthStart: "2027-02-01",
    nextMonth: "2027-03-01",
    nextDay: "2027-03-01",
  },
  {
    name: "last day of the year",
    day: "2026-12-31",
    weekStart: "2026-12-28",
    nextWeek: "2027-01-04",
    monthStart: "2026-12-01",
    nextMonth: "2027-01-01",
    nextDay: "2027-01-01",
  },
  {
    name: "first day of the year, in a week that began last year",
    day: "2027-01-01",
    weekStart: "2026-12-28",
    nextWeek: "2027-01-04",
    monthStart: "2027-01-01",
    nextMonth: "2027-02-01",
    nextDay: "2027-01-02",
  },
  {
    name: "1 Jan 2025, a week that began in 2024",
    day: "2025-01-01",
    weekStart: "2024-12-30",
    nextWeek: "2025-01-06",
    monthStart: "2025-01-01",
    nextMonth: "2025-02-01",
    nextDay: "2025-01-02",
  },
  {
    name: "31 Dec 2024, a week that ends in 2025",
    day: "2024-12-31",
    weekStart: "2024-12-30",
    nextWeek: "2025-01-06",
    monthStart: "2024-12-01",
    nextMonth: "2025-01-01",
    nextDay: "2025-01-01",
  },
];

function weekdayOf(dayKey: string): number {
  return new Date(`${dayKey}T00:00:00Z`).getUTCDay();
}

function expectPeriodCase(c: PeriodCase) {
  expect(weekdayOf(c.weekStart), `${c.weekStart} is a Monday`).toBe(1);
  expect(plannerPeriodStart("day", c.day)).toBe(c.day);
  expect(plannerPeriodStart("week", c.day)).toBe(c.weekStart);
  expect(plannerPeriodStart("month", c.day)).toBe(c.monthStart);
  expect(plannerNextPeriodStart("day", c.day)).toBe(c.nextDay);
  expect(plannerNextPeriodStart("week", c.weekStart)).toBe(c.nextWeek);
  expect(plannerNextPeriodStart("month", c.monthStart)).toBe(c.nextMonth);
}

describe("plannerHorizons", () => {
  it("lists the three planning horizons", () => {
    expect([...plannerHorizons]).toEqual(["day", "week", "month"]);
  });
});

describe("plannerIsValidDayKey", () => {
  it("accepts real calendar days", () => {
    for (const day of [
      "2026-10-05",
      "2026-12-31",
      "2028-02-29",
      "2000-02-29",
      "0001-01-01",
      "0050-06-15",
      "9999-12-31",
    ]) {
      expect(plannerIsValidDayKey(day), day).toBe(true);
    }
  });

  it("rejects days that do not exist", () => {
    for (const day of [
      "2027-02-29",
      "2100-02-29",
      "2026-02-30",
      "2026-04-31",
      "2026-00-10",
      "2026-13-01",
      "2026-10-00",
      "2026-10-32",
      "0000-01-01",
    ]) {
      expect(plannerIsValidDayKey(day), day).toBe(false);
    }
  });

  it("rejects anything that is not exactly YYYY-MM-DD", () => {
    for (const value of [
      "",
      "2026-1-05",
      "2026-10-5",
      "26-10-05",
      "20261005",
      "2026/10/05",
      " 2026-10-05",
      "2026-10-05 ",
      "2026-10-05\n",
      "2026-10-05T00:00:00Z",
      "２０２６-10-05",
      "abcd-ef-gh",
      null,
      undefined,
      20261005,
      new Date(Date.UTC(2026, 9, 5)),
    ]) {
      expect(plannerIsValidDayKey(value), String(value)).toBe(false);
    }
  });
});

describe("plannerPeriodStart and plannerNextPeriodStart", () => {
  it.each(PERIOD_CASES)("$name ($day)", (c) => {
    expectPeriodCase(c);
  });

  it("moves every day of a week to the same Monday", () => {
    const days = [
      "2026-10-05",
      "2026-10-06",
      "2026-10-07",
      "2026-10-08",
      "2026-10-09",
      "2026-10-10",
      "2026-10-11",
    ];
    for (const day of days) {
      expect(plannerPeriodStart("week", day), day).toBe("2026-10-05");
      expect(plannerNextPeriodStart("week", day), day).toBe("2026-10-12");
    }
    expect(plannerPeriodStart("week", "2026-10-12")).toBe("2026-10-12");
  });

  it("moves every day of a month to the 1st", () => {
    expect(plannerPeriodStart("month", "2026-10-01")).toBe("2026-10-01");
    expect(plannerPeriodStart("month", "2026-10-17")).toBe("2026-10-01");
    expect(plannerPeriodStart("month", "2026-10-31")).toBe("2026-10-01");
    expect(plannerNextPeriodStart("month", "2026-10-17")).toBe("2026-11-01");
  });

  it("steps from a day that is not a period start to the next period", () => {
    // Wednesday 25 March 2026: the next week starts on Monday the 30th.
    expect(plannerNextPeriodStart("week", "2026-03-25")).toBe("2026-03-30");
    // 31 January must not overflow into March.
    expect(plannerNextPeriodStart("month", "2026-01-31")).toBe("2026-02-01");
    expect(plannerNextPeriodStart("month", "2028-01-31")).toBe("2028-02-01");
  });

  it("walks a leap February one day, one week and one month at a time", () => {
    expect(plannerNextPeriodStart("day", "2028-02-28")).toBe("2028-02-29");
    expect(plannerNextPeriodStart("day", "2028-02-29")).toBe("2028-03-01");
    expect(plannerNextPeriodStart("day", "2027-02-28")).toBe("2027-03-01");
    expect(plannerNextPeriodStart("month", "2028-02-01")).toBe("2028-03-01");
  });

  it("is idempotent and never moves a period start", () => {
    for (const horizon of plannerHorizons) {
      const start = plannerPeriodStart(horizon, "2026-10-17");
      expect(plannerPeriodStart(horizon, start)).toBe(start);
    }
  });

  it("handles the earliest and latest supported days", () => {
    // 0001-01-01 is a Monday, so no valid day has a period start before it.
    expect(plannerPeriodStart("week", "0001-01-01")).toBe("0001-01-01");
    expect(plannerPeriodStart("week", "0001-01-07")).toBe("0001-01-01");
    // Years below 100 stay in that century (Date.UTC would map them to 19xx).
    expect(plannerPeriodStart("month", "0050-06-15")).toBe("0050-06-01");
    expect(plannerNextPeriodStart("month", "0050-12-01")).toBe("0051-01-01");
    expect(plannerPeriodStart("week", "9999-12-31")).toBe("9999-12-27");
    expect(plannerNextPeriodStart("day", "9999-12-30")).toBe("9999-12-31");
  });

  it("throws a RangeError rather than writing a period past year 9999", () => {
    expect(() => plannerNextPeriodStart("day", "9999-12-31")).toThrow(
      RangeError,
    );
    expect(() => plannerNextPeriodStart("week", "9999-12-27")).toThrow(
      RangeError,
    );
    expect(() => plannerNextPeriodStart("month", "9999-12-01")).toThrow(
      RangeError,
    );
  });

  it("throws a RangeError for an invalid day or an unknown horizon", () => {
    expect(() => plannerPeriodStart("week", "2026-02-30")).toThrow(RangeError);
    expect(() => plannerPeriodStart("day", "")).toThrow(RangeError);
    expect(() => plannerPeriodStart("month", "2026-10-05T00:00:00Z")).toThrow(
      RangeError,
    );
    expect(() => plannerNextPeriodStart("week", "not-a-day")).toThrow(
      RangeError,
    );
    expect(() =>
      plannerPeriodStart("year" as PlannerHorizon, "2026-10-05"),
    ).toThrow(RangeError);
    expect(() =>
      plannerNextPeriodStart("year" as PlannerHorizon, "2026-10-05"),
    ).toThrow(RangeError);
  });

  it("agrees with an independent day-by-day calendar from 2024 to 2030", () => {
    // 2024-01-01 is a Monday, so a day's index modulo 7 is its weekday offset.
    const total = 2557;
    const days: string[] = [];
    const cursor = new Date("2024-01-01T00:00:00Z");
    for (let i = 0; i < total; i++) {
      days.push(cursor.toISOString().slice(0, 10));
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    expect(days.at(-1)).toBe("2030-12-31");

    const monthStarts: string[] = [];
    let monthStart = "";
    for (const day of days) {
      if (day.endsWith("-01")) monthStart = day;
      monthStarts.push(monthStart);
    }
    const nextMonthStarts: string[] = [];
    let upcoming = "";
    for (let i = days.length - 1; i >= 0; i--) {
      nextMonthStarts[i] = upcoming;
      if (days[i]?.endsWith("-01")) upcoming = days[i] ?? "";
    }
    const expected = {
      week: days.map((_, i) => days[i - (i % 7)]),
      nextWeek: days.map((_, i) => days[i - (i % 7) + 7]),
      month: monthStarts,
      nextMonth: nextMonthStarts,
      nextDay: days.map((_, i) => days[i + 1]),
    };
    // The last weeks and months have no later day to look ahead to.
    const checked = days.length - 40;
    const head = <T>(values: T[]) => values.slice(0, checked);
    const input = head(days);
    const startOf = (horizon: PlannerHorizon) =>
      input.map((day) => plannerPeriodStart(horizon, day));
    const nextOf = (horizon: PlannerHorizon) =>
      input.map((day) => plannerNextPeriodStart(horizon, day));

    expect(startOf("day")).toEqual(input);
    expect(startOf("week")).toEqual(head(expected.week));
    expect(startOf("month")).toEqual(head(expected.month));
    expect(nextOf("day")).toEqual(head(expected.nextDay));
    expect(nextOf("week")).toEqual(head(expected.nextWeek));
    expect(nextOf("month")).toEqual(head(expected.nextMonth));
    for (const day of [...startOf("week"), ...nextOf("month")]) {
      expect(plannerIsValidDayKey(day), day).toBe(true);
    }
  });
});

describe("plannerTodayWithinBounds", () => {
  const at = (iso: string) => new Date(iso);

  it("accepts the server's UTC date and one day either side", () => {
    const now = at("2026-10-05T12:00:00Z");
    for (const day of ["2026-10-04", "2026-10-05", "2026-10-06"]) {
      expect(plannerTodayWithinBounds(day, now), day).toBe(true);
    }
    for (const day of [
      "2026-10-03",
      "2026-10-07",
      "2026-09-05",
      "2025-10-05",
      "2027-10-05",
    ]) {
      expect(plannerTodayWithinBounds(day, now), day).toBe(false);
    }
  });

  it("follows the server's UTC date at the edges of the day", () => {
    const lastMs = at("2026-10-05T23:59:59.999Z");
    expect(plannerTodayWithinBounds("2026-10-06", lastMs)).toBe(true);
    expect(plannerTodayWithinBounds("2026-10-07", lastMs)).toBe(false);
    const midnight = at("2026-10-06T00:00:00.000Z");
    expect(plannerTodayWithinBounds("2026-10-07", midnight)).toBe(true);
    expect(plannerTodayWithinBounds("2026-10-04", midnight)).toBe(false);
  });

  it("crosses month, year and leap-day boundaries", () => {
    const monthEnd = at("2026-10-31T10:00:00Z");
    expect(plannerTodayWithinBounds("2026-11-01", monthEnd)).toBe(true);
    expect(plannerTodayWithinBounds("2026-11-02", monthEnd)).toBe(false);
    const newYear = at("2027-01-01T01:00:00Z");
    expect(plannerTodayWithinBounds("2026-12-31", newYear)).toBe(true);
    expect(plannerTodayWithinBounds("2026-12-30", newYear)).toBe(false);
    const leapDay = at("2028-02-29T10:00:00Z");
    expect(plannerTodayWithinBounds("2028-02-28", leapDay)).toBe(true);
    expect(plannerTodayWithinBounds("2028-03-01", leapDay)).toBe(true);
    expect(plannerTodayWithinBounds("2028-03-02", leapDay)).toBe(false);
    const afterLeapDay = at("2028-03-01T10:00:00Z");
    expect(plannerTodayWithinBounds("2028-02-29", afterLeapDay)).toBe(true);
    expect(plannerTodayWithinBounds("2028-02-28", afterLeapDay)).toBe(false);
  });

  it("accepts epoch milliseconds as the server clock", () => {
    const now = Date.UTC(2026, 9, 5, 12);
    expect(plannerTodayWithinBounds("2026-10-06", now)).toBe(true);
    expect(plannerTodayWithinBounds("2026-10-07", now)).toBe(false);
  });

  it("accepts the local date of every real time zone at any hour", () => {
    // Local dates range from UTC-12 to UTC+14, a spread of 26 hours, so each is
    // within a day of the UTC date. Includes the half and quarter-hour zones.
    const offsetsInHours = [
      -12, -9.5, -8, -3.5, 0, 1, 5.5, 5.75, 8, 9.5, 12, 12.75, 13, 14,
    ];
    const start = Date.UTC(2026, 9, 5);
    for (let hour = 0; hour < 72; hour++) {
      const now = start + hour * 3_600_000;
      for (const offset of offsetsInHours) {
        const local = new Date(now + offset * 3_600_000)
          .toISOString()
          .slice(0, 10);
        expect(
          plannerTodayWithinBounds(local, now),
          `${local} at +${hour}h`,
        ).toBe(true);
      }
    }
  });

  it("rejects a malformed day or an unusable server clock", () => {
    const now = at("2026-10-05T12:00:00Z");
    for (const value of [
      "",
      "2026-10-5",
      "2026-02-30",
      "2026-10-05T12:00:00Z",
      null,
      undefined,
      20261005,
    ]) {
      expect(plannerTodayWithinBounds(value, now), String(value)).toBe(false);
    }
    expect(plannerTodayWithinBounds("2026-10-05", new Date(Number.NaN))).toBe(
      false,
    );
    expect(plannerTodayWithinBounds("2026-10-05", Number.NaN)).toBe(false);
    expect(
      plannerTodayWithinBounds("2026-10-05", Number.POSITIVE_INFINITY),
    ).toBe(false);
  });
});

describe("plannerIsValidLevel", () => {
  it("accepts lowercase slugs of 1 to 24 characters", () => {
    for (const level of [
      "area",
      "year",
      "quarter",
      "goal",
      "milestone",
      "a",
      "q1",
      "key-result",
      "a-b-c",
      `a${"b".repeat(23)}`,
    ]) {
      expect(plannerIsValidLevel(level), level).toBe(true);
    }
  });

  it("rejects everything else", () => {
    for (const level of [
      "",
      "1a",
      "-a",
      "A",
      "Goal",
      "go al",
      "go_al",
      "go.al",
      "gôal",
      "goal\n",
      " goal",
      `a${"b".repeat(24)}`,
      null,
      undefined,
      5,
      ["goal"],
    ]) {
      expect(plannerIsValidLevel(level), String(level)).toBe(false);
    }
  });

  it("exposes the pattern for request schemas", () => {
    expect(plannerLevelPattern.source).toBe("^[a-z][a-z0-9-]{0,23}$");
  });
});

describe("plannerQuarterLabel", () => {
  const label = (startDate?: string | null, dueAt?: string | null) =>
    plannerQuarterLabel({ startDate, dueAt });

  it("names the calendar quarter of the start date", () => {
    expect(label("2026-10-05")).toBe("Q4 2026");
    expect(label("2026-01-01")).toBe("Q1 2026");
    expect(label("2027-05-17")).toBe("Q2 2027");
    expect(label("2026-08-31")).toBe("Q3 2026");
  });

  it("changes quarter exactly on the first day of January, April, July and October", () => {
    const edges: Array<[string, string]> = [
      ["2026-03-31", "Q1 2026"],
      ["2026-04-01", "Q2 2026"],
      ["2026-06-30", "Q2 2026"],
      ["2026-07-01", "Q3 2026"],
      ["2026-09-30", "Q3 2026"],
      ["2026-10-01", "Q4 2026"],
      ["2026-12-31", "Q4 2026"],
      ["2027-01-01", "Q1 2027"],
    ];
    for (const [day, expected] of edges) {
      expect(label(day), day).toBe(expected);
    }
  });

  it("takes a month plan's first day, a week plan's Monday and a day plan's day", () => {
    // A month plan starts on the 1st.
    expect(label(plannerPeriodStart("month", "2026-11-18"))).toBe("Q4 2026");
    // The week of Monday 28 September is in Q3, though most of its days are in
    // October: a period belongs to the quarter its first day is in.
    expect(plannerPeriodStart("week", "2026-10-01")).toBe("2026-09-28");
    expect(label(plannerPeriodStart("week", "2026-10-01"))).toBe("Q3 2026");
    expect(label(plannerPeriodStart("day", "2026-10-01"))).toBe("Q4 2026");
  });

  it("uses the due date when there is no start date", () => {
    expect(label(null, "2026-02-14")).toBe("Q1 2026");
    expect(label(undefined, "2027-12-25")).toBe("Q4 2027");
    expect(label(undefined, "2026-07-04")).toBe("Q3 2026");
  });

  it("prefers the start date over the due date, whatever the due date says", () => {
    expect(label("2026-10-05", "2026-01-15")).toBe("Q4 2026");
    expect(label("2026-04-06", "2027-12-31")).toBe("Q2 2026");
  });

  it("is null with neither", () => {
    expect(label()).toBeNull();
    expect(label(null, null)).toBeNull();
    expect(plannerQuarterLabel({})).toBeNull();
  });

  it("treats a value that is not a real day as absent, so it falls back instead of guessing", () => {
    for (const bad of [
      "",
      " ",
      "2026-13-01",
      "2026-02-30",
      "2027-02-29",
      "2026-10",
      "2026-10-5",
      "tomorrow",
      "10/05/2026",
      "0000-01-01",
    ]) {
      expect(label(bad), bad).toBeNull();
      // ...and a good due date still wins over a damaged plan period.
      expect(label(bad, "2026-11-02"), bad).toBe("Q4 2026");
      // A damaged due date does not hide a good plan period either.
      expect(label("2026-05-04", bad), bad).toBe("Q2 2026");
    }
  });

  it("reads the day off a legacy due date that carries a time", () => {
    expect(label(null, "2026-10-05T00:00:00.000Z")).toBe("Q4 2026");
    expect(label(null, "2026-03-31 23:59:59")).toBe("Q1 2026");
    // Not a time, just junk after a day: not accepted.
    expect(label(null, "2026-10-05garbage")).toBeNull();
  });

  it("handles a leap day, and pads an early year like the day keys do", () => {
    expect(label("2028-02-29")).toBe("Q1 2028");
    expect(label("0005-06-07")).toBe("Q2 0005");
  });
});

// A bug that reads local time (a date-only string parsed as UTC but read with
// local getters, or the reverse) only shows in a zone other than the machine's,
// and CI usually runs in UTC. So repeat the hard cases in zones on both sides of
// UTC, with and without daylight saving.
describe("time zone independence", () => {
  const zones: Array<[zone: string, januaryOffsetMinutes: number]> = [
    ["America/Los_Angeles", 480],
    ["Europe/Berlin", -60],
    ["Asia/Shanghai", -480],
    ["Pacific/Auckland", -780],
    ["Pacific/Kiritimati", -840],
    ["Etc/GMT+12", 720],
  ];

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(zones)("gives the same answers in %s", (zone, januaryOffset) => {
    vi.stubEnv("TZ", zone);
    // Node re-reads TZ when it is assigned. If this runner did not honour it
    // the cases below would pass without proving anything, so fail instead.
    expect(
      new Date(Date.UTC(2026, 0, 15, 12)).getTimezoneOffset(),
      `TZ=${zone} did not take effect in this runner`,
    ).toBe(januaryOffset);

    for (const c of PERIOD_CASES) expectPeriodCase(c);
    expect(plannerQuarterLabel({ startDate: "2026-10-01" })).toBe("Q4 2026");
    expect(plannerQuarterLabel({ dueAt: "2026-09-30" })).toBe("Q3 2026");
    expect(plannerIsValidDayKey("2028-02-29")).toBe(true);
    expect(plannerIsValidDayKey("2027-02-29")).toBe(false);
    const now = new Date("2026-10-05T12:00:00Z");
    expect(plannerTodayWithinBounds("2026-10-04", now)).toBe(true);
    expect(plannerTodayWithinBounds("2026-10-06", now)).toBe(true);
    expect(plannerTodayWithinBounds("2026-10-07", now)).toBe(false);
  });
});
