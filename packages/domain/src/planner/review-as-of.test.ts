import { describe, expect, it } from "vitest";
import {
  plannerAsOfCutoff,
  plannerAsOfEnabled,
  plannerBeforeAsOf,
} from "./review-as-of";

// The replay's cut at the reviewed Sunday (fork-owned, review-as-of.ts).

describe("the switch", () => {
  it("is on only for review-week", () => {
    expect(plannerAsOfEnabled("review-week")).toBe(true);
    expect(plannerAsOfEnabled(" Review-Week ")).toBe(true);
    expect(plannerAsOfEnabled("on")).toBe(false);
    expect(plannerAsOfEnabled(undefined)).toBe(false);
  });
});

describe("the cut", () => {
  it("is when the owner saved the look back", () => {
    expect(plannerAsOfCutoff("2026-10-12", "2026-10-20T07:31:02.000Z")).toBe(
      "2026-10-20T07:31:02.000Z",
    );
  });
  it("else the Copenhagen start of the Tuesday after the week", () => {
    // 20 Oct 2026 00:00 in Copenhagen is 19 Oct 22:00 UTC (summer time).
    expect(plannerAsOfCutoff("2026-10-12", null)).toBe(
      "2026-10-19T22:00:00.000Z",
    );
  });
});

describe("what passes the cut", () => {
  const asOf = { at: "2026-10-20T07:31:02.000Z", weekStart: "2026-10-12" };
  const keep = plannerBeforeAsOf(asOf);
  it("keeps what came before, drops what came after", () => {
    expect(keep("2026-10-18T21:00:00.000Z")).toBe(true);
    expect(keep("2026-10-20T07:31:02.000Z")).toBe(false);
    expect(keep("2026-11-01T10:00:00.000Z")).toBe(false);
  });
  it("compares a bare day with the cut's day", () => {
    expect(keep("2026-10-19")).toBe(true);
    expect(keep("2026-10-20")).toBe(false);
  });
  it("keeps rows with no time, and everything when there is no cut", () => {
    expect(keep(null)).toBe(true);
    expect(plannerBeforeAsOf(undefined)("2099-01-01T00:00:00.000Z")).toBe(true);
  });
});
