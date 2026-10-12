/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { plannerGoalsSearch, plannerReviewSearch } from "./goals-search";

// The router hands these the parsed query: numbers where the value reads as
// JSON (`?year=2026`), strings otherwise (`?week=2026-10-05`), and whatever
// else a hand-written address holds.

const NOTHING = {
  year: undefined,
  q: undefined,
  m: undefined,
  week: undefined,
};

describe("plannerGoalsSearch", () => {
  it("returns every key, even with nothing set, so no raw value slips through", () => {
    expect(plannerGoalsSearch({})).toStrictEqual(NOTHING);
    expect(Object.keys(plannerGoalsSearch({ week: "40" })).sort()).toEqual([
      "m",
      "q",
      "week",
      "year",
    ]);
    expect(plannerGoalsSearch({ week: "40" })).toStrictEqual(NOTHING);
    expect(plannerGoalsSearch({ month: "10", other: "x" })).toStrictEqual(
      NOTHING,
    );
  });

  it("reads a year written as a number or as digits, from 1970 to 9999", () => {
    expect(plannerGoalsSearch({ year: 2026 }).year).toBe(2026);
    expect(plannerGoalsSearch({ year: "2026" }).year).toBe(2026);
    expect(plannerGoalsSearch({ year: "1970" }).year).toBe(1970);
    expect(plannerGoalsSearch({ year: 9999 }).year).toBe(9999);
    for (const year of [
      1969,
      "10000",
      2026.5,
      "2026.5",
      "-2026",
      " 2026",
      "2026a",
      "",
      Number.NaN,
      Number.POSITIVE_INFINITY,
      null,
      true,
      ["2026"],
      { year: 2026 },
    ]) {
      expect(plannerGoalsSearch({ year }).year, String(year)).toBeUndefined();
    }
  });

  it("reads a quarter from 1 to 4", () => {
    expect(plannerGoalsSearch({ year: 2026, q: 4 })).toStrictEqual({
      year: 2026,
      q: 4,
      m: undefined,
      week: undefined,
    });
    expect(plannerGoalsSearch({ q: "1" }).q).toBe(1);
    for (const q of [0, 5, "0", "5", 2.5, "Q4"]) {
      expect(
        plannerGoalsSearch({ year: 2026, q }).q,
        String(q),
      ).toBeUndefined();
    }
  });

  it("keeps a month only inside its quarter, and drops it alone", () => {
    expect(plannerGoalsSearch({ year: 2026, q: 4, m: 10 })).toStrictEqual({
      year: 2026,
      q: 4,
      m: 10,
      week: undefined,
    });
    expect(plannerGoalsSearch({ year: "2026", q: "1", m: "3" }).m).toBe(3);
    expect(plannerGoalsSearch({ year: "2026", q: "2", m: "4" }).m).toBe(4);
    expect(plannerGoalsSearch({ year: "2026", q: "4", m: "12" }).m).toBe(12);
    // Outside the quarter: the quarter is shown instead.
    expect(plannerGoalsSearch({ year: 2026, q: 4, m: 3 })).toStrictEqual({
      year: 2026,
      q: 4,
      m: undefined,
      week: undefined,
    });
    expect(plannerGoalsSearch({ year: 2026, m: 10 }).m).toBeUndefined();
    expect(plannerGoalsSearch({ year: 2026, q: 4, m: 13 }).m).toBeUndefined();
    expect(plannerGoalsSearch({ year: 2026, q: 1, m: 0 }).m).toBeUndefined();
  });

  it("takes a week by its Monday, which leaves the year, quarter and month out", () => {
    expect(
      plannerGoalsSearch({ year: 2025, q: 1, m: 2, week: "2026-10-05" }),
    ).toStrictEqual({
      year: undefined,
      q: undefined,
      m: undefined,
      week: "2026-10-05",
    });
    // 29 December 2025 is the Monday of Week 1 of 2026.
    expect(plannerGoalsSearch({ week: "2025-12-29" }).week).toBe("2025-12-29");
  });

  it("drops a week that is not a real Monday written YYYY-MM-DD, and shows the level above", () => {
    for (const week of [
      // A Tuesday and a Sunday.
      "2026-10-06",
      "2026-10-11",
      // 30 February would roll over to Monday 2 March.
      "2026-02-30",
      "2026-13-02",
      "2026-10-5",
      "05-10-2026",
      "2026-10-05T00:00:00Z",
      " 2026-10-05",
      "40",
      20261005,
      null,
    ]) {
      expect(
        plannerGoalsSearch({ year: "2026", q: "4", m: "10", week }),
        String(week),
      ).toStrictEqual({ year: 2026, q: 4, m: 10, week: undefined });
    }
  });
});

describe("plannerReviewSearch", () => {
  it("returns both keys, even with nothing set", () => {
    expect(plannerReviewSearch({})).toStrictEqual({
      part: undefined,
      step: undefined,
    });
  });

  it("reads Look back or Look forward, and nothing else", () => {
    expect(plannerReviewSearch({ part: "back" })).toStrictEqual({
      part: "back",
      step: undefined,
    });
    expect(plannerReviewSearch({ part: "forward" })).toStrictEqual({
      part: "forward",
      step: undefined,
    });
    for (const part of ["Forward", "front", "", 1, null, ["back"]]) {
      expect(
        plannerReviewSearch({ part, step: 2 }),
        String(part),
      ).toStrictEqual({ part: undefined, step: undefined });
    }
  });

  it("reads Look forward's step, 1 to 4, and no step for Look back", () => {
    expect(plannerReviewSearch({ part: "forward", step: 2 }).step).toBe(2);
    expect(plannerReviewSearch({ part: "forward", step: "4" }).step).toBe(4);
    expect(plannerReviewSearch({ part: "forward", step: "1" }).step).toBe(1);
    for (const step of [0, 5, "0", "5", 2.5, "2.5", "two", null]) {
      expect(
        plannerReviewSearch({ part: "forward", step }).step,
        String(step),
      ).toBeUndefined();
    }
    expect(plannerReviewSearch({ part: "back", step: 2 }).step).toBeUndefined();
    expect(plannerReviewSearch({ step: 2 }).step).toBeUndefined();
  });
});

describe("goals-search.ts", () => {
  it("imports nothing, since the router loads it with the app's first chunk", () => {
    const source = readFileSync(
      new URL("./goals-search.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(/^\s*import\b/m);
    expect(source).not.toMatch(/\bimport\s*\(/);
    expect(source).not.toMatch(/^\s*export\s+(\*|\{[^}]*\})\s+from\b/m);
  });
});
