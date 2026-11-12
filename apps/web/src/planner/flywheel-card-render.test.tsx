// @vitest-environment jsdom
import type { PlannerFlywheelResponse } from "@flaremo/contracts";
import { QueryClient } from "@tanstack/react-query";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PlannerFlywheelCard } from "./flywheel-card";
import { plannerTestMount } from "./test-render";

// The scorecard card in a jsdom page (flywheel-card.tsx): the numbers, the
// proposal kept off the card, and the weekly note.

const api = vi.hoisted(() => ({
  plannerFetchFlywheel: vi.fn(),
  plannerSaveTuningNoteRequest: vi.fn(),
  plannerSettleTuningRequest: vi.fn(),
  plannerProposeTuningRequest: vi.fn(),
}));
vi.mock("./flywheel-api", () => api);

const WEEK = "2026-10-26";
const base: PlannerFlywheelResponse = {
  week_start: WEEK,
  weeks: [
    {
      week_start: WEEK,
      values: [
        {
          metric: "proposals_accepted",
          origin: "ai",
          value: 0.75,
          num: 9,
          den: 12,
        },
      ],
    },
  ],
  current: null,
  proposal: {
    id: "t1",
    version: null,
    instructions: "Propose fewer errands.",
    why: "Errands were dismissed.",
    metric: "proposals_accepted",
    baseline: 0.5,
    state: "proposed",
    proposed_by: "agent",
    created_at: "2026-11-01T00:00:00.000Z",
    activated_at: null,
    judged_at: null,
  },
  verdict: null,
  proposal_due: false,
  note: null,
  note_skipped: false,
  last_viewed_days: null,
  proposing_paused: false,
  can_propose: true,
};

/** Lets queries and mutations settle: a few turns of the event loop. */
const flush = async () => {
  for (let turn = 0; turn < 5; turn += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

function type(element: HTMLTextAreaElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  act(() => {
    setter?.call(element, text);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const button = (container: HTMLElement, label: string) =>
  Array.from(container.querySelectorAll("button")).find(
    (node) => node.textContent === label,
  ) as HTMLButtonElement;

describe("PlannerFlywheelCard", () => {
  afterEach(() => vi.clearAllMocks());

  it("shows the numbers, hides the proposed change and saves the note", async () => {
    api.plannerFetchFlywheel.mockResolvedValue(base);
    api.plannerSettleTuningRequest.mockResolvedValue({
      ...base,
      proposal: null,
    });
    api.plannerSaveTuningNoteRequest.mockResolvedValue({
      ...base,
      proposal: null,
      note: "Less nagging.",
    });
    const mount = plannerTestMount(
      <PlannerFlywheelCard today="2026-11-01" week={WEEK} />,
      { queryClient: new QueryClient() },
    );
    await flush();
    const { container } = mount;
    expect(container.textContent).toContain("The agent this week");
    expect(container.textContent).toContain("75%");
    expect(container.textContent).toContain("none yet");
    expect(container.textContent).not.toContain("Errands were dismissed.");

    // The proposed change to the agent is not shown, even when the server
    // has one, and there is no "Suggest a change" button.
    expect(
      container.querySelector('[data-testid="planner-flywheel-proposal"]'),
    ).toBeNull();
    expect(container.textContent).not.toContain("Proposed change to the agent");
    expect(container.textContent).not.toContain("Suggest a change");

    const note = container.querySelector(
      '[data-testid="planner-flywheel-note"]',
    ) as HTMLTextAreaElement;
    type(note, "Less nagging.");
    act(() => button(container, "Save").click());
    await flush();
    expect(api.plannerSaveTuningNoteRequest).toHaveBeenCalledWith(
      WEEK,
      "Less nagging.",
    );
    expect(container.textContent).toContain("Less nagging.");
    expect(button(container, "Edit")).toBeTruthy();
    mount.unmount();
  });

  it("offers no Suggest button even when a suggestion is due", async () => {
    api.plannerFetchFlywheel.mockResolvedValue({
      ...base,
      proposal: null,
      proposal_due: true,
      can_propose: true,
    });
    const mount = plannerTestMount(
      <PlannerFlywheelCard today="2026-11-01" week={WEEK} />,
      { queryClient: new QueryClient() },
    );
    await flush();
    expect(mount.container.textContent).toContain("The agent this week");
    expect(mount.container.textContent).not.toContain("Suggest a change");
    mount.unmount();
  });
});
