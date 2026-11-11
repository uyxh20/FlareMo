import type { FlareMoDb } from "@flaremo/db";
import { tasks } from "@flaremo/db";
import { plannerTaskComment } from "@flaremo/db/src/schema/planner";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";

// Task comments as memory-dreaming sources (fork-owned add-on,
// docs/fork-data-sources.md). The nightly dreaming run reads new diary entries;
// with this it also reads the task comments written since its last run, each
// prefixed with its task's title so the model knows what it is about. The
// extraction prompt keeps only lasting facts, preferences, decisions and
// lessons, so a plain status update ("keys on Friday") is dropped there.
// Notes are not read: they are a task's standing description, rewritten in
// place, and would be sent again every time the task changes.
//
// No imports from the memory module: consolidation.ts calls this, so it must
// not call back.

/** Most comments one run reads, newest first; the diary keeps the rest of the room. */
export const PLANNER_DREAMING_COMMENTS_MAX = 10;

export type PlannerDreamingComment = {
  /** The comment's id. */
  id: string;
  /** `Task "<title>": <comment>` */
  content: string;
  createdAt: string;
};

/** The caller's live comments written after `sinceIso`, on any task they own. */
export async function plannerCollectDreamingComments(
  db: FlareMoDb,
  userId: string,
  sinceIso: string,
  max = PLANNER_DREAMING_COMMENTS_MAX,
): Promise<PlannerDreamingComment[]> {
  if (max <= 0) return [];
  // Extra detail: dreaming still runs on the diary if this cannot be read.
  const rows = await db
    .select({
      id: plannerTaskComment.id,
      body: plannerTaskComment.body,
      createdAt: plannerTaskComment.createdAt,
      title: tasks.title,
    })
    .from(plannerTaskComment)
    .leftJoin(tasks, eq(tasks.id, plannerTaskComment.taskId))
    .where(
      and(
        eq(plannerTaskComment.userId, userId),
        isNull(plannerTaskComment.deletedAt),
        gt(plannerTaskComment.createdAt, sinceIso),
      ),
    )
    .orderBy(desc(plannerTaskComment.createdAt))
    .limit(max)
    .all()
    .catch(() => []);
  return rows.flatMap((row) => {
    const body = row.body.trim();
    if (!body) return [];
    const title = row.title?.trim() || "a task";
    return [
      {
        id: row.id,
        content: `Task "${title}": ${body}`,
        createdAt: row.createdAt,
      },
    ];
  });
}

/**
 * Users who wrote a task comment after `sinceIso`, newest first, so a day of
 * task updates and no diary entry still gets a dreaming run.
 */
export async function plannerDreamingCommentUsers(
  db: FlareMoDb,
  sinceIso: string,
  limit = 20,
): Promise<string[]> {
  const rows = await db
    .select({ userId: plannerTaskComment.userId })
    .from(plannerTaskComment)
    .where(
      and(
        isNull(plannerTaskComment.deletedAt),
        gt(plannerTaskComment.createdAt, sinceIso),
      ),
    )
    .groupBy(plannerTaskComment.userId)
    .orderBy(desc(sql`max(${plannerTaskComment.createdAt})`))
    .limit(limit)
    .all()
    .catch(() => []);
  return rows.map((row) => row.userId);
}
