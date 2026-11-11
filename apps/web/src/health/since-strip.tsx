import { useLayoutEffect, useRef, useState } from "react";
import { healthStrings } from "./strings";

// The "days since your last night out" strip on the Health page's Nights out
// card (fork-owned, docs/fork-health-tracker.md). One small square per day
// since the last night out, oldest on the left and today at the end. A row that
// fills wraps into a new one, so the block visibly grows with the gap. Squares
// never shrink below HEALTH_SINCE_MIN_PX, and the strip stops at
// HEALTH_SINCE_MAX_ROWS rows: past that it shows only the most recent days and
// the left label says so.

export const HEALTH_SINCE_MIN_PX = 10;
export const HEALTH_SINCE_GAP_PX = 2;
export const HEALTH_SINCE_MAX_ROWS = 6;
// Used before the strip has a width (first paint, tests): a phone-width card.
const FALLBACK_WIDTH_PX = 340;

/** How many squares fit on one row of a strip this wide. */
export function healthSincePerRow(widthPx: number): number {
  return Math.max(
    1,
    Math.floor(
      (widthPx + HEALTH_SINCE_GAP_PX) /
        (HEALTH_SINCE_MIN_PX + HEALTH_SINCE_GAP_PX),
    ),
  );
}

/** Squares to draw for this gap, capped at HEALTH_SINCE_MAX_ROWS full rows. */
export function healthSinceShown(days: number, widthPx: number): number {
  return Math.min(
    Math.max(0, days),
    healthSincePerRow(widthPx) * HEALTH_SINCE_MAX_ROWS,
  );
}

const s = healthStrings.page;

export function HealthSinceStrip({ days }: { days: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(FALLBACK_WIDTH_PX);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth;
      if (w > 0) setWidth(w);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  if (days <= 0) return null;
  const shown = healthSinceShown(days, width);
  const capped = shown < days;
  return (
    <div className="flex flex-col gap-2" data-testid="health-since-strip">
      <div
        aria-label={s.sinceLast(days)}
        className="health-since-strip"
        ref={ref}
        role="img"
      >
        {Array.from({ length: shown }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed, ordered cells
          <span className="health-since-cell" key={i} />
        ))}
      </div>
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>
          {capped ? s.sinceStripCapped(shown) : s.sinceStripStart(days)}
        </span>
        <span>{s.sinceStripEnd}</span>
      </div>
    </div>
  );
}
