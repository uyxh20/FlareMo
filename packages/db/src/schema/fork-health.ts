import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

// Health tracker tables: a fork-owned add-on (docs/fork-health-tracker.md). The
// same rules as schema/planner.ts apply, read them there:
//
// - NOT exported from the ../schema.ts barrel: drizzle-kit reads the barrel, so
//   exporting these tables would fold them into upstream's journal. Import by
//   deep path: `@flaremo/db/src/schema/fork-health`.
// - Never run `pnpm db:generate` for it. The tables are created by the
//   hand-written, unjournaled migrations/9010_planner_health.sql, and this file
//   mirrors it. planner-migrations.test.ts fails when the two drift apart.
// - Never edit an applied 9NNN migration: add the next number, additive only,
//   and update this file to match.
// - No foreign key to an upstream table, no triggers. Every export is prefixed
//   health/Health.

// One session or night, read from the diary (or fixed by hand). `memo_id` is
// memos.id by value. Never hard-deleted: `deleted_at` is a soft delete, and
// `dismissed` records that the owner removed the label, which a re-read of the
// diary must not undo. `edited` marks values the owner set, which it keeps.
export const healthEntry = sqliteTable(
  "health_entry",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    // training | breath | night_out, or `t:<tracker id>` for a tracker the
    // owner made in the app (health_tracker, migrations/9011).
    kind: text("kind")
      .$type<"training" | "breath" | "night_out" | `t:${string}`>()
      .notNull(),
    // YYYY-MM-DD, the local day (the evening a night out started).
    day: text("day").notNull(),
    variant: text("variant"),
    minutes: integer("minutes"),
    // HH:MM, night_out only.
    homeAt: text("home_at"),
    // 0, 0.5 or 1; NULL while a night waits for its home time.
    units: real("units"),
    bender: integer("bender", { mode: "boolean" }).notNull().default(false),
    needsCheck: integer("needs_check", { mode: "boolean" })
      .notNull()
      .default(false),
    feel: text("feel"),
    source: text("source", { enum: ["memo", "manual", "import"] }).notNull(),
    memoId: text("memo_id"),
    dismissed: integer("dismissed", { mode: "boolean" })
      .notNull()
      .default(false),
    edited: integer("edited", { mode: "boolean" }).notNull().default(false),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    deletedAt: text("deleted_at"),
  },
  (table) => [
    index("health_entry_user_day_idx").on(table.userId, table.day),
    index("health_entry_user_memo_idx").on(table.userId, table.memoId),
    // A memo yields at most one row per kind.
    uniqueIndex("health_entry_memo_kind_uq")
      .on(table.memoId, table.kind)
      .where(sql`${table.memoId} IS NOT NULL`),
  ],
);

export type HealthEntryRow = typeof healthEntry.$inferSelect;

// Append-only history of every write to health_entry, in the same batch as the
// write. Never deleted.
export const healthEntryEvent = sqliteTable(
  "health_entry_event",
  {
    id: text("id").primaryKey(),
    entryId: text("entry_id").notNull(),
    userId: text("user_id").notNull(),
    action: text("action", {
      enum: ["create", "update", "dismiss", "delete", "restore"],
    }).notNull(),
    beforeJson: text("before_json"),
    afterJson: text("after_json"),
    at: text("at").notNull(),
  },
  (table) => [
    index("health_entry_event_entry_idx").on(table.entryId, table.at),
  ],
);

// The owner's targets; a missing row means the default.
export const healthTarget = sqliteTable(
  "health_target",
  {
    userId: text("user_id").notNull(),
    kind: text("kind", { enum: ["training", "breath", "night_out"] }).notNull(),
    period: text("period", { enum: ["week", "year"] }).notNull(),
    amount: real("amount").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.kind, table.period] }),
  ],
);

// A user with a row here has had the diary read once; the first call to the
// health API reads everything for a user without one.
export const healthSyncState = sqliteTable("health_sync_state", {
  userId: text("user_id").primaryKey(),
  scannedAt: text("scanned_at").notNull(),
  memoCount: integer("memo_count").notNull().default(0),
});

// A tracker the owner edits in the app (migrations/9011_planner_health_trackers.sql).
// A new habit gets its own row (kind `t:<id>`); a built-in kind gets one once
// the owner adds words to it. Words and blocked words are JSON arrays of lower-case
// words or phrases, a leading # making a tag. Never hard-deleted: `archived_at`
// hides it. `goal_id` is planner_goal.id by value.
export const healthTracker = sqliteTable(
  "health_tracker",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    // t:<id> for the owner's own tracker, or the built-in kind.
    kind: text("kind")
      .$type<"training" | "breath" | "night_out" | `t:${string}`>()
      .notNull(),
    label: text("label").notNull(),
    color: text("color").notNull(),
    measure: text("measure", { enum: ["days", "minutes", "hours"] })
      .notNull()
      .default("days"),
    wordsJson: text("words_json").notNull().default("[]"),
    blockedJson: text("blocked_json").notNull().default("[]"),
    goalId: text("goal_id"),
    builtin: integer("builtin", { mode: "boolean" }).notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
    archivedAt: text("archived_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("health_tracker_user_kind_uq").on(table.userId, table.kind),
  ],
);

export type HealthTrackerRow = typeof healthTracker.$inferSelect;

// Append-only history of every save of a tracker. Never deleted.
export const healthTrackerEvent = sqliteTable(
  "health_tracker_event",
  {
    id: text("id").primaryKey(),
    trackerId: text("tracker_id").notNull(),
    userId: text("user_id").notNull(),
    action: text("action", {
      enum: ["create", "update", "archive", "restore"],
    }).notNull(),
    beforeJson: text("before_json"),
    afterJson: text("after_json"),
    at: text("at").notNull(),
  },
  (table) => [
    index("health_tracker_event_tracker_idx").on(table.trackerId, table.at),
  ],
);
