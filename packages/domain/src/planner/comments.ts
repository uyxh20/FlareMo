import type { FlareMoDb, UserRow } from "@flaremo/db";
import {
  type PlannerTaskCommentRow,
  plannerTaskComment,
} from "@flaremo/db/src/schema/planner";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { NotFoundError, ValidationError } from "../errors";
import {
  type PlannerActor,
  plannerEventStatement,
  plannerLoadLiveTask,
  plannerNormalizeTaskId,
  plannerNow,
  plannerRunBatch,
} from "./shared";

// A task's comments (fork-owned add-on, docs/planning-cockpit-implementation-plan.md,
// section 13). They live in `planner_task_comment` (migration 9001), not in any
// upstream table, and are soft-deleted: `deleted_at` hides a comment but the row
// stays, and it outlives its task like the history archive does.
//
// Every write is ONE D1 batch of the comment change and its planner event (M3).
// The events are `commented`, `comment_edited` and `comment_deleted`, and carry
// only `{comment_id}`: the text never goes into the archive.
//
// A comment belongs to the user who wrote it, and so does its task, because
// tasks are per user. Another user's comment, a deleted one and one that never
// existed all answer 404, so nobody learns which is which. Reading or writing a
// comment also needs its task to be live: a task in the recycle bin has no
// panel to show its comments in.

/** The longest comment, in UTF-16 code units, which is what `String#length` and zod count. */
export const plannerCommentBodyMax = 5000;

/** A comment as the routes return it. */
export type PlannerCommentDto = {
  /** A random UUID, not namespaced. */
  id: string;
  /** Upstream's task id, namespaced like every other task id on the wire. */
  task_id: string;
  body: string;
  created_at: string;
  /** Later than `created_at` once the comment has been edited. */
  updated_at: string;
};

export function plannerCommentToDto(
  row: PlannerTaskCommentRow,
): PlannerCommentDto {
  return {
    id: row.id,
    task_id: row.taskId,
    body: row.body,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

/** A comment body as it is stored: trimmed, 1 to 5000 characters, or a 400. */
export function plannerNormalizeCommentBody(value: unknown): string {
  if (typeof value !== "string") {
    throw new ValidationError("A comment must be text.");
  }
  const body = value.trim();
  if (body.length === 0)
    throw new ValidationError("A comment cannot be empty.");
  if (body.length > plannerCommentBodyMax) {
    throw new ValidationError(
      `A comment can have at most ${plannerCommentBodyMax} characters.`,
    );
  }
  return body;
}

/**
 * The user's comments on a task, oldest first (creation time, then insertion
 * order), without the deleted ones. It does not check that the task exists: the
 * panel's detail read has just done so, and `plannerListComments` does it for the
 * list route.
 */
export async function plannerReadComments(
  db: FlareMoDb,
  input: { userId: string; taskId: string },
): Promise<PlannerCommentDto[]> {
  const rows = await db
    .select()
    .from(plannerTaskComment)
    .where(
      and(
        eq(plannerTaskComment.userId, input.userId),
        eq(plannerTaskComment.taskId, plannerNormalizeTaskId(input.taskId)),
        isNull(plannerTaskComment.deletedAt),
      ),
    )
    // rowid breaks a tie between two comments made in the same millisecond.
    .orderBy(asc(plannerTaskComment.createdAt), asc(sql`rowid`));
  return rows.map(plannerCommentToDto);
}

/** `plannerReadComments`, after checking the task is one of the caller's live tasks (404 otherwise). */
export async function plannerListComments(
  db: FlareMoDb,
  input: { userId: string; taskId: string },
): Promise<PlannerCommentDto[]> {
  const taskId = plannerNormalizeTaskId(input.taskId);
  await plannerLoadLiveTask(db, input.userId, taskId);
  return plannerReadComments(db, { userId: input.userId, taskId });
}

/** The caller's live comment and its live task, or a 404. */
async function requireOwnComment(
  db: FlareMoDb,
  userId: string,
  commentId: string,
) {
  const id = commentId.trim();
  const row = await db
    .select()
    .from(plannerTaskComment)
    .where(
      and(
        eq(plannerTaskComment.id, id),
        eq(plannerTaskComment.userId, userId),
        isNull(plannerTaskComment.deletedAt),
      ),
    )
    .get();
  if (!row) throw new NotFoundError(`Comment not found: ${id}`);
  const task = await plannerLoadLiveTask(db, userId, row.taskId);
  return { row, task };
}

/** Adds a comment to one of the caller's live tasks and writes `commented`. */
export async function plannerAddComment(
  db: FlareMoDb,
  input: {
    user: UserRow;
    actor: PlannerActor;
    taskId: string;
    body: string;
    now?: Date;
  },
): Promise<PlannerCommentDto> {
  const body = plannerNormalizeCommentBody(input.body);
  const taskId = plannerNormalizeTaskId(input.taskId);
  const task = await plannerLoadLiveTask(db, input.user.id, taskId);
  const id = crypto.randomUUID();
  const nowIso = plannerNow(input.now).toISOString();

  await plannerRunBatch(db, [
    db.insert(plannerTaskComment).values({
      id,
      userId: input.user.id,
      taskId,
      body,
      createdAt: nowIso,
      updatedAt: nowIso,
      deletedAt: null,
    }),
    plannerEventStatement(db, {
      userId: input.user.id,
      taskId,
      taskTitle: task.title,
      type: "commented",
      data: { comment_id: id },
      actor: input.actor,
      occurredAt: nowIso,
    }),
  ]);
  return {
    id,
    task_id: taskId,
    body,
    created_at: nowIso,
    updated_at: nowIso,
  };
}

/**
 * Changes a comment's text and writes `comment_edited`. A body that is the same
 * after trimming changes nothing and writes nothing.
 */
export async function plannerUpdateComment(
  db: FlareMoDb,
  input: {
    user: UserRow;
    actor: PlannerActor;
    commentId: string;
    body: string;
    now?: Date;
  },
): Promise<PlannerCommentDto> {
  const body = plannerNormalizeCommentBody(input.body);
  const { row, task } = await requireOwnComment(
    db,
    input.user.id,
    input.commentId,
  );
  if (row.body === body) return plannerCommentToDto(row);
  const nowIso = plannerNow(input.now).toISOString();

  await plannerRunBatch(db, [
    db
      .update(plannerTaskComment)
      .set({ body, updatedAt: nowIso })
      .where(
        and(
          eq(plannerTaskComment.id, row.id),
          eq(plannerTaskComment.userId, input.user.id),
          isNull(plannerTaskComment.deletedAt),
        ),
      ),
    plannerEventStatement(db, {
      userId: input.user.id,
      taskId: row.taskId,
      taskTitle: task.title,
      type: "comment_edited",
      data: { comment_id: row.id },
      actor: input.actor,
      occurredAt: nowIso,
    }),
  ]);
  return plannerCommentToDto({ ...row, body, updatedAt: nowIso });
}

/**
 * Soft-deletes a comment (`deleted_at` is set, the row stays) and writes
 * `comment_deleted`. A comment that is already deleted is a 404.
 */
export async function plannerDeleteComment(
  db: FlareMoDb,
  input: {
    user: UserRow;
    actor: PlannerActor;
    commentId: string;
    now?: Date;
  },
): Promise<void> {
  const { row, task } = await requireOwnComment(
    db,
    input.user.id,
    input.commentId,
  );
  const nowIso = plannerNow(input.now).toISOString();

  await plannerRunBatch(db, [
    db
      .update(plannerTaskComment)
      .set({ deletedAt: nowIso, updatedAt: nowIso })
      .where(
        and(
          eq(plannerTaskComment.id, row.id),
          eq(plannerTaskComment.userId, input.user.id),
          isNull(plannerTaskComment.deletedAt),
        ),
      ),
    plannerEventStatement(db, {
      userId: input.user.id,
      taskId: row.taskId,
      taskTitle: task.title,
      type: "comment_deleted",
      data: { comment_id: row.id },
      actor: input.actor,
      occurredAt: nowIso,
    }),
  ]);
}
