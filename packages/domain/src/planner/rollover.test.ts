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
import { ValidationError } from "../errors";
import { createTask, deleteTask, type TaskActor } from "../tasks";
import { plannerReadBoard } from "./board";
import { plannerRollover } from "./rollover";
import {
  type PlannerTestRuntime,
  plannerTestCount,
  plannerTestEvents,
  plannerTestFailBatch,
  plannerTestInsertPlan,
  plannerTestPlan,
  plannerTestRuntime,
  plannerTestSpyOnBatch,
} from "./test-support";

const USER: TaskActor = { type: "user" };
const AGENT: TaskActor = { type: "agent", name: "pat:abcd1234" };

// Wednesday 2026-10-07: this week starts on Monday 2026-10-05.
const TODAY = "2026-10-07";
const NOW = new Date("2026-10-07T09:00:00.000Z");

type Horizon = "day" | "week" | "month";

describe("plannerRollover", () => {
  let rt: PlannerTestRuntime;

  beforeAll(async () => {
    rt = await plannerTestRuntime("flaremo-planner-rollover");
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

  const rollover = (
    overrides: Partial<Parameters<typeof plannerRollover>[1]> = {},
    db = rt.db,
  ) =>
    plannerRollover(db, {
      userId: rt.user.id,
      actor: USER,
      today: TODAY,
      now: NOW,
      ...overrides,
    });

  /** A task with a plan row, planned at the given period. */
  const planned = async (
    title: string,
    plan: { horizon: Horizon | null; periodStart: string | null },
    extra: {
      status?: "todo" | "in_progress" | "done";
      carryCount?: number;
      droppedAt?: string | null;
      owner?: typeof rt.user;
    } = {},
  ) => {
    const owner = extra.owner ?? rt.user;
    const task = await createTask(rt.db, owner, USER, {
      title,
      status: extra.status ?? "todo",
    });
    await plannerTestInsertPlan(rt.database, {
      taskId: task.id,
      userId: owner.id,
      ...plan,
      carryCount: extra.carryCount ?? 0,
      droppedAt: extra.droppedAt ?? null,
    });
    return task.id;
  };

  const carried = async (taskId: string) =>
    (await plannerTestEvents(rt.database, taskId)).filter(
      (event) => event.type === "carried_over",
    );

  it("carries a plan from a past period into the current one, per horizon", async () => {
    const day = await planned("Day", {
      horizon: "day",
      periodStart: "2026-10-06",
    });
    const week = await planned("Week", {
      horizon: "week",
      periodStart: "2026-09-28",
    });
    const month = await planned("Month", {
      horizon: "month",
      periodStart: "2026-09-01",
    });
    const farWeek = await planned("Two weeks back", {
      horizon: "week",
      periodStart: "2026-09-21",
    });

    const result = await rollover({ actor: AGENT });

    expect(result).toEqual({ history: "ok", carried: 4 });
    expect(await plannerTestPlan(rt.database, day)).toMatchObject({
      horizon: "day",
      period_start: TODAY,
      carry_count: 1,
    });
    expect(await plannerTestPlan(rt.database, week)).toMatchObject({
      horizon: "week",
      period_start: "2026-10-05",
      carry_count: 1,
    });
    expect(await plannerTestPlan(rt.database, month)).toMatchObject({
      horizon: "month",
      period_start: "2026-10-01",
      carry_count: 1,
    });
    // Several periods behind is still one carry, straight to the current one.
    expect(await plannerTestPlan(rt.database, farWeek)).toMatchObject({
      period_start: "2026-10-05",
      carry_count: 1,
    });

    const [event] = await carried(week);
    expect(event).toMatchObject({
      type: "carried_over",
      source: "planner",
      source_ref: null,
      actor_type: "agent",
      actor_name: "pat:abcd1234",
      task_title: "Week",
      occurred_at: NOW.toISOString(),
      created_at: NOW.toISOString(),
    });
    expect(JSON.parse(event?.data ?? "{}")).toEqual({
      from: { horizon: "week", period_start: "2026-09-28" },
      to: { horizon: "week", period_start: "2026-10-05" },
    });
    expect((await carried(day)).length).toBe(1);
    expect((await carried(month)).length).toBe(1);
    expect((await carried(farWeek)).length).toBe(1);
  });

  it("leaves current and future plans, and everything that is not an unfinished live plan, alone", async () => {
    const current = await planned("Current week", {
      horizon: "week",
      periodStart: "2026-10-05",
    });
    const today = await planned("Today", {
      horizon: "day",
      periodStart: TODAY,
    });
    const future = await planned("Next month", {
      horizon: "month",
      periodStart: "2026-11-01",
    });
    const done = await planned(
      "Done",
      { horizon: "day", periodStart: "2026-10-01" },
      { status: "done" },
    );
    const dropped = await planned(
      "Dropped",
      { horizon: "day", periodStart: "2026-10-01" },
      { droppedAt: "2026-10-02T00:00:00.000Z" },
    );
    const backlog = await planned("Backlog row", {
      horizon: null,
      periodStart: null,
    });
    const deleted = await planned("Deleted", {
      horizon: "day",
      periodStart: "2026-10-01",
    });
    await deleteTask(rt.db, rt.user, deleted);
    const doing = await planned(
      "Doing",
      { horizon: "day", periodStart: "2026-10-01" },
      { status: "in_progress" },
    );
    const theirs = await planned(
      "Theirs",
      { horizon: "day", periodStart: "2026-10-01" },
      { owner: rt.other },
    );

    const result = await rollover();

    expect(result.carried).toBe(1);
    expect((await plannerTestPlan(rt.database, doing))?.period_start).toBe(
      TODAY,
    );
    for (const [id, periodStart] of [
      [current, "2026-10-05"],
      [today, TODAY],
      [future, "2026-11-01"],
      [done, "2026-10-01"],
      [dropped, "2026-10-01"],
      [deleted, "2026-10-01"],
      [theirs, "2026-10-01"],
    ] as const) {
      const plan = await plannerTestPlan(rt.database, id);
      expect(plan?.period_start, id).toBe(periodStart);
      expect(plan?.carry_count, id).toBe(0);
      expect(await carried(id), id).toHaveLength(0);
    }
    expect(await plannerTestPlan(rt.database, backlog)).toMatchObject({
      horizon: null,
      period_start: null,
      carry_count: 0,
    });
  });

  it("is idempotent: running it again carries nothing and adds no events", async () => {
    const a = await planned("A", { horizon: "day", periodStart: "2026-10-06" });
    const b = await planned("B", {
      horizon: "week",
      periodStart: "2026-09-28",
    });
    expect((await rollover()).carried).toBe(2);
    const events = await plannerTestCount(rt.database, "planner_task_event");

    const again = await rollover({ now: new Date(NOW.getTime() + 120_000) });

    expect(again).toEqual({ history: "ok", carried: 0 });
    expect(await plannerTestCount(rt.database, "planner_task_event")).toBe(
      events,
    );
    expect((await plannerTestPlan(rt.database, a))?.carry_count).toBe(1);
    expect((await plannerTestPlan(rt.database, b))?.carry_count).toBe(1);
  });

  it("carries again when the local date moves on", async () => {
    const day = await planned("Day", { horizon: "day", periodStart: TODAY });
    const week = await planned("Week", {
      horizon: "week",
      periodStart: "2026-10-05",
    });
    expect((await rollover()).carried).toBe(0);

    // Thursday: the day plan is behind, the week plan is not.
    const thursday = await rollover({
      today: "2026-10-08",
      now: new Date("2026-10-08T09:00:00.000Z"),
    });
    expect(thursday.carried).toBe(1);
    expect(await plannerTestPlan(rt.database, day)).toMatchObject({
      period_start: "2026-10-08",
      carry_count: 1,
    });
    expect((await plannerTestPlan(rt.database, week))?.carry_count).toBe(0);

    // The next Monday: both are behind now.
    const monday = await rollover({
      today: "2026-10-12",
      now: new Date("2026-10-12T09:00:00.000Z"),
    });
    expect(monday.carried).toBe(2);
    expect(await plannerTestPlan(rt.database, week)).toMatchObject({
      period_start: "2026-10-12",
      carry_count: 1,
    });
    expect(await plannerTestPlan(rt.database, day)).toMatchObject({
      period_start: "2026-10-12",
      carry_count: 2,
    });
  });

  it("respects the Monday week start and the month start", async () => {
    // Sunday 2026-11-01: still the week of Monday 2026-10-26, already November.
    const sunday = {
      today: "2026-11-01",
      now: new Date("2026-11-01T09:00:00.000Z"),
    };
    const sameWeek = await planned("Same week", {
      horizon: "week",
      periodStart: "2026-10-26",
    });
    const lastWeek = await planned("Last week", {
      horizon: "week",
      periodStart: "2026-10-19",
    });
    const october = await planned("October", {
      horizon: "month",
      periodStart: "2026-10-01",
    });

    expect((await rollover(sunday)).carried).toBe(2);

    expect((await plannerTestPlan(rt.database, sameWeek))?.period_start).toBe(
      "2026-10-26",
    );
    expect((await plannerTestPlan(rt.database, lastWeek))?.period_start).toBe(
      "2026-10-26",
    );
    expect((await plannerTestPlan(rt.database, october))?.period_start).toBe(
      "2026-11-01",
    );
  });

  it("gives each task exactly one carry and one event when two rollovers run at once", async () => {
    const ids = [
      await planned("A", { horizon: "day", periodStart: "2026-10-06" }),
      await planned("B", { horizon: "week", periodStart: "2026-09-28" }),
      await planned("C", { horizon: "month", periodStart: "2026-09-01" }),
      await planned("D", { horizon: "day", periodStart: "2026-10-01" }),
      await planned("E", { horizon: "week", periodStart: "2026-09-21" }),
    ];

    const results = await Promise.all([
      rollover(),
      rollover({ actor: AGENT }),
      rollover(),
    ]);

    // Between them they carried each plan once: one run did all the work.
    expect(results.map((result) => result.carried).sort()).toEqual([0, 0, 5]);
    for (const id of ids) {
      expect((await plannerTestPlan(rt.database, id))?.carry_count, id).toBe(1);
      expect(await carried(id), id).toHaveLength(1);
    }
    expect(
      (await plannerTestEvents(rt.database)).filter(
        (event) => event.type === "carried_over",
      ),
    ).toHaveLength(5);
  });

  it("runs the history sync first and reports its status", async () => {
    const task = await createTask(rt.db, rt.user, USER, { title: "Archived" });
    const spy = plannerTestSpyOnBatch(rt.db);

    const result = await rollover({}, spy.db);

    expect(result.history).toBe("ok");
    // Two batches: the sync (10 statements), then the carry (2).
    expect(spy.batches.map((batch) => batch.length)).toEqual([10, 2]);
    expect(
      (await plannerTestEvents(rt.database, task.id)).map(
        (event) => event.type,
      ),
    ).toEqual(["created"]);
  });

  it("still carries, and the board still works, when the history sync fails", async () => {
    const stuck = await planned("Stuck", {
      horizon: "day",
      periodStart: "2026-10-06",
    });
    const failing = plannerTestFailBatch(rt.db, (texts) =>
      texts.some((text) => text.includes("FROM task_activity")),
    );

    const result = await rollover({}, failing);

    expect(result).toEqual({ history: "paused", carried: 1 });
    expect(await carried(stuck)).toHaveLength(1);
    // Nothing was archived by the failed sync, but the carry event is a planner event.
    expect(
      (await plannerTestEvents(rt.database)).map((event) => event.type),
    ).toEqual(["carried_over"]);

    const board = await plannerReadBoard(failing, {
      userId: rt.user.id,
      today: TODAY,
    });
    expect(board.history).toBe("paused");
    expect(board.columns.todo.map((card) => card.title)).toEqual(["Stuck"]);
    expect(board.columns.todo[0]).toMatchObject({
      period_start: TODAY,
      carry_count: 1,
    });
  });

  it("accepts a date one day either side of the server's and nothing further", async () => {
    const id = await planned("Bounds", {
      horizon: "day",
      periodStart: "2026-10-01",
    });
    const attempt = (today: string) => rollover({ today });

    for (const bad of [
      "2026-10-05",
      "2026-10-09",
      "2026-10-31",
      "2099-01-01",
    ]) {
      await expect(attempt(bad), bad).rejects.toBeInstanceOf(ValidationError);
    }
    for (const bad of ["yesterday", "", "2026-02-30", "2026-10-7"]) {
      await expect(attempt(bad), bad).rejects.toBeInstanceOf(ValidationError);
    }
    // Rejected before anything ran.
    expect((await plannerTestPlan(rt.database, id))?.carry_count).toBe(0);
    expect(await plannerTestCount(rt.database, "planner_sync_state")).toBe(0);

    await expect(attempt("2026-10-06")).resolves.toMatchObject({ carried: 1 });
    expect((await plannerTestPlan(rt.database, id))?.period_start).toBe(
      "2026-10-06",
    );
    await expect(attempt("2026-10-08")).resolves.toMatchObject({ carried: 1 });
  });

  it("only touches the plans of the user it runs for", async () => {
    const mine = await planned("Mine", {
      horizon: "day",
      periodStart: "2026-10-01",
    });
    const theirs = await planned(
      "Theirs",
      { horizon: "day", periodStart: "2026-10-01" },
      { owner: rt.other },
    );

    expect((await rollover()).carried).toBe(1);
    expect((await plannerTestPlan(rt.database, mine))?.period_start).toBe(
      TODAY,
    );
    expect((await plannerTestPlan(rt.database, theirs))?.period_start).toBe(
      "2026-10-01",
    );

    expect((await rollover({ userId: rt.other.id, actor: USER })).carried).toBe(
      1,
    );
    expect((await plannerTestPlan(rt.database, theirs))?.period_start).toBe(
      TODAY,
    );
  });
});
