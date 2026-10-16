import { describe, expect, it } from "vitest";
import {
  plannerIsPeriodStart,
  plannerLatestClosedPeriod,
  plannerNextPeriodStartOf,
  plannerPeriodEndOf,
  plannerPeriodLabel,
  plannerPeriodOfWeek,
  plannerPeriodReviewsDue,
  plannerPeriodStartOf,
  plannerPeriodSteps,
  plannerPeriodsClosingWith,
  plannerPeriodWeeks,
  plannerPreviousPeriodStartOf,
} from "./planner-period-review";

// The month, quarter and year reviews' period maths (planner-period-review.ts).

describe("period starts and ends", () => {
  it("finds the first and last day of each level", () => {
    expect(plannerPeriodStartOf("month", "2026-10-17")).toBe("2026-10-01");
    expect(plannerPeriodStartOf("quarter", "2026-11-02")).toBe("2026-10-01");
    expect(plannerPeriodStartOf("year", "2026-06-30")).toBe("2026-01-01");
    expect(plannerPeriodEndOf("month", "2026-02-01")).toBe("2026-02-28");
    expect(plannerPeriodEndOf("month", "2028-02-01")).toBe("2028-02-29");
    expect(plannerPeriodEndOf("quarter", "2026-10-01")).toBe("2026-12-31");
    expect(plannerPeriodEndOf("year", "2026-01-01")).toBe("2026-12-31");
  });

  it("steps to the next and previous period across a year end", () => {
    expect(plannerNextPeriodStartOf("month", "2026-12-01")).toBe("2027-01-01");
    expect(plannerNextPeriodStartOf("quarter", "2026-10-01")).toBe(
      "2027-01-01",
    );
    expect(plannerNextPeriodStartOf("year", "2026-01-01")).toBe("2027-01-01");
    expect(plannerPreviousPeriodStartOf("month", "2027-01-01")).toBe(
      "2026-12-01",
    );
    expect(plannerPreviousPeriodStartOf("quarter", "2027-01-01")).toBe(
      "2026-10-01",
    );
    expect(plannerPreviousPeriodStartOf("year", "2027-01-01")).toBe(
      "2026-01-01",
    );
  });

  it("accepts only the first day of a period of the level", () => {
    expect(plannerIsPeriodStart("month", "2026-10-01")).toBe(true);
    expect(plannerIsPeriodStart("month", "2026-10-02")).toBe(false);
    expect(plannerIsPeriodStart("quarter", "2026-11-01")).toBe(false);
    expect(plannerIsPeriodStart("quarter", "2026-10-01")).toBe(true);
    expect(plannerIsPeriodStart("year", "2026-04-01")).toBe(false);
    expect(plannerIsPeriodStart("year", 42)).toBe(false);
  });

  it("labels a period", () => {
    expect(plannerPeriodLabel("month", "2026-10-01")).toBe("October 2026");
    expect(plannerPeriodLabel("quarter", "2026-10-01")).toBe("Q4 2026");
    expect(plannerPeriodLabel("year", "2026-01-01")).toBe("2026");
  });
});

describe("the weeks of a period, by the Thursday rule", () => {
  it("gives October 2026 the weeks whose Thursday is in October", () => {
    // Thursday 1 October is in W40 (Monday 28 September); Thursday 29 October in W44.
    expect(plannerPeriodWeeks("month", "2026-10-01")).toEqual([
      "2026-09-28",
      "2026-10-05",
      "2026-10-12",
      "2026-10-19",
      "2026-10-26",
    ]);
    expect(plannerPeriodOfWeek("month", "2026-09-28")).toBe("2026-10-01");
    expect(plannerPeriodOfWeek("month", "2026-11-02")).toBe("2026-11-01");
  });

  it("gives a quarter thirteen weeks (fourteen when its last Thursday is a 53rd week) and the ISO year its weeks", () => {
    expect(plannerPeriodWeeks("quarter", "2026-07-01")).toHaveLength(13);
    expect(plannerPeriodWeeks("quarter", "2026-10-01")).toHaveLength(14);
    expect(plannerPeriodWeeks("year", "2026-01-01")).toHaveLength(53);
    expect(plannerPeriodWeeks("year", "2026-01-01")[0]).toBe("2025-12-29");
    expect(plannerPeriodWeeks("year", "2027-01-01")[0]).toBe("2027-01-04");
  });

  it("names the periods that close with a week, biggest last", () => {
    expect(plannerPeriodsClosingWith("2026-10-26")).toEqual([
      { level: "month", period_start: "2026-10-01" },
    ]);
    expect(plannerPeriodsClosingWith("2026-10-19")).toEqual([]);
    expect(plannerPeriodsClosingWith("2026-12-28")).toEqual([
      { level: "month", period_start: "2026-12-01" },
      { level: "quarter", period_start: "2026-10-01" },
      { level: "year", period_start: "2026-01-01" },
    ]);
    expect(plannerPeriodsClosingWith("2026-09-21")).toEqual([
      { level: "month", period_start: "2026-09-01" },
      { level: "quarter", period_start: "2026-07-01" },
    ]);
  });

  it("is due from the Saturday of the period's last week to the Monday after, like the weekly review", () => {
    expect(plannerPeriodReviewsDue("2026-10-31")).toEqual([
      { level: "month", period_start: "2026-10-01" },
    ]);
    expect(plannerPeriodReviewsDue("2026-11-01")).toEqual([
      { level: "month", period_start: "2026-10-01" },
    ]);
    expect(plannerPeriodReviewsDue("2026-11-02")).toEqual([
      { level: "month", period_start: "2026-10-01" },
    ]);
    expect(plannerPeriodReviewsDue("2026-11-04")).toEqual([]);
    expect(plannerPeriodReviewsDue("2026-10-25")).toEqual([]);
  });

  it("finds the latest closed period for any day", () => {
    expect(plannerLatestClosedPeriod("month", "2026-10-17")).toBe("2026-09-01");
    expect(plannerLatestClosedPeriod("month", "2026-11-01")).toBe("2026-10-01");
    expect(plannerLatestClosedPeriod("quarter", "2026-10-17")).toBe(
      "2026-07-01",
    );
    expect(plannerLatestClosedPeriod("year", "2026-10-17")).toBe("2025-01-01");
  });
});

describe("the steps", () => {
  it("has five steps per level with distinct ids", () => {
    for (const level of ["month", "quarter", "year"] as const) {
      const ids = plannerPeriodSteps[level].map((step) => step.id);
      expect(ids).toHaveLength(5);
      expect(new Set(ids).size).toBe(5);
    }
    expect(plannerPeriodSteps.month.at(-1)?.id).toBe("verdict");
    expect(plannerPeriodSteps.quarter[0]?.id).toBe("goals");
    expect(plannerPeriodSteps.year[0]?.id).toBe("calendar");
  });
});
