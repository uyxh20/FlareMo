import { describe, expect, it } from "vitest";
import { plannerFitDiary } from "./review-context";

// Fitting the week's diary to the review model's budget (review-context.ts).

describe("fitting the diary to the budget", () => {
  it("keeps short entries whole and cuts the long ones to one length", () => {
    const fitted = plannerFitDiary(
      [
        { at: "mon", content: "  Gym.  " },
        { at: "tue", content: "x".repeat(500) },
        { at: "wed", content: "   " },
        { at: "thu", content: "y".repeat(300) },
      ],
      400,
    );
    expect(fitted.map((entry) => entry.at)).toEqual(["mon", "tue", "thu"]);
    expect(fitted[0]?.text).toBe("Gym.");
    expect(fitted[1]?.text).toBe(`${"x".repeat(197)}…`);
    expect(fitted[2]?.text).toBe(`${"y".repeat(197)}…`);
    expect(fitted.reduce((sum, entry) => sum + entry.text.length, 0)).toBe(400);
  });

  it("reads the whole week when it fits, in one line per entry", () => {
    expect(
      plannerFitDiary(
        [
          { at: "mon", content: "Met\n\nAcme   about the terms." },
          { at: "tue", content: "z".repeat(900) },
        ],
        1_000,
      ),
    ).toEqual([
      { at: "mon", text: "Met Acme about the terms." },
      { at: "tue", text: "z".repeat(900) },
    ]);
    expect(plannerFitDiary([], 1_000)).toEqual([]);
  });
});
