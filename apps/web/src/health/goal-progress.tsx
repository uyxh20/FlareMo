import type { HealthGoalProgress } from "@flaremo/contracts";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { healthFetchGoalProgress } from "./api";
import { healthGoalProgressText } from "./model";
import { healthQueryKeys } from "./query-keys";
import { healthStrings } from "./strings";
import "./health.css";

// A tracker's count on the goal it is linked to (fork-owned add-on,
// docs/fork-health-tracker.md, "Trackers"). The goal's own words hold the
// target; this line only says how far the diary has got in the goal's period.

export function useHealthGoalProgress() {
  return useQuery({
    queryKey: healthQueryKeys.goalProgress,
    queryFn: healthFetchGoalProgress,
    staleTime: 60_000,
    retry: false,
  });
}

/** The lines of one goal, from the whole list. */
export function healthProgressOf(
  progress: readonly HealthGoalProgress[] | undefined,
  goalId: string,
): HealthGoalProgress[] {
  return (progress ?? []).filter((item) => item.goal_id === goalId);
}

/** One line per tracker linked to this goal; nothing when none is. */
export function HealthGoalProgressLines({
  goalId,
  className,
}: {
  goalId: string;
  className?: string;
}) {
  const query = useHealthGoalProgress();
  const lines = healthProgressOf(query.data?.progress, goalId);
  if (lines.length === 0) return null;
  return (
    <ul className={cn("flex flex-col gap-1", className)}>
      {lines.map((line) => (
        <li
          aria-label={healthStrings.trackers.goalLabel(line.label)}
          className={cn(
            "flex items-center gap-2 text-[13px] text-muted-foreground tabular-nums",
            `health-kind-t-${line.color}`,
          )}
          data-testid="health-goal-progress"
          key={line.kind}
        >
          <span
            aria-hidden
            className="size-2 shrink-0 rounded-full"
            style={{ background: "var(--k)" }}
          />
          <span className="min-w-0">{healthGoalProgressText(line)}</span>
        </li>
      ))}
    </ul>
  );
}
