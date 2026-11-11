/**
 * The authoritative classification of every physical Drizzle table.
 *
 * `RESTORE_TABLES` are the D1 source of truth and must survive a disaster
 * recovery. `REBUILDABLE_TABLES` hold only work derived from that source; the
 * restore file recreates their pending work instead of restoring stale state.
 * Keep this list in dependency order because Wrangler emits one INSERT per
 * line and the recovery drills replay it into a freshly migrated database.
 */
export const RESTORE_TABLES = [
  "users",
  "auth_users",
  "auth_accounts",
  "auth_sessions",
  "auth_apikeys",
  "auth_verifications",
  "auth_user_links",
  "auth_bootstrap",
  "auth_organizations",
  "auth_members",
  "auth_invitations",
  // Device-authorization state is source-of-truth: a restored instance must
  // keep the apps a user connected and the refresh tokens that let them keep
  // acting, exactly like the PAT rows they mint. See
  // docs/agent-access-design.md §4.
  "app_clients",
  "device_authorizations",
  "device_refresh_tokens",
  // Native sync: `sync_changes` is the monotonic cursor every native client
  // stores. Restoring it keeps those cursors contiguous; dropping it would
  // force every client into a full rebuild on the next pull. Its rows are
  // references, so the dump stays small.
  "sync_changes",
  // Registered APNs/FCM tokens are user state like the refresh tokens above:
  // a restored instance should keep waking the same devices.
  "native_push_devices",
  "memos",
  "memos_sse_events",
  "memo_tags",
  "memo_revisions",
  "memo_relations",
  "memo_review_marks",
  "reactions",
  "shortcuts",
  "memos_webhooks",
  "memos_webhook_events",
  "push_subscriptions",
  "memos_webhook_deliveries",
  "memos_notifications",
  "articles",
  "attachments",
  "shares",
  "settings",
  "voice_service_config",
  "integration_config",
  "data_tasks",
  "import_task_rows",
  "member_removal_jobs",
  "usage_counters",
  "projects",
  "tasks",
  "task_activity",
  // Fork-owned planning cockpit tables (migrations/9000_planner_init.sql,
  // 9001_planner_task_details.sql for the comments, and
  // 9005_planner_goals_review.sql for goals and the weekly review). They hold ids
  // of the tasks, projects and memos above with no foreign key, so any order
  // restores; the node table's own parent key is deferred like the rest.
  "planner_task_plan",
  "planner_task_event",
  "planner_task_seen",
  "planner_sync_state",
  "planner_project_node",
  "planner_task_comment",
  "planner_goal",
  "planner_week",
  "planner_review",
  "planner_goal_flag",
  // The month, quarter and year reviews (migrations/9013_planner_period_review.sql).
  "planner_period_review",
  "planner_evidence",
  // The general agent's sessions, its proposals and the Ask chat
  // (migrations/9014_planner_agent.sql).
  "planner_agent_run",
  "planner_agent_proposal",
  "planner_agent_chat",
  // The actions the agent proposed into tasks and the diary
  // (migrations/9015_planner_agent_action.sql).
  "planner_agent_action",
  // Files on tasks: the index rows (migrations/9016_planner_task_attachment.sql).
  // The bytes are in the R2 bucket, outside this backup.
  "planner_task_attachment",
  // The flywheel: the goal and review log, and the owner's tuning of the agent
  // (migrations/9017_planner_flywheel.sql), and the weekly scorecard, which the
  // nightly sweep rebuilds for recent weeks but keeps for older ones.
  "planner_event",
  // The goal change log (migrations/9018_planner_goal_version.sql): the words of
  // a goal before and after every write, append-only.
  "planner_goal_version",
  "planner_metric_week",
  "planner_tuning",
  // The morning page (migrations/9019_planner_morning.sql): every idea line,
  // kept as flywheel data, and the days the page was dismissed.
  "planner_morning_line",
  "planner_morning_day",
  // Fork-owned health tracker tables (migrations/9010_planner_health.sql). Memo
  // ids by value, no foreign keys, so any order restores. The events table is
  // the append-only history and is restored like the rest.
  "health_entry",
  "health_entry_event",
  "health_target",
  "health_sync_state",
  // Trackers the owner edits in the app (migrations/9011_planner_health_trackers.sql).
  "health_tracker",
  "health_tracker_event",
];

// Derived tables that must not be restored verbatim, because a stale copy
// would be indistinguishable from truth and the rebuild is cheap:
//
// - `embedding_tasks` drives the Vectorize index. Do not restore old
//   success/dead rows into an empty replacement index: POST_RESTORE_DERIVED_SQL
//   turns eligible source resources into fresh, durable reindex work instead.
// - `memo_hourly_counts` is a per-author activity aggregate whose own module
//   says `memos` is authoritative and the daily recalibration rebuilds it. The
//   restore clears the rows so the counters are recomputed from restored memos
//   rather than replayed from a dump that may predate the newest writes.
// - `memo_insights` holds AI insight tasks and their results, which the design
//   marks as derived data (docs/agent-access-design.md §9.2): rows are
//   deletable, regenerated by re-running an executor, and deliberately absent
//   from the export bundle. A restored deployment starts with none.
export const REBUILDABLE_TABLES = [
  "embedding_tasks",
  "memo_hourly_counts",
  "memo_insights",
];

export const DERIVED_INDEX_TABLES = ["memos_fts"];

export const ALL_CLASSIFIED_TABLES = [...RESTORE_TABLES, ...REBUILDABLE_TABLES];

export const TABLE_EXPORT_ARGS = RESTORE_TABLES.flatMap((table) => [
  "--table",
  table,
]);

const restoreNow = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

/**
 * Run after source-table inserts. A restored deployment must bind a fresh or
 * explicitly cleared Vectorize index; these rows let the normal outbox rebuild
 * the index without pretending a copied D1 task status proves vectors exist.
 *
 * `memo_hourly_counts` is rebuilt here too, from the restored `memos` rows: the
 * counters are derived, and recomputing them is one grouped INSERT rather than
 * a replay that could disagree with the dumps' memos.
 */
export const POST_RESTORE_DERIVED_SQL = [
  "-- Recreate durable embedding work from D1 source rows; Vectorize is derived.",
  "DELETE FROM `embedding_tasks`;",
  [
    "UPDATE `memos`",
    "SET `embedding_status` = 'pending', `embedding_version` = NULL,",
    "    `embedded_at` = NULL, `embedding_error` = NULL",
    "WHERE `status` IN ('normal', 'archived');",
  ].join(" "),
  [
    "INSERT INTO `embedding_tasks`",
    "(`id`, `user_id`, `resource_type`, `resource_id`, `operation`, `status`,",
    " `attempts`, `next_attempt_at`, `lease_until`, `last_error`, `created_at`, `updated_at`)",
    "SELECT 'restore:memo:' || `id`, `user_id`, 'memo', `id`, 'reindex', 'pending',",
    `       0, ${restoreNow}, NULL, NULL, ${restoreNow}, ${restoreNow}`,
    "FROM `memos` WHERE `status` IN ('normal', 'archived');",
  ].join(" "),
  "-- Rebuild the per-author activity counters from the restored memos.",
  "DELETE FROM `memo_hourly_counts`;",
  [
    "INSERT INTO `memo_hourly_counts`",
    "(`user_id`, `utc_hour`, `normal_count`, `archived_count`, `trashed_count`, `updated_at`)",
    "SELECT `user_id`, substr(`created_at`, 1, 13),",
    "       sum(CASE WHEN `status` = 'normal' THEN 1 ELSE 0 END),",
    "       sum(CASE WHEN `status` = 'archived' THEN 1 ELSE 0 END),",
    "       sum(CASE WHEN `status` = 'trashed' THEN 1 ELSE 0 END),",
    `       ${restoreNow}`,
    "FROM `memos` WHERE `created_at` IS NOT NULL",
    "GROUP BY `user_id`, substr(`created_at`, 1, 13)",
    // Buckets whose counters all landed on zero are tombstones the write path
    // prunes anyway; the domain read path treats a missing row as zero.
    "HAVING sum(CASE WHEN `status` IN ('normal', 'archived', 'trashed') THEN 1 ELSE 0 END) > 0;",
  ].join(" "),
];

/**
 * Tables whose rows are also written by triggers during a restore, so they
 * cannot be replayed alongside the entity tables that feed those triggers.
 *
 * `sync_changes` (migration 0049) has an AFTER INSERT/UPDATE/DELETE trigger on
 * memos, attachments, articles and memo_relations, and the derived-restore SQL
 * below also UPDATES every memo. Replaying the log in the normal order made the
 * drill fail with source=26 restored=67 — the entity replay had already
 * appended 41 fabricated changes with fresh `seq` values. A restored instance
 * would then hand every native client a page of changes pointing at data it
 * already has. These tables are cleared and replayed last, verbatim.
 */
const TABLES_REPLAYED_AFTER_TRIGGERS = ["sync_changes"];

export function buildOrderedDataRestore(dataDump) {
  const dumpLines = dataDump.split("\n");
  const lines = ["PRAGMA defer_foreign_keys=TRUE;"];

  // Migrations seed rows of their own (0020 backfills the default team). A
  // fresh DB is therefore not empty, so clear every source-of-truth table
  // before replaying the dump — the restore stays idempotent and replays the
  // backed-up rows verbatim instead of colliding with migration-seeded ones.
  // FKs are deferred above, so deletion order is safe.
  for (const table of RESTORE_TABLES) {
    lines.push(`DELETE FROM \`${table}\`;`);
  }

  for (const table of RESTORE_TABLES) {
    if (TABLES_REPLAYED_AFTER_TRIGGERS.includes(table)) continue;
    lines.push(
      ...dumpLines.filter(
        (line) =>
          line.startsWith(`INSERT INTO "${table}" `) ||
          line.startsWith(`INSERT INTO \`${table}\` `),
      ),
    );
  }

  lines.push(...POST_RESTORE_DERIVED_SQL);

  // Replay the trigger-fed log last: clear whatever the entity inserts and the
  // derived SQL appended through the 0049 triggers, then restore the backup's
  // own rows. Explicit `seq` values are kept, which also advances the
  // AUTOINCREMENT counter to the backed-up high-water mark.
  for (const table of TABLES_REPLAYED_AFTER_TRIGGERS) {
    lines.push(`DELETE FROM \`${table}\`;`);
    lines.push(
      ...dumpLines.filter(
        (line) =>
          line.startsWith(`INSERT INTO "${table}" `) ||
          line.startsWith(`INSERT INTO \`${table}\` `),
      ),
    );
  }

  return `${lines.join("\n")}\n`;
}

export function buildPersistenceCountsQuery() {
  const counts = [...RESTORE_TABLES, ...DERIVED_INDEX_TABLES].map(
    (table) => `(SELECT COUNT(*) FROM \`${table}\`) AS \`${table}\``,
  );
  return `SELECT ${counts.join(", ")};`;
}

export function assertDerivedIndexesComplete(counts) {
  for (const [source, index] of [["memos", "memos_fts"]]) {
    if (Number(counts[source]) !== Number(counts[index])) {
      throw new Error(
        `Derived FTS index is incomplete: ${index}=${counts[index]} ${source}=${counts[source]}`,
      );
    }
  }
}
