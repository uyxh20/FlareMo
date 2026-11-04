import type { PlannerFlywheelResponse } from "@flaremo/contracts";
import { describe, expect, it } from "vitest";
import { plannerFlywheelFormat, plannerFlywheelTiles } from "./flywheel-card";
import { plannerFlywheelStringsFor } from "./flywheel-strings";

const en = plannerFlywheelStringsFor("en-US");
const zh = plannerFlywheelStringsFor("zh-CN");

function card(
  values: PlannerFlywheelResponse["weeks"],
): PlannerFlywheelResponse {
  return {
    week_start: "2026-10-26",
    weeks: values,
    current: null,
    proposal: null,
    verdict: null,
    proposal_due: false,
    note: null,
    note_skipped: false,
    last_viewed_days: null,
    proposing_paused: false,
    can_propose: false,
  };
}

describe("the scorecard card", () => {
  it("shows a share with enough cases, against last week", () => {
    const tiles = plannerFlywheelTiles(
      card([
        {
          week_start: "2026-10-26",
          values: [
            {
              metric: "proposals_accepted",
              origin: "ai",
              value: 0.6,
              num: 6,
              den: 10,
            },
            { metric: "kept_7d", origin: "ai", value: 1, num: 4, den: 4 },
          ],
        },
        {
          week_start: "2026-10-19",
          values: [
            {
              metric: "proposals_accepted",
              origin: "ai",
              value: 0.5,
              num: 6,
              den: 12,
            },
          ],
        },
      ]),
      en,
    );
    expect(tiles.map((tile) => tile.metric)).toEqual([
      "proposals_accepted",
      "kept_7d",
      "tasks_done_by_due",
    ]);
    expect(tiles[0]).toMatchObject({
      value: "60%",
      shown: true,
      detail: "6 of 10 · +10 vs last week",
    });
    // Four cases is too few to be a percentage.
    expect(tiles[1]).toMatchObject({ value: "too few (4)", shown: false });
    expect(tiles[2]).toMatchObject({ value: "none yet", shown: false });
  });

  it("prints money and counts", () => {
    expect(plannerFlywheelFormat("cost_per_kept", 125)).toBe("$1.25");
    expect(plannerFlywheelFormat("goals_rewritten", 3)).toBe("3");
  });

  it("has the same copy in English and Chinese", () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
    expect(Object.keys(zh.metric).sort()).toEqual(
      Object.keys(en.metric).sort(),
    );
    expect(en.delta(-4)).toBe("−4 vs last week");
    expect(zh.tooFew(3)).toContain("3");
  });
});
