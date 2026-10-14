import type { FlareMoDb } from "@flaremo/db";
import { sql } from "drizzle-orm";
import { plannerSyncHistory } from "./history-sync";

// The nightly half of the history sync (fork-owned add-on). The cockpit syncs
// when it is opened, so a task that is created and deleted while the cockpit
// stays shut would reach upstream's trash purge unseen and leave no trace at
// all: the purge cascades away the task and its activity. The scheduled
// maintenance therefore syncs every user right before the purge (to copy what
// is about to disappear) and right after it (so the snapshot diff records
// `purged`, with the title and project name the snapshot and archive kept).

/**
 * Users the nightly sync covers: anyone with a task (new activity to copy) or a
 * sync state (a snapshot to diff against, after their last task is purged).
 */
async function listSyncUserIds(db: FlareMoDb): Promise<string[]> {
  const rows = await db.all<{ user_id: string }>(
    sql`SELECT user_id FROM tasks UNION SELECT user_id FROM planner_sync_state`,
  );
  return rows.map((row) => row.user_id);
}

/** Whether the permanent archive table exists at all. */
async function plannerArchiveInstalled(db: FlareMoDb): Promise<boolean> {
  const rows = await db.all<{ name: string }>(
    sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'planner_task_event'`,
  );
  return rows.length > 0;
}

/**
 * Syncs every user, skipping the debounce. Never throws and never blocks the
 * caller's work: the per-user sync already swallows its own failures, and a
 * failure to list the users is logged and ignored.
 *
 * `paused` is true when any user's archive copy paused, or the users could not
 * be listed while the archive table exists. The scheduled job then skips the task and project purge that
 * night (fork review finding A01): the purge cascades away `task_activity`, so
 * running it while the copy is paused would delete history the archive never
 * saw. Purging resumes, with nothing lost, on the first night the copy runs.
 */
export async function plannerSyncAllUsers(
  db: FlareMoDb,
  now: Date,
): Promise<{ users: number; paused: boolean }> {
  try {
    // Without the planner's tables there is no archive to protect, and the
    // purge runs exactly as upstream's own (the upstream-compat suite pins it).
    if (!(await plannerArchiveInstalled(db)))
      return { users: 0, paused: false };
    const userIds = await listSyncUserIds(db);
    let paused = false;
    for (const userId of userIds) {
      const result = await plannerSyncHistory(db, { userId, now, force: true });
      if (result.history === "paused") paused = true;
    }
    if (paused) {
      console.error(
        JSON.stringify({
          level: "error",
          message:
            "Planner history paused: the task and project trash purge is skipped tonight",
        }),
      );
    }
    return { users: userIds.length, paused };
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        message:
          "Planner nightly history sync failed: the task and project trash purge is skipped tonight",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return { users: 0, paused: true };
  }
}
