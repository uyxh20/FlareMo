import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

// Planning cockpit tables: a fork-owned add-on (docs/planning-cockpit-implementation-plan.md,
// section 3). Read this before changing the file.
//
// - It is NOT exported from the ../schema.ts barrel (G2). drizzle-kit reads the
//   barrel, so exporting these tables would fold them into upstream's journal.
//   Import it by deep path: `@flaremo/db/src/schema/planner`.
// - Never run `pnpm db:generate` for it (G3). This is the fork's one exception
//   to the AGENTS.md rule. The tables are created by the hand-written,
//   unjournaled migrations named migrations/9NNN_planner_*.sql, and this file
//   mirrors them. planner-migrations.test.ts fails when the two drift apart.
// - Never edit an applied 9NNN migration (G12): add the next number, additive
//   only (G13), and update this file to match.
// - No foreign key to an upstream table (G10). Upstream rebuilds tables with
//   `PRAGMA foreign_keys=OFF; ... DROP TABLE tasks`, and inside Wrangler's batch
//   the PRAGMA does nothing, so the drop cascades into every referencing row.
//   Planner rows point at upstream rows by id only and are joined explicitly.
//   Planner-internal keys (planner_project_node's parent) are allowed.
// - No triggers (G11). Every export is prefixed planner/Planner (M8).

// One plan per task: which period it is planned in, how often it carried over,
// and whether it was dropped. A task with no row, or a NULL horizon, is in the
// backlog. `task_id` is upstream tasks.id by value, with no foreign key.
//
// `effort` (migration 9001) is the task's effort estimate, 0 to 999 with at most
// one decimal. It lives here because the row already is the task's planner-side
// record. A backlog task can get a row with a NULL horizon only to hold it, which
// plans nothing: the board reads a NULL horizon as the backlog. `start_date`
// (migration 9002) is the start day, held the same way.
export const plannerTaskPlan = sqliteTable(
  "planner_task_plan",
  {
    taskId: text("task_id").primaryKey(),
    userId: text("user_id").notNull(),
    // day | week | month, or NULL for the backlog. `period_start` is NULL
    // exactly when `horizon` is NULL.
    horizon: text("horizon", { enum: ["day", "week", "month"] }),
    // YYYY-MM-DD, the first day of the period (Monday for weeks).
    periodStart: text("period_start"),
    carryCount: integer("carry_count").notNull().default(0),
    droppedAt: text("dropped_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    // Added by 9001, so it is the last column, where ALTER TABLE puts it.
    effort: real("effort"),
    // Added by 9002: the task's start day, YYYY-MM-DD, or NULL. Together with the
    // due date it is the task's time range on the board.
    startDate: text("start_date"),
    // Added by 9004: the card's manual place in its board column,
    // `<column>|<fractional key>`, or NULL when it was never ranked. Keys compare
    // as plain strings; a key whose column prefix is not the card's column is
    // stale and counts as NULL.
    boardRank: text("board_rank"),
  },
  (table) => [
    index("planner_task_plan_user_period_idx").on(
      table.userId,
      table.horizon,
      table.periodStart,
    ),
  ],
);

// The permanent history archive: a copy of upstream task_activity plus events
// detected by snapshot diff (deleted, restored, purged) and events the planner
// writes itself. It outlives the task, so `task_id` has no foreign key and
// `task_title` is a snapshot taken at copy time.
export const plannerTaskEvent = sqliteTable(
  "planner_task_event",
  {
    // Tie-breaker for equal `occurred_at`; never an identity across rebuilds.
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: text("user_id").notNull(),
    taskId: text("task_id").notNull(),
    taskTitle: text("task_title"),
    // Upstream `action` values as they are for activity events, else one of the
    // sync or planner event types in the plan's "Event types" table.
    type: text("type").notNull(),
    data: text("data", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    source: text("source", { enum: ["activity", "sync", "planner"] }).notNull(),
    // Idempotency key for activity and sync events. NULL for planner events,
    // which are never copied twice.
    sourceRef: text("source_ref"),
    actorType: text("actor_type", { enum: ["user", "agent"] }),
    actorName: text("actor_name"),
    // When it happened (the source timestamp) versus when it was archived.
    occurredAt: text("occurred_at").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    // Partial, so planner events (NULL ref) never collide. Copies use
    // `INSERT ... SELECT ... WHERE true ON CONFLICT DO NOTHING`.
    uniqueIndex("planner_task_event_source_ref_uq")
      .on(table.source, table.sourceRef)
      .where(sql`${table.sourceRef} IS NOT NULL`),
    index("planner_task_event_task_idx").on(table.taskId, table.occurredAt),
    index("planner_task_event_user_idx").on(table.userId, table.occurredAt),
  ],
);

// Snapshot of every task as the last sync saw it. Comparing it with `tasks`
// is how deleted, restored and purged tasks are detected without triggers.
export const plannerTaskSeen = sqliteTable(
  "planner_task_seen",
  {
    taskId: text("task_id").primaryKey(),
    userId: text("user_id").notNull(),
    title: text("title").notNull(),
    status: text("status").notNull(),
    projectId: text("project_id"),
    deletedAt: text("deleted_at"),
    lastSeenAt: text("last_seen_at").notNull(),
  },
  (table) => [index("planner_task_seen_user_idx").on(table.userId)],
);

// Per-user progress of the history sync.
export const plannerSyncState = sqliteTable("planner_sync_state", {
  userId: text("user_id").primaryKey(),
  // Max task_activity.created_at copied so far.
  activityWatermark: text("activity_watermark"),
  // Max task_activity.id seen. May go down after an upstream table rebuild.
  activityLastId: integer("activity_last_id"),
  lastSyncAt: text("last_sync_at"),
  status: text("status", { enum: ["ok", "paused"] })
    .notNull()
    .default("ok"),
  pausedReason: text("paused_reason"),
});

// The goal tree over upstream projects. A project with no row here is a root
// with no level. `project_id` is upstream projects.id by value, with no foreign
// key. The parent link is planner-internal and sets itself to NULL when the
// parent's row goes, so upserts must be ON CONFLICT(project_id) DO UPDATE and
// never INSERT OR REPLACE, which deletes the row and orphans its children.
export const plannerProjectNode = sqliteTable(
  "planner_project_node",
  {
    projectId: text("project_id").primaryKey(),
    userId: text("user_id").notNull(),
    parentProjectId: text("parent_project_id").references(
      (): AnySQLiteColumn => plannerProjectNode.projectId,
      { onDelete: "set null" },
    ),
    // A validated slug (^[a-z][a-z0-9-]{0,23}$) or NULL, so a new level needs
    // no schema change.
    level: text("level"),
    periodStart: text("period_start"),
    periodEnd: text("period_end"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("planner_project_node_user_parent_idx").on(
      table.userId,
      table.parentProjectId,
      table.sortOrder,
    ),
  ],
);

// A task's comment thread (migration 9001). Comments are soft-deleted and kept
// after the task is purged, like the history archive, so `task_id` is upstream
// tasks.id by value with no foreign key. The body never goes into a history
// event: the events `commented`, `comment_edited` and `comment_deleted` carry
// only the comment's id.
export const plannerTaskComment = sqliteTable(
  "planner_task_comment",
  {
    // A random UUID, not namespaced.
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    taskId: text("task_id").notNull(),
    // Trimmed, 1 to 5000 characters.
    body: text("body").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    deletedAt: text("deleted_at"),
  },
  (table) => [
    index("planner_task_comment_task_idx").on(table.taskId, table.createdAt),
  ],
);

export type PlannerTaskPlanRow = typeof plannerTaskPlan.$inferSelect;
export type PlannerTaskEventRow = typeof plannerTaskEvent.$inferSelect;
export type PlannerTaskSeenRow = typeof plannerTaskSeen.$inferSelect;
export type PlannerSyncStateRow = typeof plannerSyncState.$inferSelect;
export type PlannerProjectNodeRow = typeof plannerProjectNode.$inferSelect;
export type PlannerTaskCommentRow = typeof plannerTaskComment.$inferSelect;
