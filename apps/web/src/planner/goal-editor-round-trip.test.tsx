// @vitest-environment jsdom
import type { PlannerGoalDto } from "@flaremo/contracts";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PlannerGoalEditor } from "./goal-editor";
import { plannerUpdateGoalRequest } from "./goals-api";
import { plannerTestClick, plannerTestMount } from "./test-render";

// Round trip (fork QA rule, AGENTS.md "Fork: QA rules"): opening a goal and
// pressing Save without touching anything must send back every field the goal
// already has. Saving must never drop what the form doesn't show or didn't
// load: the tags wiped by Save in the memo editor and the lines wiped by a goal
// Rewrite were both this mistake.

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));
vi.mock("./goals-api", () => ({
  plannerCreateGoalRequest: vi.fn(),
  plannerDeleteGoalRequest: vi.fn(),
  plannerUpdateGoalRequest: vi.fn(async () => ({})),
}));

const update = vi.mocked(plannerUpdateGoalRequest);

// Sample goal with every optional field filled in.
const goal: PlannerGoalDto = {
  id: "goal-1",
  level: "month",
  period_start: "2026-11-01",
  pillar: "health",
  title: "Run a half marathon (sample)",
  lines: [
    { text: "Three runs a week", note: "one long", struck: true },
    { text: "Sign up for the race", note: "before Friday" },
    { text: "Stretch after every run" },
  ],
  status: "contested",
  note: "Knee still sore (sample)",
  result: "partial",
  sort_order: 2,
  created_at: "2026-11-01T08:00:00.000Z",
  updated_at: "2026-11-02T08:00:00.000Z",
};

function saveButton(): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === "Save",
  );
  if (!button) throw new Error("No Save button in the editor.");
  return button as HTMLButtonElement;
}

describe("goal editor round trip", () => {
  afterEach(() => {
    update.mockClear();
    document.body.innerHTML = "";
  });

  it("saving an untouched goal sends back every field it had", async () => {
    const view = plannerTestMount(
      <PlannerGoalEditor
        target={{ kind: "edit", goal }}
        onClose={() => undefined}
      />,
      { queryClient: new QueryClient() },
    );
    plannerTestClick(saveButton());
    await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(1));

    expect(update).toHaveBeenCalledWith(goal.id, {
      pillar: goal.pillar,
      status: goal.status,
      result: goal.result,
      title: goal.title,
      lines: goal.lines,
      note: goal.note,
    });
    view.unmount();
  });
});
