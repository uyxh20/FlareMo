import { importBundleSchema } from "@flaremo/contracts";
import { projects, taskActivity, tasks } from "@flaremo/db";
import { getTableColumns } from "drizzle-orm";
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
import { importData } from "../import-export";
import { createProject } from "../projects";
import {
  createTask,
  deleteTask,
  hardDeleteExpiredTasks,
  restoreTask,
  type TaskActor,
  updateTask,
} from "../tasks";
import {
  plannerFindMissingColumns,
  plannerKnownActivityActions,
  plannerKnownTaskStatuses,
  plannerRequiredColumns,
  plannerSyncBatchSteps,
  plannerSyncDebounceMs,
  plannerSyncHistory,
} from "./history-sync";
import {
  type PlannerTestRuntime,
  plannerTestAt,
  plannerTestCount,
  plannerTestEvents,
  plannerTestInsertActivity,
  plannerTestInsertTask,
  plannerTestRows,
  plannerTestRun,
  plannerTestRuntime,
  plannerTestSpyOnBatch,
  plannerTestTypes,
} from "./test-support";

const USER: TaskActor = { type: "user" };
const AGENT: TaskActor = { type: "agent", name: "pat:abcd1234" };

// The sync takes its clock as a parameter. Real activity timestamps come from
// the real clock, so these only drive the debounce and `last_sync_at`.
const T0 = new Date("2026-10-05T10:00:00.000Z");

type SyncStateRow = {
  user_id: string;
  activity_watermark: string | null;
  activity_last_id: number | null;
  last_sync_at: string | null;
  status: string;
  paused_reason: string | null;
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("plannerSyncHistory", () => {
  let rt: PlannerTestRuntime;

  beforeAll(async () => {
    rt = await plannerTestRuntime("flaremo-planner-history-sync");
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

  const sync = (minutes: number, userId = rt.user.id) =>
    plannerSyncHistory(rt.db, { userId, now: plannerTestAt(T0, minutes) });

  const state = async (userId = rt.user.id) => {
    const [row] = await plannerTestRows<SyncStateRow>(
      rt.database,
      "SELECT * FROM planner_sync_state WHERE user_id = ?",
      userId,
    );
    return row;
  };

  const taskRow = async (id: string) => {
    const [row] = await plannerTestRows<{
      deleted_at: string | null;
      title: string;
    }>(rt.database, "SELECT deleted_at, title FROM tasks WHERE id = ?", id);
    return row;
  };

  // Past the 30 day trash window: what the daily sweep would purge.
  const purge = async (taskId: string) => {
    await plannerTestRun(
      rt.database,
      "UPDATE tasks SET deleted_at = '2026-01-01T00:00:00.000Z' WHERE id = ?",
      taskId,
    );
    expect(
      await hardDeleteExpiredTasks(rt.db, "2026-02-01T00:00:00.000Z"),
    ).toBe(1);
  };

  describe("activity copy", () => {
    it("copies upstream activity with its actor, the current title and an id-free source_ref", async () => {
      const task = await createTask(rt.db, rt.user, USER, {
        title: "Write the plan",
      });
      await updateTask(rt.db, rt.user, AGENT, task.id, {
        title: "Write the v3 plan",
      });
      await updateTask(rt.db, rt.user, USER, task.id, { status: "done" });

      expect(await sync(0)).toEqual({ history: "ok" });

      const events = await plannerTestEvents(rt.database, task.id);
      expect(
        events.map((event) => [
          event.type,
          event.source,
          event.actor_type,
          event.actor_name,
          event.task_title,
        ]),
      ).toEqual([
        ["created", "activity", "user", null, "Write the v3 plan"],
        ["updated", "activity", "agent", "pat:abcd1234", "Write the v3 plan"],
        ["status_changed", "activity", "user", null, "Write the v3 plan"],
      ]);

      // occurred_at is the activity's own created_at; data is its changes JSON;
      // the ref is built from task, time, action and changes, never the row id.
      const activity = await plannerTestRows<{
        id: number;
        action: string;
        changes: string;
        created_at: string;
      }>(
        rt.database,
        "SELECT id, action, changes, created_at FROM task_activity WHERE task_id = ? ORDER BY id",
        task.id,
      );
      expect(activity).toHaveLength(3);
      for (const [index, row] of activity.entries()) {
        const event = events[index];
        expect(event?.occurred_at).toBe(row.created_at);
        expect(event?.data).toBe(row.changes);
        expect(event?.source_ref).toBe(
          `a:${task.id}@${row.created_at}|${row.action}|${row.changes}`,
        );
        expect(event?.user_id).toBe(rt.user.id);
      }
      expect(JSON.parse(events[2]?.data ?? "{}")).toMatchObject({
        status: "done",
      });
    });

    it("leaves project-scoped rows and other users' activity out", async () => {
      const mine = await createTask(rt.db, rt.user, USER, { title: "Mine" });
      const theirs = await createTask(rt.db, rt.other, USER, {
        title: "Theirs",
      });
      await plannerTestInsertActivity(rt.database, {
        taskId: null,
        userId: rt.user.id,
        action: "reordered",
        changes: { project_id: "projects/x", task_ids: [] },
        createdAt: "2026-10-01T00:00:00.000Z",
      });

      await sync(0);

      expect(
        (await plannerTestEvents(rt.database)).map((e) => e.task_id),
      ).toEqual([mine.id]);
      expect(await state(rt.other.id)).toBeUndefined();

      await sync(0, rt.other.id);
      const all = await plannerTestEvents(rt.database);
      expect(
        all
          .filter((event) => event.user_id === rt.other.id)
          .map((e) => e.task_id),
      ).toEqual([theirs.id]);
      expect(
        all
          .filter((event) => event.user_id === rt.user.id)
          .map((e) => e.task_id),
      ).toEqual([mine.id]);
    });

    it("keeps each event's title as it was when the event was archived", async () => {
      const task = await createTask(rt.db, rt.user, USER, {
        title: "Old name",
      });
      await sync(0);
      await updateTask(rt.db, rt.user, USER, task.id, { title: "New name" });
      await sync(1);
      const events = await plannerTestEvents(rt.database, task.id);
      expect(events.map((event) => event.task_title)).toEqual([
        "Old name",
        "New name",
      ]);
    });
  });

  describe("idempotency and debounce", () => {
    it("adds no events and rewrites no snapshot rows on a second run", async () => {
      const spy = plannerTestSpyOnBatch(rt.db);
      const project = await createProject(rt.db, rt.user, { name: "P" });
      const a = await createTask(rt.db, rt.user, USER, {
        title: "A",
        project_id: project.id,
      });
      await createTask(rt.db, rt.user, AGENT, { title: "B" });
      await updateTask(rt.db, rt.user, USER, a.id, { status: "in_progress" });
      const deleted = await createTask(rt.db, rt.user, USER, { title: "C" });
      await deleteTask(rt.db, rt.user, deleted.id);

      const changesOf = (batch: Array<{ meta?: { changes?: number } }>) =>
        Object.fromEntries(
          plannerSyncBatchSteps.map((step, index) => [
            step,
            batch[index]?.meta?.changes ?? 0,
          ]),
        );

      await plannerSyncHistory(spy.db, { userId: rt.user.id, now: T0 });
      const first = changesOf(spy.batches[0] ?? []);
      // 4 activity rows (3 created + 1 status change), 1 sync `deleted`, 3
      // snapshot rows. Every task has a `created` activity, so none is synced.
      expect(first.copy_activity).toBe(4);
      expect(first.deleted).toBe(1);
      expect(first.created).toBe(0);
      expect(first.snapshot).toBe(3);
      const eventsAfterFirst = await plannerTestCount(
        rt.database,
        "planner_task_event",
      );
      expect(eventsAfterFirst).toBe(5);
      const seenBefore = await plannerTestRows(
        rt.database,
        "SELECT * FROM planner_task_seen ORDER BY task_id",
      );

      await plannerSyncHistory(spy.db, {
        userId: rt.user.id,
        now: plannerTestAt(T0, 5),
      });
      expect(spy.batches).toHaveLength(2);
      expect(changesOf(spy.batches[1] ?? [])).toEqual({
        copy_activity: 0,
        // The state row's last_sync_at moves on every run: that is the debounce clock.
        state: 1,
        restored: 0,
        deleted: 0,
        purged: 0,
        purge_plans: 0,
        purge_seen: 0,
        created: 0,
        snapshot: 0,
        orphan_nodes: 0,
      });
      expect(await plannerTestCount(rt.database, "planner_task_event")).toBe(
        eventsAfterFirst,
      );
      // Not even last_seen_at moved.
      expect(
        await plannerTestRows(
          rt.database,
          "SELECT * FROM planner_task_seen ORDER BY task_id",
        ),
      ).toEqual(seenBefore);
    });

    it("rewrites only the snapshot rows whose tracked fields changed", async () => {
      const spy = plannerTestSpyOnBatch(rt.db);
      const a = await createTask(rt.db, rt.user, USER, { title: "A" });
      await createTask(rt.db, rt.user, USER, { title: "B" });
      await plannerSyncHistory(spy.db, { userId: rt.user.id, now: T0 });

      // due_at is not a snapshot field; the title is.
      await updateTask(rt.db, rt.user, USER, a.id, {
        due_at: "2026-10-09",
        title: "A renamed",
      });
      await plannerSyncHistory(spy.db, {
        userId: rt.user.id,
        now: plannerTestAt(T0, 1),
      });
      const snapshotIndex = plannerSyncBatchSteps.indexOf("snapshot");
      expect(spy.batches[1]?.[snapshotIndex]?.meta?.changes).toBe(1);
      const [seen] = await plannerTestRows<{ title: string }>(
        rt.database,
        "SELECT title FROM planner_task_seen WHERE task_id = ?",
        a.id,
      );
      expect(seen?.title).toBe("A renamed");
    });

    it("skips a sync under 30 seconds after the last one", async () => {
      const spy = plannerTestSpyOnBatch(rt.db);
      await createTask(rt.db, rt.user, USER, { title: "First" });
      await plannerSyncHistory(spy.db, { userId: rt.user.id, now: T0 });
      expect(spy.batches).toHaveLength(1);

      await createTask(rt.db, rt.user, USER, { title: "Second" });
      const justUnder = new Date(T0.getTime() + plannerSyncDebounceMs - 1);
      expect(
        await plannerSyncHistory(spy.db, {
          userId: rt.user.id,
          now: justUnder,
        }),
      ).toEqual({ history: "ok" });
      expect(spy.batches).toHaveLength(1);
      expect(await plannerTestCount(rt.database, "planner_task_event")).toBe(1);
      expect((await state())?.last_sync_at).toBe(T0.toISOString());

      const exactly = new Date(T0.getTime() + plannerSyncDebounceMs);
      await plannerSyncHistory(spy.db, { userId: rt.user.id, now: exactly });
      expect(spy.batches).toHaveLength(2);
      expect(await plannerTestCount(rt.database, "planner_task_event")).toBe(2);
    });

    it("returns the stored status while debounced, paused included", async () => {
      await sync(0);
      await plannerTestRun(
        rt.database,
        "UPDATE planner_sync_state SET status = 'paused', paused_reason = 'x' WHERE user_id = ?",
        rt.user.id,
      );
      expect(
        await plannerSyncHistory(rt.db, {
          userId: rt.user.id,
          now: new Date(T0.getTime() + 10_000),
        }),
      ).toEqual({ history: "paused" });
      // Past the debounce it syncs again and clears the pause.
      expect(await sync(1)).toEqual({ history: "ok" });
      expect(await state()).toMatchObject({
        status: "ok",
        paused_reason: null,
      });
    });

    it("does not let a last_sync_at in the future block syncing", async () => {
      const spy = plannerTestSpyOnBatch(rt.db);
      await plannerSyncHistory(spy.db, { userId: rt.user.id, now: T0 });
      await plannerTestRun(
        rt.database,
        "UPDATE planner_sync_state SET last_sync_at = ? WHERE user_id = ?",
        plannerTestAt(T0, 60).toISOString(),
        rt.user.id,
      );
      await createTask(rt.db, rt.user, USER, { title: "Later" });
      await plannerSyncHistory(spy.db, {
        userId: rt.user.id,
        now: plannerTestAt(T0, 1),
      });
      expect(spy.batches).toHaveLength(2);
      expect(await plannerTestCount(rt.database, "planner_task_event")).toBe(1);
    });

    it("never throws, even for a clock it cannot read", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      await expect(
        plannerSyncHistory(rt.db, {
          userId: rt.user.id,
          now: new Date(Number.NaN),
        }),
      ).resolves.toEqual({ history: "paused" });
    });
  });

  describe("selection window", () => {
    it("archives rows that arrive after an upstream rebuild restarts the ids", async () => {
      const task = await createTask(rt.db, rt.user, USER, {
        title: "Survivor",
      });
      for (let index = 0; index < 3; index += 1) {
        await updateTask(rt.db, rt.user, USER, task.id, {
          notes: `note ${index}`,
        });
      }
      await sync(0);
      const before = await state();
      expect(before?.activity_last_id).toBeGreaterThanOrEqual(4);

      // A rebuild wipes task_activity and restarts its ids at 1.
      await plannerTestRun(rt.database, "DELETE FROM task_activity");
      await plannerTestRun(
        rt.database,
        "DELETE FROM sqlite_sequence WHERE name = 'task_activity'",
      );
      await updateTask(rt.db, rt.user, AGENT, task.id, { title: "Renamed" });
      const [restarted] = await plannerTestRows<{ id: number }>(
        rt.database,
        "SELECT id FROM task_activity",
      );
      expect(restarted?.id).toBe(1);
      expect(restarted?.id).toBeLessThan(before?.activity_last_id ?? 0);

      await sync(1);

      // The id clause misses it; the time window before the watermark catches it.
      expect(await plannerTestTypes(rt.database, task.id)).toEqual([
        "created",
        "updated",
        "updated",
        "updated",
        "updated",
      ]);
      const after = await state();
      // The last id follows the table down; the watermark never goes back.
      expect(after?.activity_last_id).toBe(1);
      expect(
        (after?.activity_watermark ?? "") >= (before?.activity_watermark ?? ""),
      ).toBe(true);
    });

    it("looks back exactly ten minutes before the watermark", async () => {
      const task = await createTask(rt.db, rt.user, USER, { title: "Edge" });
      for (let index = 0; index < 3; index += 1) {
        await updateTask(rt.db, rt.user, USER, task.id, {
          notes: `note ${index}`,
        });
      }
      await sync(0);
      const synced = await state();
      const watermark = Date.parse(synced?.activity_watermark ?? "");
      const inside = new Date(watermark - 10 * 60_000).toISOString();
      const outside = new Date(watermark - 10 * 60_000 - 1).toISOString();
      const archived = await plannerTestCount(
        rt.database,
        "planner_task_event",
      );

      // Free two ids at or below the last id, then reuse them for rows whose
      // ids the id clause cannot see.
      const [first, second] = await plannerTestRows<{ id: number }>(
        rt.database,
        "SELECT id FROM task_activity ORDER BY id LIMIT 2",
      );
      await plannerTestRun(
        rt.database,
        "DELETE FROM task_activity WHERE id IN (?, ?)",
        first?.id,
        second?.id,
      );
      await plannerTestInsertActivity(rt.database, {
        id: first?.id,
        taskId: task.id,
        userId: rt.user.id,
        action: "updated",
        changes: { marker: "outside" },
        createdAt: outside,
      });
      await plannerTestInsertActivity(rt.database, {
        id: second?.id,
        taskId: task.id,
        userId: rt.user.id,
        action: "updated",
        changes: { marker: "inside" },
        createdAt: inside,
      });

      await sync(1);

      const markers = (await plannerTestEvents(rt.database, task.id))
        .map((event) => JSON.parse(event.data) as { marker?: string })
        .map((data) => data.marker)
        .filter(Boolean);
      expect(markers).toEqual(["inside"]);
      expect(await plannerTestCount(rt.database, "planner_task_event")).toBe(
        archived + 1,
      );
    });

    it("treats a sync that saw an empty table as having seen nothing", async () => {
      await sync(0);
      expect(await state()).toMatchObject({
        activity_last_id: null,
        activity_watermark: null,
        status: "ok",
      });
      const task = await createTask(rt.db, rt.user, USER, { title: "After" });
      await sync(1);
      expect(await plannerTestTypes(rt.database, task.id)).toEqual(["created"]);
    });
  });

  describe("snapshot diff", () => {
    it("records delete, restore and purge, and the purge title comes from the snapshot", async () => {
      const task = await createTask(rt.db, rt.user, USER, {
        title: "Pay rent",
      });
      await sync(0);
      expect(await plannerTestTypes(rt.database, task.id)).toEqual(["created"]);

      await deleteTask(rt.db, rt.user, task.id);
      const deletedAt = (await taskRow(task.id))?.deleted_at ?? "";
      await sync(1);
      const [deleted] = (await plannerTestEvents(rt.database, task.id)).filter(
        (event) => event.type === "deleted",
      );
      expect(deleted).toMatchObject({
        source: "sync",
        source_ref: `del:${task.id}@${deletedAt}`,
        occurred_at: deletedAt,
        task_title: "Pay rent",
        actor_type: null,
        actor_name: null,
      });

      await restoreTask(rt.db, rt.user, task.id);
      await sync(2);
      const [restored] = (await plannerTestEvents(rt.database, task.id)).filter(
        (event) => event.type === "restored",
      );
      expect(restored).toMatchObject({
        source: "sync",
        source_ref: `res:${task.id}@${deletedAt}`,
        occurred_at: plannerTestAt(T0, 2).toISOString(),
        task_title: "Pay rent",
      });
      expect(JSON.parse(restored?.data ?? "{}")).toEqual({ detected: true });

      // A rename after the last sync, then a purge before the next one: the
      // purge event carries the title the snapshot last saw.
      await updateTask(rt.db, rt.user, USER, task.id, {
        title: "Pay rent late",
      });
      await sync(3);
      await deleteTask(rt.db, rt.user, task.id);
      await sync(4);
      await plannerTestRun(
        rt.database,
        "INSERT INTO planner_task_plan (task_id, user_id, horizon, period_start, carry_count, created_at, updated_at) VALUES (?, ?, 'day', '2026-10-05', 0, ?, ?)",
        task.id,
        rt.user.id,
        T0.toISOString(),
        T0.toISOString(),
      );
      await purge(task.id);
      await sync(5);

      const events = await plannerTestEvents(rt.database, task.id);
      expect(events.map((event) => event.type)).toEqual([
        "created",
        "deleted",
        "restored",
        "updated",
        "deleted",
        "purged",
      ]);
      const purged = events.at(-1);
      expect(purged).toMatchObject({
        source: "sync",
        source_ref: `pur:${task.id}`,
        task_title: "Pay rent late",
        occurred_at: plannerTestAt(T0, 5).toISOString(),
      });
      expect(JSON.parse(purged?.data ?? "{}")).toEqual({ detected: true });
      // Plan and snapshot go with the task; the archive stays.
      expect(await plannerTestCount(rt.database, "planner_task_plan")).toBe(0);
      expect(await plannerTestCount(rt.database, "planner_task_seen")).toBe(0);

      // And it stays gone: nothing new on the next run.
      await sync(6);
      expect(await plannerTestCount(rt.database, "planner_task_event")).toBe(6);
    });

    it("records a delete and a purge that happen before the next sync as the purge alone", async () => {
      const task = await createTask(rt.db, rt.user, USER, {
        title: "Fleeting",
      });
      await sync(0);
      await deleteTask(rt.db, rt.user, task.id);
      await purge(task.id);
      await sync(1);
      // The known gap: no `deleted` event, but the history is not lost.
      expect(await plannerTestTypes(rt.database, task.id)).toEqual([
        "created",
        "purged",
      ]);
    });

    it("records a task created and deleted between two syncs", async () => {
      const task = await createTask(rt.db, rt.user, USER, { title: "Oops" });
      await deleteTask(rt.db, rt.user, task.id);
      const deletedAt = (await taskRow(task.id))?.deleted_at ?? "";

      await sync(0);

      const events = await plannerTestEvents(rt.database, task.id);
      expect(events.map((event) => [event.type, event.source])).toEqual([
        ["created", "activity"],
        ["deleted", "sync"],
      ]);
      expect(events[1]?.occurred_at).toBe(deletedAt);
    });

    it("records deleted, restored, then deleted again across separate syncs", async () => {
      const task = await createTask(rt.db, rt.user, USER, { title: "Yo-yo" });
      await sync(0);

      await deleteTask(rt.db, rt.user, task.id);
      const first = (await taskRow(task.id))?.deleted_at ?? "";
      await sync(1);
      await restoreTask(rt.db, rt.user, task.id);
      await sync(2);
      await tick();
      await deleteTask(rt.db, rt.user, task.id);
      const second = (await taskRow(task.id))?.deleted_at ?? "";
      expect(second).not.toBe(first);
      await sync(3);

      const events = await plannerTestEvents(rt.database, task.id);
      expect(events.map((event) => [event.type, event.source_ref])).toEqual([
        ["created", expect.stringMatching(/^a:/)],
        ["deleted", `del:${task.id}@${first}`],
        ["restored", `res:${task.id}@${first}`],
        ["deleted", `del:${task.id}@${second}`],
      ]);
    });

    it("records a restore and a second delete that happen before one sync as both", async () => {
      const task = await createTask(rt.db, rt.user, USER, { title: "Twice" });
      await sync(0);
      await deleteTask(rt.db, rt.user, task.id);
      const first = (await taskRow(task.id))?.deleted_at ?? "";
      await sync(1);

      await restoreTask(rt.db, rt.user, task.id);
      await tick();
      await deleteTask(rt.db, rt.user, task.id);
      const second = (await taskRow(task.id))?.deleted_at ?? "";
      await sync(2);

      const events = await plannerTestEvents(rt.database, task.id);
      // Restored is detected before deleted, so it archives first.
      expect(
        events.slice(-2).map((event) => [event.type, event.source_ref]),
      ).toEqual([
        ["restored", `res:${task.id}@${first}`],
        ["deleted", `del:${task.id}@${second}`],
      ]);
      await sync(3);
      expect(await plannerTestCount(rt.database, "planner_task_event")).toBe(
        events.length,
      );
    });

    it("skips a synced delete when upstream already logged a matching deleted event", async () => {
      const task = await createTask(rt.db, rt.user, USER, { title: "Future" });
      await deleteTask(rt.db, rt.user, task.id);
      const deletedAt = (await taskRow(task.id))?.deleted_at ?? "";
      // A hypothetical future upstream `deleted` action, stamped with the same time.
      await plannerTestInsertActivity(rt.database, {
        taskId: task.id,
        userId: rt.user.id,
        action: "deleted",
        changes: {},
        createdAt: deletedAt,
      });

      await sync(0);

      const events = await plannerTestEvents(rt.database, task.id);
      expect(events.filter((event) => event.type === "deleted")).toHaveLength(
        1,
      );
      expect(events.find((event) => event.type === "deleted")?.source).toBe(
        "activity",
      );
    });

    it("syncs a created event, with a baseline, for a task that has no activity", async () => {
      const project = await createProject(rt.db, rt.user, { name: "Imported" });
      const bare = await plannerTestInsertTask(rt.database, {
        id: "tasks/bare",
        userId: rt.user.id,
        title: "No trail",
        status: "in_progress",
        dueAt: "2020-03-05",
        projectId: project.id,
        createdAt: "2020-03-01T08:00:00.000Z",
      });
      const normal = await createTask(rt.db, rt.user, USER, {
        title: "Normal",
      });

      await sync(0);

      const events = await plannerTestEvents(rt.database, bare);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "created",
        source: "sync",
        source_ref: `new:${bare}`,
        occurred_at: "2020-03-01T08:00:00.000Z",
        actor_type: null,
        actor_name: null,
        task_title: "No trail",
      });
      expect(JSON.parse(events[0]?.data ?? "{}")).toEqual({
        status: "in_progress",
        project_id: project.id,
        due_at: "2020-03-05",
      });
      // A task with an activity `created` gets no second one.
      expect(await plannerTestTypes(rt.database, normal.id)).toEqual([
        "created",
      ]);
      await sync(1);
      expect(await plannerTestTypes(rt.database, bare)).toEqual(["created"]);
    });

    it("removes the node of a purged project and un-parents its children", async () => {
      const parent = await createProject(rt.db, rt.user, { name: "Goal" });
      const child = await createProject(rt.db, rt.user, { name: "Milestone" });
      const grandchild = await createProject(rt.db, rt.user, { name: "Step" });
      const insertNode = (id: string, parentId: string | null) =>
        plannerTestRun(
          rt.database,
          "INSERT INTO planner_project_node (project_id, user_id, parent_project_id, sort_order, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)",
          id,
          rt.user.id,
          parentId,
          T0.toISOString(),
          T0.toISOString(),
        );
      await insertNode(parent.id, null);
      await insertNode(child.id, parent.id);
      await insertNode(grandchild.id, child.id);

      await plannerTestRun(
        rt.database,
        "UPDATE projects SET deleted_at = '2026-01-01T00:00:00.000Z' WHERE id = ?",
        parent.id,
      );
      await plannerTestRun(
        rt.database,
        "DELETE FROM projects WHERE id = ?",
        parent.id,
      );
      await sync(0);

      const nodes = await plannerTestRows<{
        project_id: string;
        parent_project_id: string | null;
      }>(
        rt.database,
        "SELECT project_id, parent_project_id FROM planner_project_node ORDER BY project_id",
      );
      expect(
        nodes.find((node) => node.project_id === parent.id),
      ).toBeUndefined();
      expect(nodes.find((node) => node.project_id === child.id)).toMatchObject({
        parent_project_id: null,
      });
      expect(
        nodes.find((node) => node.project_id === grandchild.id),
      ).toMatchObject({ parent_project_id: child.id });
    });

    it("keeps the node of a soft-deleted project", async () => {
      const project = await createProject(rt.db, rt.user, { name: "Binned" });
      await plannerTestRun(
        rt.database,
        "INSERT INTO planner_project_node (project_id, user_id, sort_order, created_at, updated_at) VALUES (?, ?, 0, ?, ?)",
        project.id,
        rt.user.id,
        T0.toISOString(),
        T0.toISOString(),
      );
      await plannerTestRun(
        rt.database,
        "UPDATE projects SET deleted_at = ? WHERE id = ?",
        T0.toISOString(),
        project.id,
      );
      await sync(0);
      expect(await plannerTestCount(rt.database, "planner_project_node")).toBe(
        1,
      );
    });
  });

  describe("bundle import", () => {
    const importedBundle = () =>
      importBundleSchema.parse({
        version: 5,
        memos: [],
        projects: [
          {
            name: "projects/imp-p",
            title: "Imported project",
            description: null,
            status: "active",
            deleted_at: null,
            created_at: "2019-01-01T00:00:00.000Z",
            updated_at: "2019-01-01T00:00:00.000Z",
          },
        ],
        tasks: [
          {
            name: "tasks/imp-t1",
            project_id: "projects/imp-p",
            source_memo_id: null,
            title: "Imported task",
            notes: null,
            status: "done",
            priority: "none",
            due_at: "2019-02-01",
            sort_order: 0,
            completed_at: "2019-01-05T00:00:00.000Z",
            deleted_at: null,
            created_at: "2019-01-01T00:00:00.000Z",
            updated_at: "2019-01-05T00:00:00.000Z",
          },
        ],
        task_activity: [
          {
            task_id: "tasks/imp-t1",
            actor_type: "user",
            actor_name: null,
            action: "created",
            changes: {
              project_id: "projects/imp-p",
              title: "Imported task",
              status: "todo",
            },
            created_at: "2019-01-01T00:00:00.000Z",
          },
          {
            task_id: "tasks/imp-t1",
            actor_type: "agent",
            actor_name: "pat:import01",
            action: "status_changed",
            changes: {
              status: "done",
              completed_at: "2019-01-05T00:00:00.000Z",
            },
            created_at: "2019-01-05T00:00:00.000Z",
          },
        ],
      });

    it("archives back-dated activity that the real import path writes", async () => {
      await createTask(rt.db, rt.user, USER, { title: "Before the import" });
      await sync(0);
      const watermark = (await state())?.activity_watermark ?? "";
      expect(watermark > "2019-12-31").toBe(true);

      const result = await importData(rt.db, rt.user, importedBundle());
      expect(result.imported_task_activity).toBe(2);
      await sync(1);

      const events = await plannerTestEvents(rt.database, "tasks/imp-t1");
      expect(
        events.map((event) => [
          event.type,
          event.source,
          event.actor_name,
          event.occurred_at,
        ]),
      ).toEqual([
        ["created", "activity", null, "2019-01-01T00:00:00.000Z"],
        [
          "status_changed",
          "activity",
          "pat:import01",
          "2019-01-05T00:00:00.000Z",
        ],
      ]);
      // Its activity `created` is in the archive, so no synced one is added.
      expect(events.some((event) => event.source === "sync")).toBe(false);
    });

    it("does not duplicate the archive when a skip-mode import replays the activity", async () => {
      await importData(rt.db, rt.user, importedBundle());
      await sync(0);
      const archived = await plannerTestCount(
        rt.database,
        "planner_task_event",
      );
      expect(archived).toBe(2);

      // Skip mode keeps the existing task but still replays its activity rows
      // with new ids, so upstream now holds every row twice.
      await importData(rt.db, rt.user, importedBundle(), { conflict: "skip" });
      expect(await plannerTestCount(rt.database, "task_activity")).toBe(4);
      await sync(1);

      expect(await plannerTestCount(rt.database, "planner_task_event")).toBe(
        archived,
      );
    });
  });

  describe("compatibility guards", () => {
    it("keeps every required column inside Drizzle's columns for the same tables", () => {
      const drizzle = {
        tasks: getTableColumns(tasks),
        task_activity: getTableColumns(taskActivity),
        projects: getTableColumns(projects),
      };
      for (const [table, columns] of Object.entries(plannerRequiredColumns)) {
        const known = Object.values(drizzle[table as keyof typeof drizzle]).map(
          (column) => column.name,
        );
        for (const column of columns) {
          expect(known, `${table}.${column}`).toContain(column);
        }
      }
      // Nothing is required twice.
      for (const columns of Object.values(plannerRequiredColumns)) {
        expect(new Set(columns).size).toBe(columns.length);
      }
    });

    it("derives the known action and status sets from upstream's enums", () => {
      expect([...plannerKnownActivityActions]).toEqual([
        ...taskActivity.action.enumValues,
      ]);
      expect([...plannerKnownTaskStatuses]).toEqual([
        ...tasks.status.enumValues,
      ]);
      expect(plannerKnownActivityActions).toEqual(
        expect.arrayContaining(["created", "updated", "status_changed"]),
      );
      expect(plannerKnownTaskStatuses).toEqual(["todo", "in_progress", "done"]);
    });

    it("finds no missing column in the real schema, and names the ones that are", async () => {
      expect(await plannerFindMissingColumns(rt.db)).toEqual([]);
      expect(
        await plannerFindMissingColumns(rt.db, {
          tasks: ["id", "nope"],
          ghost: ["x"],
        }),
      ).toEqual(["tasks.nope", "ghost.x"]);
    });

    it("keeps syncing but records a warning when it meets an unknown action or status", async () => {
      const task = await createTask(rt.db, rt.user, USER, { title: "Known" });
      const odd = await plannerTestInsertTask(rt.database, {
        id: "tasks/odd",
        userId: rt.user.id,
        title: "Odd one",
        status: "blocked",
        createdAt: "2026-09-01T00:00:00.000Z",
      });
      await plannerTestInsertActivity(rt.database, {
        taskId: task.id,
        userId: rt.user.id,
        action: "archived",
        changes: { why: "future upstream" },
        createdAt: "2026-10-01T00:00:00.000Z",
      });

      expect(await sync(0)).toEqual({ history: "ok" });

      const synced = await state();
      expect(synced?.status).toBe("ok");
      expect(synced?.paused_reason).toContain(
        "unknown task_activity actions: archived",
      );
      expect(synced?.paused_reason).toContain("unknown task statuses: blocked");
      // The unknown action is archived like any other, and the odd task is seen.
      expect((await plannerTestTypes(rt.database, task.id)).sort()).toEqual([
        "archived",
        "created",
      ]);
      expect(await plannerTestTypes(rt.database, odd)).toEqual(["created"]);

      // The warning lasts while the drift does, and clears with it.
      await sync(1);
      expect((await state())?.paused_reason).toContain("blocked");
      await plannerTestRun(
        rt.database,
        "DELETE FROM tasks WHERE id = 'tasks/odd'",
      );
      await plannerTestRun(
        rt.database,
        "DELETE FROM task_activity WHERE action = 'archived'",
      );
      await sync(2);
      expect(await state()).toMatchObject({
        status: "ok",
        paused_reason: null,
      });
    });
  });
});
