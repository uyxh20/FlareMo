import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createProject, hardDeleteExpiredProjects } from "../projects";
import {
  createTask,
  deleteTask,
  hardDeleteExpiredTasks,
  type TaskActor,
  updateTask,
} from "../tasks";
import { plannerSyncAllUsers } from "./history-sync-nightly";
import {
  type PlannerTestRuntime,
  plannerTestEvents,
  plannerTestRun,
  plannerTestRuntime,
} from "./test-support";

const USER: TaskActor = { type: "user" };

describe("plannerSyncAllUsers", () => {
  let rt: PlannerTestRuntime;
  beforeAll(async () => {
    rt = await plannerTestRuntime("flaremo-planner-nightly-sync");
  });
  afterAll(async () => {
    await rt.dispose();
  });
  beforeEach(async () => {
    await rt.reset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("syncs every user with tasks, before and after a purge, with no cockpit visit", async () => {
    const project = await createProject(rt.db, rt.user, { name: "Launch" });
    const mine = await createTask(rt.db, rt.user, USER, {
      title: "Draft",
      project_id: project.id,
    });
    await updateTask(rt.db, rt.user, USER, mine.id, { title: "Final" });
    await deleteTask(rt.db, rt.user, mine.id);
    const theirs = await createTask(rt.db, rt.other, USER, { title: "Theirs" });

    const now = new Date(Date.now() + 31 * 86_400_000);
    expect(await plannerSyncAllUsers(rt.db, now)).toEqual({ users: 2 });

    // The purge: project first, then the standalone sweep.
    await plannerTestRun(
      rt.database,
      "UPDATE projects SET deleted_at = '2026-01-01T00:00:00.000Z' WHERE id = ?",
      project.id,
    );
    expect(await hardDeleteExpiredProjects(rt.db, now.toISOString())).toBe(1);
    expect(await hardDeleteExpiredTasks(rt.db, now.toISOString())).toBe(0);

    // The same instant again: force beats the debounce.
    await plannerSyncAllUsers(rt.db, now);

    const events = await plannerTestEvents(rt.database, mine.id);
    expect(events.map((e) => [e.type, e.task_title])).toEqual([
      ["created", "Draft"],
      ["updated", "Final"],
      ["deleted", "Final"],
      ["purged", "Final"],
    ]);
    expect(events.map((e) => JSON.parse(e.data).project_name)).toEqual([
      "Launch",
      "Launch",
      "Launch",
      "Launch",
    ]);
    expect(
      (await plannerTestEvents(rt.database, theirs.id)).map((e) => e.type),
    ).toEqual(["created"]);
  });

  it("never throws, even without the planner tables", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await plannerTestRun(
      rt.database,
      "ALTER TABLE planner_sync_state RENAME TO planner_sync_state_x",
    );
    try {
      expect(await plannerSyncAllUsers(rt.db, new Date())).toEqual({
        users: 0,
      });
    } finally {
      await plannerTestRun(
        rt.database,
        "ALTER TABLE planner_sync_state_x RENAME TO planner_sync_state",
      );
    }
  });
});
