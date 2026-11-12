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

function mount(
  state: PlannerVoiceState,
  notice: string | null = null,
  paused = false,
) {
  const handlers = {
    onDone: vi.fn(),
    onMic: vi.fn(),
    onSkip: vi.fn(),
    onRetry: vi.fn(),
    onType: vi.fn(),
  };
  mounted = plannerTestMount(
    <PlannerReviewVoiceBar
      level={0.5}
      notice={notice}
      paused={paused}
      seconds={65}
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

  it("offers the send bubble while listening, with the time and no auto-end hint", () => {
    const { root, buttons, handlers } = mount("listening");
    expect(root.textContent).toContain("Listening");
    expect(root.textContent).toContain("Pause as long as you like");
    expect(
      root.querySelector('[data-testid="planner-review-voice-time"]')
        ?.textContent,
    ).toBe("1:05");
    expect(buttons()).toEqual(["", "Send", "Type instead"]);
    plannerTestClick(
      root.querySelector(
        '[data-testid="planner-review-voice-done"]',
      ) as HTMLButtonElement,
    );
    expect(handlers.onDone).toHaveBeenCalledOnce();
  });

  it("pauses and resumes the mic with its own button", () => {
    const live = mount("listening");
    const mic = () =>
      live.root.querySelector(
        '[data-testid="planner-review-voice-mic"]',
      ) as HTMLButtonElement;
    expect(mic().getAttribute("aria-label")).toBe("Pause the mic");
    expect(mic().getAttribute("aria-pressed")).toBe("false");
    plannerTestClick(mic());
    expect(live.handlers.onMic).toHaveBeenCalledOnce();
    mounted?.unmount();

    const held = mount("listening", null, true);
    expect(held.root.textContent).toContain("Mic paused");
    expect(held.root.textContent).toContain("Nothing is recorded now");
    const button = held.root.querySelector(
      '[data-testid="planner-review-voice-mic"]',
    ) as HTMLButtonElement;
    expect(button.getAttribute("aria-label")).toBe("Turn the mic back on");
    expect(button.getAttribute("aria-pressed")).toBe("true");
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
