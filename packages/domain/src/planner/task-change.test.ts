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
import { createTask, getTask, type TaskActor } from "../tasks";
import { plannerCreateGoal } from "./goals";
import { plannerDropTask } from "./plans";
import { plannerAddTask, plannerChangeTask } from "./task-change";
import {
  type PlannerTestRuntime,
  plannerTestCount,
  plannerTestEvents,
  plannerTestFailBatch,
  plannerTestPlan,
  plannerTestRuntime,
} from "./test-support";

// Changing a task as one domain call: the order of the steps, and the rule that
// a refused change writes nothing (task-change.ts).

const USER: TaskActor = { type: "user" };

// 2026-10-07 is a Wednesday, so this week starts on Monday 2026-10-05.
const TODAY = "2026-10-07";
const THIS_WEEK = "2026-10-05";

describe("plannerChangeTask and plannerAddTask", () => {
  let rt: PlannerTestRuntime;

  beforeAll(async () => {
    rt = await plannerTestRuntime("flaremo-planner-task-change");
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

  const newTask = (title = "Task") =>
    createTask(rt.db, rt.user, USER, { title });

  const goal = (level: "week" | "quarter") =>
    plannerCreateGoal(rt.db, {
      userId: rt.user.id,
      goal: {
        level,
        periodStart: level === "week" ? THIS_WEEK : "2026-10-01",
        pillar: "work",
        title: `A ${level} goal`,
      },
    });

  const plannerEventTypes = async (taskId: string) =>
    (await plannerTestEvents(rt.database, taskId))
      .filter((event) => event.source === "planner")
      .map((event) => event.type);

  describe("plannerChangeTask", () => {
    it("writes nothing when the goal is not a weekly goal", async () => {
      const task = await newTask("Before");
      const quarter = await goal("quarter");
      await expect(
        plannerChangeTask(rt.db, {
          user: rt.user,
          actor: USER,
          taskId: task.id,
          today: TODAY,
          change: { title: "After", priority: "high", goalId: quarter.id },
        }),
      ).rejects.toBeInstanceOf(ValidationError);
      const after = await getTask(rt.db, rt.user, task.id);
      expect(after).toMatchObject({ title: "Before", priority: "none" });
      expect(await plannerTestPlan(rt.database, task.id)).toBeUndefined();
    });

    it("writes nothing when the goal does not exist, or the effort or start date is bad", async () => {
      const task = await newTask("Before");
      const attempts = [
        {
          change: {
            title: "After",
            goalId: "00000000-0000-4000-8000-000000000000",
          },
          error: NotFoundError,
        },
        { change: { title: "After", effort: 1.25 }, error: ValidationError },
        {
          change: { title: "After", startDate: "2026-02-30" },
          error: ValidationError,
        },
        {
          change: { title: "After", column: "todo" as const, plan: null },
          error: ValidationError,
        },
        {
          change: { title: "After", beforeId: task.id },
          error: ValidationError,
        },
      ];
      for (const { change, error } of attempts) {
        await expect(
          plannerChangeTask(rt.db, {
            user: rt.user,
            actor: USER,
            taskId: task.id,
            today: TODAY,
            change,
          }),
        ).rejects.toBeInstanceOf(error);
      }
      expect((await getTask(rt.db, rt.user, task.id)).title).toBe("Before");
      expect(await plannerTestCount(rt.database, "planner_task_event")).toBe(0);
    });

    it("undrops first and drops last, so one change can do both ends", async () => {
      const task = await newTask();
      await plannerDropTask(rt.db, {
        user: rt.user,
        actor: USER,
        taskId: task.id,
      });

      // Undrop and move in one go: a dropped task cannot be moved otherwise.
      const moved = await plannerChangeTask(rt.db, {
        user: rt.user,
        actor: USER,
        taskId: task.id,
        today: TODAY,
        change: { dropped: false, column: "doing" },
      });
      expect(moved.task.status).toBe("in_progress");
      expect(moved.plan?.dropped_at).toBeNull();

      // A due date set in the same change as a drop is cleared by the drop.
      const dropped = await plannerChangeTask(rt.db, {
        user: rt.user,
        actor: USER,
        taskId: task.id,
        today: TODAY,
        change: { dueAt: "2026-10-09", dropped: true },
      });
      expect(dropped.task.due_at).toBeNull();
      expect(dropped.plan?.dropped_at).not.toBeNull();
      expect(await plannerEventTypes(task.id)).toEqual([
        "dropped",
        "undropped",
        "dropped",
      ]);
    });

    it("answers with the task and plan as they are after every step", async () => {
      const task = await newTask();
      const week = await goal("week");
      const result = await plannerChangeTask(rt.db, {
        user: rt.user,
        actor: USER,
        taskId: task.id,
        today: TODAY,
        change: {
          title: "Renamed",
          column: "todo",
          effort: 2.5,
          startDate: TODAY,
          goalId: week.id,
        },
      });
      expect(result.task).toMatchObject({ title: "Renamed", status: "todo" });
      expect(result.plan).toMatchObject({
        horizon: "day",
        period_start: TODAY,
        effort: 2.5,
        start_date: TODAY,
        goal_id: week.id,
      });
      expect(await plannerEventTypes(task.id)).toEqual([
        "planned",
        "effort_changed",
        "start_date_changed",
        "goal_changed",
      ]);
    });
  });

  describe("plannerAddTask", () => {
    it("creates a task already linked to its weekly goal", async () => {
      const week = await goal("week");
      const created = await plannerAddTask(rt.db, {
        user: rt.user,
        actor: USER,
        title: "From the year map",
        goalId: week.id,
        today: TODAY,
      });
      expect(created.goalError).toBeUndefined();
      expect(created.plan?.goal_id).toBe(week.id);
      expect(await plannerEventTypes(created.task.id)).toEqual([
        "goal_changed",
      ]);
    });

    it("creates nothing when the goal is not a weekly goal", async () => {
      const quarter = await goal("quarter");
      await expect(
        plannerAddTask(rt.db, {
          user: rt.user,
          actor: USER,
          title: "Nope",
          goalId: quarter.id,
          today: TODAY,
        }),
      ).rejects.toBeInstanceOf(ValidationError);
      expect(await plannerTestCount(rt.database, "tasks")).toBe(0);
    });

    it("keeps the task and says so when only the goal link fails", async () => {
      const week = await goal("week");
      const failing = plannerTestFailBatch(rt.db, (texts) =>
        texts.some((text) => text.includes('"planner_task_plan"')),
      );
      const created = await plannerAddTask(failing, {
        user: rt.user,
        actor: USER,
        title: "Half done",
        goalId: week.id,
        today: TODAY,
      });
      expect(created.task.title).toBe("Half done");
      expect(created.goalError).toBeTruthy();
      expect(await plannerTestCount(rt.database, "tasks")).toBe(1);
    });
  });
});
