import type { FlareMoDb, UserRow } from "@flaremo/db";
import { createDb } from "@flaremo/db";
import { applyPlannerMigrations } from "@flaremo/db/src/planner-migrations";
import { ensureSingleUser, getFlaremoUserById } from "@flaremo/domain";
import {
  plannerDropTask,
  plannerReadBoard,
  plannerReadRollup,
  plannerReadTaskHistory,
  plannerReadTree,
  plannerRollover,
  plannerSetPlan,
  plannerSyncHistory,
  plannerUpsertProjectNode,
} from "@flaremo/domain/src/planner";
import type { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runScheduledMaintenance } from "../index";
import { createAppTestHarness, json } from "../test-support/app";
import { createTestRuntime, fetchWorker } from "../test-support/runtime";
import { bootstrapAndSignIn } from "../test-support/sign-in";

// Upstream-flows compatibility suite for the planning cockpit (fork-owned
// add-on, docs/planning-cockpit-implementation-plan.md, sections 6 and 10).
//
// The planner promises not to change how upstream's tasks, projects, reminders,
// imports and member removal behave: no triggers, no foreign keys to upstream
// tables, task rows written only through upstream's services. This suite drives
// those flows through the real routes and cron entry points with the planner
// tables installed, pins down what upstream does, and checks that the history
// sync then archives the right events.
//
// It uses the worker's own test runtime and harness unchanged. The planner
// migrations are applied here, in this file, on top of upstream's.

const SCHEDULED_AT = Date.parse("2026-09-15T03:00:00.000Z");
// The sync clock only drives the 30 second debounce, so whole minutes apart
// clear it each time.
const T0 = Date.parse("2026-10-05T10:00:00.000Z");
const at = (minutes: number) => new Date(T0 + minutes * 60_000);

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const STAMP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;

type TaskBody = {
  id: string;
  project_id: string | null;
  source_memo_id: string | null;
  title: string;
  notes: string | null;
  status: string;
  priority: string;
  due_at: string | null;
  sort_order: number;
  completed_at: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
};

type Context = {
  runtime: Miniflare;
  d1: D1Database;
  env: Env;
  cookie: string;
};

describe("planner and upstream flows", () => {
  let ctx: Context;
  let db: FlareMoDb;
  let owner: UserRow;

  // Resolved lazily so a test can swap `ctx` for a second runtime.
  const harness = createAppTestHarness(() => ({
    env: ctx.env,
    sessionCookie: ctx.cookie,
  }));

  /** A fresh database and session, with or without the planner on top. */
  async function boot(options: { planner: boolean }): Promise<Context> {
    const {
      runtime,
      db: d1,
      env,
    } = await createTestRuntime({
      name: "flaremo-planner-compat",
      env: { FLAREMO_EMBEDDING_PROVIDER: "none" },
    });
    // Upstream's migrations ran inside the runtime; the planner's run here.
    if (options.planner) await applyPlannerMigrations(d1);
    return { runtime, d1, env, cookie: await bootstrapAndSignIn(env) };
  }

  beforeEach(async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    ctx = await boot({ planner: true });
    db = createDb(ctx.d1);
    owner = await ensureSingleUser(db, {
      email: "owner@example.com",
      name: "Owner",
    });
  });

  afterEach(async () => {
    await ctx.runtime.dispose();
    vi.restoreAllMocks();
  });

  // --- requests ------------------------------------------------------------

  const { fetchApp } = harness;
  const url = (path: string) => `http://flaremo.test${path}`;
  const send = (method: string, path: string, body?: unknown) =>
    fetchApp(url(path), {
      method,
      ...(body === undefined
        ? {}
        : {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
    });

  const bare = (id: string) => id.replace(/^(tasks|projects)\//, "");

  async function createProject(name: string) {
    const response = await send("POST", "/api/app/projects", { name });
    expect(response.status).toBe(201);
    return (await response.json<{ project: { id: string } }>()).project.id;
  }

  async function createTask(
    title: string,
    extra: Record<string, unknown> = {},
  ) {
    const response = await send("POST", "/api/app/tasks", { title, ...extra });
    expect(response.status).toBe(201);
    return (await response.json<{ task: TaskBody }>()).task;
  }

  async function patchTask(id: string, body: Record<string, unknown>) {
    const response = await send("PATCH", `/api/app/tasks/${bare(id)}`, body);
    expect(response.status).toBe(200);
    return (await response.json<{ task: TaskBody }>()).task;
  }

  // --- database ------------------------------------------------------------

  async function rows<T = Record<string, unknown>>(
    sql: string,
    ...params: unknown[]
  ): Promise<T[]> {
    return (
      await ctx.d1
        .prepare(sql)
        .bind(...params)
        .all<T>()
    ).results;
  }

  const run = (sql: string, ...params: unknown[]) =>
    ctx.d1
      .prepare(sql)
      .bind(...params)
      .run();

  const count = async (table: string) =>
    (await rows<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`))[0]?.n ??
    -1;

  /** Everything upstream owns that these flows touch, in a stable order. */
  const upstreamTables = async () => ({
    tasks: await rows("SELECT * FROM tasks ORDER BY title, id"),
    projects: await rows("SELECT * FROM projects ORDER BY name, id"),
    task_activity: await rows("SELECT * FROM task_activity ORDER BY id"),
  });

  // --- the archive -----------------------------------------------------------

  const sync = (minutes: number, userId = owner.id) =>
    plannerSyncHistory(db, { userId, now: at(minutes) });

  type ArchiveRow = {
    type: string;
    source: string;
    source_ref: string | null;
    actor_type: string | null;
    task_title: string | null;
    occurred_at: string;
    data: string;
  };

  const archive = (taskId: string, userId = owner.id) =>
    rows<ArchiveRow>(
      "SELECT type, source, source_ref, actor_type, task_title, occurred_at, data FROM planner_task_event WHERE task_id = ? AND user_id = ? ORDER BY id",
      taskId,
      userId,
    );

  const archiveTypes = async (taskId: string, userId = owner.id) =>
    (await archive(taskId, userId)).map((event) => event.type);

  // --- the flows -------------------------------------------------------------

  describe("task routes", () => {
    it("create, update, a no-op update, status changes, delete, restore and reorder behave as before", async () => {
      const projectId = await createProject("Plan");

      // Create.
      const a = await createTask("A", { project_id: projectId });
      const b = await createTask("B", { project_id: projectId });
      const c = await createTask("C", { project_id: projectId });
      expect(a).toMatchObject({
        project_id: projectId,
        source_memo_id: null,
        title: "A",
        notes: null,
        status: "todo",
        priority: "none",
        due_at: null,
        sort_order: 0,
        completed_at: null,
        deleted_at: null,
      });
      await sync(0);

      // Update, then an update that changes nothing real.
      const renamed = await patchTask(a.id, {
        title: "A renamed",
        due_at: "2026-10-09",
        priority: "high",
        notes: "details",
      });
      expect(renamed).toMatchObject({
        title: "A renamed",
        due_at: "2026-10-09",
        priority: "high",
        notes: "details",
      });
      const same = await patchTask(a.id, { title: "A renamed" });
      expect(same.title).toBe("A renamed");
      // An empty update is still a validation error.
      expect(
        (await send("PATCH", `/api/app/tasks/${bare(a.id)}`, {})).status,
      ).toBe(400);

      // Status changes keep completed_at in step.
      const done = await patchTask(a.id, { status: "done" });
      expect(done.status).toBe("done");
      expect(done.completed_at).not.toBeNull();
      const reopened = await patchTask(a.id, { status: "todo" });
      expect(reopened.completed_at).toBeNull();

      // Delete: gone from live reads, in the bin, restorable.
      expect(
        (await send("DELETE", `/api/app/tasks/${bare(b.id)}`)).status,
      ).toBe(200);
      expect((await send("GET", `/api/app/tasks/${bare(b.id)}`)).status).toBe(
        404,
      );
      const binned = await json<{
        tasks: Array<{ id: string; deleted_at: string }>;
      }>(await send("GET", "/api/app/tasks?include_deleted=1&page_size=100"));
      const binnedB = binned.tasks.find((task) => task.id === b.id);
      expect(binnedB?.deleted_at).toBeTruthy();
      await sync(1);
      const restored = await json<{ task: TaskBody }>(
        await send("POST", `/api/app/tasks/${bare(b.id)}/restore`),
      );
      expect(restored.task.deleted_at).toBeNull();
      await sync(2);

      // Reorder is project-scoped: its activity row has no task.
      const reordered = await json<{
        tasks: Array<{ title: string; sort_order: number }>;
      }>(
        await send("POST", "/api/app/tasks/reorder", {
          project_id: projectId,
          task_ids: [c.id, a.id, b.id],
        }),
      );
      expect(
        reordered.tasks.map((task) => [task.title, task.sort_order]),
      ).toEqual([
        ["C", 0],
        ["A renamed", 1],
        ["B", 2],
      ]);
      const reorderRows = await rows<{ task_id: string | null }>(
        "SELECT task_id FROM task_activity WHERE action = 'reordered'",
      );
      expect(reorderRows).toEqual([{ task_id: null }]);

      // Upstream's own trail for A, exactly as it always was.
      const trail = await rows<{ action: string }>(
        "SELECT action FROM task_activity WHERE task_id = ? ORDER BY id",
        a.id,
      );
      expect(trail.map((row) => row.action)).toEqual([
        "created",
        "updated",
        "updated",
        "status_changed",
        "status_changed",
      ]);

      // The sync archives it, with the events upstream never logs.
      await sync(3);
      expect(await archiveTypes(a.id)).toEqual([
        "created",
        "updated",
        "updated",
        "status_changed",
        "status_changed",
      ]);
      expect(await archiveTypes(b.id)).toEqual([
        "created",
        "deleted",
        "restored",
      ]);
      expect(await archiveTypes(c.id)).toEqual(["created"]);
      // A project-scoped reorder has no task, so it is not archived.
      expect(await count("planner_task_event")).toBe(5 + 3 + 1);
      expect(
        (await archive(a.id)).every((event) => event.actor_type === "user"),
      ).toBe(true);

      // Nothing new on a repeat.
      await sync(4);
      expect(await count("planner_task_event")).toBe(9);
    });

    it("keeps the archive of a task that upstream later loses its activity for", async () => {
      const task = await createTask("Remembered");
      await patchTask(task.id, { status: "in_progress" });
      await sync(0);
      // Upstream's activity trail goes (as a table rebuild once did).
      await run("DELETE FROM task_activity");
      expect(await count("task_activity")).toBe(0);

      await sync(1);

      expect(await archiveTypes(task.id)).toEqual([
        "created",
        "status_changed",
      ]);
      expect(
        await plannerReadTaskHistory(db, { userId: owner.id, taskId: task.id }),
      ).toHaveLength(2);
    });
  });

  describe("project routes and the daily trash purge", () => {
    it("delete, restore and purge work, and the planner records each step", async () => {
      const projectId = await createProject("Doomed");
      const t1 = await createTask("One", { project_id: projectId });
      const t2 = await createTask("Two", { project_id: projectId });
      await sync(0);
      // A planned task and a goal node, so the purge has planner rows to clean.
      await plannerSetPlan(db, {
        user: owner,
        actor: { type: "user" },
        taskId: t1.id,
        plan: { horizon: "week", day: "2026-10-07" },
        today: "2026-10-07",
        now: at(0),
      });
      await plannerUpsertProjectNode(db, {
        userId: owner.id,
        projectId,
        level: "goal",
        now: at(0),
      });

      // Delete: the project and its live tasks go to the bin together.
      expect(
        (await send("DELETE", `/api/app/projects/${bare(projectId)}`)).status,
      ).toBe(200);
      expect((await send("GET", `/api/app/tasks/${bare(t1.id)}`)).status).toBe(
        404,
      );
      const during = await json<{ projects: unknown[] }>(
        await send("GET", "/api/app/projects"),
      );
      expect(during.projects).toHaveLength(0);
      await sync(1);
      expect(await archiveTypes(t1.id)).toEqual([
        "created",
        "planned",
        "deleted",
      ]);
      expect(await archiveTypes(t2.id)).toEqual(["created", "deleted"]);

      // Restore brings both back.
      const restored = await json<{ project: { deleted_at: string | null } }>(
        await send("POST", `/api/app/projects/${bare(projectId)}/restore`),
      );
      expect(restored.project.deleted_at).toBeNull();
      expect((await send("GET", `/api/app/tasks/${bare(t1.id)}`)).status).toBe(
        200,
      );
      await sync(2);
      expect(await archiveTypes(t1.id)).toEqual([
        "created",
        "planned",
        "deleted",
        "restored",
      ]);

      // Delete again and let the trash expire: the daily sweep purges the
      // project, and the foreign key cascade takes its tasks and their trail.
      expect(
        (await send("DELETE", `/api/app/projects/${bare(projectId)}`)).status,
      ).toBe(200);
      await sync(3);
      const stale = "2026-07-01T00:00:00.000Z";
      await run(
        "UPDATE projects SET deleted_at = ? WHERE id = ?",
        stale,
        projectId,
      );
      await run(
        "UPDATE tasks SET deleted_at = ? WHERE project_id = ?",
        stale,
        projectId,
      );
      await runScheduledMaintenance(ctx.env, SCHEDULED_AT);

      expect(await count("projects")).toBe(0);
      expect(await count("tasks")).toBe(0);
      expect(await count("task_activity")).toBe(0);

      // The planner kept its archive and now records the purge.
      await sync(4);
      for (const [task, title, planned] of [
        [t1, "One", ["planned"]],
        [t2, "Two", []],
      ] as const) {
        const events = await archive(task.id);
        expect(events.map((event) => event.type)).toEqual([
          "created",
          ...planned,
          "deleted",
          "restored",
          "deleted",
          // This test back-dates `deleted_at` by hand; the nightly sync before
          // the purge reads that as a restore and a new delete.
          "restored",
          "deleted",
          "purged",
        ]);
        expect(events.at(-1)).toMatchObject({
          source: "sync",
          source_ref: `pur:${task.id}`,
          task_title: title,
        });
      }
      // The plan, the snapshots and the goal node went with the purge.
      expect(await count("planner_task_plan")).toBe(0);
      expect(await count("planner_task_seen")).toBe(0);
      expect(await count("planner_project_node")).toBe(0);
    });

    it("purges a standalone expired task, and its archive survives with the title", async () => {
      const task = await createTask("Long gone");
      await sync(0);
      expect(
        (await send("DELETE", `/api/app/tasks/${bare(task.id)}`)).status,
      ).toBe(200);
      await sync(1);
      await run(
        "UPDATE tasks SET deleted_at = '2026-07-01T00:00:00.000Z' WHERE id = ?",
        task.id,
      );

      await runScheduledMaintenance(ctx.env, SCHEDULED_AT);

      expect(await count("tasks")).toBe(0);
      expect(await count("task_activity")).toBe(0);
      await sync(2);
      // `deleted_at` was back-dated by hand above, so the nightly sync before
      // the purge records it as a restore and a new delete.
      expect(await archiveTypes(task.id)).toEqual([
        "created",
        "deleted",
        "restored",
        "deleted",
        "purged",
      ]);
      const history = await plannerReadTaskHistory(db, {
        userId: owner.id,
        taskId: task.id,
      });
      expect(history.map((event) => event.task_title)).toEqual([
        "Long gone",
        "Long gone",
        "Long gone",
        "Long gone",
        "Long gone",
      ]);
    });
  });

  describe("member removal", () => {
    it("removes a member with planner rows, leaves the owner's data alone and keeps the member's archive until it is cleaned by hand", async () => {
      const ownerTask = await createTask("Owner task");
      const member = await harness.createActivatedMember(
        "member@example.com",
        "Member",
      );
      const memberUser = await getFlaremoUserById(db, member.id);
      expect(memberUser).not.toBeNull();
      const asMember = (method: string, path: string, body?: unknown) =>
        fetchWorker(
          new Request(url(path), {
            method,
            headers: {
              cookie: member.cookie,
              origin: "http://flaremo.test",
              ...(body === undefined
                ? {}
                : { "content-type": "application/json" }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          }),
          ctx.env,
        );
      const created = await asMember("POST", "/api/app/tasks", {
        title: "Member task",
      });
      expect(created.status).toBe(201);
      const memberTask = (await created.json<{ task: TaskBody }>()).task;
      await sync(0);
      await sync(0, member.id);
      await plannerSetPlan(db, {
        user: memberUser as UserRow,
        actor: { type: "user" },
        taskId: memberTask.id,
        plan: { horizon: "day", day: "2026-10-07" },
        today: "2026-10-07",
        now: at(0),
      });
      expect(await archiveTypes(memberTask.id, member.id)).toEqual([
        "created",
        "planned",
      ]);

      const removal = await fetchApp(
        url(`/api/app/admin/users/${encodeURIComponent(member.id)}`),
        { method: "DELETE" },
      );
      expect(removal.status).toBe(200);

      // Upstream: the member's tasks are gone and the owner's are not.
      expect(
        await rows("SELECT id FROM tasks WHERE user_id = ?", member.id),
      ).toEqual([]);
      expect(
        (await send("GET", `/api/app/tasks/${bare(ownerTask.id)}`)).status,
      ).toBe(200);
      expect((await asMember("GET", "/api/app/health")).status).toBe(401);

      // The planner has no foreign key to users, so removal was never blocked
      // and the member's rows are still there: the runbook cleans them by hand.
      expect(
        (
          await rows(
            "SELECT 1 FROM planner_task_plan WHERE user_id = ?",
            member.id,
          )
        ).length,
      ).toBe(1);
      expect(await archiveTypes(memberTask.id, member.id)).toEqual([
        "created",
        "planned",
      ]);

      // The owner's history keeps syncing, untouched by the removal.
      await sync(1);
      expect(await archiveTypes(ownerTask.id)).toEqual(["created"]);
      expect(await archiveTypes(memberTask.id)).toEqual([]);

      // If the removed member were ever synced, the purge would be recorded.
      await sync(2, member.id);
      expect(await archiveTypes(memberTask.id, member.id)).toEqual([
        "created",
        "planned",
        "purged",
      ]);
    });
  });

  describe("overdue reminders", () => {
    const overdue = () =>
      rows<{ snippet: string; source_event_id: string }>(
        "SELECT snippet, source_event_id FROM memos_notifications WHERE type = 'task_overdue' ORDER BY snippet",
      );

    it("file once per task per due date, and a plan date is not a due date", async () => {
      const dated = await createTask("Overdue chore", { due_at: "2026-09-01" });
      await createTask("On time", { due_at: "2026-09-30" });
      // Planning a task for this week does not touch its due date.
      await plannerSetPlan(db, {
        user: owner,
        actor: { type: "user" },
        taskId: dated.id,
        plan: { horizon: "week", day: "2026-10-07" },
        today: "2026-10-07",
        now: at(0),
      });
      expect(
        (
          await json<{ task: TaskBody }>(
            await send("GET", `/api/app/tasks/${bare(dated.id)}`),
          )
        ).task.due_at,
      ).toBe("2026-09-01");

      await runScheduledMaintenance(ctx.env, SCHEDULED_AT);
      expect(await overdue()).toEqual([
        {
          snippet: "Overdue chore",
          source_event_id: `task-overdue:${dated.id}:2026-09-01`,
        },
      ]);

      // A cron retry, and the next day, add nothing.
      await runScheduledMaintenance(ctx.env, SCHEDULED_AT);
      await runScheduledMaintenance(ctx.env, SCHEDULED_AT + 86_400_000);
      expect(await overdue()).toHaveLength(1);
    });

    it("stop for a dropped task, whose due date the drop clears through upstream", async () => {
      const kept = await createTask("Still overdue", { due_at: "2026-09-01" });
      const dropped = await createTask("Dropped for good", {
        due_at: "2026-09-01",
      });
      const result = await plannerDropTask(db, {
        user: owner,
        actor: { type: "user" },
        taskId: dropped.id,
        now: at(0),
      });
      expect(result.task.due_at).toBeNull();

      await runScheduledMaintenance(ctx.env, SCHEDULED_AT);

      expect((await overdue()).map((row) => row.snippet)).toEqual([
        "Still overdue",
      ]);
      expect(kept.id).toBeTruthy();
      // The old date lives on in the history, where it can be read back. The
      // planner event was written first, the copied activity after it, so
      // compare by type rather than by position.
      await sync(1);
      const events = await archive(dropped.id);
      expect(events.map((event) => event.type).sort()).toEqual([
        "created",
        "dropped",
        "updated",
      ]);
      const droppedEvent = events.find((event) => event.type === "dropped");
      expect(JSON.parse(droppedEvent?.data ?? "{}")).toEqual({
        previous_due_at: "2026-09-01",
      });
      const cleared = events.find((event) => event.type === "updated");
      expect(JSON.parse(cleared?.data ?? "{}")).toEqual({ due_at: null });
    });
  });

  describe("convert to task", () => {
    it("creates an unassigned task bridged to its memo, and archives it like any other", async () => {
      const memo = await harness.createMemo<{ name: string }>("- [ ] buy milk");
      const memoName = memo.name;
      expect(memoName).toMatch(/^memos\//);

      // What the memo page's "convert to task" action sends.
      const task = await createTask("buy milk", { source_memo_id: memoName });
      expect(task).toMatchObject({
        title: "buy milk",
        project_id: null,
        source_memo_id: memoName,
        status: "todo",
      });
      const fetched = await json<{ task: TaskBody }>(
        await send("GET", `/api/app/tasks/${bare(task.id)}`),
      );
      expect(fetched.task.source_memo_id).toBe(memoName);

      await sync(0);
      expect(await archiveTypes(task.id)).toEqual(["created"]);
      const [created] = await archive(task.id);
      expect(JSON.parse(created?.data ?? "{}")).toEqual({
        project_id: null,
        title: "buy milk",
        status: "todo",
      });
      // The board shows it in the backlog; its memo link stays upstream's.
      const board = await plannerReadBoard(db, {
        userId: owner.id,
        today: "2026-10-07",
      });
      expect(board.columns.backlog.map((card) => card.title)).toEqual([
        "buy milk",
      ]);
      expect(board.columns.backlog[0]).not.toHaveProperty("source_memo_id");
    });
  });

  describe("the planner's own reads and writes", () => {
    it("never write to upstream tables when they only sync, read or roll over", async () => {
      const projectId = await createProject("Quiet");
      const parentId = await createProject("Quiet parent");
      const planned = await createTask("Planned", { project_id: projectId });
      await createTask("Done", { project_id: projectId });
      await plannerSetPlan(db, {
        user: owner,
        actor: { type: "user" },
        taskId: planned.id,
        plan: { horizon: "day", day: "2026-10-05" },
        today: "2026-10-05",
        now: at(0),
      });
      await plannerUpsertProjectNode(db, {
        userId: owner.id,
        projectId,
        parentProjectId: parentId,
        now: at(0),
      });
      const before = await upstreamTables();

      await sync(1);
      await plannerRollover(db, {
        userId: owner.id,
        actor: { type: "user" },
        today: "2026-10-06",
        now: new Date("2026-10-06T09:00:00.000Z"),
      });
      await plannerReadBoard(db, { userId: owner.id, today: "2026-10-06" });
      await plannerReadTree(db, { userId: owner.id });
      await plannerReadRollup(db, {
        userId: owner.id,
        projectId: parentId,
        from: "2026-10-01",
        to: "2026-10-31",
      });

      expect(await upstreamTables()).toEqual(before);
      // The rollover itself did move the plan, in the planner's own table.
      const [plan] = await rows<{ period_start: string; carry_count: number }>(
        "SELECT period_start, carry_count FROM planner_task_plan WHERE task_id = ?",
        planned.id,
      );
      expect(plan).toEqual({ period_start: "2026-10-06", carry_count: 1 });
    });
  });

  describe("with and without the planner installed", () => {
    // The same sequence of upstream calls, against one database that has the
    // planner tables and one that does not. Every response and every upstream
    // row must come out the same, with ids and clock times normalised.
    function normalise(value: unknown): string {
      const ids = new Map<string, string>();
      return JSON.stringify(value)
        .replaceAll(UUID, (id) => {
          if (!ids.has(id)) ids.set(id, `<id${ids.size + 1}>`);
          return ids.get(id) ?? id;
        })
        .replaceAll(STAMP, "<ts>");
    }

    async function scenario(context: Context) {
      const previous = ctx;
      ctx = context;
      try {
        const observed: unknown[] = [];
        // The scenario only reads the bodies of requests that succeed.
        type StepBody = { task: TaskBody; project: { id: string } };
        const step = async (
          label: string,
          method: string,
          path: string,
          body?: unknown,
        ): Promise<StepBody> => {
          const response = await send(method, path, body);
          const text = await response.text();
          observed.push({
            label,
            status: response.status,
            body: text ? JSON.parse(text) : null,
          });
          return (text ? JSON.parse(text) : {}) as StepBody;
        };

        const projectId = (
          await step("project", "POST", "/api/app/projects", { name: "Plan" })
        ).project.id;
        const ids: Record<string, string> = {};
        for (const [name, extra] of [
          ["A", { due_at: "2026-09-01" }],
          ["B", {}],
          ["C", {}],
        ] as const) {
          const body = await step(`create ${name}`, "POST", "/api/app/tasks", {
            title: name,
            project_id: projectId,
            ...extra,
          });
          ids[name] = bare(body.task.id);
        }
        await step("rename A", "PATCH", `/api/app/tasks/${ids.A}`, {
          title: "A2",
          priority: "high",
        });
        await step("no-op A", "PATCH", `/api/app/tasks/${ids.A}`, {
          title: "A2",
        });
        await step("done A", "PATCH", `/api/app/tasks/${ids.A}`, {
          status: "done",
        });
        await step("reopen A", "PATCH", `/api/app/tasks/${ids.A}`, {
          status: "todo",
        });
        await step("empty patch", "PATCH", `/api/app/tasks/${ids.A}`, {});
        await step("delete B", "DELETE", `/api/app/tasks/${ids.B}`);
        await step("read B", "GET", `/api/app/tasks/${ids.B}`);
        await step("restore B", "POST", `/api/app/tasks/${ids.B}/restore`);
        await step("reorder", "POST", "/api/app/tasks/reorder", {
          project_id: projectId,
          task_ids: [`tasks/${ids.C}`, `tasks/${ids.A}`, `tasks/${ids.B}`],
        });
        await step(
          "delete project",
          "DELETE",
          `/api/app/projects/${bare(projectId)}`,
        );
        await step(
          "restore project",
          "POST",
          `/api/app/projects/${bare(projectId)}/restore`,
        );
        await step("list", "GET", "/api/app/tasks?page_size=100");

        // A second project and a loose task, both binned and expired, then the
        // daily sweep: purge, and the overdue reminder for A.
        const doomed = (
          await step("project 2", "POST", "/api/app/projects", {
            name: "Doomed",
          })
        ).project.id;
        await step("task D", "POST", "/api/app/tasks", {
          title: "D",
          project_id: doomed,
        });
        const loose = await step("task E", "POST", "/api/app/tasks", {
          title: "E",
        });
        await step(
          "delete project 2",
          "DELETE",
          `/api/app/projects/${bare(doomed)}`,
        );
        await step(
          "delete E",
          "DELETE",
          `/api/app/tasks/${bare(loose.task.id)}`,
        );
        const stale = "2026-07-01T00:00:00.000Z";
        await context.d1
          .prepare("UPDATE projects SET deleted_at = ? WHERE name = 'Doomed'")
          .bind(stale)
          .run();
        await context.d1
          .prepare("UPDATE tasks SET deleted_at = ? WHERE title IN ('D', 'E')")
          .bind(stale)
          .run();
        await runScheduledMaintenance(context.env, SCHEDULED_AT);

        const dump = async (sql: string) =>
          (await context.d1.prepare(sql).all()).results;
        return normalise({
          observed,
          tasks: await dump("SELECT * FROM tasks ORDER BY title, id"),
          projects: await dump("SELECT * FROM projects ORDER BY name, id"),
          task_activity: await dump("SELECT * FROM task_activity ORDER BY id"),
          notifications: await dump(
            "SELECT type, snippet, source_event_id FROM memos_notifications WHERE type = 'task_overdue' ORDER BY snippet",
          ),
        });
      } finally {
        ctx = previous;
      }
    }

    it("leaves every upstream response and row exactly as they are without it", async () => {
      const without = await boot({ planner: false });
      const withPlanner = await boot({ planner: true });
      try {
        const plain = await scenario(without);
        const planned = await scenario(withPlanner);
        expect(planned).toBe(plain);
        // The scenario really did something.
        expect(plain).toContain("task-overdue:");
        expect(plain).toContain('"status":200');
        expect(plain).toContain('"status":404');
        // And only the second database has planner tables.
        const tableNames = async (context: Context) =>
          (
            await context.d1
              .prepare(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'planner%'",
              )
              .all<{ name: string }>()
          ).results.length;
        expect(await tableNames(without)).toBe(0);
        // 9000 made five planner tables and 9001 added the comments.
        expect(await tableNames(withPlanner)).toBe(6);
      } finally {
        await without.runtime.dispose();
        await withPlanner.runtime.dispose();
      }
    });
  });
});
