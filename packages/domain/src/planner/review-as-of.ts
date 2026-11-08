import { healthLocalDayStart, plannerAddDays } from "@flaremo/contracts";
import type { FlareMoDb } from "@flaremo/db";
import { plannerAgentRun, plannerWeek } from "@flaremo/db/src/schema/planner";
import { and, desc, eq } from "drizzle-orm";

// The agent's view cut at the reviewed Sunday (fork-owned, for the cascade
// replay on dev; docs/fork-general-agent.md, "The cascade ladder"). A replay
// of a past week runs against the diary as it is today, so the agent would
// read the owner's own saved review of that week, tasks made later and later
// weeks' scores, and copy them. With FLAREMO_REVIEW_AS_OF=review-week the
// MCP server hides, for the open review's week, what was written after the
// owner saved that week's look back (or after the Monday following the week,
// when it was never saved). Goal state cannot be rolled back: points struck
// and results stay as they are today. Off (the default) changes nothing, and
// live never sets it: a live review has nothing after its Sunday to hide.

export type PlannerAsOf = {
  /** The instant after which nothing is shown (ISO). */
  at: string;
  /** The Monday of the week under review. */
  weekStart: string;
};

/** Whether the Worker var asks for the cut; anything but "review-week" is off. */
export function plannerAsOfEnabled(value: string | undefined | null): boolean {
  return value?.trim().toLowerCase() === "review-week";
}

/**
 * The cut for a week: when the owner saved its look back, else the local
 * start of the Tuesday after it (a review happens Sunday evening or Monday).
 */
export function plannerAsOfCutoff(
  weekStart: string,
  reviewedAt: string | null | undefined,
): string {
  if (reviewedAt?.trim()) return new Date(reviewedAt).toISOString();
  return healthLocalDayStart(plannerAddDays(weekStart, 8));
}

/** Keeps a row whose instant (or day) is before the cut; with no cut, everything. */
export function plannerBeforeAsOf(
  asOf: PlannerAsOf | undefined,
): (at: string | null | undefined) => boolean {
  if (!asOf) return () => true;
  const day = asOf.at.slice(0, 10);
  return (at) => {
    if (!at) return true;
    // A bare day compares with the cut's day; an instant with the cut.
    return at.length <= 10 ? at < day : at < asOf.at;
  };
}

/**
 * The cut for this user's open review, read from the run the Worker started:
 * null when no review session is open (an Ask chat, or nothing running).
 */
export async function plannerReviewAsOf(
  db: FlareMoDb,
  userId: string,
): Promise<PlannerAsOf | null> {
  const run = await db
    .select({ ownerKey: plannerAgentRun.ownerKey })
    .from(plannerAgentRun)
    .where(
      and(
        eq(plannerAgentRun.userId, userId),
        eq(plannerAgentRun.job, "review"),
        eq(plannerAgentRun.state, "open"),
      ),
    )
    .orderBy(desc(plannerAgentRun.createdAt))
    .limit(1)
    .get();
  const weekStart = run?.ownerKey.startsWith("week:")
    ? run.ownerKey.slice("week:".length)
    : null;
  if (!weekStart) return null;
  const week = await db
    .select({ reviewedAt: plannerWeek.reviewedAt })
    .from(plannerWeek)
    .where(
      and(eq(plannerWeek.userId, userId), eq(plannerWeek.weekStart, weekStart)),
    )
    .get();
  return { at: plannerAsOfCutoff(weekStart, week?.reviewedAt), weekStart };
}
