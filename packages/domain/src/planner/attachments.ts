import {
  healthLocalMoment,
  type PlannerAgentActionDto,
  type PlannerAttachmentDto,
  type PlannerAttachmentReadState,
  plannerAttachmentMaxBytes,
  plannerAttachmentNameMax,
  plannerAttachmentReadsPerMonth,
  plannerAttachmentsPerTask,
} from "@flaremo/contracts";
import type { FlareMoDb, UserRow } from "@flaremo/db";
import { tasks } from "@flaremo/db";
import {
  type PlannerTaskAttachmentRow,
  plannerAgentAction,
  plannerTaskAttachment,
  plannerTaskPlan,
} from "@flaremo/db/src/schema/planner";
import {
  and,
  asc,
  eq,
  gte,
  inArray,
  isNull,
  lt,
  notInArray,
  sql,
} from "drizzle-orm";
import { DomainError, NotFoundError, ValidationError } from "../errors";
import { plannerAgentActionToDto } from "./agent-store";
import {
  type PlannerActor,
  plannerEventStatement,
  plannerLoadLiveTask,
  plannerLoadPlan,
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
  proposal: PlannerAgentActionDto | null = null,
): PlannerAttachmentDto {
  return {
    id: row.id,
    task_id: row.taskId,
    filename: row.filename,
    content_type: row.contentType,
    size: row.size,
    read_state: row.readState,
    action_id: row.actionId,
    proposal,
    created_at: row.createdAt,
    url: plannerAttachmentPath(row),
  };
}

/** The proposed comments the rows point at, by id, as cards. */
async function proposalsFor(
  db: FlareMoDb,
  userId: string,
  rows: readonly PlannerTaskAttachmentRow[],
): Promise<Map<string, PlannerAgentActionDto>> {
  const ids = rows.flatMap((row) => (row.actionId ? [row.actionId] : []));
  if (ids.length === 0) return new Map();
  const actions = await db
    .select()
    .from(plannerAgentAction)
    .where(
      and(
        eq(plannerAgentAction.userId, userId),
        inArray(plannerAgentAction.id, ids),
      ),
    );
  return new Map(
    actions.map((action) => [action.id, plannerAgentActionToDto(action)]),
  );
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
  const proposals = await proposalsFor(db, input.userId, rows);
  return rows.map((row) =>
    plannerAttachmentToDto(
      row,
      row.actionId ? (proposals.get(row.actionId) ?? null) : null,
    ),
  );
}

// ---------------------------------------------------------------------------
// Reading on drop (phase 2): the task's switch, the read states, the caps
// ---------------------------------------------------------------------------

/** Whether files dropped on the task are read into proposed comments (the default). */
export async function plannerTaskFilesRead(
  db: FlareMoDb,
  input: { userId: string; taskId: string },
): Promise<boolean> {
  const plan = await plannerLoadPlan(
    db,
    input.userId,
    plannerNormalizeTaskId(input.taskId),
  );
  return plan?.filesRead !== 0;
}

/**
 * The task's "Store only, don't read these files" switch, kept on its plan row
 * (a row is made with no plan when the task has none). No History event: it is
 * a setting about the files, not a change to the task.
 */
export async function plannerSetTaskFilesRead(
  db: FlareMoDb,
  input: { userId: string; taskId: string; filesRead: boolean; now?: Date },
): Promise<boolean> {
  const taskId = plannerNormalizeTaskId(input.taskId);
  await plannerLoadLiveTask(db, input.userId, taskId);
  const nowIso = plannerNow(input.now).toISOString();
  const filesRead = input.filesRead ? 1 : 0;
  await db
    .insert(plannerTaskPlan)
    .values({
      taskId,
      userId: input.userId,
      horizon: null,
      periodStart: null,
      carryCount: 0,
      droppedAt: null,
      filesRead,
      createdAt: nowIso,
      updatedAt: nowIso,
    })
    .onConflictDoUpdate({
      target: plannerTaskPlan.taskId,
      set: { filesRead, updatedAt: nowIso },
    });
  return input.filesRead;
}

/** Moves a file's read state, and records the proposal it produced when there is one. */
export async function plannerSetAttachmentReadState(
  db: FlareMoDb,
  input: {
    userId: string;
    attachmentId: string;
    state: PlannerAttachmentReadState;
    actionId?: string | null;
  },
): Promise<void> {
  await db
    .update(plannerTaskAttachment)
    .set({
      readState: input.state,
      ...(input.actionId === undefined ? {} : { actionId: input.actionId }),
    })
    .where(
      and(
        eq(plannerTaskAttachment.id, input.attachmentId),
        eq(plannerTaskAttachment.userId, input.userId),
      ),
    );
}

/** The first instant of the owner's local month `now` falls in. */
function localMonthStart(now: Date): string {
  return `${healthLocalMoment(now.toISOString()).day.slice(0, 7)}-01T00:00:00.000Z`;
}

/**
 * How many reads were started this month, over every task: a read counts from
 * the moment it starts (`pending`), whatever it came to, so retries count too.
 * `stored` and `skipped` files were never sent anywhere and do not count.
 */
export async function plannerAttachmentReadsThisMonth(
  db: FlareMoDb,
  input: { userId: string; now?: Date },
): Promise<number> {
  const row = await db
    .select({ count: sql<number>`count(*)` })
    .from(plannerTaskAttachment)
    .where(
      and(
        eq(plannerTaskAttachment.userId, input.userId),
        gte(
          plannerTaskAttachment.createdAt,
          localMonthStart(input.now ?? new Date()),
        ),
        notInArray(plannerTaskAttachment.readState, ["stored", "skipped"]),
      ),
    )
    .get();
  return Number(row?.count ?? 0);
}

/**
 * Decides whether a file is read now, and claims the read. Returns the row to
 * read with its state set to `pending`, or null with the reason recorded on the
 * row: `skipped` when the task is set to store only (or `force` is not given
 * for a file that was read before), `capped` when the month's reads are used
 * up. A file that is not the caller's, or is removed, is a 404.
 */
export async function plannerClaimAttachmentRead(
  db: FlareMoDb,
  input: { userId: string; attachmentId: string; force?: boolean; now?: Date },
): Promise<PlannerTaskAttachmentRow | null> {
  const row = await plannerLoadAttachment(db, {
    userId: input.userId,
    attachmentId: input.attachmentId,
  });
  if (row.readState === "pending") return null;
  if (!input.force) {
    const read = await plannerTaskFilesRead(db, {
      userId: input.userId,
      taskId: row.taskId,
    });
    if (!read) {
      await plannerSetAttachmentReadState(db, {
        userId: input.userId,
        attachmentId: row.id,
        state: "skipped",
      });
      return null;
    }
  }
  const used = await plannerAttachmentReadsThisMonth(db, {
    userId: input.userId,
    now: input.now,
  });
  if (used >= plannerAttachmentReadsPerMonth) {
    await plannerSetAttachmentReadState(db, {
      userId: input.userId,
      attachmentId: row.id,
      state: "capped",
    });
    return null;
  }
  await plannerSetAttachmentReadState(db, {
    userId: input.userId,
    attachmentId: row.id,
    state: "pending",
  });
  return { ...row, readState: "pending" };
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
