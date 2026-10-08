import {
  type Active,
  type Announcements,
  type CollisionDetection,
  closestCenter,
  DndContext,
  type DragEndEvent,
  type DragMoveEvent,
  DragOverlay,
  type DragStartEvent,
  KeyboardSensor,
  MouseSensor,
  type Over,
  pointerWithin,
  rectIntersection,
  TouchSensor,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type {
  PlannerBoardCard,
  PlannerBoardResponse,
  PlannerColumn,
} from "@flaremo/contracts";
import { PlusIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
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
  plannerResolveDrop,
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

const columnId = (column: PlannerColumnKey) => `column:${column}`;
const isColumnId = (id: string | number) => String(id).startsWith("column:");

/**
 * Two steps. First the column: the one under the pointer, or for a keyboard or
 * an unmoved pointer the one the dragged card overlaps most. Then, inside it, the
 * card whose centre is nearest (that is the place in the column); a column with
 * no cards to order against answers with the column itself.
 */
function makeCollide(
  cardsOfColumn: (column: string) => ReadonlySet<string>,
): CollisionDetection {
  return (args) => {
    const columns = args.droppableContainers.filter((container) =>
      isColumnId(container.id),
    );
    const within = args.pointerCoordinates
      ? pointerWithin({ ...args, droppableContainers: columns })
      : [];
    const hit =
      within[0] ??
      rectIntersection({ ...args, droppableContainers: columns })[0];
    if (!hit) return [];
    const ids = cardsOfColumn(String(hit.id).slice("column:".length));
    const cards = args.droppableContainers.filter((container) =>
      ids.has(String(container.id)),
    );
    if (cards.length === 0) return [hit];
    return closestCenter({ ...args, droppableContainers: cards }).slice(0, 1);
  };
}

/** Whether the dragged card's centre is below the centre of the card it is over. */
function isBelow(active: Active, over: Over): boolean {
  const moved = active.rect.current.translated;
  if (!moved) return false;
  return moved.top + moved.height / 2 > over.rect.top + over.rect.height / 2;
}

function DraggableCard({
  card,
  dragging,
  droppable,
  enterIndex,
  hintSide,
  reveal,
  ...rest
}: {
  card: PlannerBoardCard;
  today: string;
  actions: PlannerActions;
  onRequest: (request: PlannerCardRequest) => void;
  onOpen: (card: PlannerBoardCard) => void;
  dragging: boolean;
  /** Whether other cards can be dropped next to this one (not in Other). */
  droppable: boolean;
  /** Where a card from another column would land next to this one, if here. */
  hintSide: "before" | "after" | null;
  /** Set only while the board first appears, to stagger the cards in. */
  enterIndex?: number;
  /** The card the person just acted on, if any; this one rings when it is its own. */
  reveal: PlannerReveal | null;
}) {
  // A card the server has not answered for yet cannot be picked up: it may
  // vanish, or turn into another id, before it lands.
  const waiting = plannerIsPendingCard(card);
  const {
    setNodeRef,
    setActivatorNodeRef,
    node,
    attributes,
    listeners,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: card.id,
    disabled: { draggable: waiting, droppable: waiting || !droppable },
  });

  // `aria-pressed` is a button's; this is a group.
  const { "aria-pressed": _pressed, ...groupAttributes } = attributes;

  // The card holds buttons of its own, so it cannot be a button: it is a labelled
  // group that can be focused and lifted with the keyboard. A card still waiting
  // for the server is only a label.
  const cardProps = {
    ...(waiting ? undefined : groupAttributes),
    ...(waiting ? undefined : listeners),
    "aria-label": card.title,
    role: "group",
    tabIndex: waiting ? undefined : 0,
  };

  // Scroll into view when this card is pointed out: the moment it mounts into its
  // new place while the request is current, and again when a newer request for
  // the same card arrives.
  const revealStamp = reveal?.id === card.id ? reveal.stamp : null;
  useEffect(() => {
    if (revealStamp !== null) plannerScrollCardIntoView(node.current);
  }, [revealStamp, node]);

  return (
    <div
      ref={(element) => {
        setNodeRef(element);
        // Only a key pressed on the card itself lifts it, never one pressed on
        // the buttons inside it (Enter on the title opens the panel).
        setActivatorNodeRef(element);
      }}
      {...cardProps}
      className={cn(
        // `relative` holds the reveal ring; `scroll-my-3` keeps a card scrolled
        // into view off the very edge of the page.
        "relative scroll-my-3 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring/50 [@media(pointer:coarse)]:[-webkit-touch-callout:none] [@media(pointer:coarse)]:select-none",
        enterIndex !== undefined && "motion-safe:animate-rise",
        isDragging && "opacity-40",
        // While something is being dragged, hovering other cards must not offer
        // their menus: the pointer is busy.
        dragging && !isDragging && "pointer-events-none",
      )}
      data-testid="planner-card"
      style={{
        // The neighbours step aside while a card is carried over its own column.
        transform: CSS.Translate.toString(transform),
        transition,
        ...(enterIndex === undefined
          ? undefined
          : { animationDelay: `${Math.min(enterIndex, 8) * 35}ms` }),
      }}
    >
      {hintSide !== null && (
        <span
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute inset-x-1 z-10 h-0.5 rounded-full bg-brand-400",
            hintSide === "before" ? "-top-[5px]" : "-bottom-[5px]",
          )}
          data-testid="planner-drop-hint"
        />
      )}
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
  highlighted,
  dropHint,
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
  /** A dragged card is over this column. */
  highlighted: boolean;
  /** The card a dragged one from another column would land next to, and on which side. */
  dropHint: { id: string; side: "before" | "after" } | null;
  reveal: PlannerReveal | null;
}) {
  const strings = usePlannerStrings();
  const { setNodeRef } = useDroppable({
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
          droppable && highlighted && "bg-accent ring-1 ring-brand-400/40",
        )}
      >
        {composing && onAdd && (
          <PlannerColumnComposer
            label={strings.columnAdd.label(label)}
            onClose={() => setComposing(false)}
            onSubmit={onAdd}
          />
        )}
        {cards.length === 0 ? (
          // The composer says what to do, so the hint steps aside while it is open.
          !composing && (
            <p className="rounded-lg px-2 py-6 text-center text-xs leading-relaxed text-muted-foreground">
              {hint}
            </p>
          )
        ) : (
          <SortableContext
            items={cards.map((card) => card.id)}
            strategy={verticalListSortingStrategy}
          >
            {cards.map((card, index) => (
              <DraggableCard
                actions={actions}
                card={card}
                dragging={dragging}
                droppable={droppable}
                enterIndex={entering ? index : undefined}
                hintSide={dropHint?.id === card.id ? dropHint.side : null}
                key={card.id}
                reveal={reveal}
                today={today}
                onOpen={onOpen}
                onRequest={onRequest}
              />
            ))}
          </SortableContext>
        )}
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
    // Focus a card, Space to lift it, arrows to move it (the sortable
    // coordinates step between cards and columns), Space to drop, Escape to cancel.
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );
  const [activeId, setActiveId] = useState<string | null>(null);
  // Whether the card in hand was lifted by a finger: it gets the lift cue.
  const [lifted, setLifted] = useState(false);
  // Where the card in hand would land if it were dropped now: the column it is
  // over, and for a card from another column the card it would sit next to.
  const [target, setTarget] = useState<{
    column: string;
    hint: { id: string; side: "before" | "after" } | null;
  } | null>(null);
  const activeCard =
    activeId === null ? undefined : plannerFindCard(board, activeId);

  const collide = useMemo(
    () =>
      makeCollide(
        (column) =>
          new Set(
            (board.columns[column as keyof typeof board.columns] ?? []).map(
              (card) => card.id,
            ),
          ),
      ),
    [board],
  );

  /** What dropping `active` on `over` does, from the board as it is drawn now. */
  const resolve = useCallback(
    (active: Active, over: Over | null) =>
      over
        ? plannerResolveDrop(
            board,
            String(active.id),
            String(over.id),
            isColumnId(over.id) ? false : isBelow(active, over),
          )
        : null,
    [board],
  );

  // The library's own announcements read out raw task ids; say the task and the
  // column and place instead.
  const announcements = useMemo<Announcements>(() => {
    const titleOf = (id: string | number) =>
      plannerFindCard(board, String(id))?.title ?? "";
    const columnName = (column: string) =>
      strings.column[column as keyof typeof strings.column] ?? "";
    const columnOf = (id: string | number) =>
      isColumnId(id)
        ? columnName(String(id).replace(/^column:/, ""))
        : columnName(
            (() => {
              const over = plannerFindCard(board, String(id));
              return over ? plannerCardColumn(over) : "";
            })(),
          );
    const place = (active: Active, over: Over) => {
      const overCard = plannerFindCard(board, String(over.id));
      if (!overCard) return null;
      const column = plannerCardColumn(overCard);
      const list = board.columns[column as keyof typeof board.columns] ?? [];
      const drop = resolve(active, over);
      const index = list.findIndex((card) => card.id === over.id);
      const cross = drop?.crossColumn ?? true;
      const below = drop?.position?.afterId !== undefined;
      return {
        column: columnName(column),
        place: Math.max(1, index + 1 + (cross && below ? 1 : 0)),
        total: list.length + (cross ? 1 : 0),
      };
    };
    return {
      onDragStart: ({ active }) => strings.drag.picked(titleOf(active.id)),
      onDragOver: ({ active, over }) => {
        if (!over) return undefined;
        const spot = isColumnId(over.id) ? null : place(active, over);
        return spot
          ? strings.drag.position(
              titleOf(active.id),
              spot.column,
              spot.place,
              spot.total,
            )
          : strings.drag.over(titleOf(active.id), columnOf(over.id));
      },
      onDragEnd: ({ active, over }) =>
        over
          ? strings.drag.dropped(titleOf(active.id), columnOf(over.id))
          : undefined,
      onDragCancel: ({ active }) => strings.drag.cancelled(titleOf(active.id)),
    };
  }, [board, resolve, strings]);

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
    setTarget(null);
  };

  // Follows the card while it is carried: which column lights up, and where a
  // card from another column would go (a line between two cards).
  const onDragMove = ({ active, over }: DragMoveEvent) => {
    let next: typeof target = null;
    if (over) {
      const overCard = isColumnId(over.id)
        ? undefined
        : plannerFindCard(board, String(over.id));
      const column = isColumnId(over.id)
        ? String(over.id).replace(/^column:/, "")
        : overCard
          ? plannerCardColumn(overCard)
          : "";
      const drop = resolve(active, over);
      next = {
        column,
        hint:
          drop?.crossColumn && drop.position
            ? {
                id: (drop.position.beforeId ?? drop.position.afterId) as string,
                side: drop.position.beforeId !== undefined ? "before" : "after",
              }
            : null,
      };
    }
    setTarget((previous) =>
      previous?.column === next?.column &&
      previous?.hint?.id === next?.hint?.id &&
      previous?.hint?.side === next?.hint?.side
        ? previous
        : next,
    );
  };

  const onDragEnd = (event: DragEndEvent) => {
    endDrag();
    const { active, over } = event;
    const card = plannerFindCard(board, String(active.id));
    if (!card || card.dropped_at !== null) return;
    const drop = resolve(active, over);
    if (!drop) return;
    if (drop.crossColumn) {
      actions.move(card, drop.to, drop.position);
    } else if (drop.position) {
      actions.reorder(card, drop.position);
    }
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
      onDragMove={onDragMove}
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
              dropHint={target?.column === column ? target.hint : null}
              entering={entering}
              highlighted={target?.column === column}
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
