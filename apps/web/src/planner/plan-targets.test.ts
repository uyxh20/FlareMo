import { plannerPeriodStart } from "@flaremo/contracts";
import { describe, expect, it } from "vitest";
import {
  plannerPlanForDay,
  plannerPlanOptionKeys,
  plannerPlanOptionOf,
  plannerPlanTarget,
  plannerQuickAddChoices,
  plannerQuickAddPlan,
} from "./plan-targets";

// Wednesday 7 October 2026: its week starts Monday the 5th, its month the 1st.
const TODAY = "2026-10-07";

describe("plannerPlanTarget", () => {
  it("plans a day for today and for tomorrow", () => {
    expect(plannerPlanTarget("today", TODAY)).toEqual({
      horizon: "day",
      day: "2026-10-07",
    });
    expect(plannerPlanTarget("tomorrow", TODAY)).toEqual({
      horizon: "day",
      day: "2026-10-08",
    });
  });

  it("plans this week and next week on Mondays", () => {
    expect(plannerPlanTarget("thisWeek", TODAY)).toEqual({
      horizon: "week",
      day: "2026-10-05",
    });
    expect(plannerPlanTarget("nextWeek", TODAY)).toEqual({
      horizon: "week",
      day: "2026-10-12",
    });
  });

  it("plans this month and next month on the 1st", () => {
    expect(plannerPlanTarget("thisMonth", TODAY)).toEqual({
      horizon: "month",
      day: "2026-10-01",
    });
    expect(plannerPlanTarget("nextMonth", TODAY)).toEqual({
      horizon: "month",
      day: "2026-11-01",
    });
  });

  it("counts from the local today across the end of a week, a month and a year", () => {
    // Sunday 29 November 2026 is the last day of its week (Monday the 23rd).
    expect(plannerPlanTarget("thisWeek", "2026-11-29").day).toBe("2026-11-23");
    expect(plannerPlanTarget("nextWeek", "2026-11-29").day).toBe("2026-11-30");
    // Thursday 31 December 2026.
    expect(plannerPlanTarget("tomorrow", "2026-12-31").day).toBe("2027-01-01");
    expect(plannerPlanTarget("nextWeek", "2026-12-31").day).toBe("2027-01-04");
    expect(plannerPlanTarget("nextMonth", "2026-12-31").day).toBe("2027-01-01");
    // 29 February in a leap year.
    expect(plannerPlanTarget("tomorrow", "2028-02-29").day).toBe("2028-03-01");
    expect(plannerPlanTarget("nextMonth", "2028-01-31").day).toBe("2028-02-01");
  });

  it("never names a period before the one that contains today", () => {
    for (const today of [
      "2026-10-05",
      "2026-10-11",
      "2026-10-31",
      "2026-02-28",
    ]) {
      for (const key of plannerPlanOptionKeys) {
        const { horizon, day } = plannerPlanTarget(key, today);
        expect(
          plannerPeriodStart(horizon, day) >=
            plannerPeriodStart(horizon, today),
        ).toBe(true);
      }
    }
  });

  it("offers the choices in menu order", () => {
    expect(plannerPlanOptionKeys).toEqual([
      "today",
      "tomorrow",
      "thisWeek",
      "nextWeek",
      "thisMonth",
      "nextMonth",
    ]);
  });
});

describe("plannerPlanForDay", () => {
  it("plans exactly the day picked", () => {
    expect(plannerPlanForDay("2026-10-21")).toEqual({
      horizon: "day",
      day: "2026-10-21",
    });
  });
});

describe("plannerPlanOptionOf", () => {
  it("recognises the named choice a plan is", () => {
    const of = (horizon: "day" | "week" | "month", start: string) =>
      plannerPlanOptionOf({ horizon, period_start: start }, TODAY);
    expect(of("day", "2026-10-07")).toBe("today");
    expect(of("day", "2026-10-08")).toBe("tomorrow");
    expect(of("week", "2026-10-05")).toBe("thisWeek");
    expect(of("week", "2026-10-12")).toBe("nextWeek");
    expect(of("month", "2026-10-01")).toBe("thisMonth");
    expect(of("month", "2026-11-01")).toBe("nextMonth");
  });

  it("names no choice for a day further out, a past plan or no plan", () => {
    const of = (horizon: "day" | "week" | "month", start: string) =>
      plannerPlanOptionOf({ horizon, period_start: start }, TODAY);
    expect(of("day", "2026-10-20")).toBeNull();
    expect(of("week", "2026-09-28")).toBeNull();
    expect(of("month", "2026-12-01")).toBeNull();
    expect(
      plannerPlanOptionOf({ horizon: null, period_start: null }, TODAY),
    ).toBeNull();
  });

  it("does not mistake a day plan for the week plan that starts the same day", () => {
    // Monday: today and this week share a start, but they are different horizons.
    expect(
      plannerPlanOptionOf(
        { horizon: "day", period_start: "2026-10-05" },
        "2026-10-05",
      ),
    ).toBe("today");
    expect(
      plannerPlanOptionOf(
        { horizon: "week", period_start: "2026-10-05" },
        "2026-10-05",
      ),
    ).toBe("thisWeek");
  });
});

describe("plannerQuickAddPlan", () => {
  it("sends the backlog choice without a plan", () => {
    expect(plannerQuickAddPlan("backlog", TODAY)).toBeNull();
  });

  it("plans today, this week or this month for the other choices", () => {
    expect(plannerQuickAddPlan("day", TODAY)).toEqual({
      horizon: "day",
      day: "2026-10-07",
    });
    expect(plannerQuickAddPlan("week", TODAY)).toEqual({
      horizon: "week",
      day: "2026-10-05",
    });
    expect(plannerQuickAddPlan("month", TODAY)).toEqual({
      horizon: "month",
      day: "2026-10-01",
    });
  });

  it("offers Backlog, Today, This week and This month in that order", () => {
    expect(plannerQuickAddChoices).toEqual(["backlog", "day", "week", "month"]);
  });
});
