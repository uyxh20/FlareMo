import {
  type PlannerBoardCard,
  type PlannerBoardColumnKey,
  type PlannerBoardResponse,
  type PlannerColumn,
  type PlannerPlanDto,
  type PlannerPlanInput,
  plannerCardColumn,
  plannerColumnMove,
  plannerColumnStatus,
  plannerIsColumn,
  plannerParseBoardRank,
  plannerPeriodStart,
  plannerPlaceRank,
  plannerSortCards,
  plannerTodoMarker,
  type TaskDto,
} from "@flaremo/contracts";

// The cockpit board as plain data (fork-owned add-on,
// docs/planning-cockpit-implementation-plan.md, sections 4 and 5): where a card
// goes on the cached board, and what a card looks like right after an edit.
//
// The server decides all of this and the page refetches it after every change, so
// nothing here is authoritative. It exists so an edit can show up the instant it
// is made (optimistic edits, M4) with the card where the server will put it. The
// board's rules themselves (which column, what order, what a move does) are the
// server's own, read from planner-board.ts in the contracts, so the two cannot
// drift apart.

export {
  plannerCardColumn,
  plannerColumns,
  plannerHasPlan,
  plannerIsColumn,
  plannerSortCards,
} from "@flaremo/contracts";

/** A column, or one of the two buckets that are not move targets. */
export type PlannerColumnKey = PlannerBoardColumnKey;

type Columns = PlannerBoardResponse["columns"];

// --- Finding and placing cards ------------------------------------------------

const COLUMN_NAMES = [
  "backlog",
  "todo",
  "doing",
  "done",
  "other",
  "dropped",
] as const;

export function plannerFindCard(
  board: PlannerBoardResponse,
  taskId: string,
): PlannerBoardCard | undefined {
  for (const name of COLUMN_NAMES) {
    const found = board.columns[name]?.find((card) => card.id === taskId);
    if (found) return found;
  }
  return undefined;
}

/**
 * The board with `card` in the column its own fields put it in, replacing any
 * copy of the same task elsewhere. A dropped card leaves the board when the
 * Dropped list was not asked for (the list is absent then, as on the server).
 * Only the columns that change get a new array.
 */
export function plannerPlaceCard(
  board: PlannerBoardResponse,
  card: PlannerBoardCard,
): PlannerBoardResponse {
  const without = plannerRemoveCard(board, card.id);
  const target = plannerCardColumn(card);
  const list = without.columns[target];
  if (list === undefined) return without;
  return {
    ...without,
    columns: {
      ...without.columns,
      [target]: plannerSortCards(target, [...list, card]),
    },
  };
}

/** The board after `update` rewrites one card; unchanged when the task is not on it. */
export function plannerUpdateCard(
  board: PlannerBoardResponse,
  taskId: string,
  update: (card: PlannerBoardCard) => PlannerBoardCard,
): PlannerBoardResponse {
  const card = plannerFindCard(board, taskId);
  return card ? plannerPlaceCard(board, update(card)) : board;
}

/** Cards on the board, Dropped excluded. */
export function plannerBoardCardCount(board: PlannerBoardResponse): number {
  const { backlog, todo, doing, done, other } = board.columns;
  return (
    backlog.length + todo.length + doing.length + done.length + other.length
  );
}

// --- What a card looks like right after an edit ------------------------------

/**
 * The card after a column move, by the server's move table (`plannerColumnMove`
 * in the contracts): the status of the target column, a Done card completed now
 * and any other not completed, and the plan kept, cleared or given the To Do
 * marker for today. A move to the column the card is in, and any move of a
 * dropped card, change nothing.
 */
export function plannerPredictMove(
  card: PlannerBoardCard,
  to: PlannerColumn,
  context: { today: string; now: Date },
): PlannerBoardCard {
  const move = plannerColumnMove(card, to, context.today);
  if (move === null) return card;
  // A rank only counts in the column it was made in.
  const next: PlannerBoardCard = {
    ...card,
    status: move.status,
    completed_at: to === "done" ? context.now.toISOString() : null,
    board_rank: null,
    updated_at: context.now.toISOString(),
  };
  if (move.plan === "clear") {
    next.horizon = null;
    next.period_start = null;
  } else if (move.plan === "todo-marker") {
    const marker = plannerTodoMarker(context.today);
    next.horizon = marker.horizon;
    next.period_start = plannerPeriodStart(marker.horizon, marker.day);
  }
  return next;
}

/** The card after a plan change (a retry of a plan that did not save, or a plan set by hand). */
export function plannerPredictPlan(
  card: PlannerBoardCard,
  plan: PlannerPlanInput | null,
  now: Date,
): PlannerBoardCard {
  return {
    ...card,
    horizon: plan ? plan.horizon : null,
    period_start: plan ? plannerPeriodStart(plan.horizon, plan.day) : null,
    updated_at: now.toISOString(),
  };
}

/** The card after its start date changes (a planner-side field: no column moves). */
export function plannerPredictStartDate(
  card: PlannerBoardCard,
  startDate: string | null,
  now: Date,
): PlannerBoardCard {
  return { ...card, start_date: startDate, updated_at: now.toISOString() };
}

export function plannerPredictDue(
  card: PlannerBoardCard,
  due: string | null,
  now: Date,
): PlannerBoardCard {
  return { ...card, due_at: due, updated_at: now.toISOString() };
}

/** A new title, as upstream stores it (trimmed). */
export function plannerPredictTitle(
  card: PlannerBoardCard,
  title: string,
  now: Date,
): PlannerBoardCard {
  return { ...card, title: title.trim(), updated_at: now.toISOString() };
}

export function plannerPredictPriority(
  card: PlannerBoardCard,
  priority: string,
  now: Date,
): PlannerBoardCard {
  return { ...card, priority, updated_at: now.toISOString() };
}

/** The weekly goal the task serves, or null; it never moves the card. */
export function plannerPredictGoal(
  card: PlannerBoardCard,
  goalId: string | null,
  now: Date,
): PlannerBoardCard {
  return { ...card, goal_id: goalId, updated_at: now.toISOString() };
}

/** Dropping keeps the plan and clears the due date (decision D1). */
export function plannerPredictDrop(
  card: PlannerBoardCard,
  now: Date,
): PlannerBoardCard {
  return {
    ...card,
    dropped_at: now.toISOString(),
    due_at: null,
    updated_at: now.toISOString(),
  };
}

/** Undropping lands the card where its status and kept plan put it; the old due date is not restored. */
export function plannerPredictUndrop(
  card: PlannerBoardCard,
  now: Date,
): PlannerBoardCard {
  return { ...card, dropped_at: null, updated_at: now.toISOString() };
}

/**
 * A board card from the task and plan the API answers a change with. The
 * response has no project name, so `projectName` carries over what the card
 * already showed.
 */
export function plannerCardFromTask(
  task: TaskDto,
  plan: PlannerPlanDto | null,
  projectName: string | null = null,
): PlannerBoardCard {
  return {
    id: task.id,
    project_id: task.project_id,
    project_name: task.project_id === null ? null : projectName,
    title: task.title,
    status: task.status,
    priority: task.priority,
    due_at: task.due_at,
    sort_order: task.sort_order,
    completed_at: task.completed_at,
    created_at: task.created_at,
    updated_at: task.updated_at,
    horizon: plan?.horizon ?? null,
    period_start: plan?.period_start ?? null,
    carry_count: plan?.carry_count ?? 0,
    dropped_at: plan?.dropped_at ?? null,
    start_date: plan?.start_date ?? null,
    board_rank: boardRankOf(task, plan),
    goal_id: plan?.goal_id ?? null,
  };
}

/** The bare rank key of a task's plan row, if it is for the column the task is in. */
function boardRankOf(task: TaskDto, plan: PlannerPlanDto | null) {
  const column = plannerCardColumn({
    status: task.status,
    horizon: plan?.horizon ?? null,
    period_start: plan?.period_start ?? null,
    dropped_at: plan?.dropped_at ?? null,
  });
  return plannerParseBoardRank(plan?.board_rank, column);
}

// --- Cards the server has not answered for yet --------------------------------

// A column's "+" button puts the new card on the board the instant Enter is
// pressed (an optimistic insert), under an id no server task can have: real ids are
// `tasks/<uuid>`. The card is swapped for the real one when the response lands, or
// taken away when it fails. Until then it can be neither opened nor dragged.

const PENDING_PREFIX = "tasks/pending-";

/** The id of the `serial`th card that is still waiting for its server answer. */
export function plannerPendingCardId(serial: number): string {
  return `${PENDING_PREFIX}${serial}`;
}

export function plannerIsPendingCard(card: Pick<PlannerBoardCard, "id">) {
  return card.id.startsWith(PENDING_PREFIX);
}

/**
 * The card a created task will be, by the server's create rules (the status of
 * its column, a plan only as asked, a Done task completed now), for the moment
 * before the response arrives.
 */
export function plannerPendingCard(input: {
  id: string;
  title: string;
  column: PlannerColumn;
  plan: PlannerPlanInput | null;
  now: Date;
}): PlannerBoardCard {
  const at = input.now.toISOString();
  return {
    id: input.id,
    project_id: null,
    project_name: null,
    title: input.title.trim(),
    status: plannerColumnStatus[input.column],
    priority: "none",
    due_at: null,
    sort_order: 0,
    completed_at: input.column === "done" ? at : null,
    created_at: at,
    updated_at: at,
    horizon: input.plan ? input.plan.horizon : null,
    period_start: input.plan
      ? plannerPeriodStart(input.plan.horizon, input.plan.day)
      : null,
    carry_count: 0,
    dropped_at: null,
    start_date: null,
    board_rank: null,
    goal_id: null,
  };
}

/**
 * The board with `card` (already predicted into `column`) placed directly above
 * `beforeId` or below `afterId`, by the server's rank rules: a key between its
 * neighbours when they have keys, else every card of the column gets a fresh key
 * (the server does the same, with other keys and the same order). An anchor that
 * is not in the column puts the card at the natural place instead.
 */
export function plannerPlaceCardAt(
  board: PlannerBoardResponse,
  card: PlannerBoardCard,
  anchors: { beforeId?: string; afterId?: string },
): PlannerBoardResponse {
  const column = plannerCardColumn(card);
  if (column === "dropped" || column === "other") {
    return plannerPlaceCard(board, card);
  }
  const without = plannerRemoveCard(board, card.id);
  const others = without.columns[column];
  const anchor = anchors.beforeId ?? anchors.afterId;
  const position = others.findIndex((entry) => entry.id === anchor);
  if (anchor === undefined || position === -1) {
    return plannerPlaceCard(board, card);
  }
  const index = anchors.beforeId === undefined ? position + 1 : position;
  const placement = plannerPlaceRank(
    others.map((entry) => entry.board_rank),
    index,
  );
  const key = (place: number) =>
    placement.kind === "respread" ? (placement.keys[place] as string) : null;
  const order: PlannerBoardCard[] = [
    ...others.slice(0, index),
    card,
    ...others.slice(index),
  ].map((entry, place) =>
    placement.kind === "respread"
      ? { ...entry, board_rank: key(place) }
      : entry === card
        ? { ...entry, board_rank: placement.key }
        : entry,
  );
  return { ...without, columns: { ...without.columns, [column]: order } };
}

// --- Dropping a card ----------------------------------------------------------

export type PlannerDrop = {
  to: PlannerColumn;
  /** Where in `to`; left out for a plain move (an empty column, or nothing to order against). */
  position?: { beforeId?: string; afterId?: string };
  /** Whether the card changes column. */
  crossColumn: boolean;
};

/**
 * What dropping `activeId` on `overId` means. `overId` is a card, or a column as
 * `column:<name>`. `below` says whether the dragged card's centre is under the
 * centre of the card it is over, which decides above or below it when it comes
 * from another column; inside one column the direction of travel decides, like
 * dnd-kit's own `arrayMove`. Null means nothing to do: the card is over itself,
 * over a place that is not a column, or dropped back where it was.
 */
export function plannerResolveDrop(
  board: PlannerBoardResponse,
  activeId: string,
  overId: string,
  below: boolean,
): PlannerDrop | null {
  const card = plannerFindCard(board, activeId);
  if (!card || card.dropped_at !== null || activeId === overId) return null;
  const from = plannerCardColumn(card);
  if (overId.startsWith("column:")) {
    const to = overId.slice("column:".length);
    if (!plannerIsColumn(to) || to === from) return null;
    return { to, crossColumn: true };
  }
  const over = plannerFindCard(board, overId);
  if (!over || plannerIsPendingCard(over)) return null;
  const to = plannerCardColumn(over);
  if (!plannerIsColumn(to)) return null;
  const list = board.columns[to];
  if (to === from) {
    const oldIndex = list.findIndex((entry) => entry.id === activeId);
    const newIndex = list.findIndex((entry) => entry.id === overId);
    if (oldIndex === -1 || oldIndex === newIndex) return null;
    return {
      to,
      position:
        newIndex > oldIndex ? { afterId: overId } : { beforeId: overId },
      crossColumn: false,
    };
  }
  return {
    to,
    position: below ? { afterId: overId } : { beforeId: overId },
    crossColumn: true,
  };
}

/** The board without a task, wherever it is; unchanged when it is not on it. */
export function plannerRemoveCard(
  board: PlannerBoardResponse,
  taskId: string,
): PlannerBoardResponse {
  const columns: Columns = { ...board.columns };
  for (const name of COLUMN_NAMES) {
    const list = columns[name];
    if (list?.some((entry) => entry.id === taskId)) {
      columns[name] = list.filter((entry) => entry.id !== taskId);
    }
  }
  return { ...board, columns };
}

// --- Reading the board --------------------------------------------------------

/** Past its due date and still open: the card's due chip turns red. */
export function plannerIsOverdue(
  card: Pick<PlannerBoardCard, "due_at" | "status" | "dropped_at">,
  today: string,
): boolean {
  return (
    card.due_at !== null &&
    card.due_at < today &&
    card.status !== "done" &&
    card.dropped_at === null
  );
}
