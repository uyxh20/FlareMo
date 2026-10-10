import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import type { TaskActor } from "../tasks";
import { plannerReadBoard } from "./board";
import {
  plannerCreateGoal,
  plannerDeleteGoal,
  plannerGoalPeriodStart,
  plannerReadCockpitWeek,
  plannerReadGoalsById,
  plannerReadGoalsYear,
  plannerRequireMonday,
  plannerSetTaskGoal,
  plannerUpdateGoal,
  plannerUpsertWeek,
} from "./goals";
import {
  type PlannerTestRuntime,
  plannerTestEvents,
  plannerTestInsertPlan,
  plannerTestInsertTask,
  plannerTestPlan,
  plannerTestRuntime,
} from "./test-support";

// Goals and week records (goals.ts, migration 9005).

const USER: TaskActor = { type: "user" };
const NOW = new Date("2026-10-07T09:00:00.000Z");

describe("goals", () => {
  let rt: PlannerTestRuntime;

  beforeAll(async () => {
    rt = await plannerTestRuntime("flaremo-planner-goals");
  });
  afterAll(async () => {
    await rt.dispose();
  });
  beforeEach(async () => {
    await rt.reset();
  });

  it("keeps the first day of the goal's period", async () => {
    expect(plannerGoalPeriodStart("year", "2026-06-30")).toBe("2026-01-01");
    expect(plannerGoalPeriodStart("quarter", "2026-11-15")).toBe("2026-10-01");
    expect(plannerGoalPeriodStart("month", "2026-10-31")).toBe("2026-10-01");
    expect(plannerGoalPeriodStart("week", "2026-10-11")).toBe("2026-10-05");
    expect(plannerGoalPeriodStart("north_star", "2026-10-11")).toBeNull();
    expect(() => plannerGoalPeriodStart("week", "2026-13-01")).toThrow(
      ValidationError,
    );

    const goal = await plannerCreateGoal(rt.db, {
      userId: rt.user.id,
      goal: {
        level: "quarter",
        periodStart: "2026-11-15",
        pillar: "work",
        title: "  Get the terms in writing ",
        lines: [
          { text: " Acme ", note: " offer " },
          { text: "   " },
          { text: "Zeta", struck: true },
        ],
      },
      now: NOW,
    });
    expect(goal).toMatchObject({
      level: "quarter",
      period_start: "2026-10-01",
      pillar: "work",
      title: "Get the terms in writing",
      lines: [
        { text: "Acme", note: "offer" },
        { text: "Zeta", struck: true },
      ],
      status: "active",
      note: null,
      result: null,
      sort_order: 0,
      created_at: NOW.toISOString(),
    });
  });

  it("creates a goal once per client id and refuses someone else's id", async () => {
    const id = crypto.randomUUID();
    const first = await plannerCreateGoal(rt.db, {
      userId: rt.user.id,
      goal: { id, level: "north_star", title: "Freedom with people I love" },
    });
    const again = await plannerCreateGoal(rt.db, {
      userId: rt.user.id,
      goal: { id, level: "north_star", title: "Something else" },
    });
    expect(again).toEqual(first);
    await expect(
      plannerCreateGoal(rt.db, {
        userId: rt.other.id,
        goal: { id, level: "north_star", title: "Mine" },
      }),
    ).rejects.toThrow(ConflictError);
    await expect(
      plannerCreateGoal(rt.db, {
        userId: rt.user.id,
        goal: { level: "year", periodStart: "2026-01-01", title: " " },
      }),
    ).rejects.toThrow(ValidationError);
  });

  it("updates only the fields given and never another user's goal", async () => {
    const goal = await plannerCreateGoal(rt.db, {
      userId: rt.user.id,
      goal: {
        level: "year",
        periodStart: "2026-01-01",
        pillar: "work",
        title: "Stay on better terms",
        status: "contested",
        note: "A 6 Oct note says otherwise",
      },
    });
    const updated = await plannerUpdateGoal(rt.db, {
      userId: rt.user.id,
      goalId: goal.id,
      patch: { note: null, status: "active", lines: [{ text: "Grade A" }] },
    });
    expect(updated).toMatchObject({
      title: "Stay on better terms",
      status: "active",
      note: null,
      lines: [{ text: "Grade A" }],
      pillar: "work",
    });
    await expect(
      plannerUpdateGoal(rt.db, {
        userId: rt.other.id,
        goalId: goal.id,
        patch: { title: "x" },
      }),
    ).rejects.toThrow(NotFoundError);
    await expect(
      plannerUpdateGoal(rt.db, {
        userId: rt.user.id,
        goalId: goal.id,
        patch: { title: "", lines: [] },
      }),
    ).rejects.toThrow(ValidationError);
  });

  it("reads one ISO year for the Goals page, without removed goals", async () => {
    const make = (
      level: "year" | "quarter" | "month" | "week",
      periodStart: string,
      title: string,
    ) =>
      plannerCreateGoal(rt.db, {
        userId: rt.user.id,
        goal: { level, periodStart, pillar: "ai", title },
      });
    await plannerCreateGoal(rt.db, {
      userId: rt.user.id,
      goal: { level: "north_star", title: "North" },
    });
    await make("year", "2026-01-01", "Year 2026");
    await make("year", "2025-01-01", "Year 2025");
    await make("quarter", "2026-10-01", "Q4");
    await make("month", "2026-10-01", "October");
    // ISO 2026 starts on Monday 29 December 2025 and ends on Sunday 3 January 2027.
    await make("week", "2025-12-29", "ISO week 1");
    await make("week", "2026-12-28", "ISO week 53");
    await make("week", "2027-01-04", "Next ISO year");
    const gone = await make("month", "2026-11-01", "November");
    await plannerDeleteGoal(rt.db, { userId: rt.user.id, goalId: gone.id });
    await plannerUpsertWeek(rt.db, {
      userId: rt.user.id,
      weekStart: "2026-09-28",
      patch: { auth: 4, ach: 3.5, source: "import" },
    });

    const year = await plannerReadGoalsYear(rt.db, {
      userId: rt.user.id,
      year: 2026,
      today: "2026-10-11",
    });
    expect(year.current_week).toBe("2026-10-05");
    expect(year.north_star?.title).toBe("North");
    expect(year.goals.map((goal) => goal.title)).toEqual([
      "Year 2026",
      "Q4",
      "October",
      "ISO week 1",
      "ISO week 53",
    ]);
    expect(year.weeks).toEqual([
      expect.objectContaining({
        week_start: "2026-09-28",
        auth: 4,
        ach: 3.5,
        source: "import",
      }),
    ]);
    // A removed goal can still be named by id.
    const named = await plannerReadGoalsById(rt.db, {
      userId: rt.user.id,
      ids: [gone.id],
    });
    expect(named.map((goal) => goal.title)).toEqual(["November"]);
  });

  it("shows next week on the cockpit at the weekend once it is planned", async () => {
    await plannerCreateGoal(rt.db, {
      userId: rt.user.id,
      goal: {
        level: "week",
        periodStart: "2026-10-05",
        pillar: "work",
        title: "This week",
      },
    });
    const read = (today: string) =>
      plannerReadCockpitWeek(rt.db, { userId: rt.user.id, today });
    expect((await read("2026-10-10")).start).toBe("2026-10-05");
    await plannerCreateGoal(rt.db, {
      userId: rt.user.id,
      goal: {
        level: "week",
        periodStart: "2026-10-12",
        pillar: "health",
        title: "Next week",
      },
    });
    const saturday = await read("2026-10-10");
    expect(saturday.start).toBe("2026-10-12");
    expect(saturday.goals.map((goal) => goal.title)).toEqual(["Next week"]);
    const friday = await read("2026-10-09");
    expect(friday.start).toBe("2026-10-05");
    expect(friday.goals.map((goal) => goal.title)).toEqual(["This week"]);
  });

  it("writes a week's record field by field", async () => {
    expect(() => plannerRequireMonday("2026-10-06", "The week")).toThrow(
      ValidationError,
    );
    const first = await plannerUpsertWeek(rt.db, {
      userId: rt.user.id,
      weekStart: "2026-10-05",
      patch: { auth: 4.5, ach: 3, question: "  Did I ask? " },
    });
    expect(first).toMatchObject({
      auth: 4.5,
      ach: 3,
      question: "Did I ask?",
      source: "review",
      memo_id: null,
    });
    const second = await plannerUpsertWeek(rt.db, {
      userId: rt.user.id,
      weekStart: "2026-10-05",
      patch: { ach: null },
    });
    expect(second).toMatchObject({
      auth: 4.5,
      ach: null,
      question: "Did I ask?",
    });
  });

  it("links a task to a goal with a goal_changed event", async () => {
    const goal = await plannerCreateGoal(rt.db, {
      userId: rt.user.id,
      goal: {
        level: "week",
        periodStart: "2026-10-05",
        pillar: "work",
        title: "Terms",
      },
    });
    const taskId = await plannerTestInsertTask(rt.database, {
      id: "tasks/terms",
      userId: rt.user.id,
      title: "Email Acme",
    });
    await plannerTestInsertPlan(rt.database, {
      taskId,
      userId: rt.user.id,
      horizon: "day",
      periodStart: "2026-10-07",
    });
    const set = (goalId: string | null) =>
      plannerSetTaskGoal(rt.db, {
        user: rt.user,
        actor: USER,
        taskId,
        goalId,
        now: NOW,
      });

    expect(await set(goal.id)).toBe(true);
    expect(await set(goal.id)).toBe(false);
    expect((await plannerTestPlan(rt.database, taskId))?.goal_id).toBe(goal.id);
    const board = await plannerReadBoard(rt.db, {
      userId: rt.user.id,
      today: "2026-10-07",
    });
    expect(board.columns.todo[0]?.goal_id).toBe(goal.id);

    expect(await set(null)).toBe(true);
    const events = (await plannerTestEvents(rt.database, taskId)).filter(
      (event) => event.type === "goal_changed",
    );
    expect(events.map((event) => JSON.parse(event.data))).toEqual([
      { from: null, to: goal.id },
      { from: goal.id, to: null },
    ]);
    // The plan is untouched: the task is still in To Do.
    expect(await plannerTestPlan(rt.database, taskId)).toMatchObject({
      horizon: "day",
      goal_id: null,
    });

    await expect(
      plannerSetTaskGoal(rt.db, {
        user: rt.other,
        actor: USER,
        taskId,
        goalId: goal.id,
      }),
    ).rejects.toThrow(NotFoundError);
  });

  it("gives a backlog task a plan row that plans nothing", async () => {
    const goal = await plannerCreateGoal(rt.db, {
      userId: rt.user.id,
      goal: {
        level: "week",
        periodStart: "2026-10-05",
        pillar: "ai",
        title: "Ship",
      },
    });
    const taskId = await plannerTestInsertTask(rt.database, {
      id: "tasks/backlog",
      userId: rt.user.id,
    });
    await plannerSetTaskGoal(rt.db, {
      user: rt.user,
      actor: USER,
      taskId,
      goalId: goal.id,
    });
    expect(await plannerTestPlan(rt.database, taskId)).toMatchObject({
      horizon: null,
      period_start: null,
      goal_id: goal.id,
    });
    const board = await plannerReadBoard(rt.db, {
      userId: rt.user.id,
      today: "2026-10-07",
    });
    expect(board.columns.backlog.map((card) => card.id)).toEqual([taskId]);
  });
});
