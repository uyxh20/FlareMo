import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from "vitest";
import {
  createTask,
  deleteTask,
  restoreTask,
  type TaskActor,
  updateTask,
} from "../tasks";
import { plannerSyncHistory } from "./history-sync";
import {
  type PlannerTestRuntime,
  plannerTestAt,
  plannerTestCount,
  plannerTestEvents,
  plannerTestFailBatch,
  plannerTestRows,
  plannerTestRun,
  plannerTestRuntime,
  plannerTestTypes,
} from "./test-support";

// These tests change the schema (drop a column, rename a table, rebuild
// `tasks`), so each one gets its own database.

const USER: TaskActor = { type: "user" };
const AGENT: TaskActor = { type: "agent", name: "pat:abcd1234" };
const T0 = new Date("2026-10-05T10:00:00.000Z");

type SyncStateRow = {
  status: string;
  paused_reason: string | null;
  last_sync_at: string | null;
  activity_watermark: string | null;
};

describe("plannerSyncHistory against a changing schema", () => {
  let rt: PlannerTestRuntime;
  let errors: MockInstance<typeof console.error>;

  beforeEach(async () => {
    errors = vi.spyOn(console, "error").mockImplementation(() => {});
    rt = await plannerTestRuntime("flaremo-planner-history-schema");
  });
  afterEach(async () => {
    await rt.dispose();
    vi.restoreAllMocks();
  });

  const sync = (minutes: number, db = rt.db) =>
    plannerSyncHistory(db, {
      userId: rt.user.id,
      now: plannerTestAt(T0, minutes),
    });

  const state = async () => {
    const [row] = await plannerTestRows<SyncStateRow>(
      rt.database,
      "SELECT * FROM planner_sync_state WHERE user_id = ?",
      rt.user.id,
    );
    return row;
  };

  describe("compatibility check", () => {
    it("pauses when a required column is missing, copies nothing, and leaves upstream writes alone", async () => {
      // `projects.name` is read by the board and the tree but not by upstream's
      // project-less task writes, so the task services keep working without it.
      await plannerTestRun(
        rt.database,
        "ALTER TABLE projects DROP COLUMN name",
      );

      const task = await createTask(rt.db, rt.user, USER, {
        title: "Still works",
      });
      await updateTask(rt.db, rt.user, AGENT, task.id, {
        status: "in_progress",
      });
      await deleteTask(rt.db, rt.user, task.id);
      await restoreTask(rt.db, rt.user, task.id);

      expect(await sync(0)).toEqual({ history: "paused" });
      const paused = await state();
      expect(paused).toMatchObject({ status: "paused" });
      expect(paused?.paused_reason).toContain("projects.name");
      expect(paused?.paused_reason).not.toContain("tasks.");
      expect(await plannerTestCount(rt.database, "planner_task_event")).toBe(0);
      expect(await plannerTestCount(rt.database, "planner_task_seen")).toBe(0);
      expect(errors).toHaveBeenCalled();

      // Upstream keeps working while the planner is paused.
      await updateTask(rt.db, rt.user, USER, task.id, {
        title: "Still works, renamed",
      });

      // Debounced: the stored status comes back without another look.
      expect(await sync(0.1)).toEqual({ history: "paused" });
      // Past the debounce it checks again, and the column is still missing.
      expect(await sync(1)).toEqual({ history: "paused" });
      expect(await plannerTestCount(rt.database, "planner_task_event")).toBe(0);

      // Upstream catches up (a column named `name` is back): copying resumes
      // from the watermark, which never moved, so nothing is lost.
      await plannerTestRun(
        rt.database,
        "ALTER TABLE projects ADD COLUMN name text NOT NULL DEFAULT ''",
      );
      expect(await sync(2)).toEqual({ history: "ok" });
      expect(await state()).toMatchObject({
        status: "ok",
        paused_reason: null,
      });
      expect(await plannerTestTypes(rt.database, task.id)).toEqual([
        "created",
        "status_changed",
        "updated",
      ]);
      expect(await plannerTestCount(rt.database, "planner_task_seen")).toBe(1);
    });

    it("names every missing column of every table in the reason", async () => {
      await plannerTestRun(
        rt.database,
        "ALTER TABLE projects DROP COLUMN name",
      );
      await plannerTestRun(
        rt.database,
        "ALTER TABLE task_activity DROP COLUMN actor_name",
      );
      await sync(0);
      const reason = (await state())?.paused_reason ?? "";
      expect(reason).toContain("projects.name");
      expect(reason).toContain("task_activity.actor_name");
    });
  });

  describe("failure injection", () => {
    it("returns paused instead of throwing when D1 throws inside the sync, and recovers", async () => {
      const task = await createTask(rt.db, rt.user, USER, {
        title: "Survives",
      });
      const failing = plannerTestFailBatch(rt.db, (texts) =>
        texts.some((text) => text.includes("FROM task_activity")),
      );

      await expect(sync(0, failing)).resolves.toEqual({ history: "paused" });
      const paused = await state();
      expect(paused).toMatchObject({ status: "paused" });
      expect(paused?.paused_reason).toContain("injected failure");
      expect(paused?.last_sync_at).toBe(T0.toISOString());
      // The batch is atomic: nothing was written.
      expect(await plannerTestCount(rt.database, "planner_task_event")).toBe(0);
      expect(await plannerTestCount(rt.database, "planner_task_seen")).toBe(0);
      expect(errors).toHaveBeenCalled();

      // Debounced, so a failing D1 is not hammered.
      await expect(sync(0.1, failing)).resolves.toEqual({ history: "paused" });
      // The next healthy sync catches up from the beginning.
      await expect(sync(1)).resolves.toEqual({ history: "ok" });
      expect(await state()).toMatchObject({
        status: "ok",
        paused_reason: null,
      });
      expect(await plannerTestTypes(rt.database, task.id)).toEqual(["created"]);
    });

    it("rolls the whole batch back when a late statement really fails inside D1", async () => {
      const task = await createTask(rt.db, rt.user, USER, { title: "Atomic" });
      // Only the last statement of the batch (the orphan node clean-up) reads
      // this table, so the copy, the state update and the snapshot all ran first.
      await plannerTestRun(
        rt.database,
        "ALTER TABLE planner_project_node RENAME TO planner_project_node_away",
      );

      await expect(sync(0)).resolves.toEqual({ history: "paused" });

      expect(await plannerTestCount(rt.database, "planner_task_event")).toBe(0);
      expect(await plannerTestCount(rt.database, "planner_task_seen")).toBe(0);
      const paused = await state();
      expect(paused).toMatchObject({
        status: "paused",
        activity_watermark: null,
      });
      expect(paused?.paused_reason).toMatch(/planner_project_node/);

      await plannerTestRun(
        rt.database,
        "ALTER TABLE planner_project_node_away RENAME TO planner_project_node",
      );
      await expect(sync(1)).resolves.toEqual({ history: "ok" });
      expect(await plannerTestTypes(rt.database, task.id)).toEqual(["created"]);
    });

    it("never throws even when the sync state cannot be read or written", async () => {
      await plannerTestRun(
        rt.database,
        "ALTER TABLE planner_sync_state RENAME TO planner_sync_state_away",
      );
      await expect(sync(0)).resolves.toEqual({ history: "paused" });
      await plannerTestRun(
        rt.database,
        "ALTER TABLE planner_sync_state_away RENAME TO planner_sync_state",
      );
      await expect(sync(1)).resolves.toEqual({ history: "ok" });
    });

    it("never throws when the archive table itself is unusable", async () => {
      await plannerTestRun(
        rt.database,
        "ALTER TABLE planner_task_event RENAME TO planner_task_event_away",
      );
      await createTask(rt.db, rt.user, USER, { title: "Nowhere to go" });
      await expect(sync(0)).resolves.toEqual({ history: "paused" });
      expect((await state())?.paused_reason).toMatch(/planner_task_event/);
    });
  });

  describe("upstream table rebuild", () => {
    // The shape of migrations/0025_clammy_sunspot.sql: create the new table,
    // copy, drop the old one, rename. Wrangler runs a migration as one batch,
    // where `PRAGMA foreign_keys=OFF` is a no-op, so the DROP cascades into
    // every row that references the old table. Written for today's columns.
    const rebuildTasks = (where = "1") => [
      rt.database.prepare("PRAGMA foreign_keys=OFF"),
      rt.database.prepare(`CREATE TABLE __new_tasks (
        id text PRIMARY KEY NOT NULL,
        user_id text NOT NULL,
        project_id text,
        source_memo_id text,
        title text NOT NULL,
        notes text,
        status text DEFAULT 'todo' NOT NULL,
        priority text DEFAULT 'none' NOT NULL,
        due_at text,
        sort_order integer DEFAULT 0 NOT NULL,
        completed_at text,
        deleted_at text,
        created_at text NOT NULL,
        updated_at text NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE no action ON DELETE cascade,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON UPDATE no action ON DELETE cascade
      )`),
      rt.database.prepare(`INSERT INTO __new_tasks
        SELECT id, user_id, project_id, source_memo_id, title, notes, status, priority, due_at, sort_order, completed_at, deleted_at, created_at, updated_at
        FROM tasks WHERE ${where}`),
      rt.database.prepare("DROP TABLE tasks"),
      rt.database.prepare("ALTER TABLE __new_tasks RENAME TO tasks"),
      rt.database.prepare("PRAGMA foreign_keys=ON"),
      rt.database.prepare(
        "CREATE INDEX tasks_user_project_status_sort_idx ON tasks (user_id, project_id, status, sort_order)",
      ),
      rt.database.prepare(
        "CREATE INDEX tasks_user_due_idx ON tasks (user_id, due_at)",
      ),
      rt.database.prepare(
        "CREATE INDEX tasks_recycle_sweep_idx ON tasks (deleted_at)",
      ),
    ];

    const planFor = (taskId: string) =>
      plannerTestRun(
        rt.database,
        "INSERT INTO planner_task_plan (task_id, user_id, horizon, period_start, carry_count, created_at, updated_at) VALUES (?, ?, 'week', '2026-10-05', 1, ?, ?)",
        taskId,
        rt.user.id,
        T0.toISOString(),
        T0.toISOString(),
      );

    it("leaves the planner tables and the archive intact, and archives what comes after", async () => {
      const keep = await createTask(rt.db, rt.user, USER, { title: "Keep me" });
      const other = await createTask(rt.db, rt.user, AGENT, { title: "Other" });
      await updateTask(rt.db, rt.user, AGENT, keep.id, {
        status: "in_progress",
      });
      await planFor(keep.id);
      await planFor(other.id);
      await sync(0);

      const archivedBefore = await plannerTestEvents(rt.database);
      expect(archivedBefore).toHaveLength(3);
      const [lastBefore] = await plannerTestRows<
        SyncStateRow & { activity_last_id: number }
      >(
        rt.database,
        "SELECT * FROM planner_sync_state WHERE user_id = ?",
        rt.user.id,
      );
      expect(lastBefore?.activity_last_id).toBeGreaterThanOrEqual(3);

      await rt.database.batch(rebuildTasks());

      // The hazard: the rebuild's DROP cascaded into upstream's own activity.
      expect(await plannerTestCount(rt.database, "task_activity")).toBe(0);
      expect(await plannerTestCount(rt.database, "tasks")).toBe(2);
      // The planner has no foreign key to tasks, so none of it was touched.
      expect(await plannerTestCount(rt.database, "planner_task_plan")).toBe(2);
      expect(await plannerTestCount(rt.database, "planner_task_seen")).toBe(2);
      expect(await plannerTestEvents(rt.database)).toEqual(archivedBefore);

      // Upstream carries on; ids restart (the rebuild's sequence is new).
      await plannerTestRun(
        rt.database,
        "DELETE FROM sqlite_sequence WHERE name = 'task_activity'",
      );
      await updateTask(rt.db, rt.user, USER, keep.id, {
        title: "Kept and renamed",
      });

      expect(await sync(1)).toEqual({ history: "ok" });

      // Nothing purged, nothing invented, nothing duplicated.
      expect(await plannerTestTypes(rt.database, keep.id)).toEqual([
        "created",
        "status_changed",
        "updated",
      ]);
      expect(await plannerTestTypes(rt.database, other.id)).toEqual([
        "created",
      ]);
      expect(await plannerTestCount(rt.database, "planner_task_plan")).toBe(2);
      // The archive still holds the history upstream lost.
      expect(
        (await plannerTestEvents(rt.database, keep.id)).filter(
          (event) => event.source === "activity",
        ),
      ).toHaveLength(3);
      const [after] = await plannerTestRows<{ activity_last_id: number }>(
        rt.database,
        "SELECT activity_last_id FROM planner_sync_state WHERE user_id = ?",
        rt.user.id,
      );
      expect(after?.activity_last_id).toBe(1);
    });

    it("records a task the rebuild lost as purged, from the snapshot, and drops its plan", async () => {
      const keep = await createTask(rt.db, rt.user, USER, { title: "Keep me" });
      const lost = await createTask(rt.db, rt.user, USER, {
        title: "Lost in the move",
      });
      await planFor(keep.id);
      await planFor(lost.id);
      await sync(0);

      await rt.database.batch(rebuildTasks(`id <> '${lost.id}'`));
      expect(await plannerTestCount(rt.database, "tasks")).toBe(1);

      await sync(1);

      const events = await plannerTestEvents(rt.database, lost.id);
      expect(events.map((event) => event.type)).toEqual(["created", "purged"]);
      expect(events[1]).toMatchObject({
        task_title: "Lost in the move",
        source_ref: `pur:${lost.id}`,
      });
      const plans = await plannerTestRows<{ task_id: string }>(
        rt.database,
        "SELECT task_id FROM planner_task_plan",
      );
      expect(plans.map((plan) => plan.task_id)).toEqual([keep.id]);
      expect(await plannerTestTypes(rt.database, keep.id)).toEqual(["created"]);
    });
  });
});
