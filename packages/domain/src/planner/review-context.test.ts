import { describe, expect, it } from "vitest";
import { plannerFitDiary, plannerWeekInstants } from "./review-context";

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

  it("stays within the budget and never splits an emoji", () => {
    const rows = Array.from({ length: 200 }, (_, index) => ({
      at: String(index),
      content: "w".repeat(index * 7),
    }));
    const fitted = plannerFitDiary(rows, 12_000);
    expect(
      fitted.reduce((sum, entry) => sum + entry.text.length, 0),
    ).toBeLessThanOrEqual(12_000);
    const [emoji] = plannerFitDiary(
      [{ at: "mon", content: "😀".repeat(10) }],
      4,
    );
    expect(emoji?.text).toBe("😀…");
  });
});

describe("plannerWeekInstants", () => {
  it("cuts a week at the owner's local midnight, through daylight saving", () => {
    // Summer time (UTC+2) at both ends.
    expect(plannerWeekInstants("2026-10-05")).toEqual({
      from: "2026-10-04T22:00:00.000Z",
      to: "2026-10-11T22:00:00.000Z",
    });
    // The clocks go back on Sunday 25 October: the week ends at UTC+1.
    expect(plannerWeekInstants("2026-10-19")).toEqual({
      from: "2026-10-18T22:00:00.000Z",
      to: "2026-10-25T23:00:00.000Z",
    });
    // The clocks go forward on Sunday 29 March 2026.
    expect(plannerWeekInstants("2026-03-23")).toEqual({
      from: "2026-03-22T23:00:00.000Z",
      to: "2026-03-29T22:00:00.000Z",
    });
  });
});
