import {
  plannerPeriodStart,
  plannerTodayWithinBounds,
} from "@flaremo/contracts";
import type { FlareMoDb } from "@flaremo/db";
import {
  plannerTaskEvent,
  plannerTaskPlan,
} from "@flaremo/db/src/schema/planner";
import { type SQL, sql } from "drizzle-orm";
import { ValidationError } from "../errors";
import { plannerSyncHistory } from "./history-sync";
import {
  type PlannerActor,
  type PlannerHistoryStatus,
  plannerActorColumns,
  plannerChanges,
  plannerRequireDay,
  plannerRunBatch,
} from "./shared";

// Rollover (fork-owned add-on, docs/planning-cockpit-implementation-plan.md,
// section 4 "Rollover"): unfinished planned tasks move into the current period.
// The cockpit runs it once on open and again when the local date changes.

export type PlannerRolloverResult = {
  history: PlannerHistoryStatus;
  /** How many plans moved forward this run. */
  carried: number;
};

/**
 * Syncs the history first, then carries every unfinished plan from a past
 * period into the current one, in one D1 batch of two statements that share a
 * predicate: a `carried_over` event for each plan, then the update that moves
 * it and adds 1 to `carry_count`.
 *
 * The predicate is a plan with a horizon, not dropped, whose task exists, is not
 * deleted and is not `done`, and whose `period_start` is before the target
 * period for its horizon (the day, the week's Monday or the month's 1st).
 * Because the batch is one transaction, two concurrent rollovers serialise: the
 * second finds nothing left to carry, so each task gets exactly one carry and
 * one event.
 *
 * It continues whatever the history sync returns, a paused one included.
 * `today` is the client's local date; it must be a real day within one day of
 * the server's UTC date, as the route also enforces.
 */
export async function plannerRollover(
  db: FlareMoDb,
  input: {
    userId: string;
    actor: PlannerActor;
    today: string;
    now: Date;
  },
): Promise<PlannerRolloverResult> {
  const { userId, actor, now } = input;
  const day = plannerRequireDay(input.today, "today");
  if (!plannerTodayWithinBounds(day, now)) {
    throw new ValidationError(
      "today must be within one day of the server's date.",
    );
  }
  const week = plannerPeriodStart("week", day);
  const month = plannerPeriodStart("month", day);
  const nowIso = now.toISOString();
  const { actorType, actorName } = plannerActorColumns(actor);

  const { history } = await plannerSyncHistory(db, { userId, now });

  // The target period for a plan, from its own horizon.
  const targetFor = (horizon: SQL) =>
    sql`(CASE ${horizon} WHEN 'day' THEN ${day} WHEN 'week' THEN ${week} ELSE ${month} END)`;
  const target = targetFor(sql`p.horizon`);

  const predicate = sql`p.user_id = ${userId}
    AND p.horizon IS NOT NULL AND p.period_start IS NOT NULL
    AND p.dropped_at IS NULL
    AND t.deleted_at IS NULL AND t.status <> 'done'
    AND p.period_start < ${target}`;

  const [, update] = await plannerRunBatch(db, [
    db.insert(plannerTaskEvent).select(sql`
      SELECT NULL, p.user_id, p.task_id, t.title, 'carried_over',
             json_object(
               'from', json_object('horizon', p.horizon, 'period_start', p.period_start),
               'to', json_object('horizon', p.horizon, 'period_start', ${target})),
             'planner', NULL, ${actorType}, ${actorName}, ${nowIso}, ${nowIso}
      FROM planner_task_plan p
      JOIN tasks t ON t.id = p.task_id AND t.user_id = p.user_id
      WHERE ${predicate}`),
    db
      .update(plannerTaskPlan)
      .set({
        periodStart: targetFor(sql`${plannerTaskPlan.horizon}`),
        carryCount: sql`${plannerTaskPlan.carryCount} + 1`,
        updatedAt: nowIso,
      })
      .where(
        sql`${plannerTaskPlan.taskId} IN (
          SELECT p.task_id
          FROM planner_task_plan p
          JOIN tasks t ON t.id = p.task_id AND t.user_id = p.user_id
          WHERE ${predicate})`,
      ),
  ]);

  return { history, carried: plannerChanges(update) };
}
