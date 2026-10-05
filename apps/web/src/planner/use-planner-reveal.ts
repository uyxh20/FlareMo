import { useCallback, useEffect, useRef, useState } from "react";

// Pointing out the card you just acted on (fork-owned add-on,
// docs/planning-cockpit-implementation-plan.md, section 5). A quick add, a
// re-plan, a move or an undrop can put a card in another column or far down a
// long one, below the fold or off to the side on a phone, and the person is left
// looking at an empty spot. So the card is scrolled into view, smoothly and no
// further than it takes, and rings once in Ember for about a second and a half.
//
// The page holds one request at a time: `request(taskId)` sets it a beat later
// (once the board has been drawn with the card in its new place) and clears it
// when the ring has faded. The card with that id reads it, scrolls itself into
// view when it appears or the request is renewed, and draws the ring while the
// request lasts. A request for a card that is not on the board (hidden by a
// filter chip, say) simply finds no card and expires.
//
// The ring holds at full strength for a moment before it fades. The scroll that
// brings the card into view is smooth and can take half a second, and a ring that
// started fading the moment it was asked for would be mostly gone by the time the
// card arrived.

/** The card being pointed out, and a number that is new for every request. */
export type PlannerReveal = { id: string; stamp: number };

/** How long the ring holds at full strength before it fades, while the scroll arrives. */
export const plannerRevealHoldMs = 300;

/** How long the ring then takes to fade, about a second and a half. */
export const plannerRevealMs = 1500;

/**
 * The ring: an Ember outline over the card that holds, then fades out. Only
 * opacity moves, and it eases in so the ring stays strong for most of the first
 * second and is gone at the end. With reduced motion it does not fade
 * (`motion-safe:`): it stays, still, for the same time and goes. Its
 * `delay-300` is `plannerRevealHoldMs` and its `duration-1500` is
 * `plannerRevealMs`.
 */
export const plannerRevealRingClass =
  "pointer-events-none absolute inset-0 rounded-xl ring-2 ring-brand-500 dark:ring-brand-400 motion-safe:animate-out motion-safe:fade-out-0 motion-safe:fill-mode-forwards motion-safe:delay-300 motion-safe:duration-1500 motion-safe:ease-in";

/** Wait this long after an edit before pointing at the card, so the board has caught up. */
const START_DELAY_MS = 50;
/** Keep the ring in the page a beat past its fade, so it is removed only once invisible. */
const END_MARGIN_MS = 100;

/** Whether the person asked their system for less motion. */
export function plannerPrefersReducedMotion(): boolean {
  try {
    return (
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  } catch {
    return false;
  }
}

/**
 * How to bring a card into view: the least scrolling that shows all of it
 * (`block` and `inline` "nearest", so a card already on screen does not move),
 * smoothly, or at once for someone who prefers reduced motion.
 */
export function plannerRevealScrollOptions(
  reducedMotion: boolean,
): ScrollIntoViewOptions {
  return {
    behavior: reducedMotion ? "auto" : "smooth",
    block: "nearest",
    inline: "nearest",
  };
}

/** Scrolls a card into view; a missing element (or a browser without `scrollIntoView`) is a no-op. */
export function plannerScrollCardIntoView(
  element: HTMLElement | null | undefined,
  reducedMotion: boolean = plannerPrefersReducedMotion(),
): void {
  element?.scrollIntoView?.(plannerRevealScrollOptions(reducedMotion));
}

/**
 * The current request, and the function that makes one. `request` is stable, and
 * a newer request replaces an older one, ring and all.
 */
export function usePlannerReveal(): {
  reveal: PlannerReveal | null;
  request: (taskId: string) => void;
} {
  const [reveal, setReveal] = useState<PlannerReveal | null>(null);
  const stamp = useRef(0);
  const timers = useRef<{ start?: number; end?: number }>({});

  useEffect(
    () => () => {
      window.clearTimeout(timers.current.start);
      window.clearTimeout(timers.current.end);
    },
    [],
  );

  const request = useCallback((taskId: string) => {
    window.clearTimeout(timers.current.start);
    window.clearTimeout(timers.current.end);
    timers.current.start = window.setTimeout(() => {
      stamp.current += 1;
      setReveal({ id: taskId, stamp: stamp.current });
      timers.current.end = window.setTimeout(
        () => setReveal(null),
        plannerRevealHoldMs + plannerRevealMs + END_MARGIN_MS,
      );
    }, START_DELAY_MS);
  }, []);

  return { reveal, request };
}
