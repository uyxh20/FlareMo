import type { FlareMoDb, UserRow } from "@flaremo/db";
import { createDb } from "@flaremo/db";
import { applyPlannerMigrations } from "@flaremo/db/src/planner-migrations";
import { ensureSingleUser } from "@flaremo/domain";
import type { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runScheduledMaintenance } from "../index";
import { createAppTestHarness } from "../test-support/app";
import { createTestRuntime } from "../test-support/runtime";
import { bootstrapAndSignIn } from "../test-support/sign-in";

// The nightly history sync around the trash purge (fork-owned add-on). Before
// it, a task created and deleted while the cockpit stayed shut was purged with
// no trace in `planner_task_event`.

type Ctx = { runtime: Miniflare; d1: D1Database; env: Env; cookie: string };
type EventRow = {
  type: string;
  source: string;
  task_title: string | null;
  data: string;
};

describe("nightly planner history sync", () => {
  let ctx: Ctx;
  let db: FlareMoDb;
  let owner: UserRow;
  const harness = createAppTestHarness(() => ({
    env: ctx.env,
    sessionCookie: ctx.cookie,
  }));

  beforeEach(async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const {
      runtime,
      db: d1,
      env,
    } = await createTestRuntime({
      name: "flaremo-planner-nightly",
      env: { FLAREMO_EMBEDDING_PROVIDER: "none" },
    });
    await applyPlannerMigrations(d1);
    ctx = { runtime, d1, env, cookie: await bootstrapAndSignIn(env) };
    db = createDb(d1);
    owner = await ensureSingleUser(db, {
      email: "owner@example.com",
      name: "Owner",
    });
  });

  afterEach(async () => {
    await ctx.runtime.dispose();
    vi.restoreAllMocks();
  });

  const send = (method: string, path: string, body?: unknown) =>
    harness.fetchApp(`http://flaremo.test${path}`, {
      method,
      ...(body === undefined
        ? {}
        : {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
    });
  const bare = (id: string) => id.replace(/^(tasks|projects)\//, "");

  async function archive(taskId: string) {
    return (
      await ctx.d1
        .prepare(
          "SELECT type, source, task_title, data FROM planner_task_event WHERE task_id = ? ORDER BY occurred_at, id",
        )
        .bind(taskId)
        .all<EventRow>()
    ).results;
  }

  it("leaves created, activity, deleted and purged behind for a task the cockpit never saw", async () => {
    const projectResponse = await send("POST", "/api/app/projects", {
      name: "Launch",
    });
    const projectId = (
      await projectResponse.json<{ project: { id: string } }>()
    ).project.id;
    const created = await send("POST", "/api/app/tasks", {
      title: "Draft",
      project_id: projectId,
    });
    const task = (await created.json<{ task: { id: string } }>()).task;
    expect(
      (
        await send("PATCH", `/api/app/tasks/${bare(task.id)}`, {
          title: "Final draft",
        })
      ).status,
    ).toBe(200);
    expect(
      (await send("DELETE", `/api/app/tasks/${bare(task.id)}`)).status,
    ).toBe(200);
    // Nothing has synced: the cockpit was never opened.
    expect(
      (
        await ctx.d1
          .prepare("SELECT COUNT(*) AS n FROM planner_task_event")
          .first<{ n: number }>()
      )?.n,
    ).toBe(0);

    // 31 days later the nightly job purges the project and its binned task.
    await ctx.d1
      .prepare("UPDATE projects SET deleted_at = ? WHERE id = ?")
      .bind(new Date().toISOString(), projectId)
      .run();
    await runScheduledMaintenance(ctx.env, Date.now() + 31 * 86_400_000);

    const remaining = await ctx.d1
      .prepare(
        "SELECT (SELECT COUNT(*) FROM tasks) AS t, (SELECT COUNT(*) FROM task_activity) AS a",
      )
      .first<{ t: number; a: number }>();
    expect(remaining).toEqual({ t: 0, a: 0 });

    const events = await archive(task.id);
    expect(events.map((event) => event.type)).toEqual([
      "created",
      "updated",
      "deleted",
      "purged",
    ]);
    // Each event carries the title the task had at the time.
    expect(events.map((event) => event.task_title)).toEqual([
      "Draft",
      "Final draft",
      "Final draft",
      "Final draft",
    ]);
    // And the project's name survives the project.
    for (const event of events) {
      expect(JSON.parse(event.data)).toMatchObject({
        project_name: "Launch",
      });
    }
    expect(JSON.parse(events.at(-1)?.data ?? "{}")).toEqual({
      detected: true,
      project_name: "Launch",
    });
    // The purge is recorded once and the snapshot is gone.
    const seen = await ctx.d1
      .prepare("SELECT COUNT(*) AS n FROM planner_task_seen")
      .first<{ n: number }>();
    expect(seen?.n).toBe(0);
    void owner;
  });

  it("does not fail the purge when the planner tables are missing", async () => {
    await ctx.d1.prepare("DROP TABLE planner_sync_state").run();
    const created = await send("POST", "/api/app/tasks", { title: "Old" });
    const task = (await created.json<{ task: { id: string } }>()).task;
    await send("DELETE", `/api/app/tasks/${bare(task.id)}`);
    await ctx.d1
      .prepare("UPDATE tasks SET deleted_at = '2020-01-01T00:00:00.000Z'")
      .run();
    await runScheduledMaintenance(ctx.env, Date.now());
    const left = await ctx.d1
      .prepare("SELECT COUNT(*) AS n FROM tasks")
      .first<{ n: number }>();
    expect(left?.n).toBe(0);
  });
});
