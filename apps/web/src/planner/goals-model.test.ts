import {
  type PlannerBoardCard,
  type PlannerBoardResponse,
  type PlannerGoalDto,
  type PlannerWeekDto,
  plannerIsoYearMondays,
  plannerWeekMonthOf,
} from "@flaremo/contracts";
import { describe, expect, it } from "vitest";
import {
  plannerAverageText,
  plannerCardGoal,
  plannerCellKind,
  plannerCellLines,
  plannerGoalBadge,
  plannerGoalProgress,
  plannerGoalSlots,
  plannerGoalsOf,
  plannerGoalText,
  plannerIsoYearOf,
  plannerIsScored,
  plannerLinesAsChips,
  plannerLiveCards,
  plannerMonthStart,
  plannerPeriodGoals,
  plannerQuarterMonths,
  plannerQuarterStart,
  plannerScoreText,
  plannerWeekGoalCounts,
  plannerWeekNumber,
  plannerWeekPlace,
  plannerWeekRange,
  plannerWeekStats,
  plannerWeeksByMonday,
  plannerYearMonths,
} from "./goals-model";
import { plannerGoalsStringsFor } from "./goals-strings";

// Saturday 10 October 2026, in Week 41 (Monday 5 October).
const THIS_WEEK = "2026-10-05";

const en = plannerGoalsStringsFor("en-US");
const zh = plannerGoalsStringsFor("zh-CN");

let sequence = 0;

function goal(overrides: Partial<PlannerGoalDto> = {}): PlannerGoalDto {
  sequence += 1;
  return {
    id: `goal-${sequence}`,
    level: "week",
    period_start: THIS_WEEK,
    pillar: "work",
    title: `Goal ${sequence}`,
    lines: [],
    status: "active",
    note: null,
    result: null,
    sort_order: 0,
    created_at: "2026-10-04T18:00:00.000Z",
    updated_at: "2026-10-04T18:00:00.000Z",
    ...overrides,
  };
}

function week(
  monday: string,
  scores: { auth: number | null; ach: number | null },
): PlannerWeekDto {
  return {
    week_start: monday,
    ...scores,
    note: null,
    question: null,
    verdict: null,
    memo_id: null,
    source: "review",
    reviewed_at: null,
  };
}

function card(overrides: Partial<PlannerBoardCard> = {}): PlannerBoardCard {
  sequence += 1;
  return {
    id: `tasks/t${sequence}`,
    project_id: null,
    project_name: null,
    title: `Task ${sequence}`,
    status: "todo",
    priority: "none",
    due_at: null,
    sort_order: 0,
    completed_at: null,
    created_at: "2026-10-01T08:00:00.000Z",
    updated_at: "2026-10-01T08:00:00.000Z",
    horizon: null,
    period_start: null,
    carry_count: 0,
    dropped_at: null,
    start_date: null,
    board_rank: null,
    goal_id: null,
    ...overrides,
  };
}

function columns(
  overrides: Partial<PlannerBoardResponse["columns"]> = {},
): Pick<PlannerBoardResponse, "columns"> {
  return {
    columns: {
      backlog: [],
      todo: [],
      doing: [],
      done: [],
      other: [],
      ...overrides,
    },
  };
}

describe("weeks: names, numbers and places", () => {
  it("writes a week's days in one month, across two months and across the new year", () => {
    expect(plannerWeekRange("2026-10-05", en)).toBe("5 – 11 Oct");
    expect(plannerWeekRange("2026-09-28", en)).toBe("28 Sep – 4 Oct");
    expect(plannerWeekRange("2026-12-28", en)).toBe("28 Dec – 3 Jan");
    expect(plannerWeekRange("2026-10-05", zh)).toBe("10月5日 – 11日");
    expect(plannerWeekRange("2026-09-28", zh)).toBe("9月28日 – 10月4日");
  });

  it("numbers weeks the ISO way, the week of 1 January 2026 being week 1 and its last week 53", () => {
    expect(plannerWeekNumber("2026-10-05")).toBe(41);
    expect(plannerWeekNumber("2025-12-29")).toBe(1);
    expect(plannerWeekNumber("2026-12-28")).toBe(53);
    expect(plannerWeekNumber("2027-01-04")).toBe(1);
  });

  it("names the ISO year a day falls in by its week's Thursday", () => {
    expect(plannerIsoYearOf("2026-10-10")).toBe(2026);
    expect(plannerIsoYearOf("2025-12-29")).toBe(2026);
    // Friday 1 January 2027 still belongs to the last week of 2026.
    expect(plannerIsoYearOf("2027-01-01")).toBe(2026);
    expect(plannerIsoYearOf("2027-01-04")).toBe(2027);
  });

  it("shows a week under its Thursday's month and that month's quarter", () => {
    expect(plannerWeekPlace("2026-10-05")).toEqual({
      year: 2026,
      month: 9,
      quarter: 4,
    });
    // Monday 28 September, Thursday 1 October.
    expect(plannerWeekPlace("2026-09-28")).toEqual({
      year: 2026,
      month: 9,
      quarter: 4,
    });
    // Monday 29 December 2025, Thursday 1 January 2026.
    expect(plannerWeekPlace("2025-12-29")).toEqual({
      year: 2026,
      month: 0,
      quarter: 1,
    });
    expect(plannerWeekPlace("2026-03-30")).toEqual({
      year: 2026,
      month: 3,
      quarter: 2,
    });
    expect(plannerWeekPlace("2026-06-29")).toEqual({
      year: 2026,
      month: 6,
      quarter: 3,
    });
  });

  it("puts each week of an ISO year in the month of its Thursday", () => {
    const months = plannerYearMonths(2026);
    expect(months).toHaveLength(12);
    expect(months[0]).toEqual([
      "2025-12-29",
      "2026-01-05",
      "2026-01-12",
      "2026-01-19",
      "2026-01-26",
    ]);
    expect(months[2]).toEqual([
      "2026-03-02",
      "2026-03-09",
      "2026-03-16",
      "2026-03-23",
    ]);
    expect(months[9]).toEqual([
      "2026-09-28",
      "2026-10-05",
      "2026-10-12",
      "2026-10-19",
      "2026-10-26",
    ]);
    expect(months[11]).toEqual([
      "2026-11-30",
      "2026-12-07",
      "2026-12-14",
      "2026-12-21",
      "2026-12-28",
    ]);
    expect(months.map((month) => month.length)).toEqual([
      5, 4, 4, 5, 4, 4, 5, 4, 4, 5, 4, 5,
    ]);
  });

  it("lands every week of a year in exactly one of its months, 52 and 53 week years alike", () => {
    for (let year = 2019; year <= 2032; year += 1) {
      const months = plannerYearMonths(year);
      expect(months.flat(), String(year)).toEqual(plannerIsoYearMondays(year));
      months.forEach((mondays, month) => {
        for (const monday of mondays) {
          expect(plannerWeekMonthOf(monday), monday).toEqual({ year, month });
        }
      });
    }
    expect(plannerYearMonths(2026).flat()).toHaveLength(53);
    expect(plannerYearMonths(2027).flat()).toHaveLength(52);
  });

  it("gives the first day of a month and of a quarter, and a quarter's months", () => {
    expect(plannerMonthStart(2026, 0)).toBe("2026-01-01");
    expect(plannerMonthStart(2026, 9)).toBe("2026-10-01");
    expect(plannerMonthStart(2026, 11)).toBe("2026-12-01");
    expect(plannerMonthStart(999, 0)).toBe("0999-01-01");
    expect(plannerQuarterStart(2026, 1)).toBe("2026-01-01");
    expect(plannerQuarterStart(2026, 2)).toBe("2026-04-01");
    expect(plannerQuarterStart(2026, 4)).toBe("2026-10-01");
    expect(plannerQuarterMonths(1)).toEqual([0, 1, 2]);
    expect(plannerQuarterMonths(4)).toEqual([9, 10, 11]);
  });
});

describe("scores", () => {
  it("writes a score with one decimal", () => {
    expect(plannerScoreText(4)).toBe("4.0");
    expect(plannerScoreText(3.5)).toBe("3.5");
    expect(plannerScoreText(3.25)).toBe("3.3");
    expect(plannerScoreText(3.75)).toBe("3.8");
    expect(plannerScoreText(1)).toBe("1.0");
  });

  it("writes an average with two decimals, rounding a half up despite float noise", () => {
    expect(plannerAverageText(4)).toBe("4.00");
    expect(plannerAverageText(11.5 / 3)).toBe("3.83");
    expect(plannerAverageText(3.625)).toBe("3.63");
    // 1.005 * 100 is 100.49999999999999 in floating point.
    expect(plannerAverageText(1.005)).toBe("1.01");
  });

  it("averages the weeks before the current one only, skipping weeks not fully scored", () => {
    const mondays = [
      "2026-09-14",
      "2026-09-21",
      "2026-09-28",
      "2026-10-05",
      "2026-10-12",
    ];
    const records = plannerWeeksByMonday([
      week("2026-09-14", { auth: 4.5, ach: null }),
      week("2026-09-21", { auth: 4.5, ach: 3.5 }),
      week("2026-09-28", { auth: 3.5, ach: 4 }),
      // The week in progress never pulls an average down.
      week("2026-10-05", { auth: 1, ach: 1 }),
    ]);
    expect(plannerWeekStats(mondays, records, THIS_WEEK)).toEqual({
      total: 3,
      scored: 2,
      auth: 4,
      ach: 3.75,
      onTarget: 1,
    });
  });

  it("has no averages before any week is scored", () => {
    expect(plannerWeekStats([], new Map(), THIS_WEEK)).toEqual({
      total: 0,
      scored: 0,
      auth: null,
      ach: null,
      onTarget: 0,
    });
    expect(
      plannerWeekStats(["2026-09-28", "2026-10-05"], new Map(), THIS_WEEK),
    ).toEqual({ total: 1, scored: 0, auth: null, ach: null, onTarget: 0 });
  });

  it("keeps a year's records by their Monday", () => {
    const first = week("2026-09-28", { auth: 4, ach: 4 });
    const second = week("2026-10-05", { auth: null, ach: null });
    const byMonday = plannerWeeksByMonday([first, second]);
    expect(byMonday.get("2026-09-28")).toBe(first);
    expect(byMonday.get("2026-10-05")).toBe(second);
    expect(byMonday.size).toBe(2);
  });

  it("tells a week with both scores from one missing either", () => {
    expect(plannerIsScored(undefined)).toBe(false);
    expect(plannerIsScored({ auth: 4, ach: null })).toBe(false);
    expect(plannerIsScored({ auth: null, ach: 4 })).toBe(false);
    expect(plannerIsScored({ auth: 1, ach: 1 })).toBe(true);
  });
});

describe("the heatmap's cells", () => {
  it("draws this week as now and later weeks as future, whatever their record says", () => {
    const scored = week(THIS_WEEK, { auth: 5, ach: 5 });
    expect(plannerCellKind(THIS_WEEK, THIS_WEEK, scored)).toBe("now");
    expect(plannerCellKind("2026-10-12", THIS_WEEK, scored)).toBe("future");
  });

  it("draws a past week on target, below, or not scored", () => {
    const past = "2026-09-28";
    expect(plannerCellKind(past, THIS_WEEK, undefined)).toBe("none");
    expect(
      plannerCellKind(past, THIS_WEEK, week(past, { auth: 4, ach: null })),
    ).toBe("none");
    // Both floors met exactly: 4.0 and 3.5.
    expect(
      plannerCellKind(past, THIS_WEEK, week(past, { auth: 4, ach: 3.5 })),
    ).toBe("on");
    expect(
      plannerCellKind(past, THIS_WEEK, week(past, { auth: 3.5, ach: 5 })),
    ).toBe("below");
    expect(
      plannerCellKind(past, THIS_WEEK, week(past, { auth: 5, ach: 3 })),
    ).toBe("below");
  });

  it("says on hover the week, its days, its scores and its goals", () => {
    const past = "2026-09-28";
    expect(
      plannerCellLines(
        past,
        THIS_WEEK,
        week(past, { auth: 4, ach: 3.5 }),
        2,
        en,
      ),
    ).toEqual(["W40 · 28 Sep – 4 Oct", "Auth 4.0 · Ach 3.5", "2 goals"]);
    expect(plannerCellLines(past, THIS_WEEK, undefined, 1, en)).toEqual([
      "W40 · 28 Sep – 4 Oct",
      "Not scored",
      "1 goal",
    ]);
    expect(
      plannerCellLines(
        past,
        THIS_WEEK,
        week(past, { auth: 4.5, ach: null }),
        0,
        en,
      ),
    ).toEqual(["W40 · 28 Sep – 4 Oct", "Not scored", "No goals set"]);
    expect(
      plannerCellLines(
        past,
        THIS_WEEK,
        week(past, { auth: 4.5, ach: 3 }),
        2,
        zh,
      ),
    ).toEqual(["W40 · 9月28日 – 10月4日", "真实 4.5 · 达成 3.0", "2 个目标"]);
  });

  it("says only that this week is in progress, or that a week has not come yet", () => {
    const scored = week(THIS_WEEK, { auth: 4, ach: 4 });
    expect(plannerCellLines(THIS_WEEK, THIS_WEEK, scored, 3, en)).toEqual([
      "W41 · 5 – 11 Oct",
      "This week",
    ]);
    expect(plannerCellLines("2026-10-12", THIS_WEEK, undefined, 3, en)).toEqual(
      ["W42 · 12 – 18 Oct", "Not yet"],
    );
    expect(plannerCellLines("2026-10-12", THIS_WEEK, undefined, 3, zh)).toEqual(
      ["W42 · 10月12日 – 18日", "未到"],
    );
  });
});

describe("goals", () => {
  it("shows a goal's points as chips only when every one is short and plain", () => {
    const point = (text: string, extra: object = {}) => ({ text, ...extra });
    expect(plannerLinesAsChips({ lines: [] })).toBe(false);
    expect(
      plannerLinesAsChips({
        lines: [point("Grade A title"), point("Own budget"), point("A crew")],
      }),
    ).toBe(true);
    expect(plannerLinesAsChips({ lines: [point("x".repeat(24))] })).toBe(true);
    expect(plannerLinesAsChips({ lines: [point("x".repeat(25))] })).toBe(false);
    expect(
      plannerLinesAsChips({
        lines: [point("Own budget"), point("A crew", { note: "by June" })],
      }),
    ).toBe(false);
    expect(
      plannerLinesAsChips({
        lines: [point("Own budget"), point("A crew", { struck: true })],
      }),
    ).toBe(false);
    expect(
      plannerLinesAsChips({ lines: [point("A crew", { struck: false })] }),
    ).toBe(true);
  });

  it("badges a contested or draft goal first, then its result, then closed", () => {
    expect(plannerGoalBadge({ status: "contested", result: "met" })).toEqual({
      kind: "contested",
    });
    expect(plannerGoalBadge({ status: "draft", result: "met" })).toEqual({
      kind: "draft",
    });
    expect(plannerGoalBadge({ status: "closed", result: "partial" })).toEqual({
      kind: "result",
      result: "partial",
    });
    expect(plannerGoalBadge({ status: "active", result: "missed" })).toEqual({
      kind: "result",
      result: "missed",
    });
    expect(plannerGoalBadge({ status: "closed", result: null })).toEqual({
      kind: "closed",
    });
    expect(plannerGoalBadge({ status: "active", result: null })).toBeNull();
  });

  it("lists one level and period's goals by objective, then their order, then when they were made", () => {
    const health = goal({ pillar: "health" });
    const workSecond = goal({ pillar: "work", sort_order: 2 });
    const workFirst = goal({ pillar: "work", sort_order: 1 });
    const workLater = goal({
      pillar: "work",
      sort_order: 2,
      created_at: "2026-10-05T09:00:00.000Z",
    });
    const theme = goal({ pillar: null });
    const objective = goal({ pillar: "of", sort_order: 9 });
    const ai = goal({ pillar: "ai" });
    const otherWeek = goal({ period_start: "2026-09-28" });
    const month = goal({ level: "month", period_start: "2026-10-01" });
    const all = [
      health,
      workLater,
      workSecond,
      theme,
      workFirst,
      otherWeek,
      ai,
      month,
      objective,
    ];
    const before = [...all];
    expect(plannerGoalsOf(all, "week", THIS_WEEK)).toEqual([
      objective,
      workFirst,
      workSecond,
      workLater,
      ai,
      health,
      theme,
    ]);
    // Any period when none is given.
    expect(plannerGoalsOf(all, "week", null)).toContain(otherWeek);
    expect(plannerGoalsOf(all, "month", "2026-10-01")).toEqual([month]);
    expect(plannerGoalsOf(all, "year", "2026-01-01")).toEqual([]);
    // The list it was given is left as it was.
    expect(all).toEqual(before);
  });

  it("fills the cockpit's row with each objective's goals or an empty slot, goals with no objective last", () => {
    const workOne = goal({ pillar: "work", sort_order: 0 });
    const workTwo = goal({ pillar: "work", sort_order: 1 });
    const health = goal({ pillar: "health" });
    const loose = goal({ pillar: null });
    const notWeekly = goal({ level: "month", pillar: "ai" });
    expect(
      plannerGoalSlots([loose, health, workTwo, notWeekly, workOne]),
    ).toEqual([
      { kind: "empty", pillar: "of" },
      { kind: "goal", goal: workOne, pillar: "work" },
      { kind: "goal", goal: workTwo, pillar: "work" },
      { kind: "empty", pillar: "ai" },
      { kind: "goal", goal: health, pillar: "health" },
      { kind: "goal", goal: loose, pillar: null },
    ]);
    expect(plannerGoalSlots([])).toEqual([
      { kind: "empty", pillar: "of" },
      { kind: "empty", pillar: "work" },
      { kind: "empty", pillar: "ai" },
      { kind: "empty", pillar: "health" },
    ]);
  });

  it("splits a period's theme line, its first goal with no objective, from the rest", () => {
    const quarter = "2026-10-01";
    const work = goal({
      level: "quarter",
      period_start: quarter,
      pillar: "work",
    });
    const of = goal({ level: "quarter", period_start: quarter, pillar: "of" });
    const theme = goal({
      level: "quarter",
      period_start: quarter,
      pillar: null,
      sort_order: 0,
    });
    const another = goal({
      level: "quarter",
      period_start: quarter,
      pillar: null,
      sort_order: 1,
    });
    const lastQuarter = goal({
      level: "quarter",
      period_start: "2026-07-01",
      pillar: null,
    });
    expect(
      plannerPeriodGoals(
        [another, work, lastQuarter, theme, of],
        "quarter",
        quarter,
      ),
    ).toEqual({ theme, goals: [of, work, another] });
    expect(plannerPeriodGoals([work, of], "quarter", quarter)).toEqual({
      theme: null,
      goals: [of, work],
    });
  });

  it("counts each week's weekly goals", () => {
    const counts = plannerWeekGoalCounts([
      goal(),
      goal({ pillar: "health" }),
      goal({ period_start: "2026-09-28" }),
      goal({ level: "month", period_start: "2026-10-01" }),
      goal({ level: "north_star", period_start: null, pillar: null }),
    ]);
    expect(Object.fromEntries(counts)).toEqual({
      [THIS_WEEK]: 2,
      "2026-09-28": 1,
    });
  });

  it("writes a goal in one line: its title, else its points", () => {
    expect(plannerGoalText({ title: "  Ship the beta  ", lines: [] })).toBe(
      "Ship the beta",
    );
    expect(
      plannerGoalText({
        title: "Ship the beta",
        lines: [{ text: "Invite ten users" }],
      }),
    ).toBe("Ship the beta");
    expect(
      plannerGoalText({
        title: "  ",
        lines: [
          { text: "Grade A title" },
          { text: "Own budget", struck: true },
        ],
      }),
    ).toBe("Grade A title · Own budget");
    expect(plannerGoalText({ title: "", lines: [] })).toBe("");
  });
});

describe("goals on the board", () => {
  it("lists the live cards in column order, leaving Other out", () => {
    const [backlog, todo, doing, done, other] = [
      card(),
      card(),
      card(),
      card({ status: "done" }),
      card({ status: "blocked" }),
    ];
    expect(
      plannerLiveCards(
        columns({
          done: [done],
          doing: [doing],
          todo: [todo],
          backlog: [backlog],
          other: [other],
        }),
      ),
    ).toEqual([
      { card: backlog, column: "backlog" },
      { card: todo, column: "todo" },
      { card: doing, column: "doing" },
      { card: done, column: "done" },
    ]);
  });

  it("counts a goal's live tasks and how many of them are done", () => {
    const mine = "goal-mine";
    const board = columns({
      backlog: [card({ goal_id: mine })],
      todo: [card({ goal_id: mine }), card({ goal_id: "goal-other" })],
      doing: [card()],
      done: [
        card({ goal_id: mine, status: "done" }),
        card({ goal_id: mine, status: "done" }),
      ],
      other: [card({ goal_id: mine, status: "blocked" })],
    });
    expect(plannerGoalProgress(mine, board)).toEqual({ done: 2, total: 4 });
    expect(plannerGoalProgress("goal-none", board)).toEqual({
      done: 0,
      total: 0,
    });
  });

  it("finds the goal a card belongs to among the week's goals", () => {
    const work = goal();
    const goals = new Map([[work.id, work]]);
    expect(plannerCardGoal({ goal_id: work.id }, goals)).toBe(work);
    expect(plannerCardGoal({ goal_id: "goal-last-week" }, goals)).toBeNull();
    expect(plannerCardGoal({ goal_id: null }, goals)).toBeNull();
  });
});
