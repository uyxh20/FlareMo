import { describe, expect, it } from "vitest";
import {
  plannerAddDays,
  plannerCommitSchema,
  plannerCreateGoalSchema,
  plannerIsMonday,
  plannerIsoWeekCount,
  plannerIsoWeekMonday,
  plannerIsoWeekOf,
  plannerIsoYearMondays,
  plannerLookBackSchema,
  plannerMonthStartOf,
  plannerOnTarget,
  plannerQuarterStartOf,
  plannerReviewDueDay,
  plannerReviewWeekFor,
  plannerSnapScore,
  plannerUpdateGoalSchema,
  plannerWeekMonthOf,
  plannerWeekStartOf,
} from "./planner";

// Goals and the weekly review: the week maths and the request schemas
// (planner-goals.ts, re-exported from planner.ts).

const G1 = "7c4e8a52-3c8f-4a43-9a1e-0d6f3b6f1a01";
const G2 = "7c4e8a52-3c8f-4a43-9a1e-0d6f3b6f1a02";

describe("ISO weeks", () => {
  it("numbers the weeks of 2026, which has 53", () => {
    expect(plannerIsoWeekOf("2026-10-05")).toEqual({ year: 2026, week: 41 });
    expect(plannerIsoWeekOf("2026-10-11")).toEqual({ year: 2026, week: 41 });
    expect(plannerIsoWeekOf("2025-12-29")).toEqual({ year: 2026, week: 1 });
    expect(plannerIsoWeekOf("2027-01-03")).toEqual({ year: 2026, week: 53 });
    expect(plannerIsoWeekCount(2026)).toBe(53);
    expect(plannerIsoWeekCount(2025)).toBe(52);
    expect(plannerIsoWeekCount(2020)).toBe(53);
  });

  it("finds the Monday of a week number and lists every Monday of the year", () => {
    expect(plannerIsoWeekMonday(2026, 1)).toBe("2025-12-29");
    expect(plannerIsoWeekMonday(2026, 41)).toBe("2026-10-05");
    expect(plannerIsoWeekMonday(2021, 1)).toBe("2021-01-04");
    const mondays = plannerIsoYearMondays(2026);
    expect(mondays).toHaveLength(53);
    expect(mondays[0]).toBe("2025-12-29");
    expect(mondays.at(-1)).toBe("2026-12-28");
    expect(mondays.every(plannerIsMonday)).toBe(true);
  });

  it("agrees with the week number of every day from 2024 to 2030", () => {
    for (
      let day = "2024-01-01";
      day < "2031-01-01";
      day = plannerAddDays(day, 1)
    ) {
      const { year, week } = plannerIsoWeekOf(day);
      expect(plannerIsoWeekMonday(year, week)).toBe(plannerWeekStartOf(day));
    }
  });

  it("puts a week in the month of its Thursday", () => {
    // 28 Sep to 4 Oct 2026: Thursday is 1 October.
    expect(plannerWeekMonthOf("2026-09-28")).toEqual({ year: 2026, month: 9 });
    expect(plannerWeekMonthOf("2026-10-05")).toEqual({ year: 2026, month: 9 });
    // 29 Dec 2025 to 4 Jan 2026: Thursday is 1 January 2026.
    expect(plannerWeekMonthOf("2025-12-29")).toEqual({ year: 2026, month: 0 });
  });

  it("finds the first day of a month and of a quarter", () => {
    expect(plannerMonthStartOf("2026-10-11")).toBe("2026-10-01");
    expect(plannerQuarterStartOf("2026-11-30")).toBe("2026-10-01");
    expect(plannerQuarterStartOf("2026-03-31")).toBe("2026-01-01");
    expect(() => plannerMonthStartOf("2026-02-30")).toThrow(RangeError);
  });
});

describe("the review's week", () => {
  it("reviews the current week at the weekend and the last one on a weekday", () => {
    expect(plannerReviewWeekFor("2026-10-10")).toBe("2026-10-05"); // Saturday
    expect(plannerReviewWeekFor("2026-10-11")).toBe("2026-10-05"); // Sunday
    expect(plannerReviewWeekFor("2026-10-12")).toBe("2026-10-05"); // Monday
    expect(plannerReviewWeekFor("2026-10-16")).toBe("2026-10-05"); // Friday
    expect(plannerReviewWeekFor("2026-10-17")).toBe("2026-10-12"); // Saturday
  });

  it("is due from Saturday to Monday", () => {
    expect(
      [
        "2026-10-09",
        "2026-10-10",
        "2026-10-11",
        "2026-10-12",
        "2026-10-13",
      ].map(plannerReviewDueDay),
    ).toEqual([false, true, true, true, false]);
  });
});

describe("scores", () => {
  it("snaps to half steps between 1 and 5", () => {
    expect(plannerSnapScore(3.74)).toBe(3.5);
    expect(plannerSnapScore(3.76)).toBe(4);
    expect(plannerSnapScore("4.5")).toBe(4.5);
    expect(plannerSnapScore(0.5)).toBeNull();
    expect(plannerSnapScore(6)).toBeNull();
    expect(plannerSnapScore("high")).toBeNull();
  });

  it("is on target only when both floors are met", () => {
    expect(plannerOnTarget({ auth: 4, ach: 3.5 })).toBe(true);
    expect(plannerOnTarget({ auth: 3.5, ach: 4 })).toBe(false);
    expect(plannerOnTarget({ auth: 4, ach: null })).toBe(false);
  });
});

describe("goal requests", () => {
  it("needs a period for every level but the north star", () => {
    expect(
      plannerCreateGoalSchema.safeParse({ level: "north_star", title: "Cash" })
        .success,
    ).toBe(true);
    expect(
      plannerCreateGoalSchema.safeParse({
        level: "north_star",
        period_start: "2026-01-01",
        title: "Cash",
      }).success,
    ).toBe(false);
    expect(
      plannerCreateGoalSchema.safeParse({ level: "year", title: "Ship" })
        .success,
    ).toBe(false);
    expect(
      plannerCreateGoalSchema.safeParse({
        level: "quarter",
        period_start: "2026-11-30",
        pillar: "work",
        lines: [{ text: "One", note: "open since June" }],
      }).success,
    ).toBe(true);
  });

  it("needs a title or a line, and an update needs a field", () => {
    expect(
      plannerCreateGoalSchema.safeParse({
        level: "week",
        period_start: "2026-10-12",
        title: "  ",
      }).success,
    ).toBe(false);
    expect(plannerUpdateGoalSchema.safeParse({}).success).toBe(false);
    expect(plannerUpdateGoalSchema.safeParse({ result: null }).success).toBe(
      true,
    );
    expect(
      plannerUpdateGoalSchema.safeParse({ status: "archived" }).success,
    ).toBe(false);
  });
});

describe("review requests", () => {
  const plan = {
    today: "2026-10-11",
    goals: [
      { id: G1, pillar: "work", title: "Ask Acme for the terms in writing" },
    ],
    tasks: [{ ref: "n1", goal_id: G1, title: "Email Acme" }],
    to_backlog: [],
    question: "Did I get the terms on paper?",
    settled: [],
    flags: [],
  };

  it("accepts a plan whose tasks all belong to its goals", () => {
    expect(plannerCommitSchema.safeParse(plan).success).toBe(true);
  });

  it("rejects a task of another goal, a duplicate ref, or a task with both forms", () => {
    expect(
      plannerCommitSchema.safeParse({
        ...plan,
        tasks: [{ ref: "n1", goal_id: G2, title: "Email Acme" }],
      }).success,
    ).toBe(false);
    expect(
      plannerCommitSchema.safeParse({
        ...plan,
        tasks: [
          { ref: "n1", goal_id: G1, title: "Email Acme" },
          { ref: "n1", goal_id: G1, task_id: "tasks/a" },
        ],
      }).success,
    ).toBe(false);
    expect(
      plannerCommitSchema.safeParse({
        ...plan,
        tasks: [{ ref: "n1", goal_id: G1, title: "Email", task_id: "tasks/a" }],
      }).success,
    ).toBe(false);
  });

  it("needs the new title to rewrite a flagged goal", () => {
    expect(
      plannerCommitSchema.safeParse({
        ...plan,
        settled: [{ flag_id: "f1", state: "rewritten" }],
      }).success,
    ).toBe(false);
    expect(
      plannerCommitSchema.safeParse({
        ...plan,
        settled: [
          { flag_id: "f1", state: "rewritten", title: "Join Acme" },
          { flag_id: "f2", state: "kept" },
        ],
      }).success,
    ).toBe(true);
  });

  it("takes scores in half steps and seven answer lists", () => {
    const lookBack = {
      today: "2026-10-11",
      scores: { auth: 4, ach: 3.5 },
      question: null,
      verdict: { kind: "continue", text: "Continue. It works." },
      goal_results: [{ goal_id: G1, result: "met" }],
      memo: "# Week 41",
    };
    expect(plannerLookBackSchema.safeParse(lookBack).success).toBe(true);
    expect(
      plannerLookBackSchema.safeParse({
        ...lookBack,
        scores: { auth: 4.25, ach: 3.5 },
      }).success,
    ).toBe(false);
  });
});
