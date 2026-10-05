import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { CirclePauseIcon, GaugeIcon, InfoIcon, PlusIcon } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { QueryErrorState } from "@/components/query-error-state";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { FilterPill } from "@/components/ui/filter-pill";
import { Switch } from "@/components/ui/switch";
import { WorkspaceLayout } from "@/components/workspace/workspace-layout";
import { WorkspacePageHeader } from "@/components/workspace/workspace-page-header";
import { plannerFetchBoard } from "./api";
import { PlannerBoard, PlannerBoardSkeleton } from "./board";
import { plannerBoardCardCount } from "./board-model";
import { PlannerCardDialogs, usePlannerCardRequests } from "./card-dialogs";
import { PlannerDroppedList } from "./dropped-list";
import { plannerQueryKeys } from "./query-keys";
import { PlannerQuickAdd } from "./quick-add";
import { usePlannerStrings } from "./strings";
import {
  type PlannerHorizonFilter,
  plannerHorizonFilters,
  plannerTodoCounts,
} from "./todo-filter";
import { usePlannerActions } from "./use-planner-actions";
import { usePlannerToday } from "./use-planner-clock";
import { usePlannerReveal } from "./use-planner-reveal";
import { usePlannerRollover } from "./use-planner-rollover";

// The planning cockpit at /cockpit (fork-owned add-on,
// docs/planning-cockpit-implementation-plan.md, section 5): a quick add, filter
// chips for To Do (All, Today, This week, This month: what is planned inside the
// current period), a Show dropped switch whose list sits right under them, and a
// Backlog / To Do / Doing / Done board. It opens by rolling unfinished plans
// forward into the current period, then loads the board. The layout is the same
// WorkspaceLayout and WorkspacePageHeader as /projects.

/** Short, quiet notes above the board: history paused, cards hidden by the cap. */
function Notice({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title?: string;
  children: ReactNode;
}) {
  return (
    <div
      className="flex items-start gap-2 rounded-lg bg-muted/50 px-3 py-2 text-xs leading-relaxed text-muted-foreground motion-safe:animate-fade"
      role="status"
    >
      <span className="mt-0.5 shrink-0 [&>svg]:size-3.5">{icon}</span>
      <p className="min-w-0">
        {title && (
          <span className="mr-1.5 font-medium text-foreground">{title}</span>
        )}
        {children}
      </p>
    </div>
  );
}

export function PlannerCockpitPage() {
  const strings = usePlannerStrings();
  const today = usePlannerToday();
  const rolloverSettled = usePlannerRollover(today);
  const [includeDropped, setIncludeDropped] = useState(false);
  const [filter, setFilter] = useState<PlannerHorizonFilter>("all");
  const quickAddRef = useRef<HTMLInputElement | null>(null);
  const showDroppedId = useId();
  const { reveal, request: requestReveal } = usePlannerReveal();
  const actions = usePlannerActions({ today, reveal: requestReveal });
  const requests = usePlannerCardRequests();

  const boardQuery = useQuery({
    queryKey: plannerQueryKeys.board(today, includeDropped),
    queryFn: () => plannerFetchBoard({ today, includeDropped }),
    // Rollover first, so a card carried into today is on the board that arrives.
    enabled: rolloverSettled,
    staleTime: 15_000,
    // Edits made elsewhere (an agent, /projects) show up when the tab returns.
    refetchOnWindowFocus: true,
    // Toggling Show dropped or crossing midnight keeps the old board up until
    // the new one lands, instead of flashing the skeleton.
    placeholderData: keepPreviousData,
  });
  const board = boardQuery.data;

  // Cards stagger in once, when the board first appears, and never again.
  const [entering, setEntering] = useState(true);
  const hasBoard = board !== undefined;
  useEffect(() => {
    if (!hasBoard) return;
    const timer = window.setTimeout(() => setEntering(false), 900);
    return () => window.clearTimeout(timer);
  }, [hasBoard]);

  const counts = plannerTodoCounts(board?.columns.todo ?? [], today);
  const dropped = board?.columns.dropped;

  let content: ReactNode;
  if (!board && boardQuery.isError) {
    content = (
      <QueryErrorState
        className="min-h-56"
        isRetrying={boardQuery.isRefetching}
        onRetry={() => void boardQuery.refetch()}
      />
    );
  } else if (!board) {
    content = <PlannerBoardSkeleton />;
  } else if (plannerBoardCardCount(board) === 0) {
    content = (
      <Empty className="min-h-56 border" data-testid="planner-empty">
        <EmptyHeader>
          <EmptyTitle>{strings.empty.title}</EmptyTitle>
          <EmptyDescription>{strings.empty.body}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button
            size="sm"
            variant="outline"
            onClick={() => quickAddRef.current?.focus()}
          >
            <PlusIcon data-icon="inline-start" />
            {strings.empty.action}
          </Button>
        </EmptyContent>
      </Empty>
    );
  } else {
    content = (
      <PlannerBoard
        actions={actions}
        board={board}
        entering={entering}
        filter={filter}
        reveal={reveal}
        today={today}
        onRequest={requests.show}
      />
    );
  }

  return (
    <WorkspaceLayout
      maxWidthClass="max-w-[1320px]"
      outerMaxWidthClass="max-w-[1600px]"
      header={({
        sidebarCollapsed,
        toggleSidebarCollapsed,
        mobileSheetOpen,
        setMobileSheetOpen,
        explorer,
      }) => (
        <WorkspacePageHeader
          explorer={explorer}
          icon={
            <GaugeIcon className="size-4 shrink-0 text-brand-600 dark:text-brand-400" />
          }
          maxWidthClass="max-w-[1320px]"
          mobileSheetOpen={mobileSheetOpen}
          setMobileSheetOpen={setMobileSheetOpen}
          sidebarCollapsed={sidebarCollapsed}
          title={strings.title}
          toggleSidebarCollapsed={toggleSidebarCollapsed}
        />
      )}
    >
      <div className="flex flex-col gap-4 py-2">
        <PlannerQuickAdd actions={actions} inputRef={quickAddRef} />

        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <fieldset className="m-0 flex min-w-0 flex-wrap items-center gap-2 border-0 p-0">
            <legend className="sr-only">{strings.filter.label}</legend>
            {plannerHorizonFilters.map((option) => (
              <FilterPill
                active={filter === option}
                count={board ? counts[option] : undefined}
                key={option}
                label={
                  option === "all"
                    ? strings.filter.all
                    : strings.horizon[option]
                }
                onClick={() => setFilter(option)}
              />
            ))}
          </fieldset>
          <div className="ml-auto flex items-center gap-2">
            <Switch
              checked={includeDropped}
              id={showDroppedId}
              onCheckedChange={setIncludeDropped}
            />
            <label
              className="cursor-pointer text-xs text-muted-foreground select-none"
              htmlFor={showDroppedId}
            >
              {strings.showDropped}
            </label>
          </div>
        </div>

        {includeDropped && (
          <PlannerDroppedList
            actions={actions}
            cards={dropped}
            failed={boardQuery.isError}
            isRetrying={boardQuery.isRefetching}
            onRequest={requests.show}
            onRetry={() => void boardQuery.refetch()}
          />
        )}

        {board?.history === "paused" && (
          <Notice
            icon={<CirclePauseIcon />}
            title={strings.notice.historyPausedTitle}
          >
            {strings.notice.historyPausedBody}
          </Notice>
        )}
        {board?.truncated && (
          <Notice icon={<InfoIcon />}>{strings.notice.truncated}</Notice>
        )}

        {content}
      </div>

      <PlannerCardDialogs
        actions={actions}
        open={requests.open}
        shown={requests.shown}
        today={today}
        onClose={requests.close}
      />
    </WorkspaceLayout>
  );
}
