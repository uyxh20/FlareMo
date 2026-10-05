import type { FlareMoDb, UserRow } from "@flaremo/db";
import { applyFlaremoMigrations, createDb } from "@flaremo/db";
import { applyPlannerMigrations } from "@flaremo/db/src/planner-migrations";
import { Miniflare } from "miniflare";
import { createFlaremoMember, ensureSingleUser } from "../users";
import type { PlannerBatchResult } from "./shared";

// Vitest-only helpers for the planner suites (fork-owned add-on). Not exported
// from the planner barrel: importing miniflare must never reach the Worker.
//
// One Miniflare per test file, tables emptied between tests. The domain tests
// cannot use apps/worker's createTestRuntime, so this mirrors the pattern in
// packages/domain/src/projects.test.ts and adds the planner migrations.

export type PlannerTestDatabase = Awaited<
  ReturnType<Miniflare["getD1Database"]>
>;

export type PlannerTestRuntime = {
  mf: Miniflare;
  /** The raw D1 binding, for statements and assertions outside Drizzle. */
  database: PlannerTestDatabase;
  db: FlareMoDb;
  /** The bootstrap owner. */
  user: UserRow;
  /** A second member, for the isolation assertions. */
  other: UserRow;
  /** Empties every task and planner table; users stay. */
  reset(): Promise<void>;
  dispose(): Promise<void>;
};

// Children before parents: task_activity references tasks, tasks reference
// projects.
const RESET_TABLES = [
  "planner_task_event",
  "planner_task_plan",
  "planner_task_seen",
  "planner_sync_state",
  "planner_project_node",
  "task_activity",
  "tasks",
  "projects",
] as const;

export async function plannerTestRuntime(
  name = "flaremo-planner-test",
): Promise<PlannerTestRuntime> {
  const mf = new Miniflare({
    script: "export default { fetch() { return new Response('ok') } }",
    modules: true,
    compatibilityDate: "2026-07-10",
    compatibilityFlags: ["nodejs_compat"],
    d1Databases: { DB: name },
  });
  const database = await mf.getD1Database("DB");
  const db = createDb(database);
  await applyFlaremoMigrations(database);
  await applyPlannerMigrations(database);
  const user = await ensureSingleUser(db, {
    email: "owner@example.com",
    name: "Owner",
  });
  const other = await createFlaremoMember(db, {
    email: "other@example.com",
    name: "Other",
  });
  return {
    mf,
    database,
    db,
    user,
    other,
    async reset() {
      await database.batch(
        RESET_TABLES.map((table) => database.prepare(`DELETE FROM ${table}`)),
      );
    },
    async dispose() {
      await mf.dispose();
    },
  };
}

/** Rows of any SELECT, through the raw D1 binding. */
export async function plannerTestRows<T = Record<string, unknown>>(
  database: PlannerTestDatabase,
  sql: string,
  ...params: unknown[]
): Promise<T[]> {
  const result = await database
    .prepare(sql)
    .bind(...params)
    .all<T>();
  return result.results;
}

/** Runs any statement through the raw D1 binding. */
export async function plannerTestRun(
  database: PlannerTestDatabase,
  sql: string,
  ...params: unknown[]
) {
  return database
    .prepare(sql)
    .bind(...params)
    .run();
}

export type PlannerTestEvent = {
  id: number;
  user_id: string;
  task_id: string;
  task_title: string | null;
  type: string;
  data: string;
  source: string;
  source_ref: string | null;
  actor_type: string | null;
  actor_name: string | null;
  occurred_at: string;
  created_at: string;
};

/** The archive, oldest archived first, optionally for one task. */
export async function plannerTestEvents(
  database: PlannerTestDatabase,
  taskId?: string,
): Promise<PlannerTestEvent[]> {
  return taskId
    ? plannerTestRows<PlannerTestEvent>(
        database,
        "SELECT * FROM planner_task_event WHERE task_id = ? ORDER BY id",
        taskId,
      )
    : plannerTestRows<PlannerTestEvent>(
        database,
        "SELECT * FROM planner_task_event ORDER BY id",
      );
}

/** Event types for one task, in archive order. */
export async function plannerTestTypes(
  database: PlannerTestDatabase,
  taskId: string,
): Promise<string[]> {
  return (await plannerTestEvents(database, taskId)).map((row) => row.type);
}

export async function plannerTestCount(
  database: PlannerTestDatabase,
  table: string,
): Promise<number> {
  const [row] = await plannerTestRows<{ n: number }>(
    database,
    `SELECT COUNT(*) AS n FROM ${table}`,
  );
  return row?.n ?? -1;
}

/**
 * Inserts a task row exactly as given, bypassing the upstream services, for
 * tests that need a back-dated or odd row. Returns the id.
 */
export async function plannerTestInsertTask(
  database: PlannerTestDatabase,
  task: {
    id: string;
    userId: string;
    title?: string;
    status?: string;
    priority?: string;
    dueAt?: string | null;
    projectId?: string | null;
    completedAt?: string | null;
    deletedAt?: string | null;
    createdAt?: string;
    sortOrder?: number;
  },
): Promise<string> {
  const createdAt = task.createdAt ?? "2026-01-01T00:00:00.000Z";
  await plannerTestRun(
    database,
    `INSERT INTO tasks (id, user_id, project_id, title, status, priority, due_at, sort_order, completed_at, deleted_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    task.id,
    task.userId,
    task.projectId ?? null,
    task.title ?? "Task",
    task.status ?? "todo",
    task.priority ?? "none",
    task.dueAt ?? null,
    task.sortOrder ?? 0,
    task.completedAt ?? null,
    task.deletedAt ?? null,
    createdAt,
    createdAt,
  );
  return task.id;
}

/** Inserts a `task_activity` row exactly as given. */
export async function plannerTestInsertActivity(
  database: PlannerTestDatabase,
  row: {
    id?: number;
    taskId: string | null;
    userId: string;
    actorType?: string;
    actorName?: string | null;
    action: string;
    changes?: Record<string, unknown>;
    createdAt: string;
  },
): Promise<void> {
  await plannerTestRun(
    database,
    `INSERT INTO task_activity (id, task_id, user_id, actor_type, actor_name, action, changes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    row.id ?? null,
    row.taskId,
    row.userId,
    row.actorType ?? "user",
    row.actorName ?? null,
    row.action,
    JSON.stringify(row.changes ?? {}),
    row.createdAt,
  );
}

/** Inserts an archive row exactly as given. */
export async function plannerTestInsertEvent(
  database: PlannerTestDatabase,
  event: {
    userId: string;
    taskId: string;
    type?: string;
    occurredAt: string;
    taskTitle?: string | null;
    source?: "activity" | "sync" | "planner";
    sourceRef?: string | null;
    data?: Record<string, unknown>;
    actorType?: "user" | "agent" | null;
    actorName?: string | null;
  },
): Promise<void> {
  await plannerTestRun(
    database,
    `INSERT INTO planner_task_event (user_id, task_id, task_title, type, data, source, source_ref, actor_type, actor_name, occurred_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    event.userId,
    event.taskId,
    event.taskTitle ?? null,
    event.type ?? "updated",
    JSON.stringify(event.data ?? {}),
    event.source ?? "planner",
    event.sourceRef ?? null,
    event.actorType ?? null,
    event.actorName ?? null,
    event.occurredAt,
    event.occurredAt,
  );
}

type BatchCall = PlannerBatchResult[];

/**
 * Wraps `db` so every `db.batch(...)` also records its results. A sync is one
 * batch; the recorded results carry `meta.changes` per statement, in the order
 * of `plannerSyncBatchSteps`. Everything else passes straight through.
 */
export function plannerTestSpyOnBatch(db: FlareMoDb): {
  db: FlareMoDb;
  batches: BatchCall[];
} {
  const batches: BatchCall[] = [];
  const spy = new Proxy(db, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property === "batch") {
        return async (statements: unknown) => {
          const results = await (
            value as (statements: unknown) => Promise<unknown>
          ).call(target, statements);
          batches.push(results as BatchCall);
          return results;
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db: spy, batches };
}

/** The SQL text of a Drizzle statement builder, for failure injection. */
function statementSql(statement: unknown): string {
  const builder = statement as { toSQL?: () => { sql: string } };
  return builder.toSQL?.().sql ?? "";
}

/**
 * Wraps `db` so a `db.batch(...)` whose statements match `shouldFail` throws a
 * D1-style error instead of running. Other batches, and every non-batch call,
 * pass through, so one batch can fail while the rest of the system works.
 */
export function plannerTestFailBatch(
  db: FlareMoDb,
  shouldFail: (sqlTexts: string[]) => boolean,
): FlareMoDb {
  return new Proxy(db, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property === "batch") {
        return async (statements: unknown) => {
          const texts = (statements as unknown[]).map(statementSql);
          if (shouldFail(texts)) {
            throw new Error("D1_ERROR: injected failure: SQLITE_BUSY");
          }
          return (value as (statements: unknown) => Promise<unknown>).call(
            target,
            statements,
          );
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** `base` plus whole minutes, so successive syncs clear the 30 second debounce. */
export function plannerTestAt(base: Date, minutes: number): Date {
  return new Date(base.getTime() + minutes * 60_000);
}
