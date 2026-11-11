import { describe, expect, it } from "vitest";
import { plannerAskCopy } from "./ask-chat";
import { plannerAskStarterButtons } from "./ask-starters";

// Ask my diary's starter buttons (docs/fork-general-agent.md, "The starter
// buttons"): counts on the counting ones, hidden at zero, at most four.

const copy = plannerAskCopy.en.starters;
const ids = (counts: Parameters<typeof plannerAskStarterButtons>[0]) =>
  plannerAskStarterButtons(counts, copy).map((button) => button.id);

describe("plannerAskStarterButtons", () => {
  it("hides the counting buttons with nothing to do", () => {
    expect(ids({ overdue: 0, stuck: 0, stale_backlog: 0 })).toEqual([
      "todos",
      "done",
      "health",
    ]);
    expect(ids(null)).toEqual(["todos", "done", "health"]);
  });

  it("shows the counts, and at most four buttons", () => {
    const buttons = plannerAskStarterButtons(
      { overdue: 6, stuck: 2, stale_backlog: 9 },
      copy,
    );
    expect(buttons.map((button) => button.label)).toEqual([
      "Replan my week · 6 overdue, 2 stuck",
      "Find to-dos in my diary",
      "Mark what I already did",
      "Tidy my backlog · 9 untouched",
    ]);
    expect(
      plannerAskStarterButtons(
        { overdue: 0, stuck: 1, stale_backlog: 0 },
        copy,
      )[0]?.label,
    ).toBe("Replan my week · 1 stuck");
  });
});
