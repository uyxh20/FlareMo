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

/**
 * Syncs every user, skipping the debounce. Never throws and never blocks the
 * caller's work: the per-user sync already swallows its own failures, and a
 * failure to list the users is logged and ignored.
 */
export async function plannerSyncAllUsers(
  db: FlareMoDb,
  now: Date,
): Promise<{ users: number }> {
  try {
    const userIds = await listSyncUserIds(db);
    for (const userId of userIds) {
      await plannerSyncHistory(db, { userId, now, force: true });
    }
    return { users: userIds.length };
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        message: "Planner nightly history sync failed",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return { users: 0 };
  }
}
