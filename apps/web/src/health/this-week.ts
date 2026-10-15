import { healthLocalMoment, healthWeekStartOf } from "@flaremo/contracts";
import { useQuery } from "@tanstack/react-query";
import { healthFetchWeek } from "./api";
import { healthQueryKeys } from "./query-keys";

// "This week" for the health tracker (fork-owned add-on,
// docs/fork-health-tracker.md): Monday to Sunday in the owner's time zone, the
// same week the weekly review uses. The diary strip and the Health page read it
// through this one hook, so they share one request and one cache entry.

/** The Monday of the current week, in the zone the days are filed under. */
export function healthThisWeekStart(now: Date = new Date()): string {
  return healthWeekStartOf(healthLocalMoment(now).day);
}

export function useHealthThisWeek(options: { enabled?: boolean } = {}) {
  const start = healthThisWeekStart();
  return useQuery({
    queryKey: healthQueryKeys.week(start),
    queryFn: () => healthFetchWeek(start),
    enabled: options.enabled ?? true,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    retry: false,
  });
}
