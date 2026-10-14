import { is } from "drizzle-orm";
import {
  getTableConfig,
  SQLiteColumn,
  type SQLiteTable,
} from "drizzle-orm/sqlite-core";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyPlannerMigrations } from "./planner-migrations";
import {
  healthEntry,
  healthEntryEvent,
  healthSyncState,
  healthTarget,
  healthTracker,
  healthTrackerEvent,
} from "./schema/fork-health";
import { applyFlaremoMigrations } from "./test-migrations";

// migrations/9010_planner_health.sql against schema/fork-health.ts (fork-owned
// health tracker, docs/fork-health-tracker.md): the two are written by hand, so
// this fails when they drift apart. Same checks as planner-migrations.test.ts.

type ExpectedIndex = {
  name: string;
  unique: boolean;
  partial: boolean;
  columns: string[];
};

const EXPECTED_INDEXES: Record<string, ExpectedIndex[]> = {
  health_entry: [
    {
      name: "health_entry_memo_kind_uq",
      unique: true,
      partial: true,
      columns: ["memo_id", "kind"],
    },
    {
      name: "health_entry_user_day_idx",
      unique: false,
      partial: false,
      columns: ["user_id", "day"],
    },
    {
      name: "health_entry_user_memo_idx",
      unique: false,
      partial: false,
      columns: ["user_id", "memo_id"],
    },
  ],
  health_entry_event: [
    {
      name: "health_entry_event_entry_idx",
      unique: false,
      partial: false,
      columns: ["entry_id", "at"],
    },
  ],
  health_target: [],
  health_sync_state: [],
  health_tracker: [
    {
      name: "health_tracker_user_kind_uq",
      unique: true,
      partial: false,
      columns: ["user_id", "kind"],
    },
  ],
  health_tracker_event: [
    {
      name: "health_tracker_event_tracker_idx",
      unique: false,
      partial: false,
      columns: ["tracker_id", "at"],
    },
  ],
};

const DRIZZLE_TABLES: Record<string, SQLiteTable> = {
  health_entry: healthEntry,
  health_entry_event: healthEntryEvent,
  health_target: healthTarget,
  health_sync_state: healthSyncState,
  health_tracker: healthTracker,
  health_tracker_event: healthTrackerEvent,
};

const HEALTH_TABLES = Object.keys(EXPECTED_INDEXES).sort();

let mf: Miniflare;
let database: Awaited<ReturnType<Miniflare["getD1Database"]>>;

async function rows<T = Record<string, unknown>>(
  sql: string,
  ...params: unknown[]
): Promise<T[]> {
  const result = await database
    .prepare(sql)
    .bind(...params)
    .all<T>();
  return result.results;
}

describe("health migration", () => {
  beforeAll(async () => {
    mf = new Miniflare({
      script: "export default { fetch() { return new Response('ok') } }",
      modules: true,
      compatibilityDate: "2026-07-10",
      compatibilityFlags: ["nodejs_compat"],
      d1Databases: { DB: "flaremo-health-migrations-test" },
    });
    database = await mf.getD1Database("DB");
    await applyFlaremoMigrations(database);
    await applyPlannerMigrations(database);
  });

  afterAll(async () => {
    await mf.dispose();
  });

  it("creates the six health tables", async () => {
    const tables = await rows<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'health%' ORDER BY name",
    );
    expect(tables.map((table) => table.name)).toEqual(HEALTH_TABLES);
  });

  it("has no foreign key and no trigger", async () => {
    for (const table of HEALTH_TABLES) {
      expect(
        await rows(`PRAGMA foreign_key_list(${table})`),
        `${table} foreign keys`,
      ).toEqual([]);
    }
    expect(
      await rows(
        "SELECT name FROM sqlite_master WHERE type = 'trigger' AND (name LIKE 'health%' OR tbl_name LIKE 'health%')",
      ),
    ).toEqual([]);
  });

  it("is described by the Drizzle definitions in schema/fork-health.ts", async () => {
    for (const [name, table] of Object.entries(DRIZZLE_TABLES)) {
      const config = getTableConfig(table);
      expect(config.name).toBe(name);

      const actualColumns = await rows<{
        name: string;
        type: string;
        notnull: number;
        pk: number;
        dflt_value: string | null;
      }>(`PRAGMA table_info(${name})`);
      expect(
        config.columns.map((column) => ({
          name: column.name,
          type: column.getSQLType(),
          notNull: column.notNull,
          primaryKey:
            column.primary ||
            config.primaryKeys.some((key) =>
              key.columns.some((part) => part.name === column.name),
            ),
          default:
            column.default === undefined
              ? null
              : typeof column.default === "string"
                ? column.default
                : typeof column.default === "boolean"
                  ? // SQLite stores a boolean default as 0 or 1.
                    column.default
                    ? "1"
                    : "0"
                  : JSON.stringify(column.default),
        })),
        `${name} columns`,
      ).toEqual(
        actualColumns.map((column) => ({
          name: column.name,
          type: column.type.toLowerCase(),
          notNull: column.notnull === 1,
          primaryKey: column.pk > 0,
          default: column.dflt_value?.replace(/^'(.*)'$/s, "$1") ?? null,
        })),
      );

      const list = await rows<{
        name: string;
        unique: number;
        origin: string;
        partial: number;
      }>(`PRAGMA index_list(${name})`);
      const created = list
        .filter((index) => index.origin === "c")
        .sort((left, right) => left.name.localeCompare(right.name));
      const actualIndexes: ExpectedIndex[] = [];
      for (const index of created) {
        const info = await rows<{ seqno: number; name: string }>(
          `PRAGMA index_info(${index.name})`,
        );
        actualIndexes.push({
          name: index.name,
          unique: index.unique === 1,
          partial: index.partial === 1,
          columns: info
            .sort((left, right) => left.seqno - right.seqno)
            .map((column) => column.name),
        });
      }
      expect(actualIndexes, `${name} indexes (database)`).toEqual(
        [...(EXPECTED_INDEXES[name] ?? [])].sort((left, right) =>
          left.name.localeCompare(right.name),
        ),
      );
      expect(
        config.indexes
          .map((index) => ({
            name: index.config.name,
            unique: index.config.unique,
            partial: index.config.where !== undefined,
            columns: index.config.columns.map((column) =>
              is(column, SQLiteColumn) ? column.name : "<expression>",
            ),
          }))
          .sort((left, right) => left.name.localeCompare(right.name)),
        `${name} indexes (Drizzle)`,
      ).toEqual(actualIndexes);
    }
  });

  it("lets a memo yield one row per kind and no more", async () => {
    const insert = (id: string, kind: string, memoId: string | null) =>
      database
        .prepare(
          `INSERT INTO health_entry (id, user_id, kind, day, source, memo_id, created_at, updated_at)
           VALUES (?, 'u1', ?, '2026-10-13', 'memo', ?, 'now', 'now')`,
        )
        .bind(id, kind, memoId)
        .run();
    await insert("a", "training", "memos/m1");
    await insert("b", "breath", "memos/m1");
    await expect(insert("c", "training", "memos/m1")).rejects.toThrow(/UNIQUE/);
    // Manual rows have no memo and may repeat.
    await insert("d", "training", null);
    await insert("e", "training", null);
  });

  it("applies its defaults", async () => {
    await database
      .prepare(
        `INSERT INTO health_entry (id, user_id, kind, day, source, created_at, updated_at)
         VALUES ('x', 'u1', 'night_out', '2026-10-13', 'manual', 'now', 'now')`,
      )
      .run();
    const [row] = await rows<{
      bender: number;
      needs_check: number;
      dismissed: number;
      edited: number;
    }>(
      "SELECT bender, needs_check, dismissed, edited FROM health_entry WHERE id = 'x'",
    );
    expect(row).toEqual({ bender: 0, needs_check: 0, dismissed: 0, edited: 0 });
  });
});
