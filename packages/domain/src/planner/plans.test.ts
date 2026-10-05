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
import { createProject } from "../projects";
import {
  createTask,
  deleteTask,
  getTask,
  listTaskActivity,
  type TaskActor,
  updateTask,
} from "../tasks";
import type { PlannerColumn } from "./columns";
import {
  plannerApplyColumnMove,
  plannerCreateTask,
  plannerDropTask,
  plannerSetPlan,
  plannerUndropTask,
} from "./plans";
import {
  type PlannerTestRuntime,
  plannerTestCount,
  plannerTestEvents,
  plannerTestFailBatch,
  plannerTestInsertPlan,
  plannerTestInsertTask,
  plannerTestPlan,
  plannerTestRuntime,
} from "./test-support";

const USER: TaskActor = { type: "user" };
const AGENT: TaskActor = { type: "agent", name: "pat:abcd1234" };

// 2026-10-07 is a Wednesday, so this week starts on Monday 2026-10-05.
const TODAY = "2026-10-07";
const NOW = new Date("2026-10-07T09:00:00.000Z");
const THIS_WEEK = "2026-10-05";

type PlanPoint = { horizon: string | null; period_start: string | null };

describe("planner plans", () => {
  let rt: PlannerTestRuntime;

  beforeAll(async () => {
    rt = await plannerTestRuntime("flaremo-planner-plans");
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

  const plannerEvents = async (taskId: string) =>
    (await plannerTestEvents(rt.database, taskId)).filter(
      (event) => event.source === "planner",
    );

  const newTask = (title = "Task", extra: Record<string, unknown> = {}) =>
    createTask(rt.db, rt.user, USER, { title, ...extra });

  const setPlan = (
    taskId: string,
    plan: { horizon: PlannerHorizon; day: string } | null,
    actor: TaskActor = USER,
    today = TODAY,
  ) =>
    plannerSetPlan(rt.db, {
      user: rt.user,
      actor,
      taskId,
      plan,
      today,
      now: NOW,
    });

  describe("plannerCreateTask", () => {
    it("creates an unplanned task in the backlog, with no plan row and no event", async () => {
      const result = await plannerCreateTask(rt.db, {
        user: rt.user,
        actor: USER,
        title: "  Buy milk  ",
        notes: "Oat",
        priority: "high",
        dueAt: "2026-10-09",
      });

      expect(result.plan).toBeNull();
      expect(result.planError).toBeUndefined();
      expect(result.task).toMatchObject({
        title: "Buy milk",
        notes: "Oat",
        priority: "high",
        due_at: "2026-10-09",
        status: "todo",
        project_id: null,
      });
      expect(
        await plannerTestPlan(rt.database, result.task.id),
      ).toBeUndefined();
      expect(await plannerTestCount(rt.database, "planner_task_event")).toBe(0);
    });

    it("writes the plan and a planned event together, with the actor", async () => {
      const project = await createProject(rt.db, rt.user, { name: "Home" });
      const result = await plannerCreateTask(rt.db, {
        user: rt.user,
        actor: AGENT,
        title: "Fix the gate",
        projectId: project.id,
        plan: { horizon: "week", day: "2026-10-09" },
        today: TODAY,
        now: NOW,
      });

      expect(result.planError).toBeUndefined();
      expect(result.task.project_id).toBe(project.id);
      expect(result.task.status).toBe("todo");
      expect(result.plan).toMatchObject({
        task_id: result.task.id,
        horizon: "week",
        period_start: THIS_WEEK,
        carry_count: 0,
        dropped_at: null,
      });

      const events = await plannerEvents(result.task.id);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "planned",
        source: "planner",
        source_ref: null,
        actor_type: "agent",
        actor_name: "pat:abcd1234",
        task_title: "Fix the gate",
        occurred_at: NOW.toISOString(),
        created_at: NOW.toISOString(),
      });
      expect(JSON.parse(events[0]?.data ?? "{}")).toEqual({
        from: { horizon: null, period_start: null },
        to: { horizon: "week", period_start: THIS_WEEK },
      });
    });

    it("rejects a bad plan before it creates anything", async () => {
      // `null` leaves today out; an omitted argument would take the default.
      const create = (plan: unknown, today: string | null = TODAY) =>
        plannerCreateTask(rt.db, {
          user: rt.user,
          actor: USER,
          title: "Never created",
          plan: plan as { horizon: PlannerHorizon; day: string },
          today: today ?? undefined,
          now: NOW,
        });

      await expect(
        create({ horizon: "day", day: "2026-10-06" }),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        create({ horizon: "year", day: TODAY }),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        create({ horizon: "day", day: "2026-02-30" }),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        create({ horizon: "day", day: TODAY }, null),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        create({ horizon: "day", day: TODAY }, "not a day"),
      ).rejects.toBeInstanceOf(ValidationError);

      expect(await plannerTestCount(rt.database, "tasks")).toBe(0);
      expect(await plannerTestCount(rt.database, "task_activity")).toBe(0);
    });

    it("keeps the task and reports a plan error when the plan batch fails", async () => {
      const failing = plannerTestFailBatch(rt.db, (texts) =>
        texts.some((text) => text.includes('"planner_task_plan"')),
      );

      const result = await plannerCreateTask(failing, {
        user: rt.user,
        actor: USER,
        title: "Plan will fail",
        plan: { horizon: "day", day: TODAY },
        today: TODAY,
        now: NOW,
      });

      expect(result.plan).toBeNull();
      expect(result.planError).toBe("The plan could not be saved.");
      // The task exists and sits in the backlog; the failed batch left nothing.
      expect((await getTask(rt.db, rt.user, result.task.id)).status).toBe(
        "todo",
      );
      expect(
        await plannerTestPlan(rt.database, result.task.id),
      ).toBeUndefined();
      expect(await plannerTestCount(rt.database, "planner_task_event")).toBe(0);
    });

    it("passes upstream's own checks through: an unknown project is a 404", async () => {
      await expect(
        plannerCreateTask(rt.db, {
          user: rt.user,
          actor: USER,
          title: "Orphan",
          projectId: "projects/no-such-project",
        }),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        plannerCreateTask(rt.db, {
          user: rt.user,
          actor: USER,
          title: "   ",
        }),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  describe("plannerSetPlan", () => {
    it("plans, replans and unplans a task, writing {from, to} each time", async () => {
      const task = await newTask("Moving target");

      const planned = await setPlan(task.id, { horizon: "week", day: TODAY });
      expect(planned.plan).toMatchObject({
        horizon: "week",
        period_start: THIS_WEEK,
      });

      const replanned = await setPlan(task.id, {
        horizon: "day",
        day: "2026-10-08",
      });
      expect(replanned.plan).toMatchObject({
        horizon: "day",
        period_start: "2026-10-08",
      });

      const unplanned = await setPlan(task.id, null, AGENT);
      expect(unplanned.plan).toMatchObject({
        horizon: null,
        period_start: null,
      });
      expect(unplanned.task.status).toBe("todo");

      const events = await plannerEvents(task.id);
      expect(
        events.map((event) => [
          event.type,
          event.actor_type,
          JSON.parse(event.data),
        ]),
      ).toEqual([
        [
          "planned",
          "user",
          {
            from: { horizon: null, period_start: null },
            to: { horizon: "week", period_start: THIS_WEEK },
          },
        ],
        [
          "replanned",
          "user",
          {
            from: { horizon: "week", period_start: THIS_WEEK },
            to: { horizon: "day", period_start: "2026-10-08" },
          },
        ],
        [
          "unplanned",
          "agent",
          {
            from: { horizon: "day", period_start: "2026-10-08" },
            to: { horizon: null, period_start: null },
          },
        ],
      ]);
      expect(events[2]?.actor_name).toBe("pat:abcd1234");
    });

    it("turns any day inside a period into that period's start", async () => {
      const task = await newTask();
      const periodStart = async (horizon: PlannerHorizon, day: string) =>
        (await setPlan(task.id, { horizon, day })).plan?.period_start;

      expect(await periodStart("week", "2026-10-09")).toBe("2026-10-05");
      expect(await periodStart("week", "2026-10-11")).toBe("2026-10-05"); // Sunday
      expect(await periodStart("week", "2026-10-14")).toBe("2026-10-12");
      expect(await periodStart("month", "2026-10-31")).toBe("2026-10-01");
      expect(await periodStart("month", "2026-11-15")).toBe("2026-11-01");
      expect(await periodStart("day", "2026-12-24")).toBe("2026-12-24");
    });

    it("refuses a plan that starts before the current period, and only that", async () => {
      const task = await newTask();
      const attempt = (horizon: PlannerHorizon, day: string) =>
        setPlan(task.id, { horizon, day });

      // The current period itself is fine, even for a day already gone by.
      await expect(attempt("day", TODAY)).resolves.toBeDefined();
      await expect(attempt("week", "2026-10-05")).resolves.toBeDefined(); // Monday
      await expect(attempt("month", "2026-10-01")).resolves.toBeDefined();

      await expect(attempt("day", "2026-10-06")).rejects.toBeInstanceOf(
        ValidationError,
      );
      await expect(attempt("week", "2026-10-04")).rejects.toBeInstanceOf(
        ValidationError,
      ); // last Sunday
      await expect(attempt("month", "2026-09-30")).rejects.toBeInstanceOf(
        ValidationError,
      );
    });

    it("rejects an unknown horizon, an impossible day and a missing today", async () => {
      const task = await newTask();
      await expect(
        setPlan(task.id, { horizon: "decade" as PlannerHorizon, day: TODAY }),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        setPlan(task.id, { horizon: "day", day: "2026-13-01" }),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        setPlan(task.id, { horizon: "day", day: TODAY }, USER, "soon"),
      ).rejects.toBeInstanceOf(ValidationError);
      expect(await plannerTestCount(rt.database, "planner_task_event")).toBe(0);
    });

    it("writes nothing when the plan would not change", async () => {
      const task = await newTask();
      await setPlan(task.id, null); // nothing to clear
      expect(await plannerTestCount(rt.database, "planner_task_event")).toBe(0);
      expect(await plannerTestPlan(rt.database, task.id)).toBeUndefined();

      await setPlan(task.id, { horizon: "week", day: TODAY });
      await setPlan(task.id, { horizon: "week", day: "2026-10-10" }); // same week
      expect(await plannerEvents(task.id)).toHaveLength(1);
    });

    it("leaves carry_count to rollover", async () => {
      const task = await newTask();
      await plannerTestInsertPlan(rt.database, {
        taskId: task.id,
        userId: rt.user.id,
        horizon: "day",
        periodStart: "2026-10-07",
        carryCount: 3,
      });
      await setPlan(task.id, { horizon: "week", day: TODAY });
      expect((await plannerTestPlan(rt.database, task.id))?.carry_count).toBe(
        3,
      );
      await setPlan(task.id, null);
      expect((await plannerTestPlan(rt.database, task.id))?.carry_count).toBe(
        3,
      );
    });

    it("plans a task that has a NULL-horizon row as a first plan", async () => {
      const task = await newTask();
      await plannerTestInsertPlan(rt.database, {
        taskId: task.id,
        userId: rt.user.id,
        horizon: null,
        periodStart: null,
      });
      await setPlan(task.id, { horizon: "month", day: TODAY });
      const [event] = await plannerEvents(task.id);
      expect(event?.type).toBe("planned");
      expect(JSON.parse(event?.data ?? "{}").from).toEqual({
        horizon: null,
        period_start: null,
      });
    });

    it("is a 404 for a task that is missing, deleted or someone else's", async () => {
      const task = await newTask();
      const theirs = await createTask(rt.db, rt.other, USER, {
        title: "Theirs",
      });
      await expect(
        setPlan("tasks/nope", { horizon: "day", day: TODAY }),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        setPlan(theirs.id, { horizon: "day", day: TODAY }),
      ).rejects.toBeInstanceOf(NotFoundError);
      await deleteTask(rt.db, rt.user, task.id);
      await expect(
        setPlan(task.id, { horizon: "day", day: TODAY }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("takes a bare task id", async () => {
      const task = await newTask();
      const result = await setPlan(task.id.replace(/^tasks\//, ""), {
        horizon: "day",
        day: TODAY,
      });
      expect(result.task.id).toBe(task.id);
      expect(result.plan?.horizon).toBe("day");
    });

    it("refuses to plan a dropped task", async () => {
      const task = await newTask();
      await plannerDropTask(rt.db, {
        user: rt.user,
        actor: USER,
        taskId: task.id,
      });
      await expect(
        setPlan(task.id, { horizon: "day", day: TODAY }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("writes the plan and its event in one batch, or neither", async () => {
      const task = await newTask();
      const failing = plannerTestFailBatch(rt.db, (texts) =>
        texts.some((text) => text.includes('"planner_task_event"')),
      );
      await expect(
        plannerSetPlan(failing, {
          user: rt.user,
          actor: USER,
          taskId: task.id,
          plan: { horizon: "day", day: TODAY },
          today: TODAY,
          now: NOW,
        }),
      ).rejects.toThrow(/injected failure/);
      expect(await plannerTestPlan(rt.database, task.id)).toBeUndefined();
      expect(await plannerTestCount(rt.database, "planner_task_event")).toBe(0);
    });
  });

  describe("plannerDropTask and plannerUndropTask", () => {
    it("drops a task, keeps its plan, clears its due date through upstream and records the old one", async () => {
      const task = await newTask("Overdue forever", { due_at: "2026-09-01" });
      await setPlan(task.id, { horizon: "week", day: TODAY });

      const dropped = await plannerDropTask(rt.db, {
        user: rt.user,
        actor: AGENT,
        taskId: task.id,
        now: NOW,
      });

      expect(dropped.task.due_at).toBeNull();
      expect(dropped.plan).toMatchObject({
        horizon: "week",
        period_start: THIS_WEEK,
        dropped_at: NOW.toISOString(),
      });
      const events = await plannerEvents(task.id);
      expect(events.map((event) => event.type)).toEqual(["planned", "dropped"]);
      expect(events[1]).toMatchObject({
        actor_type: "agent",
        actor_name: "pat:abcd1234",
        occurred_at: NOW.toISOString(),
      });
      expect(JSON.parse(events[1]?.data ?? "{}")).toEqual({
        previous_due_at: "2026-09-01",
      });

      // The due date went through upstream's updateTask, which logged it.
      const activity = await listTaskActivity(rt.db, rt.user, task.id);
      const last = activity.at(-1);
      expect(last).toMatchObject({
        action: "updated",
        actor_type: "agent",
        changes: { due_at: null },
      });
    });

    it("drops an undated task without touching upstream", async () => {
      const task = await newTask("No date");
      await plannerDropTask(rt.db, {
        user: rt.user,
        actor: USER,
        taskId: task.id,
        now: NOW,
      });

      const [event] = await plannerEvents(task.id);
      expect(JSON.parse(event?.data ?? "{}")).toEqual({
        previous_due_at: null,
      });
      expect(
        (await listTaskActivity(rt.db, rt.user, task.id)).map((a) => a.action),
      ).toEqual(["created"]);
      expect((await plannerTestPlan(rt.database, task.id))?.dropped_at).toBe(
        NOW.toISOString(),
      );
    });

    it("does not drop twice, but a retry still clears a due date that was left behind", async () => {
      const task = await newTask("Retry", { due_at: "2026-09-01" });
      await plannerDropTask(rt.db, {
        user: rt.user,
        actor: USER,
        taskId: task.id,
        now: NOW,
      });

      // Suppose clearing the due date had failed the first time.
      await updateTask(rt.db, rt.user, USER, task.id, { due_at: "2026-09-02" });
      const again = await plannerDropTask(rt.db, {
        user: rt.user,
        actor: USER,
        taskId: task.id,
        now: new Date(NOW.getTime() + 60_000),
      });

      expect(again.task.due_at).toBeNull();
      expect(
        (await plannerEvents(task.id)).filter((e) => e.type === "dropped"),
      ).toHaveLength(1);
      expect((await plannerTestPlan(rt.database, task.id))?.dropped_at).toBe(
        NOW.toISOString(),
      );
    });

    it("undrops a task without restoring its due date, and the plan decides where it lands", async () => {
      const task = await newTask("Back again", { due_at: "2026-09-01" });
      await setPlan(task.id, { horizon: "week", day: TODAY });
      await plannerDropTask(rt.db, {
        user: rt.user,
        actor: USER,
        taskId: task.id,
        now: NOW,
      });

      const undropped = await plannerUndropTask(rt.db, {
        user: rt.user,
        actor: AGENT,
        taskId: task.id,
        now: new Date(NOW.getTime() + 60_000),
      });

      expect(undropped.task.due_at).toBeNull();
      expect(undropped.plan).toMatchObject({
        dropped_at: null,
        horizon: "week",
        period_start: THIS_WEEK,
      });
      const events = await plannerEvents(task.id);
      expect(events.map((event) => event.type)).toEqual([
        "planned",
        "dropped",
        "undropped",
      ]);
      expect(events[2]).toMatchObject({
        actor_type: "agent",
        occurred_at: new Date(NOW.getTime() + 60_000).toISOString(),
      });
    });

    it("leaves a task that is not dropped alone when it is undropped", async () => {
      const task = await newTask();
      const result = await plannerUndropTask(rt.db, {
        user: rt.user,
        actor: USER,
        taskId: task.id,
      });
      expect(result.plan).toBeNull();
      expect(await plannerTestCount(rt.database, "planner_task_event")).toBe(0);
    });

    it("is a 404 for a task that is missing, deleted or someone else's", async () => {
      const task = await newTask();
      const theirs = await createTask(rt.db, rt.other, USER, {
        title: "Theirs",
      });
      for (const act of [plannerDropTask, plannerUndropTask]) {
        await expect(
          act(rt.db, { user: rt.user, actor: USER, taskId: "tasks/nope" }),
        ).rejects.toBeInstanceOf(NotFoundError);
        await expect(
          act(rt.db, { user: rt.user, actor: USER, taskId: theirs.id }),
        ).rejects.toBeInstanceOf(NotFoundError);
      }
      await deleteTask(rt.db, rt.user, task.id);
      await expect(
        plannerDropTask(rt.db, { user: rt.user, actor: USER, taskId: task.id }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("writes the drop and its event in one batch, or neither", async () => {
      const task = await newTask("Atomic", { due_at: "2026-09-01" });
      const failing = plannerTestFailBatch(rt.db, (texts) =>
        texts.some((text) => text.includes('"planner_task_event"')),
      );
      await expect(
        plannerDropTask(failing, {
          user: rt.user,
          actor: USER,
          taskId: task.id,
        }),
      ).rejects.toThrow(/injected failure/);
      expect(await plannerTestPlan(rt.database, task.id)).toBeUndefined();
      // Nothing was cleared either: the due date is only cleared after the drop is saved.
      expect((await getTask(rt.db, rt.user, task.id)).due_at).toBe(
        "2026-09-01",
      );
    });
  });

  describe("plannerApplyColumnMove", () => {
    type Start = {
      status: "todo" | "in_progress" | "done";
      // undefined: no plan row at all. A NULL horizon is a row that means "no plan".
      plan?: { horizon: PlannerHorizon | null; periodStart: string | null };
    };
    type Outcome = {
      status: "todo" | "in_progress" | "done";
      plan: { horizon: PlannerHorizon; periodStart: string } | null;
      events: string[];
    };

    const week = (periodStart = THIS_WEEK) => ({
      horizon: "week" as const,
      periodStart,
    });
    const day = (periodStart = TODAY) => ({
      horizon: "day" as const,
      periodStart,
    });
    const none = { horizon: null, periodStart: null };
    const thisWeek = { horizon: "week" as const, periodStart: THIS_WEEK };

    // The plan's column-move table, row by row, with each starting state spelled out.
    const table: Array<{
      name: string;
      from: PlannerColumn | "other";
      start: Start;
      to: PlannerColumn;
      outcome: Outcome;
    }> = [
      {
        name: "Backlog to To Do: plan = this week",
        from: "backlog",
        start: { status: "todo" },
        to: "todo",
        outcome: { status: "todo", plan: thisWeek, events: ["planned"] },
      },
      {
        name: "Backlog (NULL horizon) to To Do: a NULL horizon counts as no plan",
        from: "backlog",
        start: { status: "todo", plan: none },
        to: "todo",
        outcome: { status: "todo", plan: thisWeek, events: ["planned"] },
      },
      {
        name: "To Do to Backlog: plan cleared",
        from: "todo",
        start: { status: "todo", plan: week() },
        to: "backlog",
        outcome: { status: "todo", plan: null, events: ["unplanned"] },
      },
      {
        name: "To Do (day plan) to Backlog",
        from: "todo",
        start: { status: "todo", plan: day() },
        to: "backlog",
        outcome: { status: "todo", plan: null, events: ["unplanned"] },
      },
      {
        name: "Backlog to Doing: status in_progress, still no plan",
        from: "backlog",
        start: { status: "todo" },
        to: "doing",
        outcome: { status: "in_progress", plan: null, events: [] },
      },
      {
        name: "To Do to Doing: plan kept",
        from: "todo",
        start: { status: "todo", plan: week() },
        to: "doing",
        outcome: { status: "in_progress", plan: week(), events: [] },
      },
      {
        name: "Backlog to Done",
        from: "backlog",
        start: { status: "todo" },
        to: "done",
        outcome: { status: "done", plan: null, events: [] },
      },
      {
        name: "To Do to Done: plan kept for history",
        from: "todo",
        start: { status: "todo", plan: day() },
        to: "done",
        outcome: { status: "done", plan: day(), events: [] },
      },
      {
        name: "Doing to Done: plan kept",
        from: "doing",
        start: { status: "in_progress", plan: week() },
        to: "done",
        outcome: { status: "done", plan: week(), events: [] },
      },
      {
        name: "Doing (no plan) to To Do: plan = this week",
        from: "doing",
        start: { status: "in_progress" },
        to: "todo",
        outcome: { status: "todo", plan: thisWeek, events: ["planned"] },
      },
      {
        name: "Doing (NULL horizon) to To Do: plan = this week",
        from: "doing",
        start: { status: "in_progress", plan: none },
        to: "todo",
        outcome: { status: "todo", plan: thisWeek, events: ["planned"] },
      },
      {
        name: "Doing (day plan) to To Do: the plan is kept",
        from: "doing",
        start: { status: "in_progress", plan: day() },
        to: "todo",
        outcome: { status: "todo", plan: day(), events: [] },
      },
      {
        name: "Doing (past plan) to To Do: kept, rollover will carry it",
        from: "doing",
        start: { status: "in_progress", plan: week("2026-09-28") },
        to: "todo",
        outcome: { status: "todo", plan: week("2026-09-28"), events: [] },
      },
      {
        name: "Doing (plan) to Backlog: status todo, plan cleared",
        from: "doing",
        start: { status: "in_progress", plan: week() },
        to: "backlog",
        outcome: { status: "todo", plan: null, events: ["unplanned"] },
      },
      {
        name: "Doing (no plan) to Backlog",
        from: "doing",
        start: { status: "in_progress" },
        to: "backlog",
        outcome: { status: "todo", plan: null, events: [] },
      },
      {
        name: "Done (plan) to Backlog: reopened, plan cleared",
        from: "done",
        start: { status: "done", plan: week() },
        to: "backlog",
        outcome: { status: "todo", plan: null, events: ["unplanned"] },
      },
      {
        name: "Done (no plan) to Backlog",
        from: "done",
        start: { status: "done" },
        to: "backlog",
        outcome: { status: "todo", plan: null, events: [] },
      },
      {
        name: "Done (no plan) to To Do: reopened, plan = this week",
        from: "done",
        start: { status: "done" },
        to: "todo",
        outcome: { status: "todo", plan: thisWeek, events: ["planned"] },
      },
      {
        name: "Done (NULL horizon) to To Do: plan = this week",
        from: "done",
        start: { status: "done", plan: none },
        to: "todo",
        outcome: { status: "todo", plan: thisWeek, events: ["planned"] },
      },
      {
        name: "Done (past plan) to To Do: replanned to this week",
        from: "done",
        start: { status: "done", plan: day("2026-10-01") },
        to: "todo",
        outcome: { status: "todo", plan: thisWeek, events: ["replanned"] },
      },
      {
        name: "Done (plan for today) to To Do: the plan is kept",
        from: "done",
        start: { status: "done", plan: day() },
        to: "todo",
        outcome: { status: "todo", plan: day(), events: [] },
      },
      {
        name: "Done (plan for the current week) to To Do: kept",
        from: "done",
        start: { status: "done", plan: week() },
        to: "todo",
        outcome: { status: "todo", plan: week(), events: [] },
      },
      {
        name: "Done (future plan) to To Do: kept",
        from: "done",
        start: { status: "done", plan: week("2026-10-12") },
        to: "todo",
        outcome: { status: "todo", plan: week("2026-10-12"), events: [] },
      },
      {
        name: "Done to Doing: plan unchanged",
        from: "done",
        start: { status: "done", plan: week() },
        to: "doing",
        outcome: { status: "in_progress", plan: week(), events: [] },
      },
      {
        name: "Done (no plan) to Doing",
        from: "done",
        start: { status: "done" },
        to: "doing",
        outcome: { status: "in_progress", plan: null, events: [] },
      },
      // Moving to the column a card is already in changes nothing.
      {
        name: "Backlog to Backlog",
        from: "backlog",
        start: { status: "todo" },
        to: "backlog",
        outcome: { status: "todo", plan: null, events: [] },
      },
      {
        name: "To Do to To Do",
        from: "todo",
        start: { status: "todo", plan: week("2026-09-28") },
        to: "todo",
        outcome: { status: "todo", plan: week("2026-09-28"), events: [] },
      },
      {
        name: "Doing to Doing",
        from: "doing",
        start: { status: "in_progress" },
        to: "doing",
        outcome: { status: "in_progress", plan: null, events: [] },
      },
      {
        name: "Done to Done",
        from: "done",
        start: { status: "done", plan: week() },
        to: "done",
        outcome: { status: "done", plan: week(), events: [] },
      },
    ];

    it.each(table)("$name", async ({ from, start, to, outcome }) => {
      const task = await createTask(rt.db, rt.user, USER, {
        title: "Mover",
        status: start.status,
      });
      if (start.plan) {
        await plannerTestInsertPlan(rt.database, {
          taskId: task.id,
          userId: rt.user.id,
          ...start.plan,
        });
      }
      const activityBefore = (await listTaskActivity(rt.db, rt.user, task.id))
        .length;

      const result = await plannerApplyColumnMove(rt.db, {
        user: rt.user,
        actor: AGENT,
        taskId: task.id,
        to,
        today: TODAY,
        now: NOW,
      });

      expect(result.from).toBe(from);
      expect(result.to).toBe(to);
      expect(result.task.status).toBe(outcome.status);
      expect((await getTask(rt.db, rt.user, task.id)).status).toBe(
        outcome.status,
      );
      const row = await plannerTestPlan(rt.database, task.id);
      const plan: PlanPoint = row
        ? { horizon: row.horizon, period_start: row.period_start }
        : { horizon: null, period_start: null };
      expect(plan).toEqual(
        outcome.plan
          ? {
              horizon: outcome.plan.horizon,
              period_start: outcome.plan.periodStart,
            }
          : { horizon: null, period_start: null },
      );
      expect((await plannerEvents(task.id)).map((event) => event.type)).toEqual(
        outcome.events,
      );

      // A status change is upstream's: one status_changed row, attributed to the actor.
      const activity = await listTaskActivity(rt.db, rt.user, task.id);
      if (outcome.status === start.status) {
        expect(activity).toHaveLength(activityBefore);
      } else {
        expect(activity).toHaveLength(activityBefore + 1);
        expect(activity.at(-1)).toMatchObject({
          action: "status_changed",
          actor_type: "agent",
          actor_name: "pat:abcd1234",
          changes: { status: outcome.status },
        });
      }
    });

    it("records {from, to} and the actor on the plan events of a move", async () => {
      const task = await createTask(rt.db, rt.user, USER, {
        title: "Reopened",
        status: "done",
      });
      await plannerTestInsertPlan(rt.database, {
        taskId: task.id,
        userId: rt.user.id,
        horizon: "day",
        periodStart: "2026-10-01",
      });
      await plannerApplyColumnMove(rt.db, {
        user: rt.user,
        actor: AGENT,
        taskId: task.id,
        to: "todo",
        today: TODAY,
        now: NOW,
      });
      const [event] = await plannerEvents(task.id);
      expect(event).toMatchObject({
        type: "replanned",
        actor_type: "agent",
        actor_name: "pat:abcd1234",
        occurred_at: NOW.toISOString(),
      });
      expect(JSON.parse(event?.data ?? "{}")).toEqual({
        from: { horizon: "day", period_start: "2026-10-01" },
        to: { horizon: "week", period_start: THIS_WEEK },
      });
    });

    it("reopening a done task clears its completion time through upstream", async () => {
      const task = await createTask(rt.db, rt.user, USER, {
        title: "Finished",
        status: "done",
      });
      expect(task.completed_at).not.toBeNull();
      const result = await plannerApplyColumnMove(rt.db, {
        user: rt.user,
        actor: USER,
        taskId: task.id,
        to: "doing",
        today: TODAY,
      });
      expect(result.task.completed_at).toBeNull();
    });

    it("moves a task whose status upstream's enum does not list like any other", async () => {
      const odd = await plannerTestInsertTask(rt.database, {
        id: "tasks/odd",
        userId: rt.user.id,
        status: "blocked",
      });
      const result = await plannerApplyColumnMove(rt.db, {
        user: rt.user,
        actor: USER,
        taskId: odd,
        to: "doing",
        today: TODAY,
        now: NOW,
      });
      expect(result.from).toBe("other");
      expect(result.task.status).toBe("in_progress");
    });

    it("refuses a dropped task, an unknown column and a bad day", async () => {
      const task = await newTask();
      await plannerDropTask(rt.db, {
        user: rt.user,
        actor: USER,
        taskId: task.id,
      });
      const move = (to: string, today = TODAY) =>
        plannerApplyColumnMove(rt.db, {
          user: rt.user,
          actor: USER,
          taskId: task.id,
          to: to as PlannerColumn,
          today,
        });
      await expect(move("doing")).rejects.toBeInstanceOf(ValidationError);

      await plannerUndropTask(rt.db, {
        user: rt.user,
        actor: USER,
        taskId: task.id,
      });
      await expect(move("archive")).rejects.toBeInstanceOf(ValidationError);
      await expect(move("doing", "tomorrow")).rejects.toBeInstanceOf(
        ValidationError,
      );
      await expect(move("doing")).resolves.toBeDefined();
    });

    it("is a 404 for a task that is missing, deleted or someone else's", async () => {
      const task = await newTask();
      const theirs = await createTask(rt.db, rt.other, USER, {
        title: "Theirs",
      });
      const move = (taskId: string) =>
        plannerApplyColumnMove(rt.db, {
          user: rt.user,
          actor: USER,
          taskId,
          to: "doing",
          today: TODAY,
        });
      await expect(move("tasks/nope")).rejects.toBeInstanceOf(NotFoundError);
      await expect(move(theirs.id)).rejects.toBeInstanceOf(NotFoundError);
      await deleteTask(rt.db, rt.user, task.id);
      await expect(move(task.id)).rejects.toBeInstanceOf(NotFoundError);
    });

    it("keeps the plan write and its event in one batch, or neither", async () => {
      const task = await newTask();
      const failing = plannerTestFailBatch(rt.db, (texts) =>
        texts.some((text) => text.includes('"planner_task_event"')),
      );
      await expect(
        plannerApplyColumnMove(failing, {
          user: rt.user,
          actor: USER,
          taskId: task.id,
          to: "todo",
          today: TODAY,
        }),
      ).rejects.toThrow(/injected failure/);
      expect(await plannerTestPlan(rt.database, task.id)).toBeUndefined();
    });
  });

  it("uses the real clock when no time is given", async () => {
    const task = await newTask();
    const before = Date.now();
    await plannerSetPlan(rt.db, {
      user: rt.user,
      actor: USER,
      taskId: task.id,
      plan: { horizon: "month", day: TODAY },
      today: TODAY,
    });
    const [event] = await plannerEvents(task.id);
    expect(Date.parse(event?.occurred_at ?? "")).toBeGreaterThanOrEqual(
      before - 1000,
    );
  });
});
