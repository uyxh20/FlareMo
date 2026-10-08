import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { is } from "drizzle-orm";
import {
  getTableConfig,
  SQLiteColumn,
  type SQLiteTable,
} from "drizzle-orm/sqlite-core";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  applyPlannerMigrations,
  plannerMigrationFiles,
} from "./planner-migrations";
import {
  plannerProjectNode,
  plannerSyncState,
  plannerTaskComment,
  plannerTaskEvent,
  plannerTaskPlan,
  plannerTaskSeen,
} from "./schema/planner";
import { applyFlaremoMigrations } from "./test-migrations";

const migrationsDirectory = fileURLToPath(
  new URL("../../../migrations/", import.meta.url),
);

const NOW = "2026-10-05T10:00:00.000Z";

type ExpectedIndex = {
  name: string;
  unique: boolean;
  partial: boolean;
  columns: string[];
};

// What migrations/9000_planner_init.sql, 9001_planner_task_details.sql and
// 9002_planner_start_date.sql must create, written out independently of the Drizzle definitions so the parity
// test below compares two sources.
const EXPECTED_INDEXES: Record<string, ExpectedIndex[]> = {
  planner_task_plan: [
    {
      name: "planner_task_plan_user_period_idx",
      unique: false,
      partial: false,
      columns: ["user_id", "horizon", "period_start"],
    },
  ],
  planner_task_event: [
    {
      name: "planner_task_event_source_ref_uq",
      unique: true,
      partial: true,
      columns: ["source", "source_ref"],
    },
    {
      name: "planner_task_event_task_idx",
      unique: false,
      partial: false,
      columns: ["task_id", "occurred_at"],
    },
    {
      name: "planner_task_event_user_idx",
      unique: false,
      partial: false,
      columns: ["user_id", "occurred_at"],
    },
  ],
  planner_task_seen: [
    {
      name: "planner_task_seen_user_idx",
      unique: false,
      partial: false,
      columns: ["user_id"],
    },
  ],
  planner_sync_state: [],
  planner_project_node: [
    {
      name: "planner_project_node_user_parent_idx",
      unique: false,
      partial: false,
      columns: ["user_id", "parent_project_id", "sort_order"],
    },
  ],
  planner_task_comment: [
    {
      name: "planner_task_comment_task_idx",
      unique: false,
      partial: false,
      columns: ["task_id", "created_at"],
    },
  ],
};

const PLANNER_TABLES = Object.keys(EXPECTED_INDEXES).sort();

const DRIZZLE_TABLES: Record<string, SQLiteTable> = {
  planner_task_plan: plannerTaskPlan,
  planner_task_event: plannerTaskEvent,
  planner_task_seen: plannerTaskSeen,
  planner_sync_state: plannerSyncState,
  planner_project_node: plannerProjectNode,
  planner_task_comment: plannerTaskComment,
};

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

async function run(sql: string, ...params: unknown[]) {
  return database
    .prepare(sql)
    .bind(...params)
    .run();
}

async function count(table: string): Promise<number> {
  const [row] = await rows<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`);
  return row?.n ?? -1;
}

function literal(value: string | null): string {
  return value === null ? "NULL" : `'${value.replaceAll("'", "''")}'`;
}

type EventSeed = {
  taskId?: string;
  type?: string;
  source: string;
  sourceRef: string | null;
};

// The shape history sync uses to copy rows: INSERT ... SELECT ... FROM ...
// WHERE true ON CONFLICT DO NOTHING. The WHERE keeps SQLite from reading
// ON as part of the FROM clause.
function copyEventsSql(seeds: EventSeed[]): string {
  const incoming = seeds
    .map(
      (seed) =>
        `SELECT 'u1' AS user_id, ${literal(seed.taskId ?? "t1")} AS task_id,
                'Title' AS task_title, ${literal(seed.type ?? "updated")} AS type,
                '{}' AS data, ${literal(seed.source)} AS source,
                ${literal(seed.sourceRef)} AS source_ref,
                '${NOW}' AS occurred_at, '${NOW}' AS created_at`,
    )
    .join(" UNION ALL ");
  return `INSERT INTO planner_task_event
            (user_id, task_id, task_title, type, data, source, source_ref, occurred_at, created_at)
          SELECT user_id, task_id, task_title, type, data, source, source_ref, occurred_at, created_at
          FROM (${incoming}) AS incoming
          WHERE true
          ON CONFLICT DO NOTHING`;
}

async function insertNode(
  projectId: string,
  parentProjectId: string | null,
  level: string | null = null,
) {
  await run(
    `INSERT INTO planner_project_node
       (project_id, user_id, parent_project_id, level, sort_order, created_at, updated_at)
     VALUES (?, 'u1', ?, ?, 0, ?, ?)`,
    projectId,
    parentProjectId,
    level,
    NOW,
    NOW,
  );
}

async function parentOf(projectId: string): Promise<string | null | undefined> {
  const [row] = await rows<{ parent_project_id: string | null }>(
    "SELECT parent_project_id FROM planner_project_node WHERE project_id = ?",
    projectId,
  );
  return row?.parent_project_id;
}

describe("planner migrations", () => {
  beforeAll(async () => {
    mf = new Miniflare({
      script: "export default { fetch() { return new Response('ok') } }",
      modules: true,
      compatibilityDate: "2026-07-10",
      compatibilityFlags: ["nodejs_compat"],
      d1Databases: { DB: "flaremo-planner-migrations-test" },
    });
    database = await mf.getD1Database("DB");
    await applyFlaremoMigrations(database);
    await applyPlannerMigrations(database);
  });

  afterAll(async () => {
    await mf.dispose();
  });

  beforeEach(async () => {
    await database.batch(
      PLANNER_TABLES.map((table) => database.prepare(`DELETE FROM ${table}`)),
    );
  });

  describe("schema", () => {
    it("creates the six planner tables and their indexes", async () => {
      const tables = await rows<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'planner%' ORDER BY name",
      );
      expect(tables.map((table) => table.name)).toEqual(PLANNER_TABLES);

      for (const table of PLANNER_TABLES) {
        const list = await rows<{
          name: string;
          unique: number;
          origin: string;
          partial: number;
        }>(`PRAGMA index_list(${table})`);
        // origin "c" is CREATE INDEX; "pk" and "u" are the automatic ones.
        const created = list
          .filter((index) => index.origin === "c")
          .sort((left, right) => left.name.localeCompare(right.name));
        const actual: ExpectedIndex[] = [];
        for (const index of created) {
          const info = await rows<{ seqno: number; name: string }>(
            `PRAGMA index_info(${index.name})`,
          );
          actual.push({
            name: index.name,
            unique: index.unique === 1,
            partial: index.partial === 1,
            columns: info
              .sort((left, right) => left.seqno - right.seqno)
              .map((column) => column.name),
          });
        }
        const expected = [...(EXPECTED_INDEXES[table] ?? [])].sort(
          (left, right) => left.name.localeCompare(right.name),
        );
        expect(actual, table).toEqual(expected);
      }
    });

    it("indexes only the rows that carry a source_ref", async () => {
      const [index] = await rows<{ sql: string }>(
        "SELECT sql FROM sqlite_master WHERE name = 'planner_task_event_source_ref_uq'",
      );
      expect(index?.sql).toMatch(/CREATE UNIQUE INDEX/i);
      expect(index?.sql).toMatch(/WHERE\s+`?source_ref`?\s+IS NOT NULL/i);
    });

    it("has no foreign key to a table outside the planner (G10)", async () => {
      const targets: Record<string, string[]> = {};
      for (const table of PLANNER_TABLES) {
        const keys = await rows<{ table: string }>(
          `PRAGMA foreign_key_list(${table})`,
        );
        targets[table] = keys.map((key) => key.table);
      }
      expect(targets).toEqual({
        planner_project_node: ["planner_project_node"],
        planner_sync_state: [],
        planner_task_comment: [],
        planner_task_event: [],
        planner_task_plan: [],
        planner_task_seen: [],
      });
    });

    it("has no triggers on or named after planner tables (G11)", async () => {
      const triggers = await rows<{ name: string; tbl_name: string }>(
        "SELECT name, tbl_name FROM sqlite_master WHERE type = 'trigger' AND (name LIKE 'planner%' OR tbl_name LIKE 'planner%')",
      );
      expect(triggers).toEqual([]);
    });

    it("is described by the Drizzle definitions in schema/planner.ts", async () => {
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
            primaryKey: column.primary,
            default:
              column.default === undefined
                ? null
                : typeof column.default === "string"
                  ? column.default
                  : JSON.stringify(column.default),
          })),
          `${name} columns`,
        ).toEqual(
          actualColumns.map((column) => ({
            name: column.name,
            // SQLite reports the declared type in upper case.
            type: column.type.toLowerCase(),
            notNull: column.notnull === 1,
            primaryKey: column.pk > 0,
            // 'ok' and '{}' are stored quoted; 0 is not.
            default: column.dflt_value?.replace(/^'(.*)'$/s, "$1") ?? null,
          })),
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
          `${name} indexes`,
        ).toEqual(
          [...(EXPECTED_INDEXES[name] ?? [])].sort((left, right) =>
            left.name.localeCompare(right.name),
          ),
        );

        const actualKeys = await rows<{
          table: string;
          from: string;
          to: string;
          on_delete: string;
        }>(`PRAGMA foreign_key_list(${name})`);
        expect(
          config.foreignKeys.map((key) => {
            const reference = key.reference();
            return {
              table: getTableConfig(reference.foreignTable).name,
              from: reference.columns.map((column) => column.name),
              to: reference.foreignColumns.map((column) => column.name),
              onDelete: key.onDelete,
            };
          }),
          `${name} foreign keys`,
        ).toEqual(
          actualKeys.map((key) => ({
            table: key.table,
            from: [key.from],
            to: [key.to],
            onDelete: key.on_delete.toLowerCase(),
          })),
        );
      }
    });
  });

  describe("planner_task_event idempotency", () => {
    const first = {
      source: "activity",
      sourceRef: "a:t1@2026-10-04|updated|{}",
    };
    const second = {
      source: "activity",
      sourceRef: "a:t1@2026-10-05|updated|{}",
    };

    it("adds nothing when a (source, source_ref) pair is copied again", async () => {
      const inserted = await run(copyEventsSql([first, second]));
      expect(inserted.meta.changes).toBe(2);
      expect(await count("planner_task_event")).toBe(2);

      const again = await run(copyEventsSql([first, second]));
      expect(again.meta.changes).toBe(0);
      expect(await count("planner_task_event")).toBe(2);
    });

    it("keeps one row when a single statement repeats a pair", async () => {
      const result = await run(copyEventsSql([first, first, second, first]));
      expect(result.meta.changes).toBe(2);
      expect(await count("planner_task_event")).toBe(2);
    });

    it("lets the same source_ref sit under a different source", async () => {
      await run(copyEventsSql([first]));
      const result = await run(
        copyEventsSql([{ source: "sync", sourceRef: first.sourceRef }]),
      );
      expect(result.meta.changes).toBe(1);
      expect(await count("planner_task_event")).toBe(2);
    });

    it("never collides on a NULL source_ref", async () => {
      const planned = { source: "planner", sourceRef: null, type: "planned" };
      const result = await run(copyEventsSql([planned, planned]));
      expect(result.meta.changes).toBe(2);
      const again = await run(copyEventsSql([planned]));
      expect(again.meta.changes).toBe(1);
      expect(await count("planner_task_event")).toBe(3);
    });

    it("does not swallow a NOT NULL violation, unlike OR IGNORE", async () => {
      // occurred_at is NULL, which the column forbids.
      const brokenRow = (verb: string, tail: string) =>
        `${verb} INTO planner_task_event
           (user_id, task_id, type, source, source_ref, occurred_at, created_at)
         SELECT 'u1', 't1', 'updated', 'activity', 'a:broken', NULL, '${NOW}'
         WHERE true ${tail}`;

      await expect(
        run(brokenRow("INSERT", "ON CONFLICT DO NOTHING")),
      ).rejects.toThrow(/NOT NULL/i);
      expect(await count("planner_task_event")).toBe(0);

      // OR IGNORE would drop the broken row without a word.
      const ignored = await run(brokenRow("INSERT OR IGNORE", ""));
      expect(ignored.meta.changes).toBe(0);
      expect(await count("planner_task_event")).toBe(0);
    });
  });

  describe("planner_project_node", () => {
    it("sets a child's parent to NULL when the parent row is deleted", async () => {
      await insertNode("goal", null, "goal");
      await insertNode("child-a", "goal");
      await insertNode("child-b", "goal");
      await insertNode("grandchild", "child-a");

      await run("DELETE FROM planner_project_node WHERE project_id = 'goal'");

      expect(await count("planner_project_node")).toBe(3);
      expect(await parentOf("child-a")).toBeNull();
      expect(await parentOf("child-b")).toBeNull();
      expect(await parentOf("grandchild")).toBe("child-a");

      const [key] = await rows<{
        table: string;
        from: string;
        to: string;
        on_delete: string;
      }>("PRAGMA foreign_key_list(planner_project_node)");
      expect(key).toMatchObject({
        table: "planner_project_node",
        from: "parent_project_id",
        to: "project_id",
        on_delete: "SET NULL",
      });
    });

    it("rejects a parent that has no node row yet", async () => {
      await expect(insertNode("child", "missing-parent")).rejects.toThrow(
        /FOREIGN KEY/i,
      );
      expect(await count("planner_project_node")).toBe(0);
    });

    const upsertParent = (verb: string, suffix: string) =>
      run(
        `${verb} INTO planner_project_node
           (project_id, user_id, parent_project_id, level, sort_order, created_at, updated_at)
         VALUES ('goal', 'u1', NULL, 'quarter', 5, '2026-10-06T00:00:00.000Z', '2026-10-06T00:00:00.000Z')
         ${suffix}`,
      );

    it("keeps a parent's children when it is upserted with ON CONFLICT DO UPDATE", async () => {
      await insertNode("goal", null, "goal");
      await insertNode("child-a", "goal");
      await insertNode("child-b", "goal");

      await upsertParent(
        "INSERT",
        `ON CONFLICT(project_id) DO UPDATE SET
           level = excluded.level,
           sort_order = excluded.sort_order,
           updated_at = excluded.updated_at`,
      );

      expect(await parentOf("child-a")).toBe("goal");
      expect(await parentOf("child-b")).toBe("goal");
      const [parent] = await rows<{
        level: string;
        sort_order: number;
        created_at: string;
        updated_at: string;
      }>("SELECT * FROM planner_project_node WHERE project_id = 'goal'");
      expect(parent).toMatchObject({
        level: "quarter",
        sort_order: 5,
        created_at: NOW,
        updated_at: "2026-10-06T00:00:00.000Z",
      });
      expect(await count("planner_project_node")).toBe(3);
    });

    it("would orphan the children under INSERT OR REPLACE, which is why it is banned", async () => {
      await insertNode("goal", null, "goal");
      await insertNode("child-a", "goal");

      await upsertParent("INSERT OR REPLACE", "");

      expect(await parentOf("child-a")).toBeNull();
    });
  });

  describe("9001 task details", () => {
    it("adds a nullable REAL effort column to the plan row, and leaves existing rows NULL", async () => {
      const columns = await rows<{
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
      }>("PRAGMA table_info(planner_task_plan)");
      // 9002 added start_date after it, so effort is no longer the last column.
      expect(columns.find((column) => column.name === "effort")).toMatchObject({
        name: "effort",
        type: "REAL",
        notnull: 0,
        dflt_value: null,
      });

      await run(
        `INSERT INTO planner_task_plan (task_id, user_id, horizon, period_start, created_at, updated_at)
         VALUES ('t1', 'u1', 'week', '2026-10-05', ?, ?)`,
        NOW,
        NOW,
      );
      const [row] = await rows<{ effort: number | null }>(
        "SELECT effort FROM planner_task_plan WHERE task_id = 't1'",
      );
      expect(row?.effort).toBeNull();
    });

    it("keeps a fractional effort as a number, and lets a NULL-horizon row hold one", async () => {
      await run(
        `INSERT INTO planner_task_plan (task_id, user_id, horizon, period_start, effort, created_at, updated_at)
         VALUES ('t1', 'u1', NULL, NULL, 3.5, ?, ?)`,
        NOW,
        NOW,
      );
      const [row] = await rows<{
        effort: number;
        horizon: string | null;
        period_start: string | null;
      }>("SELECT * FROM planner_task_plan WHERE task_id = 't1'");
      expect(row).toMatchObject({
        effort: 3.5,
        horizon: null,
        period_start: null,
      });
    });

    it("creates the comment table with a soft-delete column and no foreign key", async () => {
      const columns = await rows<{
        name: string;
        type: string;
        notnull: number;
        pk: number;
      }>("PRAGMA table_info(planner_task_comment)");
      expect(
        columns.map((column) => ({
          name: column.name,
          type: column.type,
          notNull: column.notnull === 1,
          primaryKey: column.pk > 0,
        })),
      ).toEqual([
        { name: "id", type: "TEXT", notNull: true, primaryKey: true },
        { name: "user_id", type: "TEXT", notNull: true, primaryKey: false },
        { name: "task_id", type: "TEXT", notNull: true, primaryKey: false },
        { name: "body", type: "TEXT", notNull: true, primaryKey: false },
        { name: "created_at", type: "TEXT", notNull: true, primaryKey: false },
        { name: "updated_at", type: "TEXT", notNull: true, primaryKey: false },
        { name: "deleted_at", type: "TEXT", notNull: false, primaryKey: false },
      ]);
    });

    it("keeps a comment whose task does not exist: there is no foreign key to tasks", async () => {
      await run(
        `INSERT INTO planner_task_comment (id, user_id, task_id, body, created_at, updated_at)
         VALUES ('c1', 'u1', 'tasks/purged', 'Still here', ?, ?)`,
        NOW,
        NOW,
      );
      expect(await count("planner_task_comment")).toBe(1);
      const [row] = await rows<{ deleted_at: string | null }>(
        "SELECT deleted_at FROM planner_task_comment WHERE id = 'c1'",
      );
      expect(row?.deleted_at).toBeNull();
    });

    it("rejects a comment without a body", async () => {
      await expect(
        run(
          `INSERT INTO planner_task_comment (id, user_id, task_id, body, created_at, updated_at)
           VALUES ('c1', 'u1', 't1', NULL, ?, ?)`,
          NOW,
          NOW,
        ),
      ).rejects.toThrow(/NOT NULL/i);
    });

    it("applies on top of a database that already has 9000, without touching its rows", async () => {
      // A second database, migrated up to 9000 only: what the dev deployment
      // looks like before this migration is applied.
      const old = new Miniflare({
        script: "export default { fetch() { return new Response('ok') } }",
        modules: true,
        compatibilityDate: "2026-07-10",
        compatibilityFlags: ["nodejs_compat"],
        d1Databases: { DB: "flaremo-planner-migrations-9001" },
      });
      try {
        const oldDatabase = await old.getD1Database("DB");
        await applyFlaremoMigrations(oldDatabase);
        const statementsOf = async (name: string) =>
          (await readFile(`${migrationsDirectory}/${name}`, "utf8"))
            .split("--> statement-breakpoint")
            .map((statement) => statement.trim())
            .filter(Boolean);
        for (const statement of await statementsOf("9000_planner_init.sql")) {
          await oldDatabase.prepare(statement).run();
        }
        await oldDatabase
          .prepare(
            `INSERT INTO planner_task_plan (task_id, user_id, horizon, period_start, carry_count, dropped_at, created_at, updated_at)
             VALUES ('t1', 'u1', 'month', '2026-10-01', 2, NULL, ?, ?)`,
          )
          .bind(NOW, NOW)
          .run();

        for (const statement of await statementsOf(
          "9001_planner_task_details.sql",
        )) {
          await oldDatabase.prepare(statement).run();
        }

        const kept = await oldDatabase
          .prepare("SELECT * FROM planner_task_plan WHERE task_id = 't1'")
          .all<Record<string, unknown>>();
        expect(kept.results).toEqual([
          {
            task_id: "t1",
            user_id: "u1",
            horizon: "month",
            period_start: "2026-10-01",
            carry_count: 2,
            dropped_at: null,
            created_at: NOW,
            updated_at: NOW,
            effort: null,
          },
        ]);
      } finally {
        await old.dispose();
      }
    });
  });

  describe("9002 start date", () => {
    it("adds a nullable TEXT start_date column to the plan row and leaves existing rows NULL", async () => {
      const columns = await rows<{
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
      }>("PRAGMA table_info(planner_task_plan)");
      // 9004 added board_rank after it, so start_date is no longer the last column.
      expect(
        columns.find((column) => column.name === "start_date"),
      ).toMatchObject({
        name: "start_date",
        type: "TEXT",
        notnull: 0,
        dflt_value: null,
      });

      await run(
        `INSERT INTO planner_task_plan (task_id, user_id, horizon, period_start, created_at, updated_at)
         VALUES ('t1', 'u1', 'day', '2026-10-08', ?, ?)`,
        NOW,
        NOW,
      );
      const [row] = await rows<{ start_date: string | null }>(
        "SELECT start_date FROM planner_task_plan WHERE task_id = 't1'",
      );
      expect(row?.start_date).toBeNull();
    });

    it("lets a NULL-horizon row hold a start day, as it holds an effort", async () => {
      await run(
        `INSERT INTO planner_task_plan (task_id, user_id, horizon, period_start, start_date, created_at, updated_at)
         VALUES ('t1', 'u1', NULL, NULL, '2026-10-08', ?, ?)`,
        NOW,
        NOW,
      );
      const [row] = await rows<{
        start_date: string | null;
        horizon: string | null;
      }>(
        "SELECT start_date, horizon FROM planner_task_plan WHERE task_id = 't1'",
      );
      expect(row).toEqual({ start_date: "2026-10-08", horizon: null });
    });
  });

  describe("9004 board rank", () => {
    it("adds a nullable TEXT board_rank column to the plan row, last, and leaves existing rows NULL", async () => {
      const columns = await rows<{
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
      }>("PRAGMA table_info(planner_task_plan)");
      expect(columns.at(-1)).toMatchObject({
        name: "board_rank",
        type: "TEXT",
        notnull: 0,
        dflt_value: null,
      });

      await run(
        `INSERT INTO planner_task_plan (task_id, user_id, horizon, period_start, created_at, updated_at)
         VALUES ('t1', 'u1', 'week', '2026-10-05', ?, ?)`,
        NOW,
        NOW,
      );
      const [row] = await rows<{ board_rank: string | null }>(
        "SELECT board_rank FROM planner_task_plan WHERE task_id = 't1'",
      );
      expect(row?.board_rank).toBeNull();
    });

    it("lets a NULL-horizon row hold a rank, and sorts keys as plain strings", async () => {
      for (const [id, rank] of [
        ["t1", "todo|b"],
        ["t2", "todo|V"],
        ["t3", "todo|a"],
      ] as const) {
        await run(
          `INSERT INTO planner_task_plan (task_id, user_id, horizon, period_start, board_rank, created_at, updated_at)
           VALUES (?, 'u1', NULL, NULL, ?, ?, ?)`,
          id,
          rank,
          NOW,
          NOW,
        );
      }
      const ordered = await rows<{ task_id: string }>(
        "SELECT task_id FROM planner_task_plan WHERE board_rank LIKE 'todo|%' ORDER BY board_rank",
      );
      // Code-unit order, the same as JavaScript's `<`: digits, capitals, lowercase.
      expect(ordered.map((row) => row.task_id)).toEqual(["t2", "t3", "t1"]);
    });
  });

  describe("migration files", () => {
    it("orders planner migration files by number and ignores the rest", () => {
      expect(
        plannerMigrationFiles([
          "0033_large_multiple_man.sql",
          "9010_planner_later.sql",
          "meta",
          "9002_planner_second.sql",
          "9000_planner_init.sql",
          "9001_other_thing.sql",
          "9000_planner_init.sql.bak",
          "0000_planner_lookalike.sql",
          "9003_planner_ok.sql",
        ]),
      ).toEqual([
        "9000_planner_init.sql",
        "9002_planner_second.sql",
        "9003_planner_ok.sql",
        "9010_planner_later.sql",
      ]);
    });

    it("keeps every 9NNN file on the planner track, outside the drizzle journal", async () => {
      const files = (await readdir(migrationsDirectory)).filter((name) =>
        name.startsWith("9"),
      );
      expect(files).toContain("9000_planner_init.sql");
      expect(files).toContain("9001_planner_task_details.sql");
      expect(files).toContain("9002_planner_start_date.sql");
      expect(files).toContain("9004_planner_board_rank.sql");
      // applyPlannerMigrations reads this list, so both reach the test databases.
      expect(plannerMigrationFiles(files)).toEqual(files.sort());

      const journal = JSON.parse(
        await readFile(`${migrationsDirectory}/meta/_journal.json`, "utf8"),
      ) as { entries: Array<{ tag: string }> };
      for (const entry of journal.entries) {
        expect(entry.tag.startsWith("9"), entry.tag).toBe(false);
        const sql = await readFile(
          `${migrationsDirectory}/${entry.tag}.sql`,
          "utf8",
        );
        expect(sql.includes("planner_"), entry.tag).toBe(false);
      }
    });

    it("keeps the planner out of the @flaremo/db barrels (G2)", async () => {
      for (const barrel of ["./schema.ts", "./index.ts"]) {
        const source = await readFile(new URL(barrel, import.meta.url), "utf8");
        expect(source, barrel).not.toMatch(/planner/i);
      }
    });
  });
});
