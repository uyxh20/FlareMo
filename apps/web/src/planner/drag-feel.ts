// How lifting a card feels on a touch screen (fork-owned add-on,
// docs/planning-cockpit-implementation-plan.md, section 5): the numbers behind
// the board's touch sensor, and the small cues that tell a finger the card came
// up. Plain data and tiny functions, so the numbers can be tested and read
// without rendering anything.

/**
 * A card lifts on touch only after a deliberate long press: the finger stays put
 * (within `tolerance` px) for `delay` ms. Moving more than that first cancels the
 * lift, so a swipe scrolls the columns instead of carrying a card away.
 *
 * It was 200 ms and 8 px, which a slow swipe satisfied without trying: a finger
 * that crept along for the first 200 ms lifted the card and then dragged it.
 *
 * What the numbers can do is limited by the browser: Chromium does not report a
 * touch's first 15 px or so of movement (it holds back `touchmove` until the
 * finger leaves a slop region), so the sensor sees a move only once the finger is
 * past it. The delay is therefore what matters most. Measured with real touch
 * input in Chromium, a finger moving faster than about 100 px/s scrolled at
 * 200 ms; at 400 ms anything faster than about 50 px/s scrolls, and only a creep
 * slower than that (a press with a slow drift) still lifts the card.
 */
export const plannerTouchActivation = { delay: 400, tolerance: 5 } as const;

/**
 * The lift itself, on the copy of the card that follows the finger: it grows a
 * touch (`zoom-out-[1.03]` is the animation library's "end at 1.03×", held by
 * `fill-mode-forwards`) in 150 ms. With reduced motion the card still lifts, as
 * the overlay's deeper shadow and Ember ring, just without the growing.
 */
export const plannerLiftClass =
  "motion-safe:animate-out motion-safe:zoom-out-[1.03] motion-safe:fill-mode-forwards motion-safe:duration-150 motion-safe:ease-signal";

/**
 * Whether a drag was started by a finger. The activator event of a touch drag is
 * a `TouchEvent`; a mouse drag's is a `MouseEvent`. Checked by shape, because
 * the `TouchEvent` constructor is not defined in every browser.
 */
export function plannerIsTouchActivation(
  event: Event | null | undefined,
): boolean {
  return event != null && "touches" in event;
}

/**
 * A short buzz as the card comes up, where the device has one (Android; iOS
 * Safari has no `navigator.vibrate`). Browsers also refuse it until the page has
 * been tapped once and a vibration must never break a drag, so every failure is
 * swallowed.
 */
export function plannerHaptic(milliseconds = 10): void {
  try {
    if (
      typeof navigator !== "undefined" &&
      typeof navigator.vibrate === "function"
    ) {
      navigator.vibrate(milliseconds);
    }
  } catch {
    // No haptics is the same as haptics that did not fire.
  }
}
