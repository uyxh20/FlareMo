import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { plannerSearchSnippet, plannerSearchTasks } from "./task-search";
import {
  type PlannerTestRuntime,
  plannerTestInsertTask,
  plannerTestRun,
  plannerTestRuntime,
} from "./test-support";

// The diary search box's task hits (task-search.ts): title, notes and live
// comments, live tasks only, the caller's own.

describe("task search", () => {
  let rt: PlannerTestRuntime;

  beforeAll(async () => {
    rt = await plannerTestRuntime("flaremo-planner-task-search");
  });
  afterAll(async () => {
    await rt.dispose();
  });
  beforeEach(async () => {
    await rt.reset();
  });

  const comment = (id: string, taskId: string, body: string, at: string) =>
    plannerTestRun(
      rt.database,
      `INSERT INTO planner_task_comment (id, user_id, task_id, body, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      id,
      rt.user.id,
      taskId,
      body,
      at,
      at,
    );

  it("finds a task by its title, its notes or its newest matching comment", async () => {
    await plannerTestInsertTask(rt.database, {
      id: "tasks/a",
      userId: rt.user.id,
      title: "Call the Landlord",
    });
    await plannerTestInsertTask(rt.database, {
      id: "tasks/b",
      userId: rt.user.id,
      title: "Move flat",
    });
    await plannerTestInsertTask(rt.database, {
      id: "tasks/c",
      userId: rt.user.id,
      title: "Invoices",
    });
    await plannerTestRun(
      rt.database,
      "UPDATE tasks SET notes = ? WHERE id = ?",
      "Ask the landlord about the deposit.",
      "tasks/c",
    );
    await comment(
      "c1",
      "tasks/b",
      "Asked landlord, waiting.",
      "2026-10-01T09:00:00.000Z",
    );
    await comment(
      "c2",
      "tasks/b",
      "Landlord agreed in writing.",
      "2026-10-09T09:00:00.000Z",
    );

    const hits = await plannerSearchTasks(rt.db, {
      userId: rt.user.id,
      query: "  LANDLORD ",
    });
    const byId = Object.fromEntries(hits.map((hit) => [hit.id, hit]));
    expect(Object.keys(byId).sort()).toEqual(["tasks/a", "tasks/b", "tasks/c"]);
    expect(byId["tasks/a"]?.match).toBe("title");
    expect(byId["tasks/c"]).toMatchObject({
      match: "notes",
      snippet: "Ask the landlord about the deposit.",
    });
    expect(byId["tasks/b"]).toMatchObject({
      match: "comment",
      snippet: "Landlord agreed in writing.",
      comment_at: "2026-10-09T09:00:00.000Z",
    });
  });

  it("skips deleted comments, tasks in the bin and other users' tasks", async () => {
    await plannerTestInsertTask(rt.database, {
      id: "tasks/live",
      userId: rt.user.id,
      title: "Live",
    });
    await plannerTestInsertTask(rt.database, {
      id: "tasks/binned",
      userId: rt.user.id,
      title: "Binned sauna",
    });
    await plannerTestRun(
      rt.database,
      "UPDATE tasks SET deleted_at = '2026-10-02T00:00:00.000Z' WHERE id = 'tasks/binned'",
    );
    await comment(
      "d1",
      "tasks/live",
      "Sauna twice.",
      "2026-10-01T09:00:00.000Z",
    );
    await plannerTestRun(
      rt.database,
      "UPDATE planner_task_comment SET deleted_at = '2026-10-02T00:00:00.000Z' WHERE id = 'd1'",
    );
    expect(
      await plannerSearchTasks(rt.db, { userId: rt.user.id, query: "sauna" }),
    ).toEqual([]);
    expect(
      await plannerSearchTasks(rt.db, {
        userId: "someone-else",
        query: "live",
      }),
    ).toEqual([]);
    expect(
      await plannerSearchTasks(rt.db, { userId: rt.user.id, query: "   " }),
    ).toEqual([]);
  });

  it("cuts a snippet around the words", () => {
    const text = `${"a".repeat(100)} needle ${"b".repeat(100)}`;
    const snippet = plannerSearchSnippet(text, "NEEDLE");
    expect(snippet.startsWith("…")).toBe(true);
    expect(snippet.endsWith("…")).toBe(true);
    expect(snippet).toContain("needle");
    expect(snippet.length).toBeLessThan(140);
  });
});
