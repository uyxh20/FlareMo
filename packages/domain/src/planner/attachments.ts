import {
  type PlannerAttachmentDto,
  plannerAttachmentMaxBytes,
  plannerAttachmentNameMax,
  plannerAttachmentsPerTask,
} from "@flaremo/contracts";
import type { FlareMoDb, UserRow } from "@flaremo/db";
import { tasks } from "@flaremo/db";
import {
  type PlannerTaskAttachmentRow,
  plannerTaskAttachment,
} from "@flaremo/db/src/schema/planner";
import {
  and,
  asc,
  eq,
  inArray,
  isNull,
  lt,
  notInArray,
  sql,
} from "drizzle-orm";
import { DomainError, NotFoundError, ValidationError } from "../errors";
import {
  type PlannerActor,
  plannerEventStatement,
  plannerLoadLiveTask,
  plannerNormalizeTaskId,
  plannerNow,
  plannerRunBatch,
} from "./shared";

// Files on a task (fork-owned add-on, docs/fork-task-attachments.md). The bytes
// live in the ATTACHMENTS bucket, which the Worker owns; this module owns the
// index rows in `planner_task_attachment` (migration 9016) and the History
// events, and never touches the bucket. The Worker puts the object first, then
// calls `plannerAddAttachment`; if that fails it deletes the object again.
//
// A file is removed softly: `removed_at` is set, the file leaves the panel at
// once, and the nightly sweep deletes the object and the row seven days later
// (`plannerAttachmentsToPurge`, `plannerFinishAttachmentPurge`). A file whose
// task was purged is marked removed by the same sweep, so nothing is orphaned.
//
// Every write is ONE D1 batch of the row change and its planner event (M3). The
// events are `attachment_added` and `attachment_removed`, and carry the file's
// id, name and size: a name is how the owner knows which file a line is about.
//
// A file belongs to the user who put it there, and so does its task. Another
// user's file, a removed one and one that never existed all answer 404.

/** How long a removed file waits before the sweep deletes it. */
export const PLANNER_ATTACHMENT_PURGE_DAYS = 7;

/** The path a task's file is served at (same origin, behind the login). */
export function plannerAttachmentPath(row: {
  taskId: string;
  id: string;
  filename: string;
}): string {
  return `/api/app/planner/tasks/${encodeURIComponent(
    row.taskId.replace(/^tasks\//, ""),
  )}/attachments/${row.id}/${encodeURIComponent(row.filename)}`;
}

export function plannerAttachmentToDto(
  row: PlannerTaskAttachmentRow,
): PlannerAttachmentDto {
  return {
    id: row.id,
    task_id: row.taskId,
    filename: row.filename,
    content_type: row.contentType,
    size: row.size,
    read_state: row.readState,
    action_id: row.actionId,
    created_at: row.createdAt,
    url: plannerAttachmentPath(row),
  };
}

/**
 * A file name as it is stored: trimmed, without path separators or control
 * characters, cut at 200 characters, never empty ("file" when nothing is left).
 */
export function plannerNormalizeAttachmentName(value: unknown): string {
  if (typeof value !== "string") return "file";
  const cleaned = [...value.trim()]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 32 ||
        code === 127 ||
        character === "/" ||
        character === "\\"
        ? "_"
        : character;
    })
    .join("")
    .trim();
  if (!cleaned) return "file";
  return [...cleaned].slice(0, plannerAttachmentNameMax).join("");
}

/** The size check the route does before anything is stored, as a 413. */
export function plannerAssertAttachmentSize(bytes: number): void {
  if (!Number.isFinite(bytes) || bytes < 0) {
    throw new ValidationError("The file's size is unknown.");
  }
  if (bytes === 0) throw new ValidationError("The file is empty.");
  if (bytes > plannerAttachmentMaxBytes) {
    throw new DomainError(
      `A file can be at most ${plannerAttachmentMaxBytes / (1024 * 1024)} MB.`,
      413,
    );
  }
}

/**
 * The user's live files on a task, oldest first. It does not check that the
 * task exists: the panel's detail read has just done so, and
 * `plannerListAttachments` does it for the list route.
 */
export async function plannerReadAttachments(
  db: FlareMoDb,
  input: { userId: string; taskId: string },
): Promise<PlannerAttachmentDto[]> {
  const rows = await db
    .select()
    .from(plannerTaskAttachment)
    .where(
      and(
        eq(plannerTaskAttachment.userId, input.userId),
        eq(plannerTaskAttachment.taskId, plannerNormalizeTaskId(input.taskId)),
        isNull(plannerTaskAttachment.removedAt),
      ),
    )
    .orderBy(asc(plannerTaskAttachment.createdAt), asc(sql`rowid`));
  return rows.map(plannerAttachmentToDto);
}

/** `plannerReadAttachments`, after checking the task is one of the caller's live tasks (404 otherwise). */
export async function plannerListAttachments(
  db: FlareMoDb,
  input: { userId: string; taskId: string },
): Promise<PlannerAttachmentDto[]> {
  const taskId = plannerNormalizeTaskId(input.taskId);
  await plannerLoadLiveTask(db, input.userId, taskId);
  return plannerReadAttachments(db, { userId: input.userId, taskId });
}

/** How many live files a task holds. */
export async function plannerCountAttachments(
  db: FlareMoDb,
  input: { userId: string; taskId: string },
): Promise<number> {
  const row = await db
    .select({ count: sql<number>`count(*)` })
    .from(plannerTaskAttachment)
    .where(
      and(
        eq(plannerTaskAttachment.userId, input.userId),
        eq(plannerTaskAttachment.taskId, plannerNormalizeTaskId(input.taskId)),
        isNull(plannerTaskAttachment.removedAt),
      ),
    )
    .get();
  return Number(row?.count ?? 0);
}

/**
 * Checks a file may be added to the task before the Worker stores its bytes:
 * the task is the caller's and live, the size is within the limit and the task
 * has room. Returns the task so the caller has its title for the event.
 */
export async function plannerAssertAttachmentAllowed(
  db: FlareMoDb,
  input: { userId: string; taskId: string; size: number },
) {
  plannerAssertAttachmentSize(input.size);
  const taskId = plannerNormalizeTaskId(input.taskId);
  const task = await plannerLoadLiveTask(db, input.userId, taskId);
  const count = await plannerCountAttachments(db, {
    userId: input.userId,
    taskId,
  });
  if (count >= plannerAttachmentsPerTask) {
    throw new ValidationError(
      `A task can hold at most ${plannerAttachmentsPerTask} files. Remove one first.`,
    );
  }
  return task;
}

/**
 * Records a file the Worker has just stored and writes `attachment_added`. The
 * checks of `plannerAssertAttachmentAllowed` run again here, so two uploads
 * racing for the last slot cannot both land.
 */
export async function plannerAddAttachment(
  db: FlareMoDb,
  input: {
    user: UserRow;
    actor: PlannerActor;
    taskId: string;
    filename: string;
    contentType: string | null;
    size: number;
    r2Key: string;
    etag: string | null;
    now?: Date;
  },
): Promise<PlannerAttachmentDto> {
  const taskId = plannerNormalizeTaskId(input.taskId);
  const task = await plannerAssertAttachmentAllowed(db, {
    userId: input.user.id,
    taskId,
    size: input.size,
  });
  const filename = plannerNormalizeAttachmentName(input.filename);
  const id = crypto.randomUUID();
  const nowIso = plannerNow(input.now).toISOString();
  const row: PlannerTaskAttachmentRow = {
    id,
    userId: input.user.id,
    taskId,
    filename,
    contentType: input.contentType?.trim() || null,
    size: input.size,
    r2Key: input.r2Key,
    etag: input.etag,
    readState: "stored",
    actionId: null,
    createdAt: nowIso,
    removedAt: null,
  };

  await plannerRunBatch(db, [
    db.insert(plannerTaskAttachment).values(row),
    plannerEventStatement(db, {
      userId: input.user.id,
      taskId,
      taskTitle: task.title,
      type: "attachment_added",
      data: { attachment_id: id, filename, size: input.size },
      actor: input.actor,
      occurredAt: nowIso,
    }),
  ]);
  return plannerAttachmentToDto(row);
}

/** The caller's live file and its live task, or a 404. */
export async function plannerLoadAttachment(
  db: FlareMoDb,
  input: { userId: string; attachmentId: string },
): Promise<PlannerTaskAttachmentRow> {
  const id = input.attachmentId.trim();
  const row = await db
    .select()
    .from(plannerTaskAttachment)
    .where(
      and(
        eq(plannerTaskAttachment.id, id),
        eq(plannerTaskAttachment.userId, input.userId),
        isNull(plannerTaskAttachment.removedAt),
      ),
    )
    .get();
  if (!row) throw new NotFoundError(`File not found: ${id}`);
  await plannerLoadLiveTask(db, input.userId, row.taskId);
  return row;
}

/**
 * Takes a file off its task: `removed_at` is set and `attachment_removed` is
 * written. The object stays in the bucket until the sweep, seven days on, so a
 * mistaken removal can still be undone by hand within that week.
 */
export async function plannerRemoveAttachment(
  db: FlareMoDb,
  input: {
    user: UserRow;
    actor: PlannerActor;
    attachmentId: string;
    now?: Date;
  },
): Promise<void> {
  const row = await plannerLoadAttachment(db, {
    userId: input.user.id,
    attachmentId: input.attachmentId,
  });
  const task = await plannerLoadLiveTask(db, input.user.id, row.taskId);
  const nowIso = plannerNow(input.now).toISOString();

  await plannerRunBatch(db, [
    db
      .update(plannerTaskAttachment)
      .set({ removedAt: nowIso })
      .where(
        and(
          eq(plannerTaskAttachment.id, row.id),
          eq(plannerTaskAttachment.userId, input.user.id),
          isNull(plannerTaskAttachment.removedAt),
        ),
      ),
    plannerEventStatement(db, {
      userId: input.user.id,
      taskId: row.taskId,
      taskTitle: task.title,
      type: "attachment_removed",
      data: { attachment_id: row.id, filename: row.filename, size: row.size },
      actor: input.actor,
      occurredAt: nowIso,
    }),
  ]);
}

/**
 * The nightly sweep's first half. Files whose task is gone from `tasks` (purged
 * by the bin sweep) are marked removed now, so they purge a week later like any
 * removed file; then every file removed before the cutoff is returned, up to
 * `limit` at a time, for the Worker to delete from the bucket. The task purge
 * removes tasks and their activity, never these rows, so this is the only place
 * that notices.
 */
export async function plannerAttachmentsToPurge(
  db: FlareMoDb,
  input: { now: Date; limit?: number },
): Promise<PlannerTaskAttachmentRow[]> {
  const nowIso = input.now.toISOString();
  await db
    .update(plannerTaskAttachment)
    .set({ removedAt: nowIso })
    .where(
      and(
        isNull(plannerTaskAttachment.removedAt),
        notInArray(
          plannerTaskAttachment.taskId,
          db.select({ id: tasks.id }).from(tasks),
        ),
      ),
    );
  const cutoff = new Date(
    input.now.getTime() - PLANNER_ATTACHMENT_PURGE_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  return db
    .select()
    .from(plannerTaskAttachment)
    .where(lt(plannerTaskAttachment.removedAt, cutoff))
    .orderBy(asc(plannerTaskAttachment.removedAt))
    .limit(input.limit ?? 100);
}

/** The sweep's second half: the rows whose objects are gone from the bucket. */
export async function plannerFinishAttachmentPurge(
  db: FlareMoDb,
  ids: readonly string[],
): Promise<void> {
  if (ids.length === 0) return;
  await db
    .delete(plannerTaskAttachment)
    .where(inArray(plannerTaskAttachment.id, [...ids]));
}
