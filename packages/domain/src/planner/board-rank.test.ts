import { plannerRankMaxLength } from "@flaremo/contracts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ValidationError } from "../errors";
import type { TaskActor } from "../tasks";
import { plannerReadBoard } from "./board";
import { plannerRankNewTaskOnTop, plannerSetBoardRank } from "./board-rank";
import {
  plannerApplyColumnMove,
  plannerCreateTask,
  plannerDropTask,
} from "./plans";
import {
  type PlannerTestRuntime,
  plannerTestCount,
  plannerTestEvents,
  plannerTestInsertPlan,
  plannerTestInsertTask,
  plannerTestPlan,
  plannerTestRuntime,
} from "./test-support";

const USER: TaskActor = { type: "user" };
const TODAY = "2026-10-07";
const WEEK = { horizon: "week" as const, periodStart: "2026-10-05" };

describe("the board's manual order", () => {
  let rt: PlannerTestRuntime;

  beforeAll(async () => {
    rt = await plannerTestRuntime("flaremo-planner-board-rank");
  });
  afterAll(async () => {
    await rt.dispose();
  });
  beforeEach(async () => {
    await rt.reset();
  });

  const board = () =>
    plannerReadBoard(rt.db, { userId: rt.user.id, today: TODAY });
  const ids = async (column: "backlog" | "todo" | "doing" | "done") =>
    (await board()).columns[column].map((card) => card.id);

  /** A To Do task (planned this week), created `n` days into October. */
  const todo = async (name: string, options: { rank?: string } = {}) => {
    const id = `tasks/${name}`;
    await plannerTestInsertTask(rt.database, {
      id,
      userId: rt.user.id,
      title: name,
      createdAt: "2026-10-01T08:00:00.000Z",
    });
    await plannerTestInsertPlan(rt.database, {
      taskId: id,
      userId: rt.user.id,
      ...WEEK,
      boardRank: options.rank ? `todo|${options.rank}` : null,
    });
    return id;
  };
  const move = (
    taskId: string,
    input: { beforeId?: string; afterId?: string },
  ) =>
    plannerSetBoardRank(rt.db, {
      user: rt.user,
      taskId,
      column: "todo",
      today: TODAY,
      ...input,
    });

  describe("reading", () => {
    it("lists ranked cards first, in key order, then the rest in the old order", async () => {
      await todo("a", { rank: "m" });
      await todo("bb");
      await todo("c", { rank: "f" });
      await todo("dd");
      // Unranked To Do cards sort by plan, then upstream order (sort_order, created).
      const result = await board();
      expect(result.columns.todo.map((card) => card.id)).toEqual([
        "tasks/c",
        "tasks/a",
        "tasks/bb",
        "tasks/dd",
      ]);
      expect(result.columns.todo.map((card) => card.board_rank)).toEqual([
        "f",
        "m",
        null,
        null,
      ]);
    });

    it("ignores a rank that belongs to another column", async () => {
      const id = await todo("a");
      await rt.database
        .prepare(
          "UPDATE planner_task_plan SET board_rank = 'doing|m' WHERE task_id = ?",
        )
        .bind(id)
        .run();
      expect((await board()).columns.todo[0]?.board_rank).toBeNull();
    });

    it("orders every column by rank, not only To Do", async () => {
      for (const [name, status] of [
        ["x", "in_progress"],
        ["y", "in_progress"],
        ["p", "done"],
        ["q", "done"],
        ["m", "todo"],
        ["n", "todo"],
      ] as const) {
        await plannerTestInsertTask(rt.database, {
          id: `tasks/${name}`,
          userId: rt.user.id,
          status,
          completedAt: status === "done" ? "2026-10-06T08:00:00.000Z" : null,
        });
      }
      const rank = (name: string, column: string, key: string) =>
        plannerTestInsertPlan(rt.database, {
          taskId: `tasks/${name}`,
          userId: rt.user.id,
          boardRank: `${column}|${key}`,
        });
      await rank("x", "doing", "b");
      await rank("y", "doing", "a");
      await rank("p", "done", "b");
      await rank("q", "done", "a");
      await rank("m", "backlog", "b");
      await rank("n", "backlog", "a");
      expect(await ids("doing")).toEqual(["tasks/y", "tasks/x"]);
      expect(await ids("done")).toEqual(["tasks/q", "tasks/p"]);
      expect(await ids("backlog")).toEqual(["tasks/n", "tasks/m"]);
    });
  });

  describe("placing a card", () => {
    it("ranks unranked cards on the first move, then writes one row per move", async () => {
      const [a, b, c, d] = [
        await todo("a"),
        await todo("bb"),
        await todo("c"),
        await todo("dd"),
      ] as [string, string, string, string];
      const natural = await ids("todo");
      expect(natural).toHaveLength(4);

      // First move: nothing has a rank, so the card goes on top with a key of its own.
      await move(d, { beforeId: natural[0] });
      expect((await ids("todo"))[0]).toBe(d);
      expect((await ids("todo")).slice(1)).toEqual(
        natural.filter((id) => id !== d),
      );
      expect(await plannerTestPlan(rt.database, a)).toMatchObject({
        board_rank: null,
      });

      // Dropping below an unranked card gives the whole column keys, once.
      await move(a, { afterId: c });
      const ranks = await Promise.all(
        [a, b, c, d].map((id) => plannerTestPlan(rt.database, id)),
      );
      expect(ranks.every((row) => row?.board_rank?.startsWith("todo|"))).toBe(
        true,
      );

      // From now on every card has a key, so a move writes exactly one row.
      const before = await Promise.all(
        [a, b, c, d].map((id) => plannerTestPlan(rt.database, id)),
      );
      await move(b, { beforeId: d });
      const after = await Promise.all(
        [a, b, c, d].map((id) => plannerTestPlan(rt.database, id)),
      );
      const changed = after.filter(
        (row, index) => row?.board_rank !== before[index]?.board_rank,
      );
      expect(changed.map((row) => row?.task_id)).toEqual([b]);
      expect((await ids("todo"))[0]).toBe(b);
    });

    it("drops a card to the top, the bottom and between two others", async () => {
      const a = await todo("a", { rank: "d" });
      const b = await todo("bb", { rank: "h" });
      const c = await todo("c", { rank: "m" });
      const e = await todo("eee", { rank: "r" });
      await move(e, { beforeId: a });
      expect(await ids("todo")).toEqual([e, a, b, c]);
      await move(e, { afterId: c });
      expect(await ids("todo")).toEqual([a, b, c, e]);
      await move(e, { beforeId: c });
      expect(await ids("todo")).toEqual([a, b, e, c]);
    });

    it("prefers before_id when both are given", async () => {
      const a = await todo("a", { rank: "d" });
      const b = await todo("bb", { rank: "h" });
      const c = await todo("c", { rank: "m" });
      await move(c, { beforeId: a, afterId: b });
      expect(await ids("todo")).toEqual([c, a, b]);
    });

    it("keeps a stable order after many drops at one spot, re-spreading when keys get long", async () => {
      const first = await todo("a", { rank: "d" });
      await todo("bb", { rank: "e" });
      const others: string[] = [];
      for (let index = 0; index < 40; index += 1) {
        others.push(
          await todo(`z${"z".repeat(index % 3)}${index}`, {
            rank: `${"f"}${index % 10}1`,
          }),
        );
      }
      // Squeeze every other card between the first two, one after another.
      for (const id of others) await move(id, { afterId: first });
      const order = await ids("todo");
      expect(order[0]).toBe(first);
      expect(order).toHaveLength(42);
      const rows = await Promise.all(
        order.map((id) => plannerTestPlan(rt.database, id)),
      );
      const keys = rows.map(
        (row) => row?.board_rank?.slice("todo|".length) ?? "",
      );
      expect([...keys].sort()).toEqual(keys);
      expect(new Set(keys).size).toBe(keys.length);
      for (const key of keys) {
        expect(key.length).toBeLessThanOrEqual(plannerRankMaxLength);
      }
    });

    it("re-spreads a column whose cards share a key without losing the dropped place", async () => {
      const a = await todo("a", { rank: "k" });
      const b = await todo("bb", { rank: "k" });
      const c = await todo("c", { rank: "k" });
      const tied = await ids("todo");
      await move(c, { beforeId: tied[1] });
      const order = await ids("todo");
      expect(order.indexOf(c)).toBe(order.indexOf(tied[1] as string) - 1);
      expect(new Set(order)).toEqual(new Set([a, b, c]));
    });

    it("writes no history event for a reorder", async () => {
      const a = await todo("a", { rank: "d" });
      const b = await todo("bb", { rank: "h" });
      await move(b, { beforeId: a });
      expect(await plannerTestEvents(rt.database)).toEqual([]);
    });

    it("leaves the plan, the carry count and updated_at alone", async () => {
      const a = await todo("a", { rank: "d" });
      const b = await todo("bb", { rank: "h" });
      const before = await plannerTestPlan(rt.database, b);
      await move(b, { beforeId: a });
      const after = await plannerTestPlan(rt.database, b);
      expect(after).toMatchObject({
        horizon: "week",
        period_start: "2026-10-05",
        carry_count: 0,
        updated_at: before?.updated_at,
      });
      expect(after?.board_rank).not.toBe(before?.board_rank);
    });

    it("gives a task with no plan row its own row to hold the rank", async () => {
      for (const name of ["a", "b"]) {
        await plannerTestInsertTask(rt.database, {
          id: `tasks/${name}`,
          userId: rt.user.id,
          createdAt:
            name === "a"
              ? "2026-10-02T00:00:00.000Z"
              : "2026-10-01T00:00:00.000Z",
        });
      }
      // Backlog, newest first: a then b. Put b on top.
      await plannerSetBoardRank(rt.db, {
        user: rt.user,
        taskId: "tasks/b",
        column: "backlog",
        beforeId: "tasks/a",
        today: TODAY,
      });
      expect(await ids("backlog")).toEqual(["tasks/b", "tasks/a"]);
      expect(await plannerTestPlan(rt.database, "tasks/b")).toMatchObject({
        horizon: null,
        period_start: null,
      });
    });

    it("refuses an anchor that is not in the column, a dropped task and the wrong column", async () => {
      const a = await todo("a", { rank: "d" });
      const b = await todo("bb", { rank: "h" });
      await expect(
        move(b, { beforeId: "tasks/nowhere" }),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(move(b, {})).rejects.toBeInstanceOf(ValidationError);
      await expect(
        plannerSetBoardRank(rt.db, {
          user: rt.user,
          taskId: b,
          column: "doing",
          beforeId: a,
          today: TODAY,
        }),
      ).rejects.toBeInstanceOf(ValidationError);
      await plannerDropTask(rt.db, { user: rt.user, actor: USER, taskId: b });
      await expect(move(b, { beforeId: a })).rejects.toBeInstanceOf(
        ValidationError,
      );
    });

    it("never touches another user's rows", async () => {
      const a = await todo("a", { rank: "d" });
      await plannerTestInsertTask(rt.database, {
        id: "tasks/theirs",
        userId: rt.other.id,
      });
      await expect(move("tasks/theirs", { beforeId: a })).rejects.toMatchObject(
        {
          status: 404,
        },
      );
    });
  });

  describe("moving between columns", () => {
    it("ignores the old column's rank by its prefix: a move without a place has none", async () => {
      const a = await todo("a", { rank: "d" });
      await todo("bb", { rank: "h" });
      await plannerApplyColumnMove(rt.db, {
        user: rt.user,
        actor: USER,
        taskId: a,
        to: "doing",
        today: TODAY,
      });
      expect((await board()).columns.doing[0]?.board_rank).toBeNull();
    });

    it("lands a card at a place in another column after the move", async () => {
      const a = await todo("a", { rank: "d" });
      for (const name of ["x", "y"]) {
        await plannerTestInsertTask(rt.database, {
          id: `tasks/${name}`,
          userId: rt.user.id,
          status: "in_progress",
        });
      }
      await plannerApplyColumnMove(rt.db, {
        user: rt.user,
        actor: USER,
        taskId: a,
        to: "doing",
        today: TODAY,
      });
      await plannerSetBoardRank(rt.db, {
        user: rt.user,
        taskId: a,
        column: "doing",
        afterId: "tasks/x",
        today: TODAY,
      });
      const doing = await ids("doing");
      expect(doing.indexOf(a)).toBe(doing.indexOf("tasks/x") + 1);
      // Only the column move wrote history; the placement added nothing.
      expect(
        (await plannerTestEvents(rt.database, a)).map((event) => event.type),
      ).toEqual([]);
    });
  });

  describe("new tasks", () => {
    it("go on top of a column that has a manual order", async () => {
      const a = await todo("a", { rank: "d" });
      const b = await todo("bb", { rank: "h" });
      const created = await plannerCreateTask(rt.db, {
        user: rt.user,
        actor: USER,
        title: "New",
        column: "todo",
        plan: { horizon: "week", day: TODAY },
        today: TODAY,
      });
      // Unranked, it would sit after the ranked cards.
      expect((await ids("todo")).at(-1)).toBe(created.task.id);
      expect(
        await plannerRankNewTaskOnTop(rt.db, {
          userId: rt.user.id,
          taskId: created.task.id,
          column: "todo",
        }),
      ).toBe(true);
      expect(await ids("todo")).toEqual([created.task.id, a, b]);
    });

    it("write nothing in a column nobody has ranked", async () => {
      const created = await plannerCreateTask(rt.db, {
        user: rt.user,
        actor: USER,
        title: "New",
        column: "backlog",
      });
      expect(
        await plannerRankNewTaskOnTop(rt.db, {
          userId: rt.user.id,
          taskId: created.task.id,
          column: "backlog",
        }),
      ).toBe(false);
      expect(
        await plannerTestPlan(rt.database, created.task.id),
      ).toBeUndefined();
      expect(await plannerTestCount(rt.database, "planner_task_plan")).toBe(0);
    });

    it("count another column's ranks as nothing", async () => {
      await todo("a", { rank: "d" });
      const created = await plannerCreateTask(rt.db, {
        user: rt.user,
        actor: USER,
        title: "New",
        column: "doing",
      });
      expect(
        await plannerRankNewTaskOnTop(rt.db, {
          userId: rt.user.id,
          taskId: created.task.id,
          column: "doing",
        }),
      ).toBe(false);
    });
  });
});
