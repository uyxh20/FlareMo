import { healthLocalMoment } from "@flaremo/contracts";
import {
  exportData,
  getFlaremoUserByAuthUserId,
  getOwnerAuthUserId,
} from "@flaremo/domain";
import { getFlareMoDb } from "../context";
import type { FlareMoEnv } from "../env";

// The weekly long-term backup (fork-owned; docs/fork-customizations.md).
//
// D1 Time Travel on the free plan reaches back 7 days. Once a week this saves
// the owner's personal export (the same bundle as Settings > Export, fork
// section included, attachment files left in R2 where they already are) to
// R2 as backups/weekly/<Copenhagen date>.json. Copies are never deleted by the
// app: nothing sweeps the backups/ prefix (the export-task cleanup only removes
// exports/<task id>/).
//
// When it runs: the Sunday cron fires at 10:00 and 11:00 UTC. The general
// agent's prep takes the firing that is noon in Copenhagen; the backup takes
// the other one, so the two never share an invocation's 50 D1 queries (free
// plan) and a failed prep cannot skip the backup. The backup costs about 35
// queries: two to find the owner, twelve upstream selects plus one per 500
// entries for relations, and nineteen fork tables (fork/export.ts).
//
// A copy already saved for that date makes a repeat firing a no-op.

export const FORK_WEEKLY_BACKUP_PREFIX = "backups/weekly/";

export type ForkWeeklyBackup =
  | "prep hour"
  | "exists already"
  | "no owner"
  | { key: string; bytes: number; memos: number; fork_rows: number };

export async function forkWeeklyBackup(
  env: FlareMoEnv,
  scheduledTime: number,
): Promise<ForkWeeklyBackup> {
  const local = healthLocalMoment(new Date(scheduledTime));
  if (local.hour === 12) return "prep hour";
  const key = `${FORK_WEEKLY_BACKUP_PREFIX}${local.day}.json`;
  if (await env.ATTACHMENTS.head(key)) return "exists already";
  const db = getFlareMoDb(env);
  const authUserId = await getOwnerAuthUserId(db);
  const user = authUserId
    ? await getFlaremoUserByAuthUserId(db, authUserId)
    : null;
  if (!user) return "no owner";
  const bundle = await exportData(db, user);
  const body = JSON.stringify(bundle);
  const forkRows = Object.values(bundle.fork.counts).reduce(
    (sum, count) => sum + count,
    0,
  );
  await env.ATTACHMENTS.put(key, body, {
    httpMetadata: { contentType: "application/json" },
    customMetadata: {
      memos: String(bundle.memos.length),
      fork_rows: String(forkRows),
      exported_at: bundle.exported_at ?? "",
    },
  });
  return {
    key,
    bytes: body.length,
    memos: bundle.memos.length,
    fork_rows: forkRows,
  };
}
