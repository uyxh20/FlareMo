// The Schizo Diary part of the personal export (fork-owned;
// docs/fork-customizations.md, docs/fork-data-sources.md).
//
// Upstream's export (import-export/export-data.ts, the small inline bundle, and
// data-tasks.ts streamExportData, the large chunked export) only knows upstream
// tables. Each calls forkExportSection once, through a one-line hook-in, so the
// goals, reviews, task history, agent and health tables travel in the same file
// under the key `fork`.
//
// - Rows go out as stored, one array per table, only the owner's rows. Nothing
//   is summarised or dropped: this is a backup, not a report.
// - Import ignores the `fork` key (importBundleSchema is a plain z.object), so an
//   export with it still imports into upstream or an older fork. A full restore
//   of the fork tables comes from the D1 backup.
// - Which tables are here is decided in data-sources.ts (userExport: yes for a
//   fork table); export.test.ts fails when this list and the registry disagree.
// - One query per table: 19 queries. The weekly backup runs the whole export in
//   one cron invocation, which the free plan caps at 50 D1 queries.

import type { FlareMoDb, UserRow } from "@flaremo/db";
import {
  healthEntry,
  healthEntryEvent,
} from "@flaremo/db/src/schema/fork-health";
import {
  plannerAgentAction,
  plannerAgentChat,
  plannerAgentProposal,
  plannerEvent,
  plannerEvidence,
  plannerGoal,
  plannerGoalFlag,
  plannerGoalVersion,
  plannerMetricWeek,
  plannerPeriodReview,
  plannerProjectNode,
  plannerReview,
  plannerTaskAttachment,
  plannerTaskComment,
  plannerTaskEvent,
  plannerTaskPlan,
  plannerTuning,
  plannerWeek,
} from "@flaremo/db/src/schema/planner";
import { eq } from "drizzle-orm";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";

/** Bumped only when the shape of the section changes, not when a table is added. */
export const FORK_EXPORT_FORMAT = 1;

type OwnedTable = SQLiteTable & { userId: SQLiteColumn };

/** Every fork table in the export, by its database name. */
export const FORK_EXPORT_TABLES = {
  planner_task_plan: plannerTaskPlan,
  planner_task_event: plannerTaskEvent,
  planner_task_comment: plannerTaskComment,
  planner_task_attachment: plannerTaskAttachment,
  planner_project_node: plannerProjectNode,
  planner_goal: plannerGoal,
  planner_week: plannerWeek,
  planner_review: plannerReview,
  planner_goal_flag: plannerGoalFlag,
  planner_period_review: plannerPeriodReview,
  planner_evidence: plannerEvidence,
  planner_agent_proposal: plannerAgentProposal,
  planner_agent_chat: plannerAgentChat,
  planner_agent_action: plannerAgentAction,
  planner_event: plannerEvent,
  planner_goal_version: plannerGoalVersion,
  planner_metric_week: plannerMetricWeek,
  planner_tuning: plannerTuning,
  health_entry: healthEntry,
  health_entry_event: healthEntryEvent,
} satisfies Record<string, OwnedTable>;

export type ForkExportTable = keyof typeof FORK_EXPORT_TABLES;

export type ForkExportSection = {
  format_version: number;
  /** Row counts per table, so a reader can check the file without parsing rows. */
  counts: Record<ForkExportTable, number>;
  /** Tables the database does not have (fork migrations not applied); absent when none. */
  missing_tables?: ForkExportTable[];
  tables: Record<ForkExportTable, Array<Record<string, unknown>>>;
};

/** The owner's rows of every fork table in the export. */
export async function forkExportSection(
  db: FlareMoDb,
  user: Pick<UserRow, "id">,
): Promise<ForkExportSection> {
  const tables = {} as ForkExportSection["tables"];
  const counts = {} as ForkExportSection["counts"];
  const missing: ForkExportTable[] = [];
  for (const [name, table] of Object.entries(FORK_EXPORT_TABLES) as Array<
    [ForkExportTable, OwnedTable]
  >) {
    // Sequential on purpose: D1 runs one query at a time per connection anyway,
    // and this keeps a failure pointing at the table it came from.
    let rows: Array<Record<string, unknown>> = [];
    try {
      rows = (await db
        .select()
        .from(table)
        .where(eq(table.userId, user.id))
        .all()) as Array<Record<string, unknown>>;
    } catch (error) {
      // A database without the fork migrations (upstream's own tests, a fresh
      // install) still exports the diary; the table is named as missing.
      if (!isMissingTable(error)) throw error;
      missing.push(name);
    }
    tables[name] = rows;
    counts[name] = rows.length;
  }
  return {
    format_version: FORK_EXPORT_FORMAT,
    counts,
    ...(missing.length > 0 ? { missing_tables: missing } : {}),
    tables,
  };
}

function isMissingTable(error: unknown): boolean {
  for (let e = error; e instanceof Error; e = e.cause) {
    if (/no such table/i.test(e.message)) return true;
  }
  return false;
}

/** The section as one NDJSON line, for the chunked export (streamExportData). */
export async function forkExportChunk(
  db: FlareMoDb,
  user: Pick<UserRow, "id">,
): Promise<{ kind: "fork"; records: string }> {
  return {
    kind: "fork",
    records: JSON.stringify(await forkExportSection(db, user)),
  };
}
