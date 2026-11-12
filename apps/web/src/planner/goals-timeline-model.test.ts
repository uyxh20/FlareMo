import type { PlannerGoalDto } from "@flaremo/contracts";
import { describe, expect, it } from "vitest";
import {
  PLANNER_GOALS_DEFAULT_VIEW,
  plannerReadGoalsView,
  plannerTimelineRows,
  plannerTimelineStartMonth,
  plannerWriteGoalsView,
} from "./goals-timeline-model";
import { plannerYearMap } from "./year-map-model";

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

function mapOf(goals: PlannerGoalDto[], currentWeek = THIS_WEEK) {
  return plannerYearMap(
    { north_star: null, goals, weeks: [], current_week: currentWeek },
    2026,
  );
}

describe("plannerTimelineRows", () => {
  const year = goal({ level: "year", period_start: "2026-01-01" });
  const quarter = goal({ level: "quarter", period_start: "2026-10-01" });
  const month = goal({ level: "month", period_start: "2026-10-01" });
  const week = goal();
  const health = goal({
    level: "month",
    period_start: "2026-03-01",
    pillar: "health",
  });
  const map = mapOf([year, quarter, month, week, health]);

  it("has one row per objective, each with four quarters and twelve months", () => {
    const rows = plannerTimelineRows(map, null);
    expect(rows.map((row) => row.pillar)).toEqual([
      "of",
      "work",
      "ai",
      "health",
    ]);
    for (const row of rows) {
      expect(row.quarters).toHaveLength(4);
      expect(row.months.map((entry) => entry.month)).toEqual([
        0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
      ]);
    }
  });

  it("lines a row's goals up by period", () => {
    const work = plannerTimelineRows(map, null).find(
      (row) => row.pillar === "work",
    );
    expect(work?.year).toEqual([year]);
    expect(work?.quarters[3]?.goals).toEqual([quarter]);
    expect(work?.months[9]?.goals).toEqual([month]);
    expect(work?.months[9]?.current).toBe(true);
    expect(
      work?.months[9]?.weeks.find((entry) => entry.week.monday === THIS_WEEK)
        ?.goals,
    ).toEqual([week]);
    expect(work?.months[2]?.goals).toEqual([]);
  });

  it("following an objective leaves only its row", () => {
    const rows = plannerTimelineRows(map, "health");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.pillar).toBe("health");
    expect(rows[0]?.months[2]?.goals).toEqual([health]);
  });

  it("adds a last row for goals with no objective, only when there are any", () => {
    const theme = goal({
      level: "quarter",
      period_start: "2026-10-01",
      pillar: null,
    });
    const loose = goal({ pillar: null });
    const rows = plannerTimelineRows(mapOf([year, theme, loose]), null);
    expect(rows).toHaveLength(5);
    expect(rows[4]?.pillar).toBeNull();
    expect(rows[4]?.quarters[3]?.goals).toEqual([theme]);
    expect(
      rows[4]?.months[9]?.weeks.find((entry) => entry.week.monday === THIS_WEEK)
        ?.goals,
    ).toEqual([loose]);
  });
});

describe("plannerTimelineStartMonth", () => {
  it("is the current month, or January in another year", () => {
    expect(plannerTimelineStartMonth(mapOf([]))).toBe(9);
    expect(plannerTimelineStartMonth(mapOf([], "2027-03-01"))).toBe(0);
  });
});

describe("the remembered view", () => {
  it("opens on the timeline until the grid is picked", () => {
    const kept = new Map<string, string>();
    const storage = () => ({
      getItem: (key: string) => kept.get(key) ?? null,
      setItem: (key: string, value: string) => void kept.set(key, value),
    });
    expect(PLANNER_GOALS_DEFAULT_VIEW).toBe("timeline");
    expect(plannerReadGoalsView(storage)).toBe("timeline");
    plannerWriteGoalsView("grid", storage);
    expect(plannerReadGoalsView(storage)).toBe("grid");
    plannerWriteGoalsView("timeline", storage);
    expect(plannerReadGoalsView(storage)).toBe("timeline");
  });

  it("falls back to the timeline when storage is blocked or holds junk", () => {
    const blocked = () => {
      throw new Error("blocked");
    };
    expect(plannerReadGoalsView(blocked)).toBe("timeline");
    expect(() => plannerWriteGoalsView("grid", blocked)).not.toThrow();
    expect(plannerReadGoalsView(() => ({ getItem: () => "list" }))).toBe(
      "timeline",
    );
  });
});
