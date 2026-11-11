import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { SunriseIcon } from "lucide-react";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { plannerFetchMorning, plannerMorningMemory } from "./morning-api";
import { plannerQueryKeys } from "./query-keys";
import { usePlannerToday } from "./use-planner-clock";

// The morning page's door in the diary's header (fork-owned add-on,
// docs/fork-customizations.md "Morning page"). workspace-header.tsx renders
// it once, next to search, so the upstream edit is one import and one element.
//
// - It is the "Replay the morning page" button: a small sunrise icon.
// - It is the gate: the first time the diary opens on a day, until "Start the
//   day" is pressed, it sends the owner to /morning. Once per browser session,
//   so going back to the diary without pressing it does not loop. A day this
//   browser already saw dismissed is not asked about again.

export const plannerMorningReplayLabel = "Replay the morning page";

export function PlannerMorningEntry() {
  const today = usePlannerToday();
  const navigate = useNavigate();
  const known = plannerMorningMemory.dismissed(today);
  const status = useQuery({
    queryKey: plannerQueryKeys.morning(today),
    queryFn: () => plannerFetchMorning(today),
    enabled: !known && !plannerMorningMemory.opened(today),
    staleTime: 5 * 60_000,
    retry: false,
  });
  const dismissed = status.data?.dismissed;

  useEffect(() => {
    if (dismissed === undefined) return;
    if (dismissed) {
      plannerMorningMemory.markDismissed(today);
      return;
    }
    if (plannerMorningMemory.opened(today)) return;
    plannerMorningMemory.markOpened(today);
    void navigate({ to: "/morning", replace: false });
  }, [dismissed, today, navigate]);

  return (
    <Button
      aria-label={plannerMorningReplayLabel}
      render={<Link to="/morning" />}
      size="icon-sm"
      title={plannerMorningReplayLabel}
      variant="ghost"
    >
      <SunriseIcon />
    </Button>
  );
}
