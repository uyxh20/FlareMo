import type { FlareMoDb } from "@flaremo/db";
import { taskActivity, tasks } from "@flaremo/db";
import {
  plannerProjectNode,
  plannerSyncState,
  plannerTaskEvent,
  plannerTaskPlan,
  plannerTaskSeen,
} from "@flaremo/db/src/schema/planner";
import { and, eq, notInArray, type SQL, sql } from "drizzle-orm";
import {
  type PlannerHistoryStatus,
  plannerDescribeError,
  plannerRunBatch,
} from "./shared";

// History sync: the planning cockpit's permanent archive (fork-owned add-on,
// docs/planning-cockpit-implementation-plan.md, section 4 "History sync").
//
// Upstream keeps `task_activity` only while a task exists, and upstream table
// rebuilds have wiped it before. The planner therefore copies every activity row
// into `planner_task_event` and adds the events upstream never logs (delete,
// restore, purge) by comparing `tasks` with a snapshot (`planner_task_seen`).
// There are no triggers anywhere (G11) and no writes to upstream tables (G14):
// this module only reads `tasks`, `task_activity` and `projects`.
//
// It runs on cockpit open and before history reads, and nightly around the
// trash purge (history-sync-nightly.ts), which would otherwise wipe tasks
// the archive has never seen.

/** A sync that ran less than this long ago is skipped, and its status returned. */
export const plannerSyncDebounceMs = 30_000;

/**
 * Activity rows this close to the watermark are looked at again. Together with
 * the id clause this catches back-dated bundle-import rows (new id, old
 * `created_at`) and rows written after an upstream rebuild restarted the ids.
 */
export const plannerActivityOverlapMs = 10 * 60 * 1000;

/**
 * Every upstream column the sync and the board read, per table. The sync checks
 * them with `PRAGMA table_info` before it copies anything. A test keeps this
 * list inside Drizzle's `getTableColumns` for the same tables, so it cannot name
 * a column that upstream does not have.
 */
export const plannerRequiredColumns = {
  tasks: [
    "id",
    "user_id",
    "project_id",
    "title",
    "status",
    "priority",
    "due_at",
    "sort_order",
    "completed_at",
    "deleted_at",
    "created_at",
    "updated_at",
  ],
  task_activity: [
    "id",
    "task_id",
    "user_id",
    "actor_type",
    "actor_name",
    "action",
    "changes",
    "created_at",
  ],
  projects: ["id", "user_id", "name", "status", "deleted_at", "created_at"],
} as const satisfies Record<string, readonly string[]>;

/** Upstream's `task_activity.action` values, straight from its Drizzle enum. */
export const plannerKnownActivityActions: readonly string[] =
  taskActivity.action.enumValues;

/** Upstream's `tasks.status` values, straight from its Drizzle enum. */
export const plannerKnownTaskStatuses: readonly string[] =
  tasks.status.enumValues;

/**
 * The statements of one sync, in the order they run inside the single batch.
 * Restored runs before deleted, both read the old snapshot, and the snapshot is
 * rewritten last. Exported so tests can read each statement's `meta.changes`.
 */
export const plannerSyncBatchSteps = [
  "copy_activity",
  "state",
  "restored",
  "deleted",
  "purged",
  "purge_plans",
  "purge_seen",
  "created",
  "snapshot",
  "orphan_nodes",
] as const;

export type PlannerSyncBatchStep = (typeof plannerSyncBatchSteps)[number];

export type PlannerSyncResult = { history: PlannerHistoryStatus };

type PlannerRequiredColumns = Record<string, readonly string[]>;

/**
 * The required columns that the live database does not have, as `table.column`.
 * A table that is missing altogether reports every one of its columns.
 */
export async function plannerFindMissingColumns(
  db: FlareMoDb,
  required: PlannerRequiredColumns = plannerRequiredColumns,
): Promise<string[]> {
  const missing: string[] = [];
  for (const [table, columns] of Object.entries(required)) {
    // PRAGMA takes no bound parameters; `table` is one of the constants above.
    const rows = await db.all<{ name: string }>(
      sql`PRAGMA table_info(${sql.raw(table)})`,
    );
    const present = new Set(rows.map((row) => row.name));
    for (const column of columns) {
      if (!present.has(column)) missing.push(`${table}.${column}`);
    }
  }
  return missing;
}

/**
 * A warning, or null, when the user's rows carry an activity action or task
 * status that upstream's enums do not list. Syncing carries on; the unknown
 * statuses land in the board's `other` bucket.
 */
async function findEnumDrift(
  db: FlareMoDb,
  userId: string,
): Promise<string | null> {
  const [actions, statuses] = await Promise.all([
    db
      .selectDistinct({ action: taskActivity.action })
      .from(taskActivity)
      .where(
        and(
          eq(taskActivity.userId, userId),
          notInArray(taskActivity.action, [...taskActivity.action.enumValues]),
        ),
      ),
    db
      .selectDistinct({ status: tasks.status })
      .from(tasks)
      .where(
        and(
          eq(tasks.userId, userId),
          notInArray(tasks.status, [...tasks.status.enumValues]),
        ),
      ),
  ]);
  const parts: string[] = [];
  if (actions.length > 0) {
    parts.push(
      `unknown task_activity actions: ${actions.map((row) => row.action).join(", ")}`,
    );
  }
  if (statuses.length > 0) {
    parts.push(
      `unknown task statuses: ${statuses.map((row) => row.status).join(", ")}`,
    );
  }
  return parts.length > 0 ? parts.join("; ").slice(0, 400) : null;
}

/**
 * Which activity rows to look at. Everything on the first sync; afterwards the
 * rows with a higher id than last time, plus the rows within the overlap window
 * before the watermark. Re-looking at a row is harmless: the copy is idempotent.
 */
function activitySelection(state: {
  activityLastId: number | null;
  activityWatermark: string | null;
}): SQL {
  // After a sync that saw an empty table the last id is NULL, and every row
  // that exists now is newer than that, so 0 is the right floor.
  const clauses: SQL[] = [sql`a.id > ${state.activityLastId ?? 0}`];
  if (state.activityWatermark !== null) {
    const watermark = Date.parse(state.activityWatermark);
    if (!Number.isFinite(watermark)) {
      // A watermark we cannot read must not hide rows: look at all of them.
      return sql`1`;
    }
    const windowStart = new Date(
      watermark - plannerActivityOverlapMs,
    ).toISOString();
    clauses.push(sql`a.created_at >= ${windowStart}`);
  }
  return sql.join(clauses, sql` OR `);
}

/** The current name of the project with the given id, or NULL. */
const projectNameOf = (projectId: SQL) =>
  sql`(SELECT p.name FROM projects p WHERE p.id = ${projectId})`;

/**
 * Event data with the project's name added as `project_name`, so the history
 * still names the project after the project has been purged. Only the name is
 * added, never `project_id`: the history labels read a `project_id` key as "the
 * project changed". `base` is JSON text for an object; the data is left alone
 * when there is no project or the project is already gone.
 */
const withProjectName = (base: SQL, projectId: SQL) =>
  sql`CASE WHEN ${projectNameOf(projectId)} IS NOT NULL
    THEN json_set(${base}, '$.project_name', ${projectNameOf(projectId)})
    ELSE ${base} END`;

/**
 * The project a task was in when an activity row happened: the latest activity
 * row up to and including this one that names a project (`created`, or an edit
 * that moved or cleared it; a cleared project reads as ''). Without one, every
 * move is later than the event, so the snapshot's project is right; without a
 * snapshot, the live one is the best that is left.
 */
const projectIdAtActivity = sql`NULLIF(COALESCE(
  (SELECT COALESCE(json_extract(p.changes, '$.project_id'), '') FROM task_activity p
   WHERE p.task_id = a.task_id AND json_valid(p.changes)
     AND json_type(p.changes, '$.project_id') IS NOT NULL
     AND (p.created_at < a.created_at OR (p.created_at = a.created_at AND p.id <= a.id))
   ORDER BY p.created_at DESC, p.id DESC LIMIT 1),
  s.project_id, t.project_id), '')`;

/**
 * The title a task had when an activity row happened: the title of the latest
 * activity row up to and including this one that names a title (upstream's
 * `created` and every `updated` that renames it). Without one, every rename is
 * later than the event, so the snapshot's title (the title at the last sync) is
 * right; without a snapshot, the live title is the best that is left.
 */
const titleAtActivity = sql`COALESCE(
  (SELECT json_extract(p.changes, '$.title') FROM task_activity p
   WHERE p.task_id = a.task_id AND json_valid(p.changes)
     AND json_extract(p.changes, '$.title') IS NOT NULL
     AND (p.created_at < a.created_at OR (p.created_at = a.created_at AND p.id <= a.id))
   ORDER BY p.created_at DESC, p.id DESC LIMIT 1),
  s.title, t.title, '')`;

/**
 * Builds the sync's statements, in `plannerSyncBatchSteps` order. Every one is a
 * Drizzle builder, because a batch can only carry builders. Each insert uses
 * `ON CONFLICT DO NOTHING`, never `INSERT OR IGNORE`, which would also swallow a
 * NOT NULL violation. The SELECTs all have a WHERE clause, which stops SQLite
 * from reading the following ON as part of the FROM clause.
 */
function buildSyncStatements(
  db: FlareMoDb,
  input: {
    userId: string;
    nowIso: string;
    state: { activityLastId: number | null; activityWatermark: string | null };
    warning: string | null;
  },
) {
  const { userId, nowIso, state, warning } = input;

  // Every INSERT ... SELECT into planner_task_event selects these twelve
  // values in table order: id, user_id, task_id, task_title, type, data,
  // source, source_ref, actor_type, actor_name, occurred_at, created_at.
  const eventsFrom = (select: SQL) =>
    db.insert(plannerTaskEvent).select(select).onConflictDoNothing();

  const copyActivity = eventsFrom(sql`
    SELECT NULL, a.user_id, a.task_id, ${titleAtActivity}, a.action,
           CASE WHEN json_valid(a.changes) AND json_type(a.changes) = 'object'
             THEN ${withProjectName(sql`a.changes`, projectIdAtActivity)}
             ELSE a.changes END, 'activity',
           'a:' || a.task_id || '@' || a.created_at || '|' || a.action || '|' || COALESCE(a.changes, ''),
           a.actor_type, a.actor_name, a.created_at, ${nowIso}
    FROM task_activity a
    LEFT JOIN tasks t ON t.id = a.task_id
    LEFT JOIN planner_task_seen s ON s.task_id = a.task_id
    WHERE a.user_id = ${userId} AND a.task_id IS NOT NULL
      AND (${activitySelection(state)})
    ORDER BY a.created_at, a.id`);

  // The watermark only ever moves forward. The last id may go down (an upstream
  // rebuild restarts the ids), so it simply follows the table.
  const updateState = db
    .insert(plannerSyncState)
    .values({
      userId,
      activityWatermark: sql`(SELECT MAX(created_at) FROM task_activity WHERE user_id = ${userId} AND task_id IS NOT NULL)`,
      activityLastId: sql`(SELECT MAX(id) FROM task_activity WHERE user_id = ${userId})`,
      lastSyncAt: nowIso,
      status: "ok",
      pausedReason: warning,
    })
    .onConflictDoUpdate({
      target: plannerSyncState.userId,
      set: {
        activityWatermark: sql`CASE
          WHEN excluded.activity_watermark IS NULL THEN planner_sync_state.activity_watermark
          WHEN planner_sync_state.activity_watermark IS NULL
            OR excluded.activity_watermark > planner_sync_state.activity_watermark THEN excluded.activity_watermark
          ELSE planner_sync_state.activity_watermark END`,
        activityLastId: sql`excluded.activity_last_id`,
        lastSyncAt: sql`excluded.last_sync_at`,
        status: sql`excluded.status`,
        pausedReason: sql`excluded.paused_reason`,
      },
    });

  // A snapshot of a deleted task whose live row now has a different stamp: it
  // was restored (and maybe deleted again). Keyed by the stamp it was restored from.
  const restored = eventsFrom(sql`
    SELECT NULL, t.user_id, t.id, t.title, 'restored',
           ${withProjectName(sql`'{"detected":true}'`, sql`t.project_id`)}, 'sync',
           'res:' || t.id || '@' || s.deleted_at, NULL, NULL, ${nowIso}, ${nowIso}
    FROM planner_task_seen s
    JOIN tasks t ON t.id = s.task_id
    WHERE s.user_id = ${userId} AND t.user_id = ${userId}
      AND s.deleted_at IS NOT NULL AND t.deleted_at IS NOT s.deleted_at`);

  // A deleted task the snapshot has not seen deleted: new this sync, or created
  // and deleted between two syncs. Skipped when upstream starts logging
  // `deleted` itself and that event is already in the archive.
  const deleted = eventsFrom(sql`
    SELECT NULL, t.user_id, t.id, t.title, 'deleted',
           ${withProjectName(sql`'{}'`, sql`t.project_id`)}, 'sync',
           'del:' || t.id || '@' || t.deleted_at, NULL, NULL, t.deleted_at, ${nowIso}
    FROM tasks t
    LEFT JOIN planner_task_seen s ON s.task_id = t.id
    WHERE t.user_id = ${userId} AND t.deleted_at IS NOT NULL
      AND (s.task_id IS NULL OR s.deleted_at IS NOT t.deleted_at)
      AND NOT EXISTS (
        SELECT 1 FROM planner_task_event e
        WHERE e.task_id = t.id AND e.source = 'activity' AND e.type = 'deleted'
          AND e.occurred_at = t.deleted_at)`);

  // The project's name at purge time: the project itself if it survives, else
  // the name an earlier event of this task (its deletion, say) recorded for it.
  const purgedProjectName = sql`COALESCE(
    ${projectNameOf(sql`s.project_id`)},
    (SELECT json_extract(e.data, '$.project_name') FROM planner_task_event e
     WHERE e.task_id = s.task_id AND s.project_id IS NOT NULL
       AND json_valid(e.data)
       AND json_extract(e.data, '$.project_name') IS NOT NULL
     ORDER BY e.occurred_at DESC, e.id DESC LIMIT 1))`;

  // A snapshot with no task behind it: hard-deleted upstream. The title comes
  // from the snapshot, the only copy left.
  const purged = eventsFrom(sql`
    SELECT NULL, s.user_id, s.task_id, s.title, 'purged',
           CASE WHEN ${purgedProjectName} IS NOT NULL
             THEN json_set('{"detected":true}', '$.project_name', ${purgedProjectName})
             ELSE '{"detected":true}' END, 'sync',
           'pur:' || s.task_id, NULL, NULL, ${nowIso}, ${nowIso}
    FROM planner_task_seen s
    WHERE s.user_id = ${userId}
      AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.id = s.task_id)`);

  // Plans and snapshots of purged tasks go, once their event is written.
  const purgePlans = db
    .delete(plannerTaskPlan)
    .where(
      and(
        eq(plannerTaskPlan.userId, userId),
        sql`NOT EXISTS (SELECT 1 FROM tasks WHERE tasks.id = ${plannerTaskPlan.taskId})`,
      ),
    );
  const purgeSeen = db
    .delete(plannerTaskSeen)
    .where(
      and(
        eq(plannerTaskSeen.userId, userId),
        sql`NOT EXISTS (SELECT 1 FROM tasks WHERE tasks.id = ${plannerTaskSeen.taskId})`,
      ),
    );

  // A task first seen with no `created` event in the archive (a bundle import,
  // or activity lost upstream). The baseline records what upstream's own
  // `created` activity never logs, such as the due date.
  const created = eventsFrom(sql`
    SELECT NULL, t.user_id, t.id, t.title, 'created',
           ${withProjectName(sql`json_object('status', t.status, 'project_id', t.project_id, 'due_at', t.due_at)`, sql`t.project_id`)},
           'sync', 'new:' || t.id, NULL, NULL, t.created_at, ${nowIso}
    FROM tasks t
    LEFT JOIN planner_task_seen s ON s.task_id = t.id
    WHERE t.user_id = ${userId} AND s.task_id IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM planner_task_event e WHERE e.task_id = t.id AND e.type = 'created')`);

  // Only a changed row is written, so a second sync with nothing new writes none.
  const snapshot = db
    .insert(plannerTaskSeen)
    .select(sql`
      SELECT t.id, t.user_id, t.title, t.status, t.project_id, t.deleted_at, ${nowIso}
      FROM tasks t
      WHERE t.user_id = ${userId}`)
    .onConflictDoUpdate({
      target: plannerTaskSeen.taskId,
      set: {
        title: sql`excluded.title`,
        status: sql`excluded.status`,
        projectId: sql`excluded.project_id`,
        deletedAt: sql`excluded.deleted_at`,
        lastSeenAt: sql`excluded.last_seen_at`,
      },
      setWhere: sql`excluded.title IS NOT planner_task_seen.title
        OR excluded.status IS NOT planner_task_seen.status
        OR excluded.project_id IS NOT planner_task_seen.project_id
        OR excluded.deleted_at IS NOT planner_task_seen.deleted_at`,
    });

  // A purged project's goal-tree node goes; the self foreign key sets its
  // children's parent to NULL.
  const orphanNodes = db
    .delete(plannerProjectNode)
    .where(
      and(
        eq(plannerProjectNode.userId, userId),
        sql`NOT EXISTS (SELECT 1 FROM projects WHERE projects.id = ${plannerProjectNode.projectId})`,
      ),
    );

  // Same order as plannerSyncBatchSteps.
  return [
    copyActivity,
    updateState,
    restored,
    deleted,
    purged,
    purgePlans,
    purgeSeen,
    created,
    snapshot,
    orphanNodes,
  ];
}

/** Best effort: the sync must never throw, and neither may its failure report. */
async function recordPaused(
  db: FlareMoDb,
  userId: string,
  now: Date,
  reason: string,
): Promise<void> {
  try {
    const lastSyncAt = now.toISOString();
    await db
      .insert(plannerSyncState)
      .values({ userId, lastSyncAt, status: "paused", pausedReason: reason })
      .onConflictDoUpdate({
        target: plannerSyncState.userId,
        set: { lastSyncAt, status: "paused", pausedReason: reason },
      });
  } catch {
    // Nothing left to try. The caller still returns `paused`.
  }
}

function logPaused(reason: string): void {
  console.error(
    JSON.stringify({
      level: "error",
      message: "Planner history sync paused",
      reason,
    }),
  );
}

/**
 * Copies upstream task activity into the permanent archive and records the
 * events upstream does not log. Safe to call on every cockpit open and before
 * every history read.
 *
 * It NEVER throws. Any failure, the compatibility check included, is recorded
 * as `paused` with a reason (best effort) and returned as `paused`. Callers
 * carry on regardless: rollover, the board and history reads still work from
 * what the archive already holds.
 */
export async function plannerSyncHistory(
  db: FlareMoDb,
  input: {
    userId: string;
    now: Date;
    /** Skip the debounce. For the nightly runs around the trash purge. */
    force?: boolean;
  },
): Promise<PlannerSyncResult> {
  const { userId, now, force = false } = input;
  try {
    const nowIso = now.toISOString();

    // 0. Debounce.
    const state = await db
      .select()
      .from(plannerSyncState)
      .where(eq(plannerSyncState.userId, userId))
      .get();
    if (!force && state?.lastSyncAt) {
      const elapsed = now.getTime() - Date.parse(state.lastSyncAt);
      if (elapsed >= 0 && elapsed < plannerSyncDebounceMs) {
        return { history: state.status };
      }
    }

    // 1. Compatibility check: upstream may have changed a column we read.
    const missing = await plannerFindMissingColumns(db);
    if (missing.length > 0) {
      const reason = `upstream columns missing: ${missing.join(", ")}`.slice(
        0,
        400,
      );
      logPaused(reason);
      await recordPaused(db, userId, now, reason);
      return { history: "paused" };
    }
    const warning = await findEnumDrift(db, userId);

    // 2 and 3. Copy activity, update the state, diff the snapshot: one batch,
    // so a failure leaves nothing half-written.
    await plannerRunBatch(
      db,
      buildSyncStatements(db, {
        userId,
        nowIso,
        state: {
          activityLastId: state?.activityLastId ?? null,
          activityWatermark: state?.activityWatermark ?? null,
        },
        warning,
      }),
    );
    return { history: "ok" };
  } catch (error) {
    const reason = plannerDescribeError(error);
    logPaused(reason);
    await recordPaused(db, userId, now, reason);
    return { history: "paused" };
  }
}
