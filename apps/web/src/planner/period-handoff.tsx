import { plannerPeriodLabel } from "@flaremo/contracts";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CalendarRangeIcon } from "lucide-react";
import { plannerFetchPeriodStatus } from "./period-api";
import { usePlannerPeriodStrings } from "./period-strings";
import { plannerQueryKeys } from "./query-keys";

// The weekly review's one hand-off to the month, quarter and year reviews
// (fork-owned add-on, docs/planning-cockpit-period-review.md): a tile under the
// two parts, shown once Look back is done on a Sunday a period closes. The
// weekly review itself is untouched beyond rendering this element; the period
// review reads Look back's result and Look forward then reads the new goals.

export function PlannerPeriodHandoff({
  today,
  lookBackDone,
}: {
  today: string;
  lookBackDone: boolean;
}) {
  const strings = usePlannerPeriodStrings();
  const status = useQuery({
    queryKey: plannerQueryKeys.periodStatus(today),
    queryFn: () => plannerFetchPeriodStatus(today),
    staleTime: 5 * 60_000,
    retry: false,
  });
  const due = status.data?.due ?? [];
  if (due.length === 0) return null;
  return (
    <div
      className="flex flex-col gap-1.5 rounded-xl border border-border bg-card px-3 py-2.5"
      data-testid="planner-period-handoff"
    >
      {due.map((entry) => (
        <Link
          className="flex items-center gap-2.5 text-sm outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/50"
          key={`${entry.level}:${entry.period_start}`}
          search={{
            level: entry.level,
            period: entry.period_start,
            step: undefined,
          }}
          to="/period-review"
        >
          <CalendarRangeIcon className="size-4 shrink-0 text-brand-600 dark:text-brand-400" />
          <span className="font-medium">
            {strings.levels[entry.level]} ·{" "}
            {plannerPeriodLabel(entry.level, entry.period_start)}
          </span>
          <span className="ml-auto text-xs text-muted-foreground">
            {entry.done
              ? `✓ ${strings.done}`
              : lookBackDone
                ? strings.dueNow
                : strings.lookBackFirst}
          </span>
        </Link>
      ))}
    </div>
  );
}
