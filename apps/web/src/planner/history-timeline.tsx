import { plannerEventRevertible } from "@flaremo/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Undo2Icon } from "lucide-react";
import { useMemo } from "react";
import { toast } from "sonner";
import { QueryErrorState } from "@/components/query-error-state";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { formatDateTime } from "@/lib/date-format";
import { queryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";
import {
  plannerErrorMessage,
  plannerFetchTaskHistory,
  plannerRevertEventRequest,
} from "./api";
import { plannerRelativeTime } from "./dates";
import {
  plannerDescribeHistory,
  plannerRevertedEventIds,
} from "./history-labels";
import { plannerQueryKeys } from "./query-keys";
import { usePlannerStrings } from "./strings";
import { plannerToastId } from "./use-planner-actions";
import { usePlannerToday } from "./use-planner-clock";

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
//
// A line that can be put back carries Revert (docs/fork-general-agent.md,
// "Revert"): the inverse change is made as a new change and the timeline gets
// a "Reverted an earlier change" line; the archive is never rewritten. A line
// a later revert already names has no button. What the server cannot put back
// (an earlier value the archive never held) it says in the toast.

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
  const today = usePlannerToday();
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: plannerQueryKeys.history(taskId),
    queryFn: () => plannerFetchTaskHistory(taskId),
    enabled: enabled && taskId !== "",
    // A timeline is read once per opening and must show what just happened.
    staleTime: 0,
    refetchOnMount: "always",
  });

  const events = query.data?.events;
  const entries = useMemo(
    () => plannerDescribeHistory(events ?? [], strings),
    [events, strings],
  );
  // Which lines offer Revert: the archive's own rule, minus the lines already
  // put back and the ones that are reverts themselves.
  const revertible = useMemo(() => {
    const done = plannerRevertedEventIds(events ?? []);
    return new Set(
      (events ?? [])
        .filter((event) => plannerEventRevertible(event) && !done.has(event.id))
        .map((event) => event.id),
    );
  }, [events]);
  const nowMs = Date.now();

  const revert = useMutation({
    mutationFn: (eventId: number) =>
      plannerRevertEventRequest(taskId, eventId, today),
    onSuccess: () => {
      toast.success(strings.history.revertDone, { id: plannerToastId });
      // The task changed: the timeline, the panel, the board and upstream's
      // lists read it again.
      void queryClient.invalidateQueries({
        queryKey: plannerQueryKeys.history(taskId),
      });
      void queryClient.invalidateQueries({
        queryKey: plannerQueryKeys.detail(taskId),
      });
      void queryClient.invalidateQueries({
        queryKey: plannerQueryKeys.boards,
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all });
      // An agent-drafted change put back: its card reads "Reverted".
      void queryClient.invalidateQueries({ queryKey: plannerQueryKeys.asks });
    },
    onError: (error) => {
      toast.error(
        plannerErrorMessage(
          error,
          strings.history.revertFailed,
          strings.toast.rateLimited,
        ),
        { id: plannerToastId },
      );
    },
  });

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
              <div className="flex items-start gap-2">
                <p className="min-w-0 flex-1 text-sm leading-snug break-words">
                  {entry.label}
                </p>
                {revertible.has(entry.id) && (
                  <Button
                    aria-label={`${strings.history.revert}: ${entry.label}`}
                    className="-my-1 shrink-0 text-muted-foreground"
                    disabled={revert.isPending}
                    size="xs"
                    type="button"
                    variant="ghost"
                    onClick={() => revert.mutate(entry.id)}
                  >
                    <Undo2Icon data-icon="inline-start" />
                    {strings.history.revert}
                  </Button>
                )}
              </div>
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
