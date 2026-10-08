import type { PlannerBoardCard } from "@flaremo/contracts";
import { BanIcon, HistoryIcon, Undo2Icon } from "lucide-react";
import type { ReactNode } from "react";
import { QueryErrorState } from "@/components/query-error-state";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { plannerRelativeTime } from "./dates";
import { usePlannerStrings } from "./strings";
import type { PlannerCardRequest } from "./task-card";
import type { PlannerActions } from "./use-planner-actions";

// The Dropped list (fork-owned add-on,
// docs/planning-cockpit-implementation-plan.md, section 5): what the Show dropped
// switch reveals. It sits right under the filter row, above the columns, so it is
// on screen the moment the switch is on, and it is a compact list rather than a
// second board: a dropped task is parked, not planned, so each one is a single
// line (title, when it was dropped) with its Undrop button and a way to read its
// history. It scrolls inside itself when long, so the columns stay in reach.
// A title opens the task's panel, like a card on the board.

/** One dropped task: its title and when, then History and Undrop. */
function DroppedRow({
  card,
  actions,
  onRequest,
  onOpen,
}: {
  card: PlannerBoardCard;
  actions: PlannerActions;
  onRequest: (request: PlannerCardRequest) => void;
  onOpen: (card: PlannerBoardCard) => void;
}) {
  const strings = usePlannerStrings();
  return (
    <li
      className="flex items-center gap-2 rounded-lg bg-card py-1.5 pr-1.5 pl-3 shadow-xs ring-1 ring-foreground/10"
      data-testid="planner-dropped-item"
    >
      <div className="min-w-0 flex-1">
        <button
          aria-haspopup="dialog"
          className="block w-full cursor-pointer truncate rounded-sm text-left text-sm leading-snug text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
          title={card.title}
          type="button"
          onClick={() => onOpen(card)}
        >
          {card.title}
        </button>
        {card.dropped_at && (
          <p className="truncate text-xs leading-snug text-muted-foreground">
            {strings.card.dropped(
              plannerRelativeTime(
                card.dropped_at,
                Date.now(),
                strings.intlLocale,
              ),
            )}
          </p>
        )}
      </div>
      <Button
        aria-label={`${strings.menu.history}: ${card.title}`}
        size="icon-sm"
        title={strings.menu.history}
        type="button"
        variant="ghost"
        onClick={() => onRequest({ kind: "history", card })}
      >
        <HistoryIcon />
      </Button>
      <Button
        aria-label={`${strings.menu.undrop}: ${card.title}`}
        size="sm"
        type="button"
        variant="outline"
        onClick={() => actions.undrop(card)}
      >
        <Undo2Icon data-icon="inline-start" />
        {strings.menu.undrop}
      </Button>
    </li>
  );
}

export function PlannerDroppedList({
  cards,
  failed,
  isRetrying,
  onRetry,
  actions,
  onRequest,
  onOpen,
}: {
  /** The dropped tasks, newest first; undefined until the board has brought them. */
  cards: readonly PlannerBoardCard[] | undefined;
  /** The board failed to load the list (only matters while `cards` is undefined). */
  failed: boolean;
  isRetrying: boolean;
  onRetry: () => void;
  actions: PlannerActions;
  onRequest: (request: PlannerCardRequest) => void;
  /** Opens a dropped task's panel. */
  onOpen: (card: PlannerBoardCard) => void;
}) {
  const strings = usePlannerStrings();

  let body: ReactNode;
  if (cards === undefined) {
    body = failed ? (
      <QueryErrorState
        className="min-h-24 text-muted-foreground"
        isRetrying={isRetrying}
        onRetry={onRetry}
      />
    ) : (
      <div
        aria-busy="true"
        className="grid grid-cols-1 gap-1.5 sm:grid-cols-2 xl:grid-cols-3"
        data-testid="planner-dropped-loading"
      >
        <Skeleton className="h-11 w-full rounded-lg" />
      </div>
    );
  } else if (cards.length === 0) {
    body = (
      <p className="px-1 pb-1 text-xs text-muted-foreground">
        {strings.droppedEmpty}
      </p>
    );
  } else {
    body = (
      // The list scrolls when long; its padding (undone by the negative margin)
      // keeps the scroller from clipping the rows' ring and shadow. The columns
      // are `minmax(0, 1fr)`, not `auto`: with `auto` one long title would widen
      // the single column past the screen and push History and Undrop out of it.
      <ul className="-m-0.5 grid max-h-52 grid-cols-1 gap-1.5 overflow-y-auto p-0.5 sm:grid-cols-2 xl:grid-cols-3">
        {cards.map((card) => (
          <DroppedRow
            actions={actions}
            card={card}
            key={card.id}
            onOpen={onOpen}
            onRequest={onRequest}
          />
        ))}
      </ul>
    );
  }

  return (
    <section
      aria-label={strings.column.dropped}
      className="flex flex-col gap-1.5 rounded-xl bg-muted/35 p-2 motion-safe:animate-fade"
      data-testid="planner-dropped"
    >
      <header className="flex items-center gap-2 px-1">
        <BanIcon className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-medium">{strings.column.dropped}</h2>
        {cards !== undefined && (
          <span className="text-xs text-muted-foreground tabular-nums">
            {cards.length}
          </span>
        )}
      </header>
      {body}
    </section>
  );
}
