import type { PlannerColumn } from "@flaremo/contracts";
import { describe, expect, it } from "vitest";
import { plannerColumnAddTarget } from "./column-add";
import { plannerHorizonFilters } from "./todo-filter";

// Wednesday 7 October 2026: its week starts Monday the 5th, its month the 1st.
const TODAY = "2026-10-07";
const DAY = { horizon: "day", day: "2026-10-07" } as const;
const WEEK = { horizon: "week", day: "2026-10-05" } as const;
const MONTH = { horizon: "month", day: "2026-10-01" } as const;

describe("plannerColumnAddTarget", () => {
  it("never plans a Backlog task, whatever the chip says", () => {
    for (const filter of plannerHorizonFilters) {
      expect(plannerColumnAddTarget("backlog", filter, TODAY)).toEqual({
        column: "backlog",
        plan: null,
      });
    }
  });

  it("plans a To Do task for the chip's period, and for today under All", () => {
    expect(plannerColumnAddTarget("todo", "day", TODAY).plan).toEqual(DAY);
    expect(plannerColumnAddTarget("todo", "week", TODAY).plan).toEqual(WEEK);
    expect(plannerColumnAddTarget("todo", "month", TODAY).plan).toEqual(MONTH);
    expect(plannerColumnAddTarget("todo", "all", TODAY).plan).toEqual(DAY);
  });

  it("gives a To Do task a plan under every chip: it would read as Backlog without one", () => {
    for (const filter of plannerHorizonFilters) {
      expect(
        plannerColumnAddTarget("todo", filter, TODAY).plan,
        filter,
      ).not.toBeNull();
    }
  });

  it("uses the chip's period for Doing and Done, and no plan under All", () => {
    for (const column of ["doing", "done"] as const) {
      expect(plannerColumnAddTarget(column, "day", TODAY)).toEqual({
        column,
        plan: DAY,
      });
      expect(plannerColumnAddTarget(column, "week", TODAY)).toEqual({
        column,
        plan: WEEK,
      });
      expect(plannerColumnAddTarget(column, "month", TODAY)).toEqual({
        column,
        plan: MONTH,
      });
      expect(plannerColumnAddTarget(column, "all", TODAY)).toEqual({
        column,
        plan: null,
      });
    }
  });

  it("returns the column it was asked for", () => {
    const columns: PlannerColumn[] = ["backlog", "todo", "doing", "done"];
    for (const column of columns) {
      for (const filter of plannerHorizonFilters) {
        expect(plannerColumnAddTarget(column, filter, TODAY).column).toBe(
          column,
        );
      }
    }
  });

  it("counts a week from Monday, also on a Sunday, and a month from the 1st", () => {
    // Sunday 11 October is the last day of the week that started on the 5th.
    expect(plannerColumnAddTarget("todo", "week", "2026-10-11").plan).toEqual(
      WEEK,
    );
    // Monday 12 October starts the next one.
    expect(plannerColumnAddTarget("todo", "week", "2026-10-12").plan).toEqual({
      horizon: "week",
      day: "2026-10-12",
    });
    // The last day of a month, and a week that straddles two months.
    expect(plannerColumnAddTarget("doing", "month", "2026-10-31").plan).toEqual(
      MONTH,
    );
    expect(plannerColumnAddTarget("todo", "week", "2026-11-01").plan).toEqual({
      horizon: "week",
      day: "2026-10-26",
    });
    expect(plannerColumnAddTarget("todo", "month", "2026-11-01").plan).toEqual({
      horizon: "month",
      day: "2026-11-01",
    });
  });
});
