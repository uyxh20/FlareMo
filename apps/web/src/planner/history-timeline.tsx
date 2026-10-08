import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { QueryErrorState } from "@/components/query-error-state";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { formatDateTime } from "@/lib/date-format";
import { cn } from "@/lib/utils";
import { plannerFetchTaskHistory } from "./api";
import { plannerRelativeTime } from "./dates";
import { plannerDescribeHistory } from "./history-labels";
import { plannerQueryKeys } from "./query-keys";
import { usePlannerStrings } from "./strings";

// One task's timeline (fork-owned add-on,
// docs/planning-cockpit-implementation-plan.md, sections 5 and 13): everything the
// archive kept, newest first, with who did it and when. Times are relative, with
// the exact moment on hover. The server syncs the archive before it answers, so an
// edit made a moment ago from /projects or the API is already in it.
//
// It is the body of the history sheet (the card menu's "History") and of the
// task panel's collapsible History section, so the two can never read differently.
// It fetches only while `enabled`, which is how the panel's section stays unread
// until it is opened.

export function PlannerHistoryTimeline({
  taskId,
  enabled = true,
  className,
}: {
  taskId: string;
  enabled?: boolean;
  className?: string;
}) {
  const strings = usePlannerStrings();

  const query = useQuery({
    queryKey: plannerQueryKeys.history(taskId),
    queryFn: () => plannerFetchTaskHistory(taskId),
    enabled: enabled && taskId !== "",
    // A timeline is read once per opening and must show what just happened.
    staleTime: 0,
    refetchOnMount: "always",
  });

  const entries = useMemo(
    () => plannerDescribeHistory(query.data?.events ?? [], strings),
    [query.data, strings],
  );
  const nowMs = Date.now();

  if (query.isPending) {
    return (
      <div
        aria-busy="true"
        className={cn("flex flex-col gap-4 pt-2", className)}
        data-testid="planner-history-loading"
      >
        {[0, 1, 2, 3].map((row) => (
          <div className="flex gap-3" key={row}>
            <Skeleton className="mt-1.5 size-2 shrink-0 rounded-full" />
            <div className="flex flex-1 flex-col gap-1.5">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-3 w-1/3" />
            </div>
          </div>
        ))}
      </div>
    );
  }
  if (query.isError) {
    return (
      <QueryErrorState
        className={cn("min-h-40 text-muted-foreground", className)}
        isRetrying={query.isRefetching}
        onRetry={() => void query.refetch()}
      />
    );
  }
  if (entries.length === 0) {
    return (
      <p
        className={cn(
          "py-6 text-center text-sm text-muted-foreground",
          className,
        )}
      >
        {strings.history.empty}
      </p>
    );
  }
  return (
    <ol
      className={cn("flex flex-col", className)}
      data-testid="planner-history"
    >
      {entries.map((entry, index) => {
        const exact = formatDateTime(entry.occurredAt, strings.intlLocale);
        return (
          <li className="relative flex gap-3 pb-5 last:pb-0" key={entry.id}>
            {index < entries.length - 1 && (
              <span
                aria-hidden="true"
                className="absolute top-4 bottom-0 left-[3.5px] w-px bg-border/70"
              />
            )}
            <span
              aria-hidden="true"
              className={cn(
                "relative mt-1.5 size-2 shrink-0 rounded-full",
                index === 0 ? "bg-brand-500" : "bg-muted-foreground/40",
              )}
            />
            <div className="min-w-0 flex-1">
              <p className="text-sm leading-snug break-words">{entry.label}</p>
              {entry.detail && (
                <p className="mt-0.5 text-xs leading-snug text-muted-foreground break-words">
                  {entry.detail}
                </p>
              )}
              <p className="mt-1 flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
                {entry.actor && (
                  <>
                    <span>{entry.actor}</span>
                    <span aria-hidden="true">·</span>
                  </>
                )}
                <Tooltip>
                  <TooltipTrigger
                    className="cursor-default"
                    render={<time dateTime={entry.occurredAt} />}
                  >
                    {plannerRelativeTime(
                      entry.occurredAt,
                      nowMs,
                      strings.intlLocale,
                    )}
                    {/* Hover shows the exact time; a screen reader reads it here. */}
                    <span className="sr-only"> ({exact})</span>
                  </TooltipTrigger>
                  <TooltipContent>{exact}</TooltipContent>
                </Tooltip>
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
