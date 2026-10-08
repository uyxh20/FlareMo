import type { PlannerBoardCard } from "@flaremo/contracts";
import { useQuery } from "@tanstack/react-query";
import { BanIcon, ChevronRightIcon } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ApiError } from "@/api/client";
import { QueryErrorState } from "@/components/query-error-state";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { formatDateTime } from "@/lib/date-format";
import { cn } from "@/lib/utils";
import { plannerFetchTaskDetail } from "./api";
import { plannerCardColumn } from "./board-model";
import { plannerRelativeTime } from "./dates";
import { PlannerHistoryTimeline } from "./history-timeline";
import { plannerCardFromDetail, plannerLastTouched } from "./panel-model";
import { plannerQueryKeys } from "./query-keys";
import { usePlannerStrings } from "./strings";
import { PlannerTaskComments } from "./task-panel-comments";
import { PlannerTaskNotes, usePlannerAutoGrow } from "./task-panel-notes";
import { PlannerTaskProperties } from "./task-panel-properties";
import type { PlannerActions } from "./use-planner-actions";

// The task panel (fork-owned add-on,
// docs/planning-cockpit-implementation-plan.md, section 13): a card opened into a
// page, in a sheet on the right. It is Notion-like without being pages: a large
// title you edit in place, the properties as rows you click, a notes box that
// saves by itself, comments, a History you can unfold, and when the task was made
// and last touched. On a phone it fills the screen.
//
// The panel reads one `GET /tasks/:id` and keeps it in the query cache under
// `plannerQueryKeys.detail`. Every edit goes through the cockpit's actions, which
// patch that cache and the board behind it at once, so a change is on screen the
// moment it is made and rolled back, with a toast, if the server refuses.
//
// The page owns whether it is open (the `?task=` address, see use-task-param.ts),
// so a link opens it and the back button closes it. While it closes, its content
// stays until the sheet has slid away.

// --- The title ----------------------------------------------------------------

/**
 * The title, edited in place: Enter or leaving the field saves it, Esc puts the
 * saved title back. An empty title is not saved (a task needs one). While it is
 * not being typed into it follows the saved title, so an edit made elsewhere shows.
 */
function PanelTitle({
  card,
  actions,
}: {
  card: PlannerBoardCard;
  actions: PlannerActions;
}) {
  const strings = usePlannerStrings();
  const [draft, setDraft] = useState(card.title);
  const [focused, setFocused] = useState(false);
  const ref = useRef<HTMLTextAreaElement | null>(null);
  // Set by Escape for the length of the blur it causes: that blur runs `commit`
  // with the text as last rendered, which would save what Escape is throwing away.
  const reverting = useRef(false);
  usePlannerAutoGrow(ref, draft);

  useEffect(() => {
    if (!focused) setDraft(card.title);
  }, [card.title, focused]);

  const commit = () => {
    setFocused(false);
    const next = draft.trim();
    if (reverting.current || next === "" || next === card.title) {
      setDraft(card.title);
      return;
    }
    actions.setTitle(card, next);
  };

  return (
    <Textarea
      aria-label={strings.panel.titleLabel}
      className="field-sizing-fixed min-h-0 resize-none overflow-hidden border-transparent bg-transparent px-2 py-1 text-lg leading-snug font-semibold tracking-tight hover:bg-muted/60 focus-visible:bg-transparent sm:text-xl md:text-xl dark:bg-transparent dark:hover:bg-muted/40"
      maxLength={2000}
      placeholder={strings.panel.titlePlaceholder}
      ref={ref}
      rows={1}
      value={draft}
      onBlur={commit}
      // A title is one line: a pasted line break becomes a space.
      onChange={(event) =>
        setDraft(event.target.value.replace(/\s*[\r\n]+\s*/g, " "))
      }
      onFocus={() => setFocused(true)}
      onKeyDown={(event) => {
        if (event.key === "Enter" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          event.currentTarget.blur();
        } else if (event.key === "Escape") {
          // Put the saved title back and leave the field, not the panel.
          event.stopPropagation();
          reverting.current = true;
          event.currentTarget.blur();
          reverting.current = false;
        }
      }}
    />
  );
}

// --- History ------------------------------------------------------------------

/** The task's timeline, folded away until it is asked for (and unread until then). */
function PanelHistory({ taskId }: { taskId: string }) {
  const strings = usePlannerStrings();
  const [open, setOpen] = useState(false);
  const bodyId = useId();

  return (
    <section>
      <button
        aria-controls={bodyId}
        aria-expanded={open}
        className="flex cursor-pointer items-center gap-1 rounded-sm text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
        type="button"
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronRightIcon
          className={cn(
            "size-3.5 motion-safe:transition-transform motion-safe:duration-150",
            open && "rotate-90",
          )}
        />
        {strings.history.title}
      </button>
      {open && (
        <div className="pt-3" id={bodyId}>
          <PlannerHistoryTimeline taskId={taskId} />
        </div>
      )}
    </section>
  );
}

// --- Loading ------------------------------------------------------------------

function PanelSkeleton() {
  return (
    <div
      aria-busy="true"
      className="flex flex-col gap-6 px-5 pt-5"
      data-testid="planner-panel-loading"
    >
      <Skeleton className="h-7 w-3/4" />
      <div className="flex flex-col gap-3">
        {[0, 1, 2, 3, 4, 5, 6].map((row) => (
          <div className="flex items-center gap-3" key={row}>
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-6 w-32" />
          </div>
        ))}
      </div>
      <Skeleton className="h-24 w-full" />
    </div>
  );
}

// --- The body -----------------------------------------------------------------

function PanelBody({
  taskId,
  today,
  actions,
}: {
  taskId: string;
  today: string;
  actions: PlannerActions;
}) {
  const strings = usePlannerStrings();
  const query = useQuery({
    queryKey: plannerQueryKeys.detail(taskId),
    queryFn: () => plannerFetchTaskDetail(taskId),
    // Opening a task shows what is cached at once and reads the truth under it.
    staleTime: 0,
    refetchOnMount: "always",
    // A task that is gone will not come back by asking again.
    retry: (failures, error) =>
      !(error instanceof ApiError && error.status === 404) && failures < 2,
  });
  const detail = query.data;
  const card = useMemo(
    () => (detail ? plannerCardFromDetail(detail) : null),
    [detail],
  );
  // The title stays put while the rest scrolls; a hairline under it shows once
  // there is something sliding beneath it.
  const [scrolled, setScrolled] = useState(false);
  const nowMs = Date.now();

  if (!detail || !card) {
    if (query.isError) {
      const gone =
        query.error instanceof ApiError && query.error.status === 404;
      return (
        <div className="flex min-h-0 flex-1 flex-col px-5 pt-14">
          <SheetTitle className="sr-only">{strings.panel.label}</SheetTitle>
          {gone ? (
            <p className="text-sm leading-relaxed text-muted-foreground">
              {strings.panel.notFound}
            </p>
          ) : (
            <QueryErrorState
              className="min-h-56 text-muted-foreground"
              isRetrying={query.isRefetching}
              onRetry={() => void query.refetch()}
            />
          )}
        </div>
      );
    }
    return (
      <>
        <SheetTitle className="sr-only">{strings.panel.label}</SheetTitle>
        <PanelSkeleton />
      </>
    );
  }

  const dropped = plannerCardColumn(card) === "dropped";
  const createdExact = formatDateTime(
    detail.task.created_at,
    strings.intlLocale,
  );
  const touchedAt = plannerLastTouched(
    detail.task.updated_at,
    detail.plan?.updated_at,
  );
  const updatedExact = formatDateTime(touchedAt, strings.intlLocale);

  return (
    <>
      <SheetTitle className="sr-only">{card.title}</SheetTitle>
      {/* Room on the right for the sheet's close button. */}
      <div
        className={cn(
          "border-b border-transparent px-3 pt-4 pr-12 pb-2 motion-safe:transition-colors motion-safe:duration-150",
          scrolled && "border-border/60",
        )}
      >
        <PanelTitle actions={actions} card={card} />
      </div>
      <div
        className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto overscroll-contain px-5 pt-3 pb-[max(2rem,env(safe-area-inset-bottom))]"
        data-testid="planner-panel-body"
        onScroll={(event) => setScrolled(event.currentTarget.scrollTop > 0)}
      >
        {dropped && (
          <div
            className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-muted/60 px-3 py-2 text-sm"
            role="status"
          >
            <BanIcon className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 text-muted-foreground">
              {card.dropped_at &&
                strings.card.dropped(
                  plannerRelativeTime(
                    card.dropped_at,
                    nowMs,
                    strings.intlLocale,
                  ),
                )}
            </span>
            <Button
              size="sm"
              type="button"
              variant="outline"
              onClick={() => actions.undrop(card)}
            >
              {strings.menu.undrop}
            </Button>
          </div>
        )}

        <PlannerTaskProperties actions={actions} detail={detail} />

        <div className="border-t border-border/60 pt-5">
          <PlannerTaskNotes
            notes={detail.task.notes}
            taskId={taskId}
            today={today}
          />
        </div>

        <div className="border-t border-border/60 pt-5">
          <PlannerTaskComments comments={detail.comments} taskId={taskId} />
        </div>

        <div className="border-t border-border/60 pt-5">
          <PanelHistory taskId={taskId} />
        </div>

        <p className="flex flex-wrap gap-x-1.5 text-xs text-muted-foreground">
          <time dateTime={detail.task.created_at} title={createdExact}>
            {strings.panel.footer.created(createdExact)}
          </time>
          <span aria-hidden="true">·</span>
          <time dateTime={touchedAt} title={updatedExact}>
            {strings.panel.footer.updated(
              plannerRelativeTime(touchedAt, nowMs, strings.intlLocale),
            )}
          </time>
        </p>
      </div>
    </>
  );
}

// --- The sheet ----------------------------------------------------------------

export function PlannerTaskPanel({
  taskId,
  open,
  onOpenChange,
  today,
  actions,
}: {
  /** The task to show; null while no panel is wanted. */
  taskId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  today: string;
  actions: PlannerActions;
}) {
  const strings = usePlannerStrings();
  const popupRef = useRef<HTMLDivElement | null>(null);
  // The last task stays on show while the sheet slides away.
  const lastTask = useRef<string | null>(null);
  if (taskId !== null) lastTask.current = taskId;
  const shown = taskId ?? lastTask.current;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        // Wider than the sheet's default and, under the `sm` breakpoint, the whole
        // screen. The `data-[side=right]:` prefixes are what override the sheet's
        // own width classes, which carry them.
        className="w-full gap-0 p-0 outline-none data-[side=right]:w-full data-[side=right]:sm:max-w-[34rem] max-sm:border-l-0"
        // Focus the panel itself, not its first field: opening a task must not put
        // a caret in the title (or raise a keyboard on a phone).
        initialFocus={popupRef}
        ref={popupRef}
        side="right"
      >
        <SheetDescription className="sr-only">
          {strings.panel.label}
        </SheetDescription>
        {shown && (
          <PanelBody
            actions={actions}
            key={shown}
            taskId={shown}
            today={today}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}
