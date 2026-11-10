import type { PlannerGoalDto } from "@flaremo/contracts";
import type { FlareMoDb } from "@flaremo/db";
import {
  type PlannerGoalRow,
  type PlannerGoalSnapshot,
  type PlannerGoalVersionRow,
  plannerGoalVersion,
} from "@flaremo/db/src/schema/planner";
import { and, desc, eq, sql } from "drizzle-orm";

// The goal change log (fork-owned add-on, migration 9018_planner_goal_version.sql,
// docs/planning-cockpit-goals-review.md). Every write to a goal adds one row
// holding the goal as it was and as it became, in the same batch as the write.
// Rows are append-only: no code updates or deletes one, and nothing purges goals,
// so a goal's words survive its own removal.

export type PlannerGoalVersionAction = PlannerGoalVersionRow["action"];

/** Who made the change: "user" (the default), "review", or `proposal:<id>`. */
export type PlannerGoalActor = string;

export const PLANNER_GOAL_ACTOR_USER = "user";
export const PLANNER_GOAL_ACTOR_REVIEW = "review";

/** The actor of a change the agent proposed and the owner accepted. */
export function plannerProposalActor(proposalId: string): PlannerGoalActor {
  return `proposal:${proposalId}`;
}

/** The goal as the log keeps it: the row without its id, owner and stamps. */
export function plannerGoalSnapshot(
  row: Pick<
    PlannerGoalRow,
    | "title"
    | "lines"
    | "note"
    | "status"
    | "result"
    | "pillar"
    | "level"
    | "periodStart"
    | "sortOrder"
    | "deletedAt"
  >,
): PlannerGoalSnapshot {
  return {
    title: row.title,
    lines: row.lines,
    note: row.note ?? null,
    status: row.status,
    result: row.result ?? null,
    pillar: row.pillar ?? null,
    level: row.level,
    period_start: row.periodStart ?? null,
    sort_order: row.sortOrder,
    deleted_at: row.deletedAt ?? null,
  };
}

/** The snapshot of a live goal as the DTO a read returned. */
export function plannerGoalDtoSnapshot(
  goal: PlannerGoalDto,
): PlannerGoalSnapshot {
  return {
    title: goal.title,
    lines: goal.lines,
    note: goal.note,
    status: goal.status,
    result: goal.result,
    pillar: goal.pillar,
    level: goal.level,
    period_start: goal.period_start,
    sort_order: goal.sort_order,
    deleted_at: null,
  };
}

/** Whether two snapshots say the same thing. */
export function plannerSameSnapshot(
  left: PlannerGoalSnapshot | null,
  right: PlannerGoalSnapshot | null,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** The statement that appends one version row; batch it with the goal's write. */
export function plannerGoalVersionStatement(
  db: FlareMoDb,
  input: {
    userId: string;
    goalId: string;
    action: PlannerGoalVersionAction;
    actor?: PlannerGoalActor;
    before: PlannerGoalSnapshot | null;
    after: PlannerGoalSnapshot | null;
    at: string;
  },
) {
  return db.insert(plannerGoalVersion).values({
    id: crypto.randomUUID(),
    userId: input.userId,
    goalId: input.goalId,
    action: input.action,
    actor: input.actor ?? PLANNER_GOAL_ACTOR_USER,
    beforeJson: input.before,
    afterJson: input.after,
    createdAt: input.at,
  });
}

/** The newest version of a goal (the log is append-only, so this is its last write), or null. */
export async function plannerLatestGoalVersion(
  db: FlareMoDb,
  input: { userId: string; goalId: string },
): Promise<PlannerGoalVersionRow | null> {
  const row = await db
    .select()
    .from(plannerGoalVersion)
    .where(
      and(
        eq(plannerGoalVersion.userId, input.userId),
        eq(plannerGoalVersion.goalId, input.goalId),
      ),
    )
    // Equal stamps (two writes in one millisecond) fall back to insertion order.
    .orderBy(desc(plannerGoalVersion.createdAt), desc(sql`rowid`))
    .limit(1)
    .get();
  return row ?? null;
}

/** Every version of a goal, oldest first: what a goal said, and who changed it. */
export async function plannerReadGoalVersions(
  db: FlareMoDb,
  input: { userId: string; goalId: string },
): Promise<PlannerGoalVersionRow[]> {
  return db
    .select()
    .from(plannerGoalVersion)
    .where(
      and(
        eq(plannerGoalVersion.userId, input.userId),
        eq(plannerGoalVersion.goalId, input.goalId),
      ),
    )
    .orderBy(plannerGoalVersion.createdAt, sql`rowid`)
    .all();
}
