import {
  type Announcements,
  type CollisionDetection,
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  MouseSensor,
  pointerWithin,
  rectIntersection,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import type {
  PlannerBoardCard,
  PlannerBoardResponse,
  PlannerColumn,
} from "@flaremo/contracts";
import { PlusIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  type PlannerColumnKey,
  plannerCardColumn,
  plannerColumns,
  plannerFindCard,
  plannerIsPendingCard,
} from "./board-model";
import { plannerColumnAddTarget } from "./column-add";
import { PlannerColumnComposer } from "./column-composer";
import {
  plannerHaptic,
  plannerIsTouchActivation,
  plannerLiftClass,
  plannerTouchActivation,
} from "./drag-feel";
import { usePlannerStrings } from "./strings";
import {
  type PlannerCardRequest,
  PlannerColumnIcon,
  PlannerTaskCard,
} from "./task-card";
import type { PlannerActions } from "./use-planner-actions";
import {
  type PlannerReveal,
  plannerRevealRingClass,
  plannerScrollCardIntoView,
} from "./use-planner-reveal";

// The board itself (fork-owned add-on,
// docs/planning-cockpit-implementation-plan.md, section 5): Backlog, To Do, Doing
// and Done side by side, plus Other when a task has a status the cockpit does not
// know. Dropping a card on a column asks the server to move it
// (`PATCH {column}`); the server owns the move table. Modelled on upstream's
// pages/projects/board.tsx, minus the in-column sorting that this board, ordered
// by plan, does not have.
//
// Sensors: a mouse sensor (the card lifts after 6px) and a touch sensor (a
// deliberate long press lifts it, 400 ms without moving more than 5px, so even a
// slow swipe still scrolls the board; see drag-feel.ts). Upstream pairs the touch
// sensor with dnd-kit's PointerSensor, but that one also claims touch pointers
// and wins the race, so there a long press never lifts anything and the swipe
// that follows is cancelled. The mouse sensor leaves touch to the touch sensor.
//
// A card that was just added, moved or re-planned is scrolled into view and rings
// in Ember for a moment (use-planner-reveal.ts); the page says which card.
//
// Each column's header has a "+" that opens a composer at the top of the column
// (column-composer.tsx): the new task goes straight into that column (column-add.ts),
// and shows on the board before the server answers. There are no period filters
// any more (section 13.x): the board always shows every card. Clicking a card opens its task panel (task-card.tsx);
// a card still waiting for the server can be neither opened nor dragged.

/** The column under the pointer; for a keyboard or an unmoved pointer, the one the card overlaps most. */
const collide: CollisionDetection = (args) => {
  const within = pointerWithin(args);
  return within.length > 0 ? within : rectIntersection(args);
};

const columnId = (column: PlannerColumnKey) => `column:${column}`;

function DraggableCard({
  card,
  dragging,
  enterIndex,
  reveal,
  ...rest
}: {
  card: PlannerBoardCard;
  today: string;
  actions: PlannerActions;
  onRequest: (request: PlannerCardRequest) => void;
  onOpen: (card: PlannerBoardCard) => void;
  dragging: boolean;
  /** Set only while the board first appears, to stagger the cards in. */
  enterIndex?: number;
  /** The card the person just acted on, if any; this one rings when it is its own. */
  reveal: PlannerReveal | null;
}) {
  // A card the server has not answered for yet cannot be picked up: it may
  // vanish, or turn into another id, before it lands.
  const waiting = plannerIsPendingCard(card);
  const { setNodeRef, node, listeners, isDragging } = useDraggable({
    id: card.id,
    disabled: waiting,
  });

  // Scroll into view when this card is pointed out: the moment it mounts into its
  // new place while the request is current, and again when a newer request for
  // the same card arrives.
  const revealStamp = reveal?.id === card.id ? reveal.stamp : null;
  useEffect(() => {
    if (revealStamp !== null) plannerScrollCardIntoView(node.current);
  }, [revealStamp, node]);

  return (
    <div
      ref={setNodeRef}
      {...(waiting ? undefined : listeners)}
      className={cn(
        // `relative` holds the reveal ring; `scroll-my-3` keeps a card scrolled
        // into view off the very edge of the page.
        "relative scroll-my-3 rounded-xl [@media(pointer:coarse)]:[-webkit-touch-callout:none] [@media(pointer:coarse)]:select-none",
        enterIndex !== undefined && "motion-safe:animate-rise",
        isDragging && "opacity-40",
        // While something is being dragged, hovering other cards must not offer
        // their menus: the pointer is busy.
        dragging && !isDragging && "pointer-events-none",
      )}
      data-testid="planner-card"
      style={
        enterIndex === undefined
          ? undefined
          : { animationDelay: `${Math.min(enterIndex, 8) * 35}ms` }
      }
    >
      <PlannerTaskCard card={card} {...rest} />
      {revealStamp !== null && (
        <span
          aria-hidden="true"
          className={plannerRevealRingClass}
          data-testid="planner-reveal"
          // A new request for the same card restarts the fade.
          key={revealStamp}
        />
      )}
    </div>
  );
}

function Column({
  column,
  label,
  hint,
  cards,
  droppable,
  today,
  actions,
  onRequest,
  onOpen,
  onAdd,
  entering,
  dragging,
  reveal,
}: {
  column: PlannerColumnKey;
  label: string;
  hint: string;
  cards: readonly PlannerBoardCard[];
  droppable: boolean;
  today: string;
  actions: PlannerActions;
  onRequest: (request: PlannerCardRequest) => void;
  onOpen: (card: PlannerBoardCard) => void;
  /** Adds a task to this column; left out for a column that is not a place to add to. */
  onAdd?: (title: string) => Promise<boolean>;
  entering: boolean;
  dragging: boolean;
  reveal: PlannerReveal | null;
}) {
  const strings = usePlannerStrings();
  const { isOver, setNodeRef } = useDroppable({
    id: columnId(column),
    disabled: !droppable,
  });
  const [composing, setComposing] = useState(false);
  const addLabel = strings.columnAdd.add(label);

  return (
    <section
      aria-label={label}
      className="flex min-w-0 snap-start flex-col gap-2"
      data-column={column}
    >
      <header className="flex items-center gap-2 px-1">
        <PlannerColumnIcon column={column} />
        <h2 className="text-sm font-medium">{label}</h2>
        <span className="text-xs text-muted-foreground tabular-nums">
          {cards.length}
        </span>
        {onAdd && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  aria-expanded={composing}
                  aria-label={addLabel}
                  className="ml-auto -mr-1 text-muted-foreground hover:text-foreground"
                  size="icon-sm"
                  type="button"
                  variant="ghost"
                  // Pressing it must not take focus from an open, empty composer:
                  // that blur would close it and the click reopen it.
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => setComposing(true)}
                >
                  <PlusIcon />
                </Button>
              }
            />
            <TooltipContent>{addLabel}</TooltipContent>
          </Tooltip>
        )}
      </header>
      <div
        ref={setNodeRef}
        className={cn(
          "flex min-h-32 flex-1 flex-col gap-2 rounded-xl bg-muted/35 p-2 motion-safe:transition-colors motion-safe:duration-150 sm:min-h-48",
          droppable && isOver && "bg-accent ring-1 ring-brand-400/40",
        )}
      >
        {composing && onAdd && (
          <PlannerColumnComposer
            label={strings.columnAdd.label(label)}
            onClose={() => setComposing(false)}
            onSubmit={onAdd}
          />
        )}
        {cards.length === 0
          ? // The composer says what to do, so the hint steps aside while it is open.
            !composing && (
              <p className="rounded-lg px-2 py-6 text-center text-xs leading-relaxed text-muted-foreground">
                {hint}
              </p>
            )
          : cards.map((card, index) => (
              <DraggableCard
                actions={actions}
                card={card}
                dragging={dragging}
                enterIndex={entering ? index : undefined}
                key={card.id}
                reveal={reveal}
                today={today}
                onOpen={onOpen}
                onRequest={onRequest}
              />
            ))}
      </div>
    </section>
  );
}

export function PlannerBoard({
  board,
  today,
  actions,
  onRequest,
  onOpen,
  entering,
  reveal,
}: {
  board: PlannerBoardResponse;
  today: string;
  actions: PlannerActions;
  onRequest: (request: PlannerCardRequest) => void;
  /** Opens a card's task panel. */
  onOpen: (card: PlannerBoardCard) => void;
  entering: boolean;
  /** The card to scroll to and ring, from the page; null when there is none. */
  reveal: PlannerReveal | null;
}) {
  const strings = usePlannerStrings();
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: plannerTouchActivation }),
  );
  const [activeId, setActiveId] = useState<string | null>(null);
  // Whether the card in hand was lifted by a finger: it gets the lift cue.
  const [lifted, setLifted] = useState(false);
  const activeCard =
    activeId === null ? undefined : plannerFindCard(board, activeId);

  // The library's own announcements read out raw task ids; say the task and the
  // column instead.
  const announcements = useMemo<Announcements>(() => {
    const titleOf = (id: string | number) =>
      plannerFindCard(board, String(id))?.title ?? "";
    const columnOf = (id: string | number) =>
      strings.column[
        String(id).replace(/^column:/, "") as keyof typeof strings.column
      ] ?? "";
    return {
      onDragStart: ({ active }) => strings.drag.picked(titleOf(active.id)),
      onDragOver: ({ active, over }) =>
        over
          ? strings.drag.over(titleOf(active.id), columnOf(over.id))
          : undefined,
      onDragEnd: ({ active, over }) =>
        over
          ? strings.drag.dropped(titleOf(active.id), columnOf(over.id))
          : undefined,
      onDragCancel: ({ active }) => strings.drag.cancelled(titleOf(active.id)),
    };
  }, [board, strings]);

  const onDragStart = (event: DragStartEvent) => {
    setActiveId(String(event.active.id));
    if (plannerIsTouchActivation(event.activatorEvent)) {
      setLifted(true);
      plannerHaptic();
    }
  };

  const endDrag = () => {
    setActiveId(null);
    setLifted(false);
  };

  const onDragEnd = (event: DragEndEvent) => {
    endDrag();
    const { active, over } = event;
    if (!over) return;
    const target = String(over.id).replace(/^column:/, "");
    if (!(plannerColumns as readonly string[]).includes(target)) return;
    const card = plannerFindCard(board, String(active.id));
    if (!card || card.dropped_at !== null) return;
    if (plannerCardColumn(card) === target) return;
    actions.move(card, target as PlannerColumn);
  };

  // What a column's "+" adds: the column itself, and the plan that column needs.
  const addTo = (column: PlannerColumn) => (title: string) => {
    const target = plannerColumnAddTarget(column, today);
    return actions.createIn({
      title,
      column: target.column,
      plan: target.plan,
    });
  };

  const shown: {
    column: PlannerColumnKey;
    cards: readonly PlannerBoardCard[];
  }[] = [
    { column: "backlog", cards: board.columns.backlog },
    { column: "todo", cards: board.columns.todo },
    { column: "doing", cards: board.columns.doing },
    { column: "done", cards: board.columns.done },
  ];
  // Cards with a status the cockpit does not know get a column of their own,
  // only while there are any. It is not a move target.
  if (board.columns.other.length > 0) {
    shown.push({ column: "other", cards: board.columns.other });
  }

  return (
    <DndContext
      accessibility={{ announcements }}
      collisionDetection={collide}
      sensors={sensors}
      onDragCancel={endDrag}
      onDragEnd={onDragEnd}
      onDragStart={onDragStart}
    >
      <div
        className={cn(
          // overscroll-x-contain: a swipe that reaches the last column must not
          // become the browser's back gesture.
          "-mx-5 overflow-x-auto overscroll-x-contain px-5 pb-3 lg:mx-0 lg:px-0 max-sm:scroll-pl-5",
          activeId === null
            ? "max-sm:snap-x max-sm:snap-mandatory"
            : "max-sm:snap-none",
        )}
        data-testid="planner-board"
      >
        <div className="grid grid-flow-col auto-cols-[85%] gap-3 sm:auto-cols-[minmax(13.5rem,1fr)]">
          {shown.map(({ column, cards }) => (
            <Column
              actions={actions}
              cards={cards}
              column={column}
              droppable={column !== "other"}
              dragging={activeId !== null}
              entering={entering}
              hint={
                strings.columnHint[
                  column as Exclude<PlannerColumnKey, "dropped">
                ]
              }
              key={column}
              label={strings.column[column]}
              reveal={reveal}
              today={today}
              onAdd={
                (plannerColumns as readonly string[]).includes(column)
                  ? addTo(column as PlannerColumn)
                  : undefined
              }
              onOpen={onOpen}
              onRequest={onRequest}
            />
          ))}
        </div>
      </div>
      <DragOverlay dropAnimation={null}>
        {activeCard ? (
          <PlannerTaskCard
            actions={actions}
            card={activeCard}
            className={lifted ? plannerLiftClass : undefined}
            overlay
            today={today}
            onOpen={onOpen}
            onRequest={onRequest}
          />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

/** Four columns of ghost cards while the first board loads. */
export function PlannerBoardSkeleton() {
  return (
    <div
      aria-busy="true"
      className="grid grid-flow-col auto-cols-[85%] gap-3 overflow-hidden sm:auto-cols-[minmax(13.5rem,1fr)]"
      data-testid="planner-board-skeleton"
    >
      {[3, 2, 1, 2].map((rows, column) => (
        <div
          className="flex flex-col gap-2"
          // The columns are fixed and never reorder.
          // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder list
          key={column}
        >
          <Skeleton className="mx-1 h-5 w-24" />
          <div className="flex flex-col gap-2 rounded-xl bg-muted/35 p-2">
            {Array.from({ length: rows }, (_, row) => (
              <Skeleton
                className="h-[4.5rem] w-full rounded-xl"
                // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder list
                key={row}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
