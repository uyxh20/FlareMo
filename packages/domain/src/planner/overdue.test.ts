import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ValidationError } from "../errors";
import { plannerReadOverdue } from "./overdue";
import {
  type PlannerTestRuntime,
  plannerTestCount,
  plannerTestInsertPlan,
  plannerTestInsertTask,
  plannerTestRuntime,
} from "./test-support";

// Wednesday 2026-10-07.
const TODAY = "2026-10-07";

describe("plannerReadOverdue", () => {
  let rt: PlannerTestRuntime;

  beforeAll(async () => {
    rt = await plannerTestRuntime("flaremo-planner-overdue");
  });
  afterAll(async () => {
    await rt.dispose();
  });
  beforeEach(async () => {
    await rt.reset();
  });

  let n = 0;
  const seed = async (options: {
    dueAt: string | null;
    status?: string;
    deletedAt?: string | null;
    droppedAt?: string | null;
    owner?: typeof rt.user;
  }) => {
    n += 1;
    const id = `tasks/overdue-${n}`;
    const owner = options.owner ?? rt.user;
    await plannerTestInsertTask(rt.database, {
      id,
      userId: owner.id,
      status: options.status ?? "todo",
      dueAt: options.dueAt,
      deletedAt: options.deletedAt ?? null,
    });
    if (options.droppedAt !== undefined) {
      await plannerTestInsertPlan(rt.database, {
        taskId: id,
        userId: owner.id,
        droppedAt: options.droppedAt,
      });
    }
    return id;
  };

  const read = () =>
    plannerReadOverdue(rt.db, { userId: rt.user.id, today: TODAY });

  it("is zero with no tasks", async () => {
    expect(await read()).toEqual({ today: TODAY, overdue: 0, due_today: 0 });
  });

  it("counts open tasks past due from any month, and those due today", async () => {
    await seed({ dueAt: "2026-10-06" }); // yesterday
    await seed({ dueAt: "2026-08-15", status: "in_progress" }); // two months ago
    await seed({ dueAt: "2025-12-31" }); // last year
    await seed({ dueAt: TODAY });
    await seed({ dueAt: TODAY, droppedAt: null }); // a plan row, not dropped

    expect(await read()).toEqual({ today: TODAY, overdue: 3, due_today: 2 });
  });

  it("leaves out done, dropped, deleted, undated, future and other people's tasks", async () => {
    await seed({ dueAt: "2026-10-01", status: "done" });
    await seed({ dueAt: "2026-10-01", droppedAt: "2026-10-02T09:00:00.000Z" });
    await seed({ dueAt: "2026-10-01", deletedAt: "2026-10-03T09:00:00.000Z" });
    await seed({ dueAt: null });
    await seed({ dueAt: "2026-10-08" });
    await seed({ dueAt: "2026-10-01", owner: rt.other });

    expect(await read()).toEqual({ today: TODAY, overdue: 0, due_today: 0 });
  });

  it("only reads: it writes nothing to the history archive", async () => {
    await seed({ dueAt: "2026-10-01" });
    await read();
    expect(await plannerTestCount(rt.database, "planner_task_event")).toBe(0);
    expect(await plannerTestCount(rt.database, "planner_sync_state")).toBe(0);
  });

  it("rejects a day that is not a real date", async () => {
    await expect(
      plannerReadOverdue(rt.db, { userId: rt.user.id, today: "2026-02-30" }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
