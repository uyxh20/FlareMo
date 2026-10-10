import { drizzle } from "drizzle-orm/d1";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ValidationError } from "../errors";
import { createProject } from "../projects";
import { createTask, type TaskActor, updateTask } from "../tasks";
import {
  plannerBoardCardCap,
  plannerBoardDoneDaysDefault,
  plannerReadBoard,
} from "./board";
import { plannerDropTask, plannerUndropTask } from "./plans";
import {
  type PlannerTestRuntime,
  plannerTestInsertPlan,
  plannerTestInsertPlans,
  plannerTestInsertTask,
  plannerTestInsertTasks,
  plannerTestRun,
  plannerTestRuntime,
} from "./test-support";

const USER: TaskActor = { type: "user" };

// Wednesday 2026-10-07.
const TODAY = "2026-10-07";

type Status = "todo" | "in_progress" | "done";

describe("plannerReadBoard", () => {
  let rt: PlannerTestRuntime;

  beforeAll(async () => {
    rt = await plannerTestRuntime("flaremo-planner-board");
  });
  afterAll(async () => {
    await rt.dispose();
  });
  beforeEach(async () => {
    await rt.reset();
  });

  const board = (
    overrides: Partial<Parameters<typeof plannerReadBoard>[1]> = {},
  ) =>
    plannerReadBoard(rt.db, { userId: rt.user.id, today: TODAY, ...overrides });

  const titles = (cards: Array<{ title: string }>) =>
    cards.map((card) => card.title);

  /** A task row, optionally with a plan row. */
  const seed = async (
    title: string,
    options: {
      status?: Status | string;
      plan?: {
        horizon: "day" | "week" | "month" | null;
        periodStart: string | null;
        carryCount?: number;
        droppedAt?: string | null;
      };
      createdAt?: string;
      completedAt?: string | null;
      deletedAt?: string | null;
      projectId?: string | null;
      owner?: typeof rt.user;
      sortOrder?: number;
      dueAt?: string | null;
    } = {},
  ) => {
    const owner = options.owner ?? rt.user;
    const id = `tasks/${title.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}`;
    await plannerTestInsertTask(rt.database, {
      id,
      userId: owner.id,
      title,
      status: options.status ?? "todo",
      createdAt: options.createdAt ?? "2026-10-01T08:00:00.000Z",
      completedAt: options.completedAt ?? null,
      deletedAt: options.deletedAt ?? null,
      projectId: options.projectId ?? null,
      sortOrder: options.sortOrder ?? 0,
      dueAt: options.dueAt ?? null,
    });
    if (options.plan) {
      await plannerTestInsertPlan(rt.database, {
        taskId: id,
        userId: owner.id,
        ...options.plan,
      });
    }
    return id;
  };

  const week = { horizon: "week" as const, periodStart: "2026-10-05" };

  it("groups tasks into the four columns and the other bucket by status and plan", async () => {
    await seed("No plan");
    await seed("Null horizon", { plan: { horizon: null, periodStart: null } });
    await seed("Planned", { plan: week });
    await seed("Underway", { status: "in_progress" });
    await seed("Finished", {
      status: "done",
      completedAt: "2026-10-06T10:00:00.000Z",
    });
    await seed("Mystery", { status: "blocked" });

    const result = await board();

    expect(titles(result.columns.backlog).sort()).toEqual([
      "No plan",
      "Null horizon",
    ]);
    expect(titles(result.columns.todo)).toEqual(["Planned"]);
    expect(titles(result.columns.doing)).toEqual(["Underway"]);
    expect(titles(result.columns.done)).toEqual(["Finished"]);
    expect(titles(result.columns.other)).toEqual(["Mystery"]);
    expect(result.columns).not.toHaveProperty("dropped");
    expect(result.truncated).toBe(false);
    expect(result.today).toBe(TODAY);
    expect(result.periods).toEqual({
      day: "2026-10-07",
      week: "2026-10-05",
      month: "2026-10-01",
    });
    expect(result.history).toBe("ok");
  });

  it("returns the explicit card fields, flattened, without notes", async () => {
    const project = await createProject(rt.db, rt.user, { name: "Home" });
    const withNotes = await createTask(rt.db, rt.user, USER, {
      title: "Has notes",
      notes: "Secret details",
      priority: "high",
      due_at: "2026-10-09",
      project_id: project.id,
    });
    await plannerTestInsertPlan(rt.database, {
      taskId: withNotes.id,
      userId: rt.user.id,
      horizon: "day",
      periodStart: TODAY,
      carryCount: 2,
    });
    await seed("Bare");

    const result = await board();

    const card = result.columns.todo[0];
    expect(card).toEqual({
      id: withNotes.id,
      project_id: project.id,
      project_name: "Home",
      title: "Has notes",
      status: "todo",
      priority: "high",
      due_at: "2026-10-09",
      sort_order: 0,
      completed_at: null,
      created_at: withNotes.created_at,
      updated_at: withNotes.updated_at,
      horizon: "day",
      period_start: TODAY,
      carry_count: 2,
      dropped_at: null,
      start_date: null,
      board_rank: null,
      goal_id: null,
    });
    expect(JSON.stringify(result)).not.toContain("Secret details");
    expect(card).not.toHaveProperty("notes");
    expect(card).not.toHaveProperty("source_memo_id");

    // A task with no plan row has the neutral plan fields.
    expect(result.columns.backlog[0]).toMatchObject({
      title: "Bare",
      project_id: null,
      project_name: null,
      horizon: null,
      period_start: null,
      carry_count: 0,
      dropped_at: null,
    });
  });

  it("reads tasks, plans and project names with one joined query and never selects notes", async () => {
    const queries: string[] = [];
    const logged = drizzle(rt.database, {
      logger: { logQuery: (query) => queries.push(query) },
    }) as unknown as typeof rt.db;
    await seed("Anything");

    await plannerReadBoard(logged, { userId: rt.user.id, today: TODAY });

    const taskQueries = queries.filter((query) =>
      query.includes('from "tasks"'),
    );
    expect(taskQueries).toHaveLength(1);
    expect(taskQueries[0]).toContain('left join "planner_task_plan"');
    expect(taskQueries[0]).toContain('left join "projects"');
    expect(taskQueries[0]).not.toContain('"notes"');
    expect(taskQueries[0]).not.toContain('"source_memo_id"');
  });

  describe("dropped tasks", () => {
    const dropped = (periodStart: string | null = null) => ({
      horizon: periodStart ? ("week" as const) : null,
      periodStart,
      droppedAt: "2026-10-03T00:00:00.000Z",
    });

    it("wins over status and is returned only on request, as its own list", async () => {
      await seed("Dropped backlog", { plan: dropped() });
      await seed("Dropped planned", { plan: dropped("2026-10-05") });
      await seed("Dropped doing", { status: "in_progress", plan: dropped() });
      await seed("Dropped done", {
        status: "done",
        completedAt: "2026-10-06T10:00:00.000Z",
        plan: dropped(),
      });
      await seed("Dropped other", { status: "blocked", plan: dropped() });
      await seed("Live");

      const hidden = await board();
      expect(titles(hidden.columns.backlog)).toEqual(["Live"]);
      for (const column of ["todo", "doing", "done", "other"] as const) {
        expect(hidden.columns[column], column).toEqual([]);
      }
      expect(hidden.columns).not.toHaveProperty("dropped");

      const shown = await board({ includeDropped: true });
      expect(titles(shown.columns.dropped ?? []).sort()).toEqual([
        "Dropped backlog",
        "Dropped doing",
        "Dropped done",
        "Dropped other",
        "Dropped planned",
      ]);
      expect(titles(shown.columns.backlog)).toEqual(["Live"]);
      for (const column of ["todo", "doing", "done", "other"] as const) {
        expect(shown.columns[column], column).toEqual([]);
      }
    });

    it("lists an old done task that was dropped, whatever the done window", async () => {
      await seed("Ancient and dropped", {
        status: "done",
        completedAt: "2025-01-01T00:00:00.000Z",
        plan: dropped(),
      });
      await seed("Ancient", {
        status: "done",
        completedAt: "2025-01-01T00:00:00.000Z",
      });
      const shown = await board({ includeDropped: true });
      expect(titles(shown.columns.dropped ?? [])).toEqual([
        "Ancient and dropped",
      ]);
      expect(shown.columns.done).toEqual([]);
    });

    it("puts an undropped task back where its status and kept plan say", async () => {
      const make = (title: string, status: Status) =>
        createTask(rt.db, rt.user, USER, { title, status });
      const planned = await make("Planned", "todo");
      const unplanned = await make("Unplanned", "todo");
      const doing = await make("Doing", "in_progress");
      const done = await make("Done", "done");
      // Inside the done window whatever the machine's clock says.
      await plannerTestRun(
        rt.database,
        "UPDATE tasks SET completed_at = '2026-10-06T10:00:00.000Z' WHERE id = ?",
        done.id,
      );
      await plannerTestInsertPlan(rt.database, {
        taskId: planned.id,
        userId: rt.user.id,
        horizon: "week",
        periodStart: "2026-10-05",
      });

      for (const task of [planned, unplanned, doing, done]) {
        await plannerDropTask(rt.db, {
          user: rt.user,
          actor: USER,
          taskId: task.id,
        });
      }
      const during = await board({ includeDropped: true });
      expect(titles(during.columns.dropped ?? []).sort()).toEqual([
        "Doing",
        "Done",
        "Planned",
        "Unplanned",
      ]);

      for (const task of [planned, unplanned, doing, done]) {
        await plannerUndropTask(rt.db, {
          user: rt.user,
          actor: USER,
          taskId: task.id,
        });
      }
      const after = await board({ includeDropped: true });
      expect(titles(after.columns.todo)).toEqual(["Planned"]);
      expect(titles(after.columns.backlog)).toEqual(["Unplanned"]);
      expect(titles(after.columns.doing)).toEqual(["Doing"]);
      expect(titles(after.columns.done)).toEqual(["Done"]);
      expect(after.columns.dropped).toEqual([]);
    });
  });

  describe("the done window", () => {
    const doneOn = (title: string, completedAt: string | null) =>
      seed(title, { status: "done", completedAt });

    it("shows tasks finished within the last 14 days by default", async () => {
      expect(plannerBoardDoneDaysDefault).toBe(14);
      await doneOn("Today", "2026-10-07T08:00:00.000Z");
      await doneOn("Thirteen days ago", "2026-09-24T08:00:00.000Z");
      await doneOn("Exactly fourteen days ago", "2026-09-23T00:00:00.000Z");
      await doneOn("Just outside", "2026-09-22T23:59:59.999Z");
      await doneOn("Long ago", "2026-01-01T00:00:00.000Z");

      expect(titles((await board()).columns.done)).toEqual([
        "Today",
        "Thirteen days ago",
        "Exactly fourteen days ago",
      ]);
    });

    it("honours done_days", async () => {
      await doneOn("Today", "2026-10-07T08:00:00.000Z");
      await doneOn("Yesterday", "2026-10-06T23:00:00.000Z");
      await doneOn("A month ago", "2026-09-07T08:00:00.000Z");

      expect(titles((await board({ doneDays: 0 })).columns.done)).toEqual([
        "Today",
      ]);
      expect(titles((await board({ doneDays: 1 })).columns.done)).toEqual([
        "Today",
        "Yesterday",
      ]);
      expect(titles((await board({ doneDays: 30 })).columns.done)).toEqual([
        "Today",
        "Yesterday",
        "A month ago",
      ]);
    });

    it("falls back to the update time for a done task with no completion time", async () => {
      await doneOn("No completion time", null);
      await plannerTestRun(
        rt.database,
        "UPDATE tasks SET updated_at = '2026-10-06T00:00:00.000Z' WHERE title = 'No completion time'",
      );
      expect(titles((await board()).columns.done)).toEqual([
        "No completion time",
      ]);
      await plannerTestRun(
        rt.database,
        "UPDATE tasks SET updated_at = '2020-01-01T00:00:00.000Z' WHERE title = 'No completion time'",
      );
      expect((await board()).columns.done).toEqual([]);
    });

    it("rejects a done_days that is not a whole number from 0 to 3650", async () => {
      for (const bad of [-1, 1.5, Number.NaN, 3651, Number.POSITIVE_INFINITY]) {
        await expect(
          board({ doneDays: bad }),
          String(bad),
        ).rejects.toBeInstanceOf(ValidationError);
      }
      await expect(board({ doneDays: 3650 })).resolves.toBeDefined();
    });
  });

  it("rejects a today that is not a real day", async () => {
    for (const bad of ["", "tomorrow", "2026-02-30", "2026-10-7"]) {
      await expect(board({ today: bad }), bad).rejects.toBeInstanceOf(
        ValidationError,
      );
    }
  });

  it("leaves out deleted tasks and other users' tasks", async () => {
    await seed("Mine");
    await seed("Binned", { deletedAt: "2026-10-05T00:00:00.000Z" });
    await seed("Theirs", { owner: rt.other });

    const mine = await board();
    expect(titles(mine.columns.backlog)).toEqual(["Mine"]);
    const theirs = await plannerReadBoard(rt.db, {
      userId: rt.other.id,
      today: TODAY,
    });
    expect(titles(theirs.columns.backlog)).toEqual(["Theirs"]);
  });

  it("orders each column: backlog newest first, to do by nearest deadline, done newest first", async () => {
    await seed("Old backlog", { createdAt: "2026-09-01T00:00:00.000Z" });
    await seed("New backlog", { createdAt: "2026-10-05T00:00:00.000Z" });
    await seed("Month", {
      plan: { horizon: "month", periodStart: "2026-10-01" },
      sortOrder: 0,
    });
    await seed("Week B", {
      plan: { horizon: "week", periodStart: "2026-10-05" },
      sortOrder: 2,
    });
    await seed("Week A", {
      plan: { horizon: "week", periodStart: "2026-10-05" },
      sortOrder: 1,
    });
    await seed("Day", { plan: { horizon: "day", periodStart: "2026-10-07" } });
    await seed("Carried day", {
      plan: { horizon: "day", periodStart: "2026-10-05" },
    });
    await seed("Done old", {
      status: "done",
      completedAt: "2026-10-01T00:00:00.000Z",
    });
    await seed("Done new", {
      status: "done",
      completedAt: "2026-10-06T00:00:00.000Z",
    });
    await seed("Doing second", { status: "in_progress", sortOrder: 2 });
    await seed("Doing first", { status: "in_progress", sortOrder: 1 });

    const result = await board();

    expect(titles(result.columns.backlog)).toEqual([
      "New backlog",
      "Old backlog",
    ]);
    // The period that ends soonest first (a day before a week before a month),
    // and upstream's own order within one.
    expect(titles(result.columns.todo)).toEqual([
      "Carried day",
      "Day",
      "Week A",
      "Week B",
      "Month",
    ]);
    expect(titles(result.columns.done)).toEqual(["Done new", "Done old"]);
    expect(titles(result.columns.doing)).toEqual([
      "Doing first",
      "Doing second",
    ]);
  });

  it("reports whether the history sync is paused, from the stored state", async () => {
    expect((await board()).history).toBe("ok");
    await plannerTestRun(
      rt.database,
      "INSERT INTO planner_sync_state (user_id, status, paused_reason) VALUES (?, 'paused', 'upstream changed')",
      rt.user.id,
    );
    expect((await board()).history).toBe("paused");
    expect(
      (await plannerReadBoard(rt.db, { userId: rt.other.id, today: TODAY }))
        .history,
    ).toBe("ok");
  });

  it("sees a task the moment upstream changes it", async () => {
    const task = await createTask(rt.db, rt.user, USER, { title: "Live data" });
    expect(titles((await board()).columns.backlog)).toEqual(["Live data"]);
    await updateTask(rt.db, rt.user, USER, task.id, { status: "in_progress" });
    const result = await board();
    expect(result.columns.backlog).toEqual([]);
    expect(titles(result.columns.doing)).toEqual(["Live data"]);
  });

  describe("the 500 card cap", () => {
    const stamp = (base: string, minute: number) =>
      new Date(Date.parse(base) + minute * 60_000).toISOString();

    const backlogRows = (count: number, base = "2026-06-01T00:00:00.000Z") =>
      Array.from({ length: count }, (_, index) => ({
        id: `tasks/b-${index}`,
        userId: rt.user.id,
        title: `Backlog ${index}`,
        createdAt: stamp(base, index),
      }));
    const doneRows = (count: number, base = "2026-10-01T00:00:00.000Z") =>
      Array.from({ length: count }, (_, index) => ({
        id: `tasks/d-${index}`,
        userId: rt.user.id,
        title: `Done ${index}`,
        status: "done",
        createdAt: "2026-01-01T00:00:00.000Z",
        completedAt: stamp(base, index),
      }));
    const planned = async (
      prefix: string,
      count: number,
      status: Status = "todo",
    ) => {
      const rows = Array.from({ length: count }, (_, index) => ({
        id: `tasks/${prefix}-${index}`,
        userId: rt.user.id,
        title: `${prefix} ${index}`,
        status,
        sortOrder: index,
        createdAt: "2026-09-01T00:00:00.000Z",
      }));
      await plannerTestInsertTasks(rt.database, rows);
      await plannerTestInsertPlans(
        rt.database,
        rows.map((row) => ({
          taskId: row.id,
          userId: rt.user.id,
          horizon: "week" as const,
          periodStart: "2026-10-05",
        })),
      );
    };

    it("does not truncate at exactly 500 cards", async () => {
      expect(plannerBoardCardCap).toBe(500);
      await plannerTestInsertTasks(rt.database, backlogRows(300));
      await plannerTestInsertTasks(rt.database, doneRows(200));

      const result = await board();

      expect(result.columns.backlog).toHaveLength(300);
      expect(result.columns.done).toHaveLength(200);
      expect(result.truncated).toBe(false);
    });

    it("cuts Backlog and Done together, newest first, once there are more than 500", async () => {
      // Every Done task is newer than every Backlog task.
      await plannerTestInsertTasks(rt.database, backlogRows(300));
      await plannerTestInsertTasks(rt.database, doneRows(300));

      const result = await board({ doneDays: 30 });

      expect(result.truncated).toBe(true);
      expect(result.columns.done).toHaveLength(300);
      expect(result.columns.backlog).toHaveLength(200);
      // The newest 200 backlog cards survive: indexes 100 to 299.
      expect(
        Math.min(
          ...result.columns.backlog.map((card) =>
            Number(card.title.replace("Backlog ", "")),
          ),
        ),
      ).toBe(100);
      expect(result.columns.backlog[0]?.title).toBe("Backlog 299");
    });

    it("lets the newer side win whichever it is", async () => {
      // Now every Backlog task is newer than every Done task.
      await plannerTestInsertTasks(
        rt.database,
        backlogRows(300, "2026-10-02T00:00:00.000Z"),
      );
      await plannerTestInsertTasks(
        rt.database,
        doneRows(300, "2026-10-01T00:00:00.000Z"),
      );

      const result = await board({ doneDays: 30 });

      expect(result.truncated).toBe(true);
      expect(result.columns.backlog).toHaveLength(300);
      expect(result.columns.done).toHaveLength(200);
      expect(result.columns.done[0]?.title).toBe("Done 299");
    });

    it("never cuts To Do or Doing, which come off the top", async () => {
      await planned("todo", 450);
      await planned("doing", 30, "in_progress");
      await plannerTestInsertTasks(rt.database, backlogRows(100));
      await plannerTestInsertTasks(rt.database, doneRows(100));

      const result = await board({ doneDays: 30 });

      expect(result.columns.todo).toHaveLength(450);
      expect(result.columns.doing).toHaveLength(30);
      // 500 - 450 - 30 = 20 cards left for Backlog and Done together.
      expect(result.columns.backlog.length + result.columns.done.length).toBe(
        20,
      );
      expect(result.truncated).toBe(true);
    });

    it("keeps every To Do card even when they alone pass the cap", async () => {
      await planned("todo", 505);
      await plannerTestInsertTasks(rt.database, backlogRows(3));

      const result = await board();

      expect(result.columns.todo).toHaveLength(505);
      expect(result.columns.backlog).toHaveLength(0);
      expect(result.truncated).toBe(true);
    });

    it("is not truncated when only To Do passes the cap and nothing was cut", async () => {
      await planned("todo", 505);
      const result = await board();
      expect(result.columns.todo).toHaveLength(505);
      expect(result.truncated).toBe(false);
    });

    it("caps the dropped list by itself and says so", async () => {
      const rows = Array.from({ length: 510 }, (_, index) => ({
        id: `tasks/x-${index}`,
        userId: rt.user.id,
        title: `Dropped ${index}`,
        createdAt: "2026-09-01T00:00:00.000Z",
      }));
      await plannerTestInsertTasks(rt.database, rows);
      await plannerTestInsertPlans(
        rt.database,
        rows.map((row, index) => ({
          taskId: row.id,
          userId: rt.user.id,
          droppedAt: stamp("2026-10-01T00:00:00.000Z", index),
        })),
      );
      await plannerTestInsertTasks(rt.database, backlogRows(5));

      const result = await board({ includeDropped: true });

      expect(result.columns.dropped).toHaveLength(500);
      expect(result.columns.dropped?.[0]?.title).toBe("Dropped 509");
      expect(result.columns.backlog).toHaveLength(5);
      expect(result.truncated).toBe(true);
    });
  });
});
