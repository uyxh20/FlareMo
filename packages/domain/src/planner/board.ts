import {
  type PlannerHorizon,
  plannerCompareRanked,
  plannerNextPeriodStart,
  plannerParseBoardRank,
  plannerPeriodStart,
} from "@flaremo/contracts";
import type { FlareMoDb } from "@flaremo/db";
import { projects, tasks } from "@flaremo/db";
import {
  plannerSyncState,
  plannerTaskPlan,
} from "@flaremo/db/src/schema/planner";
import { and, eq, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { ValidationError } from "../errors";
import { plannerColumnFor } from "./columns";
import {
  type PlannerHistoryStatus,
  plannerRequireDay,
  plannerShiftDay,
} from "./shared";

// The cockpit board (fork-owned add-on, docs/planning-cockpit-implementation-plan.md,
// section 4 "Board"): one query, grouped into columns here.

/** The most cards one board response carries. */
export const plannerBoardCardCap = 500;
/** How many days of finished tasks the Done column shows unless asked otherwise. */
export const plannerBoardDoneDaysDefault = 14;
/** The longest Done window a caller may ask for. */
export const plannerBoardDoneDaysMax = 3650;

/**
 * A task as the board shows it: upstream's own fields (never `notes`), its
 * project's name and its plan, flattened. A task with no plan row has a NULL
 * horizon, a 0 `carry_count` and no `dropped_at`.
 */
export type PlannerBoardCard = {
  id: string;
  project_id: string | null;
  project_name: string | null;
  title: string;
  /** Upstream's status; a value its enum does not list lands in `other`. */
  status: string;
  priority: string;
  due_at: string | null;
  sort_order: number;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  horizon: PlannerHorizon | null;
  period_start: string | null;
  carry_count: number;
  dropped_at: string | null;
  /** The start day, YYYY-MM-DD, or null. Shown on the card with the due date. */
  start_date: string | null;
  /**
   * The card's manual place in its column as a bare key, or null when it was
   * never ranked or the stored rank belongs to another column (migration 9004).
   */
  board_rank: string | null;
};

export type PlannerBoard = {
  columns: {
    backlog: PlannerBoardCard[];
    todo: PlannerBoardCard[];
    doing: PlannerBoardCard[];
    done: PlannerBoardCard[];
    /** Tasks with a status upstream's enum does not list. Usually empty. */
    other: PlannerBoardCard[];
    /** Present only when `includeDropped` is set. */
    dropped?: PlannerBoardCard[];
  };
  today: string;
  /** The start of the current period for each horizon. */
  periods: { day: string; week: string; month: string };
  history: PlannerHistoryStatus;
  /** True when the 500 card cap cut Backlog, Done or Dropped cards. */
  truncated: boolean;
};

const HORIZON_RANK: Record<string, number> = { day: 0, week: 1, month: 2 };

const byId = (left: PlannerBoardCard, right: PlannerBoardCard) =>
  left.id < right.id ? -1 : left.id > right.id ? 1 : 0;

/** Descending on a string field, newest first; ties fall back to the id. */
function newestFirst(field: (card: PlannerBoardCard) => string) {
  return (left: PlannerBoardCard, right: PlannerBoardCard) => {
    const a = field(left);
    const b = field(right);
    return a < b ? 1 : a > b ? -1 : byId(left, right);
  };
}

/** Upstream's own order: `sort_order`, then creation time. */
const byUpstreamOrder = (left: PlannerBoardCard, right: PlannerBoardCard) =>
  left.sort_order - right.sort_order ||
  (left.created_at < right.created_at
    ? -1
    : left.created_at > right.created_at
      ? 1
      : byId(left, right));

/**
 * The day a plan's period ends (exclusive). A damaged value sorts by its start,
 * because sorting must never throw.
 */
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
const byPlan = (left: PlannerBoardCard, right: PlannerBoardCard) =>
  periodEnd(left).localeCompare(periodEnd(right)) ||
  (HORIZON_RANK[left.horizon ?? ""] ?? 3) -
    (HORIZON_RANK[right.horizon ?? ""] ?? 3) ||
  byUpstreamOrder(left, right);

const doneAt = (card: PlannerBoardCard) => card.completed_at ?? card.updated_at;

/**
 * The board for one user: their live tasks left-joined to their plans and
 * project names, grouped into Backlog, To Do, Doing and Done plus an `other`
 * bucket, with a dropped list when asked for.
 *
 * - Dropped wins over status. A dropped task appears only in `dropped`, and only
 *   with `includeDropped`. An undropped task lands where its status and its kept
 *   plan put it: a `todo` task with a horizon in To Do, otherwise Backlog.
 * - Done shows tasks completed within `doneDays` days of `today`.
 * - 500 cards at most. To Do, Doing and Other are never cut; Backlog and Done
 *   share what is left, newest first (Backlog by creation, Done by completion),
 *   and `truncated` says when that cut anything. Dropped is capped by itself.
 *
 * `history` reports whether the history sync is paused, from the stored state.
 */
export async function plannerReadBoard(
  db: FlareMoDb,
  input: {
    userId: string;
    today: string;
    doneDays?: number;
    includeDropped?: boolean;
  },
): Promise<PlannerBoard> {
  const { userId } = input;
  const today = plannerRequireDay(input.today, "today");
  const doneDays = input.doneDays ?? plannerBoardDoneDaysDefault;
  if (
    !Number.isInteger(doneDays) ||
    doneDays < 0 ||
    doneDays > plannerBoardDoneDaysMax
  ) {
    throw new ValidationError(
      `done_days must be a whole number from 0 to ${plannerBoardDoneDaysMax}.`,
    );
  }
  const includeDropped = input.includeDropped ?? false;
  // Completion times are ISO instants and compare against a bare day as strings.
  const doneSince = plannerShiftDay(today, -doneDays);

  const notDropped = and(
    isNull(plannerTaskPlan.droppedAt),
    or(
      ne(tasks.status, "done"),
      sql`coalesce(${tasks.completedAt}, ${tasks.updatedAt}) >= ${doneSince}`,
    ),
  );

  const [rows, syncState] = await Promise.all([
    db
      .select({
        id: tasks.id,
        projectId: tasks.projectId,
        projectName: projects.name,
        title: tasks.title,
        status: tasks.status,
        priority: tasks.priority,
        dueAt: tasks.dueAt,
        sortOrder: tasks.sortOrder,
        completedAt: tasks.completedAt,
        createdAt: tasks.createdAt,
        updatedAt: tasks.updatedAt,
        horizon: plannerTaskPlan.horizon,
        periodStart: plannerTaskPlan.periodStart,
        carryCount: plannerTaskPlan.carryCount,
        droppedAt: plannerTaskPlan.droppedAt,
        startDate: plannerTaskPlan.startDate,
        boardRank: plannerTaskPlan.boardRank,
      })
      .from(tasks)
      .leftJoin(plannerTaskPlan, eq(plannerTaskPlan.taskId, tasks.id))
      .leftJoin(projects, eq(projects.id, tasks.projectId))
      .where(
        and(
          eq(tasks.userId, userId),
          isNull(tasks.deletedAt),
          includeDropped
            ? or(notDropped, isNotNull(plannerTaskPlan.droppedAt))
            : notDropped,
        ),
      ),
    db
      .select({ status: plannerSyncState.status })
      .from(plannerSyncState)
      .where(eq(plannerSyncState.userId, userId))
      .get(),
  ]);

  const groups = {
    backlog: [] as PlannerBoardCard[],
    todo: [] as PlannerBoardCard[],
    doing: [] as PlannerBoardCard[],
    done: [] as PlannerBoardCard[],
    other: [] as PlannerBoardCard[],
    dropped: [] as PlannerBoardCard[],
  };
  for (const row of rows) {
    const card: PlannerBoardCard = {
      id: row.id,
      project_id: row.projectId,
      project_name: row.projectName,
      title: row.title,
      status: row.status,
      priority: row.priority,
      due_at: row.dueAt,
      sort_order: row.sortOrder,
      completed_at: row.completedAt,
      created_at: row.createdAt,
      updated_at: row.updatedAt,
      horizon: row.horizon ?? null,
      period_start: row.periodStart ?? null,
      carry_count: row.carryCount ?? 0,
      dropped_at: row.droppedAt ?? null,
      start_date: row.startDate ?? null,
      board_rank: null,
    };
    const column = plannerColumnFor({
      status: card.status,
      horizon: card.horizon,
      periodStart: card.period_start,
      droppedAt: card.dropped_at,
    });
    // A rank counts only in the column it was made in.
    card.board_rank = plannerParseBoardRank(row.boardRank, column);
    groups[column].push(card);
  }

  // Manually ranked cards first, in rank order; the rest follow in the column's
  // own order (migration 9004).
  const ranked = (
    fallback: (l: PlannerBoardCard, r: PlannerBoardCard) => number,
  ) =>
    plannerCompareRanked<PlannerBoardCard>((card) => card.board_rank, fallback);
  groups.backlog.sort(ranked(newestFirst((card) => card.created_at)));
  groups.todo.sort(ranked(byPlan));
  groups.doing.sort(ranked(byUpstreamOrder));
  groups.done.sort(ranked(newestFirst(doneAt)));
  groups.other.sort(newestFirst((card) => card.created_at));
  groups.dropped.sort(newestFirst((card) => card.dropped_at ?? ""));

  // The cap. To Do, Doing and Other are never cut; Backlog and Done share the rest.
  let truncated = false;
  const room = Math.max(
    0,
    plannerBoardCardCap -
      groups.todo.length -
      groups.doing.length -
      groups.other.length,
  );
  if (groups.backlog.length + groups.done.length > room) {
    truncated = true;
    const kept = new Set(
      [
        ...groups.backlog.map((card) => ({
          card,
          recency: card.created_at,
        })),
        ...groups.done.map((card) => ({ card, recency: doneAt(card) })),
      ]
        .sort((left, right) =>
          left.recency < right.recency
            ? 1
            : left.recency > right.recency
              ? -1
              : byId(left.card, right.card),
        )
        .slice(0, room)
        .map((entry) => entry.card.id),
    );
    groups.backlog = groups.backlog.filter((card) => kept.has(card.id));
    groups.done = groups.done.filter((card) => kept.has(card.id));
  }
  if (groups.dropped.length > plannerBoardCardCap) {
    truncated = true;
    groups.dropped = groups.dropped.slice(0, plannerBoardCardCap);
  }

  const { dropped, ...columns } = groups;
  return {
    columns: includeDropped ? { ...columns, dropped } : columns,
    today,
    periods: {
      day: today,
      week: plannerPeriodStart("week", today),
      month: plannerPeriodStart("month", today),
    },
    history: syncState?.status ?? "ok",
    truncated,
  };
}
