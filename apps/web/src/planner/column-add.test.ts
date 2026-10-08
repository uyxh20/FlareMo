import { describe, expect, it } from "vitest";
import { plannerColumnAddTarget } from "./column-add";

// Wednesday 7 October 2026. Without periods (v1.2) a column's "+" needs one plan
// at most: the To Do marker, which is today with the day horizon.
const TODAY = "2026-10-07";
const MARKER = { horizon: "day", day: "2026-10-07" } as const;

describe("plannerColumnAddTarget", () => {
  it("never plans a Backlog task", () => {
    expect(plannerColumnAddTarget("backlog", TODAY)).toEqual({
      column: "backlog",
      plan: null,
    });
  });

  it("gives a To Do task the marker for today, or it would read as Backlog", () => {
    expect(plannerColumnAddTarget("todo", TODAY)).toEqual({
      column: "todo",
      plan: MARKER,
    });
  });

  it("gives Doing and Done no plan", () => {
    expect(plannerColumnAddTarget("doing", TODAY)).toEqual({
      column: "doing",
      plan: null,
    });
    expect(plannerColumnAddTarget("done", TODAY)).toEqual({
      column: "done",
      plan: null,
    });
  });
});
