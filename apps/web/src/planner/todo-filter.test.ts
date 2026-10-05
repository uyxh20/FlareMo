import type { PlannerBoardCard } from "@flaremo/contracts";
import { describe, expect, it } from "vitest";
import {
  type PlannerHorizonFilter,
  plannerFilterPeriod,
  plannerFilterTodo,
  plannerHorizonFilters,
  plannerPlanInFilter,
  plannerTodoCounts,
} from "./todo-filter";

type Plan = Pick<PlannerBoardCard, "horizon" | "period_start"> & { id: string };

const day = (date: string): Plan => ({
  id: `day ${date}`,
  horizon: "day",
  period_start: date,
});
const week = (monday: string): Plan => ({
  id: `week ${monday}`,
  horizon: "week",
  period_start: monday,
});
const month = (first: string): Plan => ({
  id: `month ${first}`,
  horizon: "month",
  period_start: first,
});

/** The ids a chip shows, in the order the cards were given. */
const shown = (
  plans: readonly Plan[],
  filter: PlannerHorizonFilter,
  today: string,
) => plannerFilterTodo(plans, filter, today).map((plan) => plan.id);

/** All four chips at once, to read a whole scenario in one place. */
const everyChip = (plans: readonly Plan[], today: string) => ({
  day: shown(plans, "day", today),
  week: shown(plans, "week", today),
  month: shown(plans, "month", today),
  all: shown(plans, "all", today),
});

describe("the To Do chips, on an ordinary Wednesday", () => {
  // Wednesday 7 October 2026: the week is Mon 5 to Sun 11 October.
  const today = "2026-10-07";
  const plans = [
    day("2026-10-07"),
    day("2026-10-08"), // tomorrow
    day("2026-10-11"), // Sunday, the last day of this week
    day("2026-10-12"), // next Monday
    day("2026-11-02"),
    week("2026-10-05"), // this week
    week("2026-10-12"), // next week
    week("2026-11-02"),
    month("2026-10-01"), // this month
    month("2026-11-01"), // next month
  ];

  it("Today is the day plans dated today, and nothing else", () => {
    expect(shown(plans, "day", today)).toEqual(["day 2026-10-07"]);
  });

  it("This week is the days of this week plus this week's week plan", () => {
    expect(shown(plans, "week", today)).toEqual([
      "day 2026-10-07",
      "day 2026-10-08",
      "day 2026-10-11",
      "week 2026-10-05",
    ]);
  });

  it("This month is the days, the weeks that start, and the month plan of this month", () => {
    expect(shown(plans, "month", today)).toEqual([
      "day 2026-10-07",
      "day 2026-10-08",
      "day 2026-10-11",
      "day 2026-10-12",
      "week 2026-10-05",
      "week 2026-10-12",
      "month 2026-10-01",
    ]);
  });

  it("All is everything, in the order it was given", () => {
    expect(shown(plans, "all", today)).toEqual(plans.map((plan) => plan.id));
  });

  it("does not show Tomorrow, Next week or Next month under Today", () => {
    const underToday = shown(plans, "day", today);
    expect(underToday).not.toContain("day 2026-10-08");
    expect(underToday).not.toContain("week 2026-10-12");
    expect(underToday).not.toContain("month 2026-11-01");
  });

  it("does not show Next week or Next month's plans as this week's", () => {
    const underWeek = shown(plans, "week", today);
    expect(underWeek).not.toContain("week 2026-10-12");
    expect(underWeek).not.toContain("day 2026-10-12");
    expect(underWeek).not.toContain("month 2026-11-01");
  });

  it("counts what each chip shows", () => {
    expect(plannerTodoCounts(plans, today)).toEqual({
      all: 10,
      day: 1,
      week: 4,
      month: 7,
    });
  });
});

describe("a Sunday", () => {
  // Sunday 11 October 2026: tomorrow is Monday, in next week.
  const today = "2026-10-11";
  const plans = [
    day("2026-10-11"),
    day("2026-10-12"), // tomorrow
    day("2026-10-05"), // Monday of this week, already gone
    week("2026-10-05"),
    week("2026-10-12"), // next week
    month("2026-10-01"),
  ];

  it("keeps Tomorrow and Next week out of This week", () => {
    expect(everyChip(plans, today)).toEqual({
      day: ["day 2026-10-11"],
      week: ["day 2026-10-11", "day 2026-10-05", "week 2026-10-05"],
      month: [
        "day 2026-10-11",
        "day 2026-10-12",
        "day 2026-10-05",
        "week 2026-10-05",
        "week 2026-10-12",
        "month 2026-10-01",
      ],
      all: plans.map((plan) => plan.id),
    });
  });

  it("shows the same Tomorrow under This week the day before, when it is still this week", () => {
    // Saturday 10 October: tomorrow is Sunday the 11th, the last day of the week.
    expect(shown(plans, "week", "2026-10-10")).toContain("day 2026-10-11");
    expect(shown(plans, "week", "2026-10-10")).not.toContain("day 2026-10-12");
  });

  it("counts a Sunday the same way", () => {
    expect(plannerTodoCounts(plans, today)).toEqual({
      all: 6,
      day: 1,
      week: 3,
      month: 6,
    });
  });
});

describe("the end of a month", () => {
  // Saturday 31 October 2026. Its week, Mon 26 Oct to Sun 1 Nov, spans two months.
  const today = "2026-10-31";
  const plans = [
    day("2026-10-31"),
    day("2026-11-01"), // tomorrow: this week, but already November
    day("2026-11-02"), // Monday: next week
    week("2026-10-26"), // this week
    week("2026-11-02"), // next week
    month("2026-10-01"),
    month("2026-11-01"), // next month
  ];

  it("keeps tomorrow and next month out of This month", () => {
    expect(everyChip(plans, today)).toEqual({
      day: ["day 2026-10-31"],
      week: ["day 2026-10-31", "day 2026-11-01", "week 2026-10-26"],
      month: ["day 2026-10-31", "week 2026-10-26", "month 2026-10-01"],
      all: plans.map((plan) => plan.id),
    });
  });

  it("starts a new month on the 1st", () => {
    // Sunday 1 November: still the same week, now November.
    expect(everyChip(plans, "2026-11-01")).toEqual({
      day: ["day 2026-11-01"],
      week: ["day 2026-10-31", "day 2026-11-01", "week 2026-10-26"],
      month: [
        "day 2026-11-01",
        "day 2026-11-02",
        "week 2026-11-02",
        "month 2026-11-01",
      ],
      all: plans.map((plan) => plan.id),
    });
  });
});

describe("a week that spans two months", () => {
  // Mon 28 September to Sun 4 October 2026.
  const plans = [
    day("2026-09-30"),
    day("2026-10-02"),
    week("2026-09-28"), // this week, filed under September: its Monday
    week("2026-10-05"), // next week, filed under October
    month("2026-09-01"),
    month("2026-10-01"),
  ];

  it("shows the whole week under This week from either side of the boundary", () => {
    const september = shown(plans, "week", "2026-09-30");
    const october = shown(plans, "week", "2026-10-02");
    const expected = ["day 2026-09-30", "day 2026-10-02", "week 2026-09-28"];
    expect(september).toEqual(expected);
    expect(october).toEqual(expected);
  });

  it("files the week plan under the month of its Monday", () => {
    // Wednesday 30 September: September is the month.
    expect(shown(plans, "month", "2026-09-30")).toEqual([
      "day 2026-09-30",
      "week 2026-09-28",
      "month 2026-09-01",
    ]);
    // Friday 2 October: October is the month, and the week that began in
    // September is no longer in it. Its day plan of 30 September is not either.
    expect(shown(plans, "month", "2026-10-02")).toEqual([
      "day 2026-10-02",
      "week 2026-10-05",
      "month 2026-10-01",
    ]);
  });

  it("shows only a day plan dated today under Today", () => {
    expect(shown(plans, "day", "2026-09-30")).toEqual(["day 2026-09-30"]);
    expect(shown(plans, "day", "2026-10-02")).toEqual(["day 2026-10-02"]);
  });

  it("gives the period each chip covers", () => {
    expect(plannerFilterPeriod("week", "2026-09-30")).toEqual({
      from: "2026-09-28",
      to: "2026-10-05",
    });
    expect(plannerFilterPeriod("week", "2026-10-02")).toEqual({
      from: "2026-09-28",
      to: "2026-10-05",
    });
    expect(plannerFilterPeriod("month", "2026-09-30")).toEqual({
      from: "2026-09-01",
      to: "2026-10-01",
    });
  });
});

describe("a week that spans two years", () => {
  // Thursday 31 December 2026; the week is Mon 28 December to Sun 3 January.
  const today = "2026-12-31";
  const plans = [
    day("2026-12-31"),
    day("2027-01-01"),
    week("2026-12-28"),
    week("2027-01-04"),
    month("2026-12-01"),
    month("2027-01-01"),
  ];

  it("reads the dates across the new year", () => {
    expect(everyChip(plans, today)).toEqual({
      day: ["day 2026-12-31"],
      week: ["day 2026-12-31", "day 2027-01-01", "week 2026-12-28"],
      month: ["day 2026-12-31", "week 2026-12-28", "month 2026-12-01"],
      all: plans.map((plan) => plan.id),
    });
  });
});

describe("the period a chip covers", () => {
  it("is the day, the Monday-to-Sunday week and the calendar month, end exclusive", () => {
    expect(plannerFilterPeriod("day", "2026-10-07")).toEqual({
      from: "2026-10-07",
      to: "2026-10-08",
    });
    expect(plannerFilterPeriod("week", "2026-10-07")).toEqual({
      from: "2026-10-05",
      to: "2026-10-12",
    });
    expect(plannerFilterPeriod("week", "2026-10-11")).toEqual({
      from: "2026-10-05",
      to: "2026-10-12",
    });
    expect(plannerFilterPeriod("week", "2026-10-12")).toEqual({
      from: "2026-10-12",
      to: "2026-10-19",
    });
    expect(plannerFilterPeriod("month", "2026-10-07")).toEqual({
      from: "2026-10-01",
      to: "2026-11-01",
    });
  });

  it("knows a leap February", () => {
    expect(plannerFilterPeriod("month", "2028-02-29")).toEqual({
      from: "2028-02-01",
      to: "2028-03-01",
    });
  });
});

describe("plans that are not a normal day, week or month plan", () => {
  const today = "2026-10-07";
  const damaged: Plan[] = [
    { id: "no plan", horizon: null, period_start: null },
    { id: "horizon only", horizon: "day", period_start: null },
    { id: "start only", horizon: null, period_start: today },
    // A horizon a later server might add: no chip claims it.
    { id: "unknown", horizon: "quarter" as never, period_start: today },
  ];

  it("shows them under All and under no other chip", () => {
    expect(shown(damaged, "all", today)).toEqual(
      damaged.map((plan) => plan.id),
    );
    for (const chip of ["day", "week", "month"] as const) {
      expect(shown(damaged, chip, today)).toEqual([]);
    }
    expect(plannerTodoCounts(damaged, today)).toEqual({
      all: 4,
      day: 0,
      week: 0,
      month: 0,
    });
  });
});

describe("plannerPlanInFilter", () => {
  const today = "2026-10-07";

  it("answers for a single plan", () => {
    expect(plannerPlanInFilter(day(today), "day", today)).toBe(true);
    expect(plannerPlanInFilter(day("2026-10-08"), "day", today)).toBe(false);
    expect(plannerPlanInFilter(week("2026-10-05"), "day", today)).toBe(false);
    expect(plannerPlanInFilter(week("2026-10-05"), "week", today)).toBe(true);
    expect(plannerPlanInFilter(month("2026-10-01"), "week", today)).toBe(false);
    expect(plannerPlanInFilter(month("2026-10-01"), "month", today)).toBe(true);
    expect(plannerPlanInFilter(month("2026-11-01"), "all", today)).toBe(true);
  });
});

describe("plannerFilterTodo and plannerTodoCounts", () => {
  const today = "2026-10-07";

  it("returns a new array even when nothing is filtered, and leaves its input alone", () => {
    const plans = [day(today), week("2026-10-05")];
    const copy = [...plans];
    expect(plannerFilterTodo(plans, "all", today)).not.toBe(plans);
    expect(plannerFilterTodo(plans, "day", today)).not.toBe(plans);
    expect(plans).toEqual(copy);
  });

  it("hands back the cards themselves, whatever else they carry", () => {
    const card = { ...day(today), title: "Write" };
    expect(plannerFilterTodo([card], "day", today)[0]).toBe(card);
  });

  it("counts an empty column as zero", () => {
    expect(plannerTodoCounts([], today)).toEqual({
      all: 0,
      day: 0,
      week: 0,
      month: 0,
    });
  });

  it("lists the chips in order", () => {
    expect(plannerHorizonFilters).toEqual(["all", "day", "week", "month"]);
  });
});

describe("the chips against an independent reading of the calendar", () => {
  // Plain string and Date maths, none of the code under test: Monday of a day's
  // week, and the YYYY-MM a day or a period start is in.
  const mondayOf = (key: string) => {
    const date = new Date(`${key}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
    return date.toISOString().slice(0, 10);
  };
  const monthOf = (key: string) => key.slice(0, 7);
  const addDays = (key: string, days: number) => {
    const date = new Date(`${key}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
  };

  function inside(
    plan: Plan,
    filter: PlannerHorizonFilter,
    today: string,
  ): boolean {
    if (filter === "all") return true;
    const start = plan.period_start as string;
    switch (plan.horizon) {
      case "day":
        if (filter === "day") return start === today;
        if (filter === "week") return mondayOf(start) === mondayOf(today);
        return monthOf(start) === monthOf(today);
      case "week":
        if (filter === "day") return false;
        if (filter === "week") return start === mondayOf(today);
        return monthOf(start) === monthOf(today);
      default:
        return filter === "month" && monthOf(start) === monthOf(today);
    }
  }

  /** Every kind of plan from a few weeks back to a few months ahead. */
  function plansAround(today: string): Plan[] {
    const plans: Plan[] = [];
    for (let offset = -10; offset <= 45; offset += 1) {
      plans.push(day(addDays(today, offset)));
    }
    for (let offset = -3; offset <= 10; offset += 1) {
      plans.push(week(addDays(mondayOf(today), offset * 7)));
    }
    for (let offset = -3; offset <= 3; offset += 1) {
      const date = new Date(`${today}T00:00:00Z`);
      date.setUTCDate(1);
      date.setUTCMonth(date.getUTCMonth() + offset);
      plans.push(month(date.toISOString().slice(0, 10)));
    }
    return plans;
  }

  // Every day from the start of 2026 into early 2027: every weekday, every
  // month end, the year boundary and all the weeks that span two months.
  const todays: string[] = [];
  for (let key = "2026-01-01"; key <= "2027-02-01"; key = addDays(key, 1)) {
    todays.push(key);
  }

  it("shows exactly the plans the calendar puts inside each period, every day of the year", () => {
    for (const today of todays) {
      const plans = plansAround(today);
      for (const filter of plannerHorizonFilters) {
        const expected = plans
          .filter((plan) => inside(plan, filter, today))
          .map((plan) => plan.id);
        expect(shown(plans, filter, today), `${filter} on ${today}`).toEqual(
          expected,
        );
      }
    }
  });

  it("counts exactly what each chip shows, every day of the year", () => {
    for (const today of todays) {
      const plans = plansAround(today);
      const counts = plannerTodoCounts(plans, today);
      for (const filter of plannerHorizonFilters) {
        expect(counts[filter], `${filter} on ${today}`).toBe(
          shown(plans, filter, today).length,
        );
      }
    }
  });

  it("nests Today in This week in This month whenever the week lies inside one month", () => {
    for (const today of todays) {
      const plans = plansAround(today);
      const inToday = shown(plans, "day", today);
      const inWeek = shown(plans, "week", today);
      const inMonth = shown(plans, "month", today);
      const all = shown(plans, "all", today);
      // Today is always inside its own week and its own month.
      expect(inWeek, today).toEqual(expect.arrayContaining(inToday));
      expect(inMonth, today).toEqual(expect.arrayContaining(inToday));
      // The week is inside the month unless it straddles a month end.
      const monday = mondayOf(today);
      if (monthOf(monday) === monthOf(addDays(monday, 6))) {
        expect(inMonth, today).toEqual(expect.arrayContaining(inWeek));
      }
      expect(all, today).toEqual(expect.arrayContaining(inMonth));
      expect(all, today).toEqual(expect.arrayContaining(inWeek));
    }
  });
});
