import type { PlannerBoardCard } from "@flaremo/contracts";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { QueryErrorState } from "@/components/query-error-state";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
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
// docs/planning-cockpit-implementation-plan.md, section 5): everything the
// archive kept, newest first, with who did it and when. Times are relative, with
// the exact moment on hover. The server syncs the archive before it answers, so an
// edit made a moment ago from /projects or the API is already in it.

export function PlannerHistorySheet({
  card,
  open,
  onOpenChange,
}: {
  card: PlannerBoardCard | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const strings = usePlannerStrings();
  const taskId = card?.id ?? "";

  const query = useQuery({
    queryKey: plannerQueryKeys.history(taskId),
    queryFn: () => plannerFetchTaskHistory(taskId),
    enabled: open && taskId !== "",
    // A timeline is read once per opening and must show what just happened.
    staleTime: 0,
    refetchOnMount: "always",
  });

  const entries = useMemo(
    () => plannerDescribeHistory(query.data?.events ?? [], strings),
    [query.data, strings],
  );
  const nowMs = Date.now();

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full gap-0 sm:max-w-md" side="right">
        <SheetHeader className="pr-12">
          <SheetTitle>{strings.history.title}</SheetTitle>
          <SheetDescription className="line-clamp-2 break-words">
            {card?.title ?? strings.history.description}
          </SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6">
          {query.isPending ? (
            <div
              aria-busy="true"
              className="flex flex-col gap-4 pt-2"
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
          ) : query.isError ? (
            <QueryErrorState
              className="min-h-40 text-muted-foreground"
              isRetrying={query.isRefetching}
              onRetry={() => void query.refetch()}
            />
          ) : entries.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {strings.history.empty}
            </p>
          ) : (
            <ol className="flex flex-col" data-testid="planner-history">
              {entries.map((entry, index) => {
                const exact = formatDateTime(
                  entry.occurredAt,
                  strings.intlLocale,
                );
                return (
                  <li
                    className="relative flex gap-3 pb-5 last:pb-0"
                    key={entry.id}
                  >
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
                      <p className="text-sm leading-snug break-words">
                        {entry.label}
                      </p>
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
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
