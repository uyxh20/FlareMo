import { useEffect, useState } from "react";
import { todayKey } from "@/lib/calendar-date";

// The cockpit's "today" (fork-owned add-on,
// docs/planning-cockpit-implementation-plan.md, section 4): the client's local
// calendar day, which the server accepts within one day of its own UTC date. It is
// state, not a constant, because a cockpit left open overnight must notice that
// the day changed: the page re-runs rollover for the new day, and everything
// that is "today" moves with it.

/** Milliseconds from `now` to two seconds past the next local midnight. */
export function plannerMsUntilMidnight(now: Date): number {
  const next = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + 1,
    0,
    0,
    2,
  );
  return Math.max(1_000, next.getTime() - now.getTime());
}

/**
 * The local date as `YYYY-MM-DD`, kept current. It is re-read when the tab comes
 * back (a laptop that slept through midnight fires `visibilitychange`, and
 * browsers throttle timers in hidden tabs) and by a timer for a tab that stays in
 * front across midnight. An unchanged date keeps the same string, so nothing
 * re-renders.
 */
export function usePlannerToday(): string {
  const [today, setToday] = useState(() => todayKey());

  useEffect(() => {
    const refresh = () => {
      const next = todayKey();
      setToday((current) => (current === next ? current : next));
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") refresh();
    };

    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      timer = setTimeout(() => {
        refresh();
        schedule();
      }, plannerMsUntilMidnight(new Date()));
    };
    schedule();

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", refresh);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", refresh);
      if (timer !== undefined) clearTimeout(timer);
    };
  }, []);

  return today;
}
