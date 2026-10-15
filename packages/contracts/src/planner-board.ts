// The cockpit board's rules (fork-owned add-on,
// docs/planning-cockpit-implementation-plan.md, sections 0, 4 and 14), in one
// place that the server and the web board both read:
//
// - which column a card is in (`plannerCardColumn`),
// - how each column is ordered (`plannerCompareCards`, `plannerSortCards`),
// - what a move to another column does to the status and the plan
//   (`plannerColumnMove`), and the status a card created in a column starts with.
//
// The server groups the board and applies moves with these; the web board uses
// the same functions to show an edit the instant it is made, so a dragged card
// lands exactly where the server will put it. The manual order's key maths is in
// planner-rank.ts; the period maths in planner-periods.ts.
//
// Re-exported from planner.ts, so it must never import planner.ts back.

import {
  type PlannerHorizon,
  plannerNextPeriodStart,
  plannerPeriodStart,
} from "./planner-periods";
import { plannerCompareRanked } from "./planner-rank";

// --- Columns ------------------------------------------------------------------
//
//   Backlog  status `todo` with no plan (no row, or a NULL horizon)
//   To Do    status `todo` with a plan
//   Doing    status `in_progress`
//   Done     status `done`
//
// Two more buckets sit beside them: `dropped` (a plan with `dropped_at` set,
// whatever the status, and it wins over the status) and `other` (any status
// upstream's enum does not list).

/** The four columns a card can be moved to, in board order. */
export const plannerColumns = ["backlog", "todo", "doing", "done"] as const;

/** A column, or one of the two buckets that are not move targets. */
export type PlannerBoardColumnKey =
  | (typeof plannerColumns)[number]
  | "other"
  | "dropped";

type MoveTarget = (typeof plannerColumns)[number];

export function plannerIsColumn(value: unknown): value is MoveTarget {
  return (
    typeof value === "string" &&
    (plannerColumns as readonly string[]).includes(value)
  );
}

/** The fields of a card that decide its column. */
export type PlannerColumnFields = {
  status: string;
  horizon: string | null;
  period_start: string | null;
  dropped_at: string | null;
};

/**
 * Whether a card has a plan: a horizon and a start. A row with a NULL horizon is
 * the backlog, exactly like no row; a horizon without a start is damaged and
 * counts the same way.
 */
export function plannerHasPlan(
  card: Pick<PlannerColumnFields, "horizon" | "period_start">,
): boolean {
  return card.horizon != null && card.period_start != null;
}

/** Which column or bucket a card is in, from its status and plan. Dropped wins. */
export function plannerCardColumn(
  card: PlannerColumnFields,
): PlannerBoardColumnKey {
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

/** The upstream status a card in each column has, and a card created there starts with. */
export const plannerColumnStatus = {
  backlog: "todo",
  todo: "todo",
  doing: "in_progress",
  done: "done",
} as const satisfies Record<MoveTarget, string>;

/** The three upstream statuses the four columns map onto. */
export type PlannerColumnStatus =
  (typeof plannerColumnStatus)[keyof typeof plannerColumnStatus];

// --- The To Do marker ---------------------------------------------------------

/**
 * The horizon a To Do task carries (v1.2, docs/planning-cockpit-implementation-plan.md,
 * section 13.x). The cockpit has no periods any more, but a To Do task still needs
 * a plan row to tell it from the backlog, so every move into To Do plans it for
 * today with this horizon. Nothing shows it and rollover never moves it.
 */
export const plannerTodoHorizon = "day" as const satisfies PlannerHorizon;

/** The plan a To Do task gets on the way in: today, with `plannerTodoHorizon`. */
export function plannerTodoMarker(today: string): {
  horizon: PlannerHorizon;
  day: string;
} {
  return { horizon: plannerTodoHorizon, day: today };
}

// --- Order --------------------------------------------------------------------

/** The fields of a card that decide its place in a column. */
export type PlannerSortFields = {
  id: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  horizon: PlannerHorizon | null;
  period_start: string | null;
  dropped_at: string | null;
  board_rank: string | null;
};

type Compare = (left: PlannerSortFields, right: PlannerSortFields) => number;

const byId: Compare = (left, right) =>
  left.id < right.id ? -1 : left.id > right.id ? 1 : 0;

/** Descending on a string field, newest first; ties fall back to the id. */
const newestFirst =
  (field: (card: PlannerSortFields) => string): Compare =>
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

/**
 * The day a plan's period ends (exclusive). A damaged value sorts by its start,
 * because sorting must never throw.
 */
function periodEnd(card: PlannerSortFields): string {
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

/** When a Done card was finished: its completion, else its last change. */
export function plannerDoneAt(
  card: Pick<PlannerSortFields, "completed_at" | "updated_at">,
): string {
  return card.completed_at ?? card.updated_at;
}

/** Manually ranked cards first, in key order; the rest in the column's own order. */
const ranked = (fallback: Compare): Compare =>
  plannerCompareRanked<PlannerSortFields>((card) => card.board_rank, fallback);

const COMPARE: Record<PlannerBoardColumnKey, Compare> = {
  backlog: ranked(newestFirst((card) => card.created_at)),
  todo: ranked(byPlan),
  doing: ranked(byUpstreamOrder),
  done: ranked(newestFirst(plannerDoneAt)),
  // The two buckets are never ranked by hand.
  other: newestFirst((card) => card.created_at),
  dropped: newestFirst((card) => card.dropped_at ?? ""),
};

/**
 * How a column orders its cards:
 *
 *   Backlog  ranked cards first, then newest created first
 *   To Do    ranked cards first, then the plan that ends soonest
 *   Doing    ranked cards first, then upstream's `sort_order` and creation time
 *   Done     ranked cards first, then newest finished first
 *   Other    newest created first
 *   Dropped  newest dropped first
 *
 * Every tie ends on the id, so the order is total.
 */
export function plannerCompareCards(
  column: PlannerBoardColumnKey,
): <T extends PlannerSortFields>(left: T, right: T) => number {
  return COMPARE[column];
}

/** A column's cards in board order, as a new array. */
export function plannerSortCards<T extends PlannerSortFields>(
  column: PlannerBoardColumnKey,
  cards: readonly T[],
): T[] {
  return [...cards].sort(plannerCompareCards(column));
}

// --- Moves --------------------------------------------------------------------

/** What a move does to the plan: leave it, clear it, or give it the To Do marker. */
export type PlannerMovePlan = "keep" | "clear" | "todo-marker";

/**
 * The column-move table: the status a card gets, and what happens to its plan.
 *
 *   to Backlog   status todo, plan cleared
 *   to To Do     status todo; the To Do marker when it comes from Backlog, has
 *                no plan, or comes from Done with a plan that is past; otherwise
 *                the plan stays
 *   to Doing     status in_progress, plan kept
 *   to Done      status done, plan kept for history
 *
 * Null when the move changes nothing: the card is already in that column, or
 * it is dropped (a dropped card must be undropped first). A card in Other moves
 * like any other. `today` decides whether a plan is past.
 */
export function plannerColumnMove(
  card: PlannerColumnFields,
  to: MoveTarget,
  today: string,
): { status: PlannerColumnStatus; plan: PlannerMovePlan } | null {
  const from = plannerCardColumn(card);
  if (from === "dropped" || from === to) return null;
  let plan: PlannerMovePlan = "keep";
  if (to === "backlog") plan = "clear";
  if (
    to === "todo" &&
    (from === "backlog" ||
      !plannerHasPlan(card) ||
      (from === "done" && plannerIsPastPlan(card, today)))
  ) {
    plan = "todo-marker";
  }
  return { status: plannerColumnStatus[to], plan };
}

/** Whether a plan's period starts before the one that contains `today`. */
export function plannerIsPastPlan(
  card: Pick<PlannerColumnFields, "horizon" | "period_start">,
  today: string,
): boolean {
  if (!plannerHasPlan(card)) return false;
  try {
    return (
      (card.period_start as string) <
      plannerPeriodStart(card.horizon as PlannerHorizon, today)
    );
  } catch {
    // A horizon the period maths does not know is damaged: not past.
    return false;
  }
}
