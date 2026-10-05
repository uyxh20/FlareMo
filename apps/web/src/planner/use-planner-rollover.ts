import type { PlannerRolloverResponse } from "@flaremo/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { plannerRolloverRequest } from "./api";
import { plannerQueryKeys } from "./query-keys";
import { usePlannerStrings } from "./strings";

// Rollover on open (fork-owned add-on,
// docs/planning-cockpit-implementation-plan.md, section 4): the page calls
// POST /rollover for the local day, and only then loads the board, so a card
// carried into today is already there when the board arrives. The server also
// syncs the history in the same call, which is why it runs on every open and not
// just once a day.
//
// It never blocks the page. A failed rollover (offline, a wrong clock, throttled)
// is swallowed: the board request that follows reports a real problem, and one
// that was only the rollover should not hide the board.

// Two effects for one mount (React's StrictMode double-invokes in development)
// and two mounts in a row must share one request, so the carried toast is
// announced once and a day is not rolled over twice at the same moment.
const inFlight = new Map<string, Promise<PlannerRolloverResponse | null>>();
const announced = new WeakSet<object>();

function rolloverOnce(today: string): Promise<PlannerRolloverResponse | null> {
  const running = inFlight.get(today);
  if (running) return running;
  const started = plannerRolloverRequest(today)
    .catch(() => null)
    .finally(() => {
      inFlight.delete(today);
    });
  inFlight.set(today, started);
  return started;
}

/**
 * Runs rollover for `today` whenever the page opens and whenever the local day
 * changes, and reports whether it has settled for the current day. When it
 * carried plans it says so in a quiet toast and refreshes the cached boards.
 */
export function usePlannerRollover(today: string): boolean {
  const queryClient = useQueryClient();
  const strings = usePlannerStrings();
  const stringsRef = useRef(strings);
  stringsRef.current = strings;
  const [settledFor, setSettledFor] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void rolloverOnce(today).then((result) => {
      if (result && result.carried > 0 && !announced.has(result)) {
        announced.add(result);
        toast(stringsRef.current.toast.carried(result.carried));
        void queryClient.invalidateQueries({
          queryKey: plannerQueryKeys.boards,
        });
      }
      if (active) setSettledFor(today);
    });
    return () => {
      active = false;
    };
  }, [today, queryClient]);

  return settledFor === today;
}
