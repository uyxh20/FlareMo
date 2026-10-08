import {
  type PlannerBoardCard,
  type PlannerBoardResponse,
  type PlannerColumn,
  type PlannerPlanDto,
  type PlannerPlanInput,
  plannerNextPeriodStart,
  plannerPeriodStart,
  plannerTodoHorizon,
  type TaskDto,
} from "@flaremo/contracts";

// The cockpit board as plain data (fork-owned add-on,
// docs/planning-cockpit-implementation-plan.md, sections 4 and 5): which column a
// card belongs in, how a column is ordered, and what a card looks like right
// after an edit. There are no periods to filter by any more (section 13.x).
//
// The server decides all of this and the page refetches it after every change, so
// nothing here is authoritative. It exists so an edit can show up the instant it
// is made (optimistic edits, M4) with the card where the server will put it, and
// so a rolled-back edit can put the card back. The rules mirror
// packages/domain/src/planner (`plannerColumnFor`, the column-move table and the
// board's sort orders); the web app cannot import that package.

/** The four columns a card can be moved to. */
export const plannerColumns: readonly PlannerColumn[] = [
  "backlog",
  "todo",
  "doing",
  "done",
];

/** A column, or one of the two buckets that are not move targets. */
export type PlannerColumnKey = PlannerColumn | "other" | "dropped";

type Columns = PlannerBoardResponse["columns"];
type CardPlan = Pick<PlannerBoardCard, "horizon" | "period_start">;

/** A plan with a horizon and a start. A horizon alone is damaged and counts as none. */
export function plannerHasPlan(card: CardPlan): boolean {
  return card.horizon !== null && card.period_start !== null;
}

/**
 * Where a card sits: Dropped wins over status; `todo` is To Do with a plan and
 * Backlog without; `in_progress` is Doing; `done` is Done; any other status is
 * Other.
 */
export function plannerCardColumn(
  card: Pick<
    PlannerBoardCard,
    "status" | "horizon" | "period_start" | "dropped_at"
  >,
): PlannerColumnKey {
  if (card.dropped_at !== null) return "dropped";
  switch (card.status) {
    case "todo":
      return plannerHasPlan(card) ? "todo" : "backlog";
    case "in_progress":
      return "doing";
    case "done":
      return "done";
    default:
      return "other";
  }
}

// --- Order --------------------------------------------------------------------

type Compare = (left: PlannerBoardCard, right: PlannerBoardCard) => number;

const byId: Compare = (left, right) =>
  left.id < right.id ? -1 : left.id > right.id ? 1 : 0;

/** Descending on a string field, newest first; ties fall back to the id. */
const newestFirst =
  (field: (card: PlannerBoardCard) => string): Compare =>
  (left, right) => {
    const a = field(left);
    const b = field(right);
    return a < b ? 1 : a > b ? -1 : byId(left, right);
  };

/** Upstream's own order: `sort_order`, then creation time. */
const byUpstreamOrder: Compare = (left, right) =>
  left.sort_order - right.sort_order ||
  (left.created_at < right.created_at
    ? -1
    : left.created_at > right.created_at
      ? 1
      : byId(left, right));

const HORIZON_RANK: Record<string, number> = { day: 0, week: 1, month: 2 };

/** The day a plan's period ends (exclusive); a damaged value sorts by its start. */
function periodEnd(card: PlannerBoardCard): string {
  if (card.horizon === null || card.period_start === null) return "";
  try {
    return plannerNextPeriodStart(card.horizon, card.period_start);
  } catch {
    return card.period_start;
  }
}

/**
 * Nearest deadline first: the plan whose period ends soonest, so today's day
 * plans sit above this week's, which sit above this month's. A day goes before a
 * week before a month when they end together, then upstream's order.
 */
const byPlan: Compare = (left, right) =>
  periodEnd(left).localeCompare(periodEnd(right)) ||
  (HORIZON_RANK[left.horizon ?? ""] ?? 3) -
    (HORIZON_RANK[right.horizon ?? ""] ?? 3) ||
  byUpstreamOrder(left, right);

const doneAt = (card: PlannerBoardCard) => card.completed_at ?? card.updated_at;

/** A column's cards in the order the server returns them. */
export function plannerSortCards(
  column: PlannerColumnKey,
  cards: readonly PlannerBoardCard[],
): PlannerBoardCard[] {
  const copy = [...cards];
  switch (column) {
    case "backlog":
    case "other":
      return copy.sort(newestFirst((card) => card.created_at));
    case "todo":
      return copy.sort(byPlan);
    case "doing":
      return copy.sort(byUpstreamOrder);
    case "done":
      return copy.sort(newestFirst(doneAt));
    case "dropped":
      return copy.sort(newestFirst((card) => card.dropped_at ?? ""));
  }
}

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
  const columns: Columns = { ...board.columns };
  for (const name of COLUMN_NAMES) {
    const list = columns[name];
    if (list?.some((entry) => entry.id === card.id)) {
      columns[name] = list.filter((entry) => entry.id !== card.id);
    }
  }
  const target = plannerCardColumn(card);
  const list = columns[target];
  if (list !== undefined) {
    columns[target] = plannerSortCards(target, [...list, card]);
  }
  return { ...board, columns };
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

/** Whether the plan's period starts before the one that contains `today`. */
function isPastPlan(card: CardPlan, today: string): boolean {
  return (
    card.horizon !== null &&
    card.period_start !== null &&
    card.period_start < plannerPeriodStart(card.horizon, today)
  );
}

/**
 * The card after a column move, by the server's move table:
 *
 *   to Backlog   status todo, plan cleared
 *   to To Do     status todo; from Backlog, with no plan, or from Done with a
 *                plan that is past: the To Do marker (today); otherwise the plan stays
 *   to Doing     status in_progress, plan kept
 *   to Done      status done (completed now), plan kept
 *
 * A move to the column the card is in, and any move of a dropped card, change
 * nothing.
 */
export function plannerPredictMove(
  card: PlannerBoardCard,
  to: PlannerColumn,
  context: { today: string; now: Date },
): PlannerBoardCard {
  const from = plannerCardColumn(card);
  if (from === "dropped" || from === to) return card;
  const next: PlannerBoardCard = {
    ...card,
    updated_at: context.now.toISOString(),
  };
  switch (to) {
    case "backlog":
      next.status = "todo";
      next.completed_at = null;
      next.horizon = null;
      next.period_start = null;
      break;
    case "todo":
      next.status = "todo";
      next.completed_at = null;
      if (
        from === "backlog" ||
        !plannerHasPlan(card) ||
        (from === "done" && isPastPlan(card, context.today))
      ) {
        next.horizon = plannerTodoHorizon;
        next.period_start = plannerPeriodStart(
          plannerTodoHorizon,
          context.today,
        );
      }
      break;
    case "doing":
      next.status = "in_progress";
      next.completed_at = null;
      break;
    case "done":
      next.status = "done";
      next.completed_at = context.now.toISOString();
      break;
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

/** Moving a task to another goal (or to none): its project and the name the card shows. */
export function plannerPredictProject(
  card: PlannerBoardCard,
  project: { id: string; name: string } | null,
  now: Date,
): PlannerBoardCard {
  return {
    ...card,
    project_id: project?.id ?? null,
    project_name: project?.name ?? null,
    updated_at: now.toISOString(),
  };
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
  };
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

/** The upstream status of a task created in a column. */
const COLUMN_STATUS: Record<PlannerColumn, string> = {
  backlog: "todo",
  todo: "todo",
  doing: "in_progress",
  done: "done",
};

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
    status: COLUMN_STATUS[input.column],
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
