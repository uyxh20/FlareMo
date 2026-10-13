import type { PlannerBoardCard, PlannerGoalDto } from "@flaremo/contracts";
import { describe, expect, it } from "vitest";
import {
  plannerGoalParts,
  plannerGoalTasks,
  plannerMapInitialWeeks,
  plannerMapMark,
  plannerMapPath,
  plannerToggleMonthWeeks,
  plannerYearMap,
} from "./year-map-model";

// Week 42 of 2026 starts on Monday 12 October.
const THIS_WEEK = "2026-10-12";

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

const yearGoal = goal({
  level: "year",
  period_start: "2026-01-01",
  pillar: "work",
});
const quarterTheme = goal({
  level: "quarter",
  period_start: "2026-10-01",
  pillar: null,
  title: "Habits before ambition",
});
const quarterWork = goal({
  level: "quarter",
  period_start: "2026-10-01",
  pillar: "work",
});
const monthWork = goal({
  level: "month",
  period_start: "2026-10-01",
  pillar: "work",
});
const weekWork = goal({ pillar: "work" });
const weekWorkToo = goal({ pillar: "work", sort_order: 1 });
// An imported weekly goal: no objective.
const imported = goal({ period_start: "2026-09-28", pillar: null });

const data = {
  north_star: goal({ level: "north_star", period_start: null, pillar: null }),
  goals: [
    yearGoal,
    quarterTheme,
    quarterWork,
    monthWork,
    weekWork,
    weekWorkToo,
    imported,
  ],
  weeks: [],
  current_week: THIS_WEEK,
};

describe("plannerYearMap", () => {
  const map = plannerYearMap(data, 2026);
  const q4 = map.quarters[3];
  const october = q4?.months[0];

  it("lays the year out as four quarters of three months, every ISO week once", () => {
    expect(map.quarters.map((quarter) => quarter.months.length)).toEqual([
      3, 3, 3, 3,
    ]);
    const weeks = map.quarters.flatMap((quarter) =>
      quarter.months.flatMap((month) => month.weeks),
    );
    expect(weeks).toHaveLength(53);
    expect(new Set(weeks.map((week) => week.monday)).size).toBe(53);
  });

  it("puts each goal in its objective's column, and a quarter's first goal with none in its theme", () => {
    expect(map.goals.byPillar.work).toEqual([yearGoal]);
    expect(map.theme).toBeNull();
    expect(q4?.theme).toBe(quarterTheme);
    expect(q4?.goals.byPillar.work).toEqual([quarterWork]);
    expect(q4?.goals.loose).toEqual([]);
    expect(october?.goals.byPillar.work).toEqual([monthWork]);
    expect(october?.current).toBe(true);
  });

  it("stacks two goals of one objective and keeps goals with no objective apart", () => {
    const w42 = october?.weeks.find((week) => week.monday === THIS_WEEK);
    expect(w42?.kind).toBe("now");
    expect(w42?.goals.byPillar.work).toEqual([weekWork, weekWorkToo]);
    // Week 40 (28 Sep) sits under October, its Thursday's month.
    const w40 = october?.weeks.find((week) => week.monday === "2026-09-28");
    expect(w40?.number).toBe(40);
    expect(w40?.kind).toBe("past");
    expect(w40?.goals.loose).toEqual([imported]);
  });

  it("calls an ended week with no goals none, and later weeks future", () => {
    const kinds = new Map(
      map.quarters
        .flatMap((quarter) => quarter.months.flatMap((month) => month.weeks))
        .map((week) => [week.monday, week.kind]),
    );
    expect(kinds.get("2026-10-05")).toBe("none");
    expect(kinds.get("2026-10-19")).toBe("future");
  });

  it("opens the current week first", () => {
    expect([...plannerMapInitialWeeks(map)]).toEqual([THIS_WEEK]);
    expect(plannerMapInitialWeeks(plannerYearMap(data, 2025)).size).toBe(0);
  });

  it("finds the year, quarter and month goals above a weekly goal", () => {
    expect(
      plannerMapPath(map, weekWork).map((step) => [step.level, step.goals]),
    ).toEqual([
      ["year", [yearGoal]],
      ["quarter", [quarterWork]],
      ["month", [monthWork]],
    ]);
    expect(
      plannerMapPath(map, imported).every((step) => step.goals.length === 0),
    ).toBe(true);
  });
});

describe("plannerToggleMonthWeeks", () => {
  it("opens every week of the month, or closes them all when all are open", () => {
    const opened = plannerToggleMonthWeeks(new Set(["a"]), ["a", "b"]);
    expect([...opened].sort()).toEqual(["a", "b"]);
    expect([...plannerToggleMonthWeeks(opened, ["a", "b"])]).toEqual([]);
  });
});

describe("plannerMapMark", () => {
  it("shows a flag first, then the result, then the tasks done", () => {
    expect(plannerMapMark({ status: "contested", result: "met" })).toEqual({
      kind: "contested",
    });
    expect(plannerMapMark({ status: "active", result: "partial" })).toEqual({
      kind: "partial",
    });
    expect(
      plannerMapMark({ status: "active", result: null }, { done: 1, total: 3 }),
    ).toEqual({ kind: "tasks", done: 1, total: 3 });
    expect(
      plannerMapMark({ status: "active", result: null }, { done: 0, total: 0 }),
    ).toBeNull();
  });
});

describe("plannerGoalTasks", () => {
  it("lists a goal's live tasks, Doing first and Done last", () => {
    const done = card({ goal_id: weekWork.id, status: "done" });
    const doing = card({ goal_id: weekWork.id, status: "in_progress" });
    const other = card({ goal_id: weekWorkToo.id });
    const board = {
      columns: {
        backlog: [],
        todo: [other],
        doing: [doing],
        done: [done],
        other: [],
      },
    };
    expect(
      plannerGoalTasks(weekWork.id, board).map((task) => task.card),
    ).toEqual([doing, done]);
    expect(plannerGoalTasks(weekWork.id, undefined)).toEqual([]);
  });
});

describe("plannerGoalParts", () => {
  it("heads a split part with the title and turns the points into chips", () => {
    expect(
      plannerGoalParts({
        title: "Ship the beta",
        lines: [
          { text: "Fix login" },
          { text: " ", struck: false },
          { text: "Demo", struck: true },
        ],
      }),
    ).toEqual({
      head: "Ship the beta",
      points: [
        { text: "Fix login", struck: false },
        { text: "Demo", struck: true },
      ],
    });
  });

  it("leads with the first point when a goal has no title", () => {
    expect(
      plannerGoalParts({
        title: "",
        lines: [{ text: "One" }, { text: "Two" }],
      }),
    ).toEqual({ head: "One", points: [{ text: "Two", struck: false }] });
  });
});
