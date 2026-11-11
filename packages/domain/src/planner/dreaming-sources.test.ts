import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { collectDreamingSources } from "../memory/consolidation";
import { plannerDreamingCommentUsers } from "./dreaming-sources";
import {
  type PlannerTestRuntime,
  plannerTestInsertTask,
  plannerTestRun,
  plannerTestRuntime,
} from "./test-support";

// Task comments as memory-dreaming sources (dreaming-sources.ts, hooked into
// collectDreamingSources): new live comments are read with their task's title.

describe("task comments in memory dreaming", () => {
  let rt: PlannerTestRuntime;

  beforeAll(async () => {
    rt = await plannerTestRuntime("flaremo-planner-dreaming-sources");
  });
  afterAll(async () => {
    await rt.dispose();
  });
  beforeEach(async () => {
    await rt.reset();
  });

  const comment = (id: string, userId: string, body: string, at: string) =>
    plannerTestRun(
      rt.database,
      `INSERT INTO planner_task_comment (id, user_id, task_id, body, created_at, updated_at)
       VALUES (?, ?, 'tasks/flat', ?, ?, ?)`,
      id,
      userId,
      body,
      at,
      at,
    );

  it("reads the comments written since the last run, with the task's title", async () => {
    await plannerTestInsertTask(rt.database, {
      id: "tasks/flat",
      userId: rt.user.id,
      title: "Move flat",
    });
    await comment(
      "old",
      rt.user.id,
      "Before the window.",
      "2026-11-01T09:00:00.000Z",
    );
    await comment(
      "new",
      rt.user.id,
      "Get lease changes in writing.",
      "2026-11-10T09:00:00.000Z",
    );
    await comment("gone", rt.user.id, "Deleted.", "2026-11-10T10:00:00.000Z");
    await plannerTestRun(
      rt.database,
      "UPDATE planner_task_comment SET deleted_at = '2026-11-10T11:00:00.000Z' WHERE id = 'gone'",
    );
    await comment(
      "theirs",
      rt.other.id,
      "Not mine.",
      "2026-11-10T09:30:00.000Z",
    );

    const sources = await collectDreamingSources(
      rt.db,
      rt.user,
      "2026-11-05T00:00:00.000Z",
    );
    expect(sources.filter((source) => source.kind === "task_comment")).toEqual([
      {
        id: "new",
        kind: "task_comment",
        content: 'Task "Move flat": Get lease changes in writing.',
        createdAt: "2026-11-10T09:00:00.000Z",
      },
    ]);
    expect(
      await plannerDreamingCommentUsers(rt.db, "2026-11-05T00:00:00.000Z"),
    ).toEqual([rt.other.id, rt.user.id]); // newest comment first
  });
});
