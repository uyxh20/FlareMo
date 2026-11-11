// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { plannerGoalsStringsFor } from "./goals-strings";
import type { PlannerVoiceState } from "./review-voice";
import { PlannerReviewVoiceBar } from "./review-voice-bar";
import {
  type PlannerTestMount,
  plannerTestClick,
  plannerTestMount,
} from "./test-render";

// Talk's voice bar (review-voice-bar.tsx, docs/fork-review-voice.md): each
// state says what is happening and offers only the buttons that fit it.

const strings = plannerGoalsStringsFor("en");
let mounted: PlannerTestMount | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

function mount(state: PlannerVoiceState, notice: string | null = null) {
  const handlers = {
    onDone: vi.fn(),
    onSkip: vi.fn(),
    onRetry: vi.fn(),
    onType: vi.fn(),
  };
  mounted = plannerTestMount(
    <PlannerReviewVoiceBar
      level={0.5}
      notice={notice}
      state={state}
      strings={strings}
      {...handlers}
    />,
  );
  const root = mounted.container;
  const buttons = () =>
    Array.from(root.querySelectorAll("button")).map((b) => b.textContent);
  return { root, buttons, handlers };
}

describe("PlannerReviewVoiceBar", () => {
  it("offers Skip while the coach speaks", () => {
    const { root, buttons, handlers } = mount("speaking");
    expect(root.textContent).toContain("Coach is speaking");
    expect(buttons()).toEqual(["Skip", "Type instead"]);
    plannerTestClick(root.querySelector("button") as HTMLButtonElement);
    expect(handlers.onSkip).toHaveBeenCalledOnce();
  });

  it("offers Done while listening", () => {
    const { root, buttons, handlers } = mount("listening");
    expect(root.textContent).toContain("Listening");
    expect(buttons()).toEqual(["Done", "Type instead"]);
    plannerTestClick(
      root.querySelector(
        '[data-testid="planner-review-voice-done"]',
      ) as HTMLButtonElement,
    );
    expect(handlers.onDone).toHaveBeenCalledOnce();
  });

  it("shows thinking with only the way back to typing", () => {
    const { root, buttons } = mount("thinking");
    expect(root.textContent).toContain("Thinking");
    expect(buttons()).toEqual(["Type instead"]);
  });

  it("explains a blocked microphone without a retry", () => {
    const { root, buttons } = mount("error", "mic");
    expect(root.textContent).toContain("microphone is blocked");
    expect(buttons()).toEqual(["Type instead"]);
  });

  it("offers Try again after a failed call, with the reason", () => {
    const { root, buttons, handlers } = mount("error", "Could not hear that.");
    expect(root.textContent).toContain("Could not hear that.");
    expect(buttons()).toEqual(["Try again", "Type instead"]);
    const typeButton = root.querySelector(
      '[data-testid="planner-review-voice-type"]',
    ) as HTMLButtonElement;
    plannerTestClick(typeButton);
    expect(handlers.onType).toHaveBeenCalledOnce();
  });
});
