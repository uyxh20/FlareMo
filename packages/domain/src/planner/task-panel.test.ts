import type { PlannerHorizon } from "@flaremo/contracts";
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
import { NotFoundError, ValidationError } from "../errors";
import { createProject, deleteProject } from "../projects";
import {
  createTask,
  deleteTask,
  listTaskActivity,
  type TaskActor,
  updateTask,
} from "../tasks";
import { plannerReadBoard } from "./board";
import { plannerAddComment } from "./comments";
import { plannerReadTaskHistory } from "./history-read";
import { plannerSyncHistory } from "./history-sync";
import {
  plannerApplyColumnMove,
  plannerCreateTask,
  plannerDropTask,
  plannerNormalizeEffort,
  plannerSetEffort,
  plannerSetPlan,
} from "./plans";
import { plannerReadTaskDetail } from "./task-detail";
import {
  type PlannerTestRuntime,
  plannerTestComments,
  plannerTestCount,
  plannerTestEvents,
  plannerTestFailBatch,
  plannerTestInsertComment,
  plannerTestInsertNode,
  plannerTestPlan,
  plannerTestRuntime,
} from "./test-support";
import { plannerUpsertProjectNode } from "./tree";

// The task panel's domain functions (fork-owned add-on,
// docs/planning-cockpit-implementation-plan.md, section 13): reading one task
// whole, setting its effort, and creating a task straight in a column.

const USER: TaskActor = { type: "user" };
const AGENT: TaskActor = { type: "agent", name: "pat:abcd1234" };

// 2026-10-07 is a Wednesday, so this week starts on Monday 2026-10-05.
const TODAY = "2026-10-07";
const NOW = new Date("2026-10-07T09:00:00.000Z");
const THIS_WEEK = "2026-10-05";

describe("planner task panel", () => {
  let rt: PlannerTestRuntime;

  beforeAll(async () => {
    rt = await plannerTestRuntime("flaremo-planner-task-panel");
  });
  afterAll(async () => {
    await rt.dispose();
  });
  beforeEach(async () => {
    await rt.reset();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const newTask = (title = "Task", extra: Record<string, unknown> = {}) =>
    createTask(rt.db, rt.user, USER, { title, ...extra });

  const plannerEvents = async (taskId: string) =>
    (await plannerTestEvents(rt.database, taskId)).filter(
      (event) => event.source === "planner",
    );

  const effortOf = async (taskId: string) =>
    (await plannerTestPlan(rt.database, taskId))?.effort;

  // ===========================================================================
  // plannerNormalizeEffort
  // ===========================================================================

  describe("plannerNormalizeEffort", () => {
    it("accepts null and the numbers from 0 to 999 with at most one decimal", () => {
      expect(plannerNormalizeEffort(null)).toBeNull();
      for (const value of [0, 0.5, 1, 3, 3.5, 12.3, 998.9, 999]) {
        expect(plannerNormalizeEffort(value), String(value)).toBe(value);
      }
    });

    it("returns the clean value, without float noise or a negative zero", () => {
      // 0.1 + 0.2 is 0.30000000000000004: a client that adds before it sends.
      expect(plannerNormalizeEffort(0.1 + 0.2)).toBe(0.3);
      expect(plannerNormalizeEffort(1.1)).toBe(1.1);
      expect(Object.is(plannerNormalizeEffort(-0), 0)).toBe(true);
    });

    it("rejects a number out of range, with more than one decimal, or that is not a number", () => {
      for (const value of [
        -0.1,
        -1,
        999.1,
        1000,
        3.25,
        0.05,
        1e-7,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
        "3",
        "",
        undefined,
        true,
        {},
      ]) {
        expect(() => plannerNormalizeEffort(value), String(value)).toThrowError(
          ValidationError,
        );
      }
    });
  });

  // ===========================================================================
  // plannerSetEffort
  // ===========================================================================

  describe("plannerSetEffort", () => {
    const setEffort = (
      taskId: string,
      effort: number | null,
      actor: TaskActor = USER,
    ) =>
      plannerSetEffort(rt.db, {
        user: rt.user,
        actor,
        taskId,
        effort,
        now: NOW,
      });

    it("gives a task with no plan a plan row with a NULL horizon that holds the effort, and writes effort_changed", async () => {
      const task = await newTask("Estimate me");
      const activityBefore = await listTaskActivity(rt.db, rt.user, task.id);

      const result = await setEffort(task.id, 3, AGENT);

      expect(result.plan).toMatchObject({
        task_id: task.id,
        horizon: null,
        period_start: null,
        carry_count: 0,
        dropped_at: null,
        effort: 3,
      });
      expect(await plannerTestPlan(rt.database, task.id)).toMatchObject({
        user_id: rt.user.id,
        horizon: null,
        period_start: null,
        effort: 3,
        created_at: NOW.toISOString(),
        updated_at: NOW.toISOString(),
      });

      const events = await plannerEvents(task.id);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "effort_changed",
        source: "planner",
        source_ref: null,
        actor_type: "agent",
        actor_name: "pat:abcd1234",
        task_title: "Estimate me",
        occurred_at: NOW.toISOString(),
        created_at: NOW.toISOString(),
      });
      expect(JSON.parse(events[0]?.data ?? "{}")).toEqual({
        from: null,
        to: 3,
      });

      // The task row is untouched: effort goes through no upstream service.
      expect(result.task.updated_at).toBe(task.updated_at);
      expect(await listTaskActivity(rt.db, rt.user, task.id)).toEqual(
        activityBefore,
      );
    });

    it("still counts the task as Backlog: a NULL horizon plans nothing", async () => {
      const task = await newTask("Backlog with effort");
      await setEffort(task.id, 2.5);

      const board = await plannerReadBoard(rt.db, {
        userId: rt.user.id,
        today: TODAY,
      });
      expect(board.columns.backlog.map((card) => card.title)).toEqual([
        "Backlog with effort",
      ]);
      expect(board.columns.todo).toEqual([]);
    });

    it("changes and clears the estimate, with {from, to} each time", async () => {
      const task = await newTask();
      await setEffort(task.id, 3);
      await setEffort(task.id, 5.5);
      const cleared = await setEffort(task.id, null);

      expect(cleared.plan?.effort).toBeNull();
      expect(await effortOf(task.id)).toBeNull();
      expect(
        (await plannerEvents(task.id)).map((event) => [
          event.type,
          JSON.parse(event.data),
        ]),
      ).toEqual([
        ["effort_changed", { from: null, to: 3 }],
        ["effort_changed", { from: 3, to: 5.5 }],
        ["effort_changed", { from: 5.5, to: null }],
      ]);
    });

    it("accepts 0, which is an estimate and not the same as none", async () => {
      const task = await newTask();
      const result = await setEffort(task.id, 0);
      expect(result.plan?.effort).toBe(0);
      expect(
        JSON.parse((await plannerEvents(task.id))[0]?.data ?? "{}"),
      ).toEqual({ from: null, to: 0 });
    });

    it("writes nothing when the effort already is what was asked", async () => {
      const task = await newTask();
      // Clearing an effort that was never set creates no row and no event.
      await setEffort(task.id, null);
      expect(await plannerTestPlan(rt.database, task.id)).toBeUndefined();
      expect(await plannerEvents(task.id)).toEqual([]);

      await setEffort(task.id, 4);
      const before = await plannerTestPlan(rt.database, task.id);
      const events = (await plannerEvents(task.id)).length;
      await plannerSetEffort(rt.db, {
        user: rt.user,
        actor: USER,
        taskId: task.id,
        effort: 4,
        now: new Date("2026-10-08T09:00:00.000Z"),
      });
      expect(await plannerTestPlan(rt.database, task.id)).toEqual(before);
      expect(await plannerEvents(task.id)).toHaveLength(events);
    });

    it("keeps the plan, the carry count and the effort apart: each survives the others", async () => {
      const task = await newTask("Planned and estimated");
      await plannerSetPlan(rt.db, {
        user: rt.user,
        actor: USER,
        taskId: task.id,
        plan: { horizon: "week", day: TODAY },
        today: TODAY,
        now: NOW,
      });
      await rt.database
        .prepare(
          "UPDATE planner_task_plan SET carry_count = 2 WHERE task_id = ?",
        )
        .bind(task.id)
        .run();

      await setEffort(task.id, 8);
      expect(await plannerTestPlan(rt.database, task.id)).toMatchObject({
        horizon: "week",
        period_start: THIS_WEEK,
        carry_count: 2,
        effort: 8,
      });

      // Re-planning and unplanning leave the estimate where it is.
      await plannerSetPlan(rt.db, {
        user: rt.user,
        actor: USER,
        taskId: task.id,
        plan: { horizon: "month", day: TODAY },
        today: TODAY,
        now: NOW,
      });
      expect(await effortOf(task.id)).toBe(8);
      await plannerSetPlan(rt.db, {
        user: rt.user,
        actor: USER,
        taskId: task.id,
        plan: null,
        today: TODAY,
        now: NOW,
      });
      expect(await plannerTestPlan(rt.database, task.id)).toMatchObject({
        horizon: null,
        period_start: null,
        effort: 8,
      });
    });

    it("lets a backlog task that holds only an effort be planned and moved as usual", async () => {
      const task = await newTask("Estimated first");
      await setEffort(task.id, 3);

      const moved = await plannerApplyColumnMove(rt.db, {
        user: rt.user,
        actor: USER,
        taskId: task.id,
        to: "todo",
        today: TODAY,
        now: NOW,
      });

      // A row with no horizon is the backlog, so this is Backlog to To Do.
      expect(moved.from).toBe("backlog");
      expect(moved.plan).toMatchObject({
        horizon: "week",
        period_start: THIS_WEEK,
        effort: 3,
      });
      expect((await plannerEvents(task.id)).map((event) => event.type)).toEqual(
        ["effort_changed", "planned"],
      );
      // The `planned` event's `from` is "no plan", not the effort-only row.
      expect(
        JSON.parse((await plannerEvents(task.id))[1]?.data ?? "{}"),
      ).toEqual({
        from: { horizon: null, period_start: null },
        to: { horizon: "week", period_start: THIS_WEEK },
      });
    });

    it("is allowed on a dropped task, which it does not move", async () => {
      const task = await newTask();
      await plannerDropTask(rt.db, {
        user: rt.user,
        actor: USER,
        taskId: task.id,
        now: NOW,
      });
      const result = await setEffort(task.id, 1.5);
      expect(result.plan).toMatchObject({ effort: 1.5 });
      expect(result.plan?.dropped_at).not.toBeNull();
    });

    it("rejects an invalid effort with a 400 and writes nothing", async () => {
      const task = await newTask();
      for (const effort of [-1, 1000, 2.25, Number.NaN]) {
        await expect(
          setEffort(task.id, effort),
          String(effort),
        ).rejects.toBeInstanceOf(ValidationError);
      }
      expect(await plannerTestPlan(rt.database, task.id)).toBeUndefined();
      expect(await plannerTestCount(rt.database, "planner_task_event")).toBe(0);
    });

    it("is a 404 for a task that is missing, deleted or someone else's, and writes nothing", async () => {
      const mine = await newTask("Mine");
      const theirs = await createTask(rt.db, rt.other, USER, {
        title: "Theirs",
      });
      const gone = await newTask("Binned");
      await deleteTask(rt.db, rt.user, gone.id);

      for (const taskId of ["tasks/no-such-task", theirs.id, gone.id]) {
        await expect(setEffort(taskId, 3), taskId).rejects.toBeInstanceOf(
          NotFoundError,
        );
      }
      expect(await plannerTestCount(rt.database, "planner_task_plan")).toBe(0);
      expect(await plannerTestCount(rt.database, "planner_task_event")).toBe(0);
      expect(await effortOf(mine.id)).toBeUndefined();
    });

    it("accepts a bare or a namespaced task id", async () => {
      const task = await newTask();
      const bare = task.id.replace(/^tasks\//, "");
      await setEffort(bare, 1);
      await setEffort(task.id, 2);
      expect(await effortOf(task.id)).toBe(2);
    });

    it("writes the plan row and the event in one batch: a failed event leaves no row", async () => {
      const task = await newTask();
      const failing = plannerTestFailBatch(rt.db, (texts) =>
        texts.some((text) => text.includes('"planner_task_event"')),
      );

      await expect(
        plannerSetEffort(failing, {
          user: rt.user,
          actor: USER,
          taskId: task.id,
          effort: 3,
          now: NOW,
        }),
      ).rejects.toThrow(/injected failure/);

      expect(await plannerTestPlan(rt.database, task.id)).toBeUndefined();
      expect(await plannerTestCount(rt.database, "planner_task_event")).toBe(0);
    });

    it("shows up in the task's history as an effort_changed event", async () => {
      const task = await newTask();
      await setEffort(task.id, 3);
      await plannerSyncHistory(rt.db, { userId: rt.user.id, now: NOW });
      const history = await plannerReadTaskHistory(rt.db, {
        userId: rt.user.id,
        taskId: task.id,
      });
      expect(history.map((entry) => entry.type)).toEqual([
        "effort_changed",
        "created",
      ]);
      expect(history[0]).toMatchObject({
        source: "planner",
        data: { from: null, to: 3 },
        actor_type: "user",
      });
    });
  });

  // ===========================================================================
  // plannerCreateTask with a column
  // ===========================================================================

  describe("plannerCreateTask with a column", () => {
    const create = (
      column: "backlog" | "todo" | "doing" | "done" | undefined,
      extra: Record<string, unknown> = {},
    ) =>
      plannerCreateTask(rt.db, {
        user: rt.user,
        actor: USER,
        title: "Column task",
        column,
        today: TODAY,
        now: NOW,
        ...extra,
      });

    const week = { horizon: "week" as PlannerHorizon, day: TODAY };

    it("creates a Backlog task: status todo and no plan", async () => {
      const result = await create("backlog");
      expect(result.task.status).toBe("todo");
      expect(result.plan).toBeNull();
      expect(result.planError).toBeUndefined();
      expect(
        await plannerTestPlan(rt.database, result.task.id),
      ).toBeUndefined();
      expect(await plannerTestCount(rt.database, "planner_task_event")).toBe(0);
    });

    it("refuses a plan for a Backlog task, before it creates anything", async () => {
      await expect(create("backlog", { plan: week })).rejects.toThrow(
        /cannot have a plan/,
      );
      expect(await plannerTestCount(rt.database, "tasks")).toBe(0);
      // A null plan is the same as none.
      const ok = await create("backlog", { plan: null });
      expect(ok.task.status).toBe("todo");
    });

    it("creates a To Do task with its plan and a planned event", async () => {
      const result = await create("todo", { plan: week });
      expect(result.task.status).toBe("todo");
      expect(result.plan).toMatchObject({
        horizon: "week",
        period_start: THIS_WEEK,
      });
      expect(
        (await plannerEvents(result.task.id)).map((event) => event.type),
      ).toEqual(["planned"]);
    });

    it("requires a plan for a To Do task, and creates nothing without one", async () => {
      await expect(create("todo")).rejects.toThrow(/needs a plan/);
      await expect(create("todo", { plan: null })).rejects.toBeInstanceOf(
        ValidationError,
      );
      expect(await plannerTestCount(rt.database, "tasks")).toBe(0);
      expect(await plannerTestCount(rt.database, "task_activity")).toBe(0);
    });

    it("creates a Doing task in one write: status in_progress, one created activity, no plan needed", async () => {
      const result = await create("doing");
      expect(result.task.status).toBe("in_progress");
      expect(result.task.completed_at).toBeNull();
      expect(result.plan).toBeNull();

      const activity = await listTaskActivity(rt.db, rt.user, result.task.id);
      expect(activity.map((row) => row.action)).toEqual(["created"]);
      expect(activity[0]?.changes).toMatchObject({ status: "in_progress" });
      expect(await plannerEvents(result.task.id)).toEqual([]);
    });

    it("creates a Doing task with a plan when one is given", async () => {
      const result = await create("doing", { plan: week });
      expect(result.task.status).toBe("in_progress");
      expect(result.plan).toMatchObject({
        horizon: "week",
        period_start: THIS_WEEK,
      });
      expect(
        (await plannerEvents(result.task.id)).map((event) => event.type),
      ).toEqual(["planned"]);
    });

    it("creates a Done task completed now, with or without a plan", async () => {
      const bare = await create("done");
      expect(bare.task.status).toBe("done");
      expect(bare.task.completed_at).not.toBeNull();
      expect(bare.plan).toBeNull();

      const planned = await create("done", {
        plan: { horizon: "day", day: TODAY },
      });
      expect(planned.task.status).toBe("done");
      expect(planned.plan).toMatchObject({
        horizon: "day",
        period_start: TODAY,
      });
    });

    it("lands each task in its own column on the board", async () => {
      await create("backlog", { title: "In backlog" });
      await create("todo", { title: "In todo", plan: week });
      await create("doing", { title: "In doing" });
      await create("done", { title: "In done" });
      await create(undefined, { title: "Plain", plan: undefined });

      const { columns } = await plannerReadBoard(rt.db, {
        userId: rt.user.id,
        today: TODAY,
      });
      expect({
        backlog: columns.backlog.map((card) => card.title).sort(),
        todo: columns.todo.map((card) => card.title),
        doing: columns.doing.map((card) => card.title),
        done: columns.done.map((card) => card.title),
      }).toEqual({
        backlog: ["In backlog", "Plain"],
        todo: ["In todo"],
        doing: ["In doing"],
        done: ["In done"],
      });
    });

    it("keeps working without a column, as before", async () => {
      const planned = await create(undefined, { plan: week });
      expect(planned.task.status).toBe("todo");
      expect(planned.plan?.horizon).toBe("week");
      const plain = await create(undefined);
      expect(plain.task.status).toBe("todo");
      expect(plain.plan).toBeNull();
    });

    it("rejects an unknown column before it creates anything", async () => {
      await expect(
        create("someday" as unknown as "backlog"),
      ).rejects.toBeInstanceOf(ValidationError);
      expect(await plannerTestCount(rt.database, "tasks")).toBe(0);
    });

    it("rejects a bad plan before it creates anything, whatever the column", async () => {
      for (const column of ["todo", "doing", "done"] as const) {
        await expect(
          create(column, { plan: { horizon: "day", day: "2026-10-06" } }),
        ).rejects.toBeInstanceOf(ValidationError);
      }
      expect(await plannerTestCount(rt.database, "tasks")).toBe(0);
    });

    it("keeps a Doing task in Doing when only its plan could not be saved", async () => {
      const failing = plannerTestFailBatch(rt.db, (texts) =>
        texts.some((text) => text.includes('"planner_task_plan"')),
      );
      const result = await plannerCreateTask(failing, {
        user: rt.user,
        actor: USER,
        title: "Doing without its plan",
        column: "doing",
        plan: week,
        today: TODAY,
        now: NOW,
      });
      expect(result.planError).toBe("The plan could not be saved.");
      expect(result.plan).toBeNull();
      expect(result.task.status).toBe("in_progress");
    });

    it("stamps planned after created for a task made in Doing, so history reads created first", async () => {
      // A clock that moves 5 ms on every reading, like the milliseconds a real
      // D1 round trip takes (the same device as plans.test.ts uses).
      const RealDate = Date;
      const start = RealDate.parse("2026-10-07T09:00:00.000Z");
      let readings = 0;
      const tick = () => start + readings++ * 5;
      class TickingDate extends RealDate {
        constructor(...args: unknown[]) {
          if (args.length === 0) super(tick());
          else super(...(args as [number]));
        }
        static override now() {
          return tick();
        }
      }

      let created: Awaited<ReturnType<typeof plannerCreateTask>>;
      vi.stubGlobal("Date", TickingDate);
      try {
        created = await plannerCreateTask(rt.db, {
          user: rt.user,
          actor: USER,
          title: "Order matters",
          column: "doing",
          plan: { horizon: "day", day: TODAY },
          today: TODAY,
        });
      } finally {
        vi.unstubAllGlobals();
      }
      expect(created.plan).not.toBeNull();

      await plannerSyncHistory(rt.db, {
        userId: rt.user.id,
        now: new Date("2026-10-07T10:00:00.000Z"),
      });
      const history = await plannerReadTaskHistory(rt.db, {
        userId: rt.user.id,
        taskId: created.task.id,
      });
      expect(history.map((entry) => entry.type)).toEqual([
        "planned",
        "created",
      ]);
      expect(Date.parse(history[0]?.occurred_at ?? "")).toBeGreaterThan(
        Date.parse(history[1]?.occurred_at ?? ""),
      );
    });
  });

  // ===========================================================================
  // plannerReadTaskDetail
  // ===========================================================================

  describe("plannerReadTaskDetail", () => {
    const read = (taskId: string, userId = rt.user.id) =>
      plannerReadTaskDetail(rt.db, { userId, taskId });

    it("returns the whole task, notes included, for a task with nothing else", async () => {
      const task = await newTask("Plain", {
        notes: "Some notes",
        priority: "high",
        due_at: "2026-10-12",
      });

      const detail = await read(task.id);

      expect(detail.task).toEqual({ ...task });
      expect(detail.task.notes).toBe("Some notes");
      expect(detail.plan).toBeNull();
      expect(detail.project).toBeNull();
      expect(detail.comments).toEqual([]);
    });

    it("returns the plan with its effort, carry count and drop state", async () => {
      const task = await newTask("Planned");
      await plannerSetPlan(rt.db, {
        user: rt.user,
        actor: USER,
        taskId: task.id,
        plan: { horizon: "week", day: TODAY },
        today: TODAY,
        now: NOW,
      });
      await plannerSetEffort(rt.db, {
        user: rt.user,
        actor: USER,
        taskId: task.id,
        effort: 4.5,
        now: NOW,
      });
      await rt.database
        .prepare(
          "UPDATE planner_task_plan SET carry_count = 3 WHERE task_id = ?",
        )
        .bind(task.id)
        .run();

      const { plan } = await read(task.id);

      expect(plan).toEqual({
        task_id: task.id,
        horizon: "week",
        period_start: THIS_WEEK,
        carry_count: 3,
        dropped_at: null,
        effort: 4.5,
        created_at: NOW.toISOString(),
        updated_at: NOW.toISOString(),
      });
    });

    it("returns an effort-only plan row with a NULL horizon", async () => {
      const task = await newTask();
      await plannerSetEffort(rt.db, {
        user: rt.user,
        actor: USER,
        taskId: task.id,
        effort: 2,
        now: NOW,
      });
      expect((await read(task.id)).plan).toMatchObject({
        horizon: null,
        period_start: null,
        effort: 2,
      });
    });

    it("returns the project with an empty path when it has no node row", async () => {
      const home = await createProject(rt.db, rt.user, { name: "Home" });
      const task = await newTask("In a project", { project_id: home.id });

      expect((await read(task.id)).project).toEqual({
        id: home.id,
        name: "Home",
        ancestors: [],
      });
    });

    it("returns the path above the project, the root first", async () => {
      const health = await createProject(rt.db, rt.user, { name: "Health" });
      const marathon = await createProject(rt.db, rt.user, {
        name: "Run a marathon",
      });
      const training = await createProject(rt.db, rt.user, {
        name: "Training plan",
      });
      await plannerUpsertProjectNode(rt.db, {
        userId: rt.user.id,
        projectId: marathon.id,
        parentProjectId: health.id,
        level: "goal",
      });
      await plannerUpsertProjectNode(rt.db, {
        userId: rt.user.id,
        projectId: training.id,
        parentProjectId: marathon.id,
        level: "milestone",
      });
      const deep = await newTask("Deep", { project_id: training.id });
      const mid = await newTask("Mid", { project_id: marathon.id });
      const top = await newTask("Top", { project_id: health.id });

      expect((await read(deep.id)).project).toEqual({
        id: training.id,
        name: "Training plan",
        ancestors: [
          { id: health.id, name: "Health" },
          { id: marathon.id, name: "Run a marathon" },
        ],
      });
      expect((await read(mid.id)).project?.ancestors).toEqual([
        { id: health.id, name: "Health" },
      ]);
      expect((await read(top.id)).project?.ancestors).toEqual([]);
    });

    it("stops the path at an ancestor that is in the recycle bin, like the tree does", async () => {
      const area = await createProject(rt.db, rt.user, { name: "Area" });
      const goal = await createProject(rt.db, rt.user, { name: "Goal" });
      await plannerUpsertProjectNode(rt.db, {
        userId: rt.user.id,
        projectId: goal.id,
        parentProjectId: area.id,
      });
      const task = await newTask("Under the goal", { project_id: goal.id });
      expect((await read(task.id)).project?.ancestors).toEqual([
        { id: area.id, name: "Area" },
      ]);

      await deleteProject(rt.db, rt.user, area.id);

      expect((await read(task.id)).project).toEqual({
        id: goal.id,
        name: "Goal",
        ancestors: [],
      });
    });

    it("ends the walk on a damaged tree that has a cycle", async () => {
      const a = await createProject(rt.db, rt.user, { name: "A" });
      const b = await createProject(rt.db, rt.user, { name: "B" });
      await plannerTestInsertNode(rt.database, {
        projectId: b.id,
        userId: rt.user.id,
      });
      await plannerTestInsertNode(rt.database, {
        projectId: a.id,
        userId: rt.user.id,
        parentProjectId: b.id,
      });
      await rt.database
        .prepare(
          "UPDATE planner_project_node SET parent_project_id = ? WHERE project_id = ?",
        )
        .bind(a.id, b.id)
        .run();
      const task = await newTask("In a cycle", { project_id: a.id });

      const { project } = await read(task.id);

      expect(project?.name).toBe("A");
      expect(project?.ancestors).toEqual([{ id: b.id, name: "B" }]);
    });

    it("returns the comments, oldest first, without the deleted ones", async () => {
      const task = await newTask();
      await plannerTestInsertComment(rt.database, {
        id: "c-late",
        userId: rt.user.id,
        taskId: task.id,
        body: "Later",
        createdAt: "2026-10-03T10:00:00.000Z",
      });
      await plannerTestInsertComment(rt.database, {
        id: "c-early",
        userId: rt.user.id,
        taskId: task.id,
        body: "Earlier",
        createdAt: "2026-10-02T10:00:00.000Z",
      });
      await plannerTestInsertComment(rt.database, {
        id: "c-deleted",
        userId: rt.user.id,
        taskId: task.id,
        body: "Gone",
        createdAt: "2026-10-02T11:00:00.000Z",
        deletedAt: "2026-10-04T10:00:00.000Z",
      });
      // Not the caller's, even though it names the same task.
      await plannerTestInsertComment(rt.database, {
        id: "c-other",
        userId: rt.other.id,
        taskId: task.id,
        body: "Someone else's",
        createdAt: "2026-10-02T12:00:00.000Z",
      });

      const { comments } = await read(task.id);

      expect(comments.map((comment) => [comment.id, comment.body])).toEqual([
        ["c-early", "Earlier"],
        ["c-late", "Later"],
      ]);
      expect(comments[0]).toEqual({
        id: "c-early",
        task_id: task.id,
        body: "Earlier",
        created_at: "2026-10-02T10:00:00.000Z",
        updated_at: "2026-10-02T10:00:00.000Z",
      });
    });

    it("lists comments made in the same millisecond in the order they were written", async () => {
      const task = await newTask();
      for (const body of ["one", "two", "three"]) {
        await plannerAddComment(rt.db, {
          user: rt.user,
          actor: USER,
          taskId: task.id,
          body,
          now: NOW,
        });
      }
      expect((await read(task.id)).comments.map((c) => c.body)).toEqual([
        "one",
        "two",
        "three",
      ]);
    });

    it("is a 404 for a task that is missing, in the recycle bin or someone else's", async () => {
      const gone = await newTask("Binned");
      await deleteTask(rt.db, rt.user, gone.id);
      const theirs = await createTask(rt.db, rt.other, USER, {
        title: "Theirs",
      });

      for (const taskId of ["tasks/no-such-task", gone.id, theirs.id]) {
        await expect(read(taskId), taskId).rejects.toBeInstanceOf(
          NotFoundError,
        );
      }
      // The same task read as its own user works.
      await expect(read(theirs.id, rt.other.id)).resolves.toMatchObject({
        task: { title: "Theirs" },
      });
    });

    it("accepts a bare or a namespaced task id", async () => {
      const task = await newTask("Either way");
      const bare = task.id.replace(/^tasks\//, "");
      expect((await read(bare)).task.id).toBe(task.id);
      expect((await read(task.id)).task.id).toBe(task.id);
    });

    it("sees an upstream edit made after the card was drawn", async () => {
      const task = await newTask("Before");
      await updateTask(rt.db, rt.user, USER, task.id, {
        title: "After",
        notes: "Edited elsewhere",
      });
      const { task: read_ } = await read(task.id);
      expect(read_).toMatchObject({
        title: "After",
        notes: "Edited elsewhere",
      });
    });

    it("writes nothing: a read leaves the plan, the events and the comments as they were", async () => {
      const task = await newTask();
      await plannerSetEffort(rt.db, {
        user: rt.user,
        actor: USER,
        taskId: task.id,
        effort: 1,
        now: NOW,
      });
      const plans = await plannerTestCount(rt.database, "planner_task_plan");
      const events = await plannerTestCount(rt.database, "planner_task_event");
      const comments = (await plannerTestComments(rt.database)).length;

      await read(task.id);
      await read(task.id);

      expect(await plannerTestCount(rt.database, "planner_task_plan")).toBe(
        plans,
      );
      expect(await plannerTestCount(rt.database, "planner_task_event")).toBe(
        events,
      );
      expect((await plannerTestComments(rt.database)).length).toBe(comments);
    });
  });
});
