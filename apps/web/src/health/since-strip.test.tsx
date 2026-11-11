import { describe, expect, it } from "vitest";
import {
  HEALTH_SINCE_MAX_ROWS,
  healthSincePerRow,
  healthSinceShown,
} from "./since-strip";

describe("days-since strip sizing", () => {
  it("fits 10px squares with 2px gaps", () => {
    // 340px phone strip: (340 + 2) / 12 = 28 per row.
    expect(healthSincePerRow(340)).toBe(28);
    expect(healthSincePerRow(646)).toBe(54);
    expect(healthSincePerRow(0)).toBe(1);
  });

  it("draws one square per day until six rows are full", () => {
    expect(HEALTH_SINCE_MAX_ROWS).toBe(6);
    expect(healthSinceShown(13, 340)).toBe(13);
    expect(healthSinceShown(120, 340)).toBe(120);
    expect(healthSinceShown(365, 340)).toBe(28 * 6);
    expect(healthSinceShown(365, 646)).toBe(54 * 6);
    expect(healthSinceShown(0, 340)).toBe(0);
  });
});
