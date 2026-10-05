import { describe, expect, it } from "vitest";
import { plannerMsUntilMidnight } from "./use-planner-clock";

describe("plannerMsUntilMidnight", () => {
  it("counts to two seconds past the next local midnight", () => {
    expect(plannerMsUntilMidnight(new Date(2026, 9, 5, 23, 59, 30))).toBe(
      32_000,
    );
    expect(plannerMsUntilMidnight(new Date(2026, 9, 5, 12, 0, 0))).toBe(
      12 * 3_600_000 + 2_000,
    );
  });

  it("is a whole day plus the margin just after midnight", () => {
    expect(plannerMsUntilMidnight(new Date(2026, 9, 5, 0, 0, 0))).toBe(
      24 * 3_600_000 + 2_000,
    );
  });

  it("crosses the end of a month and a year", () => {
    expect(plannerMsUntilMidnight(new Date(2026, 8, 30, 23, 0, 0))).toBe(
      3_600_000 + 2_000,
    );
    expect(plannerMsUntilMidnight(new Date(2026, 11, 31, 23, 59, 59))).toBe(
      3_000,
    );
  });

  it("never asks for a timer shorter than a second", () => {
    expect(
      plannerMsUntilMidnight(new Date(2026, 9, 5, 23, 59, 59, 999)),
    ).toBeGreaterThanOrEqual(1_000);
  });
});
