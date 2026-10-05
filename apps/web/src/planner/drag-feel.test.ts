import { afterEach, describe, expect, it, vi } from "vitest";
import {
  plannerHaptic,
  plannerIsTouchActivation,
  plannerLiftClass,
  plannerTouchActivation,
} from "./drag-feel";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("plannerTouchActivation", () => {
  it("asks for a deliberate long press: about 400 ms, moving no more than about 5 px", () => {
    expect(plannerTouchActivation).toEqual({ delay: 400, tolerance: 5 });
  });

  it("is stricter than the 200 ms and 8 px that let a slow swipe lift a card", () => {
    expect(plannerTouchActivation.delay).toBeGreaterThan(200);
    expect(plannerTouchActivation.tolerance).toBeLessThan(8);
  });
});

describe("plannerLiftClass", () => {
  it("is all motion-safe, so reduced motion keeps the card still", () => {
    const classes = plannerLiftClass.split(" ");
    expect(classes.length).toBeGreaterThan(1);
    for (const name of classes) expect(name).toMatch(/^motion-safe:/);
  });

  it("grows the card a little, quickly", () => {
    expect(plannerLiftClass).toContain("zoom-out-[1.03]");
    expect(plannerLiftClass).toContain("duration-150");
  });
});

describe("plannerIsTouchActivation", () => {
  it("is true for a touch event and false for a mouse or pointer event", () => {
    const touch = Object.assign(new Event("touchstart"), { touches: [] });
    expect(plannerIsTouchActivation(touch)).toBe(true);
    expect(plannerIsTouchActivation(new Event("mousedown"))).toBe(false);
    expect(plannerIsTouchActivation(new Event("pointerdown"))).toBe(false);
  });

  it("is false when there is no event", () => {
    expect(plannerIsTouchActivation(null)).toBe(false);
    expect(plannerIsTouchActivation(undefined)).toBe(false);
  });
});

describe("plannerHaptic", () => {
  it("buzzes for 10 ms by default, and for as long as it is asked", () => {
    const vibrate = vi.fn();
    vi.stubGlobal("navigator", { vibrate });
    plannerHaptic();
    plannerHaptic(25);
    expect(vibrate.mock.calls).toEqual([[10], [25]]);
  });

  it("does nothing where the device cannot vibrate", () => {
    vi.stubGlobal("navigator", {});
    expect(() => plannerHaptic()).not.toThrow();
  });

  it("never lets a refused vibration break a drag", () => {
    vi.stubGlobal("navigator", {
      vibrate: () => {
        throw new Error("Blocked: the page has not been tapped yet");
      },
    });
    expect(() => plannerHaptic()).not.toThrow();
  });
});
