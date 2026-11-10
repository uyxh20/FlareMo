import type { FlareMoDb } from "@flaremo/db";
import { tasks } from "@flaremo/db";
import { plannerTaskPlan } from "@flaremo/db/src/schema/planner";
import { and, eq, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { plannerRequireDay } from "./shared";

// The sidebar's overdue reminder (fork-owned add-on, docs/fork-customizations.md
// "Overdue reminder opens the cockpit"). Upstream's reminder counted the first
// 100 rows of the task list, only within the current month, and linked to the
// hidden /projects page. This counts in SQL, so every task counts.
//
// Open means what the cockpit's red due chip means (`plannerIsOverdue` in
// apps/web/src/planner/board-model.ts): live, not done, not dropped. It only
// reads: unlike the board it does not sync the history archive, so a sidebar
// that loads on every page never writes to D1.

export type PlannerOverdueCounts = {
  today: string;
  /** Open tasks whose due day is before `today`, from any month. */
  overdue: number;
  /** Open tasks due on `today`. */
  due_today: number;
};

export async function plannerReadOverdue(
  db: FlareMoDb,
  input: { userId: string; today: string },
): Promise<PlannerOverdueCounts> {
  const today = plannerRequireDay(input.today, "today");
  const row = await db
    .select({
      overdue: sql<number>`coalesce(sum(case when ${tasks.dueAt} < ${today} then 1 else 0 end), 0)`,
      dueToday: sql<number>`coalesce(sum(case when ${tasks.dueAt} = ${today} then 1 else 0 end), 0)`,
    })
    .from(tasks)
    .leftJoin(plannerTaskPlan, eq(plannerTaskPlan.taskId, tasks.id))
    .where(
      and(
        eq(tasks.userId, input.userId),
        isNull(tasks.deletedAt),
        ne(tasks.status, "done"),
        isNull(plannerTaskPlan.droppedAt),
        isNotNull(tasks.dueAt),
        sql`${tasks.dueAt} <= ${today}`,
      ),
    )
    .get();
  return {
    today,
    overdue: Number(row?.overdue ?? 0),
    due_today: Number(row?.dueToday ?? 0),
  };
}
