import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ValidationError } from "../errors";
import { createTask, hardDeleteExpiredTasks, type TaskActor } from "../tasks";
import {
  plannerHistoryRangeLimit,
  plannerHistoryRangeMax,
  plannerReadHistoryRange,
  plannerReadTaskHistory,
  plannerTaskHistoryLimit,
} from "./history-read";
import { plannerSyncHistory } from "./history-sync";
import {
  type PlannerTestRuntime,
  plannerTestInsertEvent,
  plannerTestRun,
  plannerTestRuntime,
} from "./test-support";

const USER: TaskActor = { type: "user" };

describe("planner history reads", () => {
  let rt: PlannerTestRuntime;

  beforeAll(async () => {
    rt = await plannerTestRuntime("flaremo-planner-history-read");
  });
  afterAll(async () => {
    await rt.dispose();
  });
  beforeEach(async () => {
    await rt.reset();
  });

  const event = (
    taskId: string,
    occurredAt: string,
    type = "updated",
    userId = rt.user.id,
  ) =>
    plannerTestInsertEvent(rt.database, { userId, taskId, type, occurredAt });

  describe("plannerReadTaskHistory", () => {
    it("returns one task's events newest first, by occurred_at and then by id", async () => {
      await event("tasks/a", "2026-10-03T09:00:00.000Z", "created");
      await event("tasks/a", "2026-10-05T09:00:00.000Z", "second-of-a-tie");
      await event("tasks/a", "2026-10-05T09:00:00.000Z", "first-of-a-tie");
      await event("tasks/a", "2026-10-04T09:00:00.000Z", "updated");
      await event(
        "tasks/b",
        "2026-10-06T09:00:00.000Z",
        "somebody else's task",
      );

      const history = await plannerReadTaskHistory(rt.db, {
        userId: rt.user.id,
        taskId: "tasks/a",
      });

      // Equal times fall back to the archive id, newer id first.
      expect(history.map((entry) => entry.type)).toEqual([
        "first-of-a-tie",
        "second-of-a-tie",
        "updated",
        "created",
      ]);
    });

    it("maps rows to the route shape without the internal source_ref", async () => {
      await plannerTestInsertEvent(rt.database, {
        userId: rt.user.id,
        taskId: "tasks/a",
        type: "status_changed",
        taskTitle: "Ship it",
        source: "activity",
        sourceRef: "a:tasks/a@2026-10-05T09:00:00.000Z|status_changed|{}",
        data: { status: "done" },
        actorType: "agent",
        actorName: "pat:abcd1234",
        occurredAt: "2026-10-05T09:00:00.000Z",
      });

      const [entry] = await plannerReadTaskHistory(rt.db, {
        userId: rt.user.id,
        taskId: "tasks/a",
      });

      expect(entry).toEqual({
        id: expect.any(Number),
        task_id: "tasks/a",
        task_title: "Ship it",
        type: "status_changed",
        data: { status: "done" },
        source: "activity",
        actor_type: "agent",
        actor_name: "pat:abcd1234",
        occurred_at: "2026-10-05T09:00:00.000Z",
        created_at: "2026-10-05T09:00:00.000Z",
      });
      expect(entry).not.toHaveProperty("source_ref");
    });

    it("takes a bare id like the task routes do", async () => {
      await event("tasks/abc", "2026-10-05T09:00:00.000Z");
      const history = await plannerReadTaskHistory(rt.db, {
        userId: rt.user.id,
        taskId: "abc",
      });
      expect(history).toHaveLength(1);
    });

    it("never shows another user's events", async () => {
      await event("tasks/a", "2026-10-05T09:00:00.000Z", "mine");
      await event("tasks/a", "2026-10-05T10:00:00.000Z", "theirs", rt.other.id);

      expect(
        (
          await plannerReadTaskHistory(rt.db, {
            userId: rt.user.id,
            taskId: "tasks/a",
          })
        ).map((entry) => entry.type),
      ).toEqual(["mine"]);
      expect(
        (
          await plannerReadTaskHistory(rt.db, {
            userId: rt.other.id,
            taskId: "tasks/a",
          })
        ).map((entry) => entry.type),
      ).toEqual(["theirs"]);
    });

    it("returns an empty history for a task it has never heard of", async () => {
      expect(
        await plannerReadTaskHistory(rt.db, {
          userId: rt.user.id,
          taskId: "tasks/nope",
        }),
      ).toEqual([]);
    });

    it("still serves the history of a purged task", async () => {
      const task = await createTask(rt.db, rt.user, USER, {
        title: "Gone soon",
      });
      await plannerSyncHistory(rt.db, {
        userId: rt.user.id,
        now: new Date("2026-10-05T10:00:00.000Z"),
      });
      await plannerTestRun(
        rt.database,
        "UPDATE tasks SET deleted_at = '2026-01-01T00:00:00.000Z' WHERE id = ?",
        task.id,
      );
      await hardDeleteExpiredTasks(rt.db, "2026-02-01T00:00:00.000Z");
      await plannerSyncHistory(rt.db, {
        userId: rt.user.id,
        now: new Date("2026-10-05T10:05:00.000Z"),
      });

      const history = await plannerReadTaskHistory(rt.db, {
        userId: rt.user.id,
        taskId: task.id,
      });
      expect(history.map((entry) => entry.type)).toEqual(["purged", "created"]);
      expect(history.every((entry) => entry.task_title === "Gone soon")).toBe(
        true,
      );
    });

    it("clamps the limit", async () => {
      for (let index = 0; index < 5; index += 1) {
        await event("tasks/a", `2026-10-0${index + 1}T09:00:00.000Z`);
      }
      expect(
        await plannerReadTaskHistory(rt.db, {
          userId: rt.user.id,
          taskId: "tasks/a",
          limit: 2,
        }),
      ).toHaveLength(2);
      expect(
        await plannerReadTaskHistory(rt.db, {
          userId: rt.user.id,
          taskId: "tasks/a",
          limit: 0,
        }),
      ).toHaveLength(1);
      expect(plannerTaskHistoryLimit).toBe(500);
    });
  });

  describe("plannerReadHistoryRange", () => {
    it("returns the events of the inclusive UTC day range, newest first", async () => {
      await event("tasks/a", "2026-10-04T23:59:59.999Z", "day-before");
      await event("tasks/a", "2026-10-05T00:00:00.000Z", "first-instant");
      await event("tasks/b", "2026-10-06T12:00:00.000Z", "middle");
      await event("tasks/a", "2026-10-07T23:59:59.999Z", "last-instant");
      await event("tasks/a", "2026-10-08T00:00:00.000Z", "day-after");

      const { events, truncated } = await plannerReadHistoryRange(rt.db, {
        userId: rt.user.id,
        from: "2026-10-05",
        to: "2026-10-07",
      });

      expect(events.map((entry) => entry.type)).toEqual([
        "last-instant",
        "middle",
        "first-instant",
      ]);
      expect(truncated).toBe(false);
    });

    it("works for a single day", async () => {
      await event("tasks/a", "2026-10-05T08:00:00.000Z", "in");
      await event("tasks/a", "2026-10-06T08:00:00.000Z", "out");
      const { events } = await plannerReadHistoryRange(rt.db, {
        userId: rt.user.id,
        from: "2026-10-05",
        to: "2026-10-05",
      });
      expect(events.map((entry) => entry.type)).toEqual(["in"]);
    });

    it("is scoped to the user", async () => {
      await event("tasks/a", "2026-10-05T08:00:00.000Z", "mine");
      await event("tasks/b", "2026-10-05T09:00:00.000Z", "theirs", rt.other.id);
      const { events } = await plannerReadHistoryRange(rt.db, {
        userId: rt.user.id,
        from: "2026-10-05",
        to: "2026-10-05",
      });
      expect(events.map((entry) => entry.type)).toEqual(["mine"]);
    });

    it("says when it cut the oldest events", async () => {
      for (let index = 1; index <= 5; index += 1) {
        await event("tasks/a", `2026-10-0${index}T09:00:00.000Z`, `e${index}`);
      }
      const cut = await plannerReadHistoryRange(rt.db, {
        userId: rt.user.id,
        from: "2026-10-01",
        to: "2026-10-31",
        limit: 3,
      });
      expect(cut.events.map((entry) => entry.type)).toEqual(["e5", "e4", "e3"]);
      expect(cut.truncated).toBe(true);

      const exact = await plannerReadHistoryRange(rt.db, {
        userId: rt.user.id,
        from: "2026-10-01",
        to: "2026-10-31",
        limit: 5,
      });
      expect(exact.events).toHaveLength(5);
      expect(exact.truncated).toBe(false);

      expect(plannerHistoryRangeLimit).toBe(1000);
      expect(plannerHistoryRangeMax).toBe(5000);
    });

    it("rejects an invalid or inverted range with a validation error", async () => {
      const read = (from: string, to: string) =>
        plannerReadHistoryRange(rt.db, { userId: rt.user.id, from, to });
      await expect(read("2026-10-07", "2026-10-05")).rejects.toBeInstanceOf(
        ValidationError,
      );
      await expect(read("2026-02-30", "2026-03-01")).rejects.toBeInstanceOf(
        ValidationError,
      );
      await expect(read("2026-10-05", "yesterday")).rejects.toBeInstanceOf(
        ValidationError,
      );
      await expect(read("", "")).rejects.toBeInstanceOf(ValidationError);
    });
  });
});
