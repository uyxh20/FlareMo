import {
  plannerFormatBoardRank,
  plannerParseBoardRank,
  plannerPlaceRank,
  plannerRankBetween,
  plannerRankMaxLength,
  plannerRankSpread,
} from "@flaremo/contracts";
import type { FlareMoDb, UserRow } from "@flaremo/db";
import { plannerTaskPlan } from "@flaremo/db/src/schema/planner";
import { and, eq, like, sql } from "drizzle-orm";
import { ValidationError } from "../errors";
import { plannerBoardDoneDaysMax, plannerReadBoard } from "./board";
import {
  type PlannerColumn,
  plannerColumnFor,
  plannerIsColumn,
} from "./columns";
import { type PlannerTaskPlanResult, plannerReadTaskPlan } from "./plans";
import {
  plannerLoadLiveTask,
  plannerLoadPlan,
  plannerNormalizeTaskId,
  plannerNow,
  plannerRequireDay,
  plannerRunBatch,
} from "./shared";

// The board's manual order (fork-owned add-on,
// docs/planning-cockpit-implementation-plan.md, section 14; migration 9004).
//
// A card's place in its column is `planner_task_plan.board_rank`, stored as
// `<column>|<fractional key>` (the key maths are in @flaremo/contracts,
// planner-rank.ts, shared with the web board). A move writes ONE row. Only two
// things write more: the first time a card is dropped below a card that has no
// key yet, and a key that would grow past the length cap. Both re-spread the
// whole column in one batch.
//
// A rank change is not history: it writes no planner event. The column move that
// may come with it logs itself.

/** One plan row that holds only a rank (a NULL-horizon row plans nothing). */
function rankUpsert(
  db: FlareMoDb,
  input: { userId: string; taskId: string; stored: string; nowIso: string },
) {
  return (
    db
      .insert(plannerTaskPlan)
      .values({
        taskId: input.taskId,
        userId: input.userId,
        horizon: null,
        periodStart: null,
        carryCount: 0,
        droppedAt: null,
        boardRank: input.stored,
        createdAt: input.nowIso,
        updatedAt: input.nowIso,
      })
      // updated_at stays: a reorder is not an edit of the plan.
      .onConflictDoUpdate({
        target: plannerTaskPlan.taskId,
        set: { boardRank: input.stored },
      })
  );
}

/**
 * Puts a task at a place in the column it is in now, directly above
 * `beforeId` or directly below `afterId` (`beforeId` wins when both are given).
 * Both must be cards of that column on the board; anything else is a 400, so a
 * stale drop is rolled back by the client and the board reloads. `column` is
 * what the caller expects the task to be in. A dropped task, and one in the
 * Other bucket, cannot be ranked.
 */
export async function plannerSetBoardRank(
  db: FlareMoDb,
  input: {
    user: UserRow;
    taskId: string;
    column: PlannerColumn;
    beforeId?: string;
    afterId?: string;
    today: string;
    now?: Date;
  },
): Promise<PlannerTaskPlanResult> {
  if (!plannerIsColumn(input.column)) {
    throw new ValidationError("column must be backlog, todo, doing or done.");
  }
  const today = plannerRequireDay(input.today, "today");
  const taskId = plannerNormalizeTaskId(input.taskId);
  const beforeId =
    input.beforeId === undefined
      ? undefined
      : plannerNormalizeTaskId(input.beforeId);
  const afterId =
    input.afterId === undefined
      ? undefined
      : plannerNormalizeTaskId(input.afterId);
  if (beforeId === undefined && afterId === undefined) {
    throw new ValidationError("before_id or after_id is required.");
  }
  const task = await plannerLoadLiveTask(db, input.user.id, taskId);
  const plan = await plannerLoadPlan(db, input.user.id, taskId);
  const column = plannerColumnFor({
    status: task.status,
    horizon: plan?.horizon ?? null,
    periodStart: plan?.periodStart ?? null,
    droppedAt: plan?.droppedAt ?? null,
  });
  if (column !== input.column) {
    throw new ValidationError(
      `The task is not in ${input.column}. Reload the board.`,
    );
  }

  // The column as the board shows it (the whole Done window), without the card.
  const board = await plannerReadBoard(db, {
    userId: input.user.id,
    today,
    doneDays: plannerBoardDoneDaysMax,
  });
  const others = board.columns[input.column].filter(
    (card) => card.id !== taskId,
  );
  const anchor = beforeId ?? (afterId as string);
  const position = others.findIndex((card) => card.id === anchor);
  if (position === -1) {
    throw new ValidationError(
      `The card ${anchor} is not in ${input.column}. Reload the board.`,
    );
  }
  const index = beforeId === undefined ? position + 1 : position;

  const placement = plannerPlaceRank(
    others.map((card) => card.board_rank),
    index,
  );
  const nowIso = plannerNow(input.now).toISOString();
  if (placement.kind === "rank") {
    await plannerRunBatch(db, [
      rankUpsert(db, {
        userId: input.user.id,
        taskId,
        stored: plannerFormatBoardRank(input.column, placement.key),
        nowIso,
      }),
    ]);
  } else {
    const order = [
      ...others.slice(0, index).map((card) => card.id),
      taskId,
      ...others.slice(index).map((card) => card.id),
    ];
    await plannerRunBatch(
      db,
      order.map((id, place) =>
        rankUpsert(db, {
          userId: input.user.id,
          taskId: id,
          stored: plannerFormatBoardRank(
            input.column,
            placement.keys[place] as string,
          ),
          nowIso,
        }),
      ),
    );
  }
  return plannerReadTaskPlan(db, { user: input.user, taskId });
}

/**
 * A new task's place when its column already has a manual order: above every
 * ranked card, so the card the "+" just made is on top. Returns whether it
 * wrote a rank. A column nobody has ranked keeps its natural order, so nothing
 * is written. Never throws: the task exists, and a missing rank only means it
 * sorts after the ranked cards.
 */
export async function plannerRankNewTaskOnTop(
  db: FlareMoDb,
  input: { userId: string; taskId: string; column: PlannerColumn; now?: Date },
): Promise<boolean> {
  try {
    const prefix = `${input.column}|`;
    const top = await db
      .select({ rank: sql<string | null>`min(${plannerTaskPlan.boardRank})` })
      .from(plannerTaskPlan)
      .where(
        and(
          eq(plannerTaskPlan.userId, input.userId),
          like(plannerTaskPlan.boardRank, `${prefix}%`),
        ),
      )
      .get();
    const topKey = plannerParseBoardRank(top?.rank, input.column);
    if (topKey === null) return false;
    const key = plannerRankBetween(null, topKey);
    if (key.length > plannerRankMaxLength) return false;
    await plannerRunBatch(db, [
      rankUpsert(db, {
        userId: input.userId,
        taskId: input.taskId,
        stored: plannerFormatBoardRank(input.column, key),
        nowIso: plannerNow(input.now).toISOString(),
      }),
    ]);
    return true;
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        message: "Planner board rank write failed after the task was created",
        task: input.taskId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return false;
  }
}

/**
 * Gives every card of a column a fresh key in the order given, in one batch:
 * `order` is the column's task ids top to bottom. Saving a week's plan uses it to
 * put the weekly goals' tasks on top of To Do. Like any rank change it writes no
 * event.
 */
export async function plannerRespreadColumn(
  db: FlareMoDb,
  input: {
    userId: string;
    column: PlannerColumn;
    order: readonly string[];
    now?: Date;
  },
): Promise<void> {
  if (!plannerIsColumn(input.column)) {
    throw new ValidationError("column must be backlog, todo, doing or done.");
  }
  const keys = plannerRankSpread(input.order.length);
  const nowIso = plannerNow(input.now).toISOString();
  await plannerRunBatch(
    db,
    input.order.map((taskId, place) =>
      rankUpsert(db, {
        userId: input.userId,
        taskId,
        stored: plannerFormatBoardRank(input.column, keys[place] as string),
        nowIso,
      }),
    ),
  );
}
