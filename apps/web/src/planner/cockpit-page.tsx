import type { PlannerBoardCard } from "@flaremo/contracts";
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
import { PlannerTaskPanel } from "./task-panel";
import { usePlannerActions } from "./use-planner-actions";
import { usePlannerToday } from "./use-planner-clock";
import { usePlannerReveal } from "./use-planner-reveal";
import { usePlannerTaskParam } from "./use-task-param";

// The planning cockpit at /cockpit (fork-owned add-on,
// docs/planning-cockpit-implementation-plan.md, section 5 and section 13.x): a quick
// add, a Show dropped switch whose list sits right under it, and one Backlog /
// To Do / Doing / Done board that always shows every card. There are no period
// chips and no carry-over (v1.2). The layout is the same WorkspaceLayout and
// WorkspacePageHeader as /projects.
//
// A card opens into its task panel (task-panel.tsx), whose state lives in the
// address as `?task=<id>`: a link opens it, the back button closes it.

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
  const [includeDropped, setIncludeDropped] = useState(false);
  const quickAddRef = useRef<HTMLInputElement | null>(null);
  const showDroppedId = useId();
  const { reveal, request: requestReveal } = usePlannerReveal();
  const actions = usePlannerActions({ today, reveal: requestReveal });
  const requests = usePlannerCardRequests();
  const panel = usePlannerTaskParam();
  const openCard = (card: PlannerBoardCard) => panel.open(card.id);

  const boardQuery = useQuery({
    queryKey: plannerQueryKeys.board(today, includeDropped),
    queryFn: () => plannerFetchBoard({ today, includeDropped }),
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
        reveal={reveal}
        today={today}
        onOpen={openCard}
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
            onOpen={openCard}
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
        onClose={requests.close}
      />

      <PlannerTaskPanel
        actions={actions}
        open={panel.taskId !== null}
        taskId={panel.taskId}
        today={today}
        onOpenChange={(next) => {
          if (!next) panel.close();
        }}
      />
    </WorkspaceLayout>
  );
}
