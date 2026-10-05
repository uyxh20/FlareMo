// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { plannerTestMount } from "./test-render";
import {
  type PlannerReveal,
  plannerPrefersReducedMotion,
  plannerRevealHoldMs,
  plannerRevealMs,
  plannerRevealRingClass,
  plannerRevealScrollOptions,
  plannerScrollCardIntoView,
  usePlannerReveal,
} from "./use-planner-reveal";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function stubMotionPreference(reduce: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: reduce && query.includes("prefers-reduced-motion"),
      media: query,
    })),
  );
}

describe("plannerRevealScrollOptions", () => {
  it("scrolls smoothly, no further than it takes", () => {
    expect(plannerRevealScrollOptions(false)).toEqual({
      behavior: "smooth",
      block: "nearest",
      inline: "nearest",
    });
  });

  it("jumps instead of gliding when the person asked for less motion", () => {
    expect(plannerRevealScrollOptions(true)).toEqual({
      behavior: "auto",
      block: "nearest",
      inline: "nearest",
    });
  });
});

describe("plannerPrefersReducedMotion", () => {
  it("reads the system setting", () => {
    stubMotionPreference(true);
    expect(plannerPrefersReducedMotion()).toBe(true);
    stubMotionPreference(false);
    expect(plannerPrefersReducedMotion()).toBe(false);
  });

  it("is false in a browser that cannot say", () => {
    vi.stubGlobal("matchMedia", undefined);
    expect(plannerPrefersReducedMotion()).toBe(false);
    vi.stubGlobal("matchMedia", () => {
      throw new Error("not today");
    });
    expect(plannerPrefersReducedMotion()).toBe(false);
  });
});

describe("plannerScrollCardIntoView", () => {
  it("scrolls the card with the options for the person's motion setting", () => {
    const element = document.createElement("div");
    const scrollIntoView = vi.fn();
    element.scrollIntoView = scrollIntoView;

    plannerScrollCardIntoView(element, false);
    plannerScrollCardIntoView(element, true);
    stubMotionPreference(true);
    plannerScrollCardIntoView(element);

    expect(
      scrollIntoView.mock.calls.map(([options]) => options.behavior),
    ).toEqual(["smooth", "auto", "auto"]);
    for (const [options] of scrollIntoView.mock.calls) {
      expect(options).toMatchObject({ block: "nearest", inline: "nearest" });
    }
  });

  it("does nothing for a missing element, or one that cannot scroll", () => {
    expect(() => plannerScrollCardIntoView(null)).not.toThrow();
    expect(() => plannerScrollCardIntoView(undefined)).not.toThrow();
    const element = document.createElement("div");
    (element as { scrollIntoView?: unknown }).scrollIntoView = undefined;
    expect(() => plannerScrollCardIntoView(element, false)).not.toThrow();
  });
});

describe("plannerRevealRingClass", () => {
  it("holds a moment, then fades over about a second and a half", () => {
    expect(plannerRevealHoldMs).toBe(300);
    expect(plannerRevealMs).toBe(1500);
    const classes = plannerRevealRingClass.split(" ");
    expect(classes).toContain(`motion-safe:delay-${plannerRevealHoldMs}`);
    expect(classes).toContain(`motion-safe:duration-${plannerRevealMs}`);
    expect(classes).toContain("motion-safe:ease-in");
  });

  it("fades only when motion is welcome, and never takes a click", () => {
    // The fade is what is motion-safe; the ring itself shows either way.
    const classes = plannerRevealRingClass.split(" ");
    expect(classes).toContain("motion-safe:animate-out");
    expect(classes).toContain("motion-safe:fade-out-0");
    expect(classes).toContain("motion-safe:fill-mode-forwards");
    expect(classes).toContain("ring-2");
    expect(classes).toContain("pointer-events-none");
    // Only opacity moves: no scale, translate or blur in the ring.
    expect(plannerRevealRingClass).not.toMatch(/zoom|slide|spin|blur/);
  });
});

describe("usePlannerReveal", () => {
  let reveal: PlannerReveal | null = null;
  let request: (taskId: string) => void = () => undefined;

  function Harness() {
    const state = usePlannerReveal();
    reveal = state.reveal;
    request = state.request;
    return null;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    reveal = null;
  });

  it("points at the card a moment after it is asked, and lets go when the ring has faded", () => {
    const view = plannerTestMount(<Harness />);
    expect(reveal).toBeNull();

    act(() => request("tasks/a"));
    // Not yet: the board gets a beat to draw the card where it now is.
    expect(reveal).toBeNull();
    act(() => {
      vi.advanceTimersByTime(60);
    });
    expect(reveal).toEqual({ id: "tasks/a", stamp: 1 });

    // The ring lasts its hold and its fade, and goes a beat after.
    act(() => {
      vi.advanceTimersByTime(plannerRevealHoldMs + plannerRevealMs - 100);
    });
    expect(reveal?.id).toBe("tasks/a");
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(reveal).toBeNull();
    view.unmount();
  });

  it("lets a newer request replace the one before, with a new stamp", () => {
    const view = plannerTestMount(<Harness />);
    act(() => request("tasks/a"));
    act(() => {
      vi.advanceTimersByTime(60);
    });
    expect(reveal).toEqual({ id: "tasks/a", stamp: 1 });

    // Half way through the first ring, another card is acted on.
    act(() => {
      vi.advanceTimersByTime(700);
    });
    act(() => request("tasks/b"));
    act(() => {
      vi.advanceTimersByTime(60);
    });
    expect(reveal).toEqual({ id: "tasks/b", stamp: 2 });

    // The second ring lasts its own full time, not what was left of the first.
    act(() => {
      vi.advanceTimersByTime(plannerRevealHoldMs + plannerRevealMs - 100);
    });
    expect(reveal?.id).toBe("tasks/b");
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(reveal).toBeNull();
    view.unmount();
  });

  it("renews the ring for the same card with a new stamp", () => {
    const view = plannerTestMount(<Harness />);
    act(() => request("tasks/a"));
    act(() => {
      vi.advanceTimersByTime(60);
    });
    act(() => request("tasks/a"));
    act(() => {
      vi.advanceTimersByTime(60);
    });
    expect(reveal).toEqual({ id: "tasks/a", stamp: 2 });
    view.unmount();
  });

  it("keeps the same request function across renders", () => {
    const view = plannerTestMount(<Harness />);
    const first = request;
    act(() => first("tasks/a"));
    act(() => {
      vi.advanceTimersByTime(60);
    });
    expect(request).toBe(first);
    view.unmount();
  });

  it("drops what is pending when the page goes away", () => {
    const view = plannerTestMount(<Harness />);
    act(() => request("tasks/a"));
    view.unmount();
    // Nothing is left to fire into an unmounted page.
    expect(vi.getTimerCount()).toBe(0);
  });
});
