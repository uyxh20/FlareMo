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
import {
  createTask,
  deleteTask,
  hardDeleteExpiredTasks,
  type TaskActor,
} from "../tasks";
import {
  plannerAddComment,
  plannerCommentBodyMax,
  plannerDeleteComment,
  plannerListComments,
  plannerNormalizeCommentBody,
  plannerUpdateComment,
} from "./comments";
import { plannerReadTaskHistory } from "./history-read";
import { plannerSyncHistory } from "./history-sync";
import { plannerReadTaskDetail } from "./task-detail";
import {
  type PlannerTestRuntime,
  plannerTestComments,
  plannerTestCount,
  plannerTestEvents,
  plannerTestFailBatch,
  plannerTestInsertComment,
  plannerTestRuntime,
} from "./test-support";

// Task comments (fork-owned add-on, docs/planning-cockpit-implementation-plan.md,
// section 13): add, edit, soft-delete and list, with their planner events.

const USER: TaskActor = { type: "user" };
const AGENT: TaskActor = { type: "agent", name: "pat:abcd1234" };

const NOW = new Date("2026-10-07T09:00:00.000Z");
const LATER = new Date("2026-10-07T09:30:00.000Z");

describe("planner task comments", () => {
  let rt: PlannerTestRuntime;

  beforeAll(async () => {
    rt = await plannerTestRuntime("flaremo-planner-comments");
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

  const newTask = (title = "Task", owner = rt.user) =>
    createTask(rt.db, owner, USER, { title });

  const add = (
    taskId: string,
    body: string,
    actor: TaskActor = USER,
    now = NOW,
  ) => plannerAddComment(rt.db, { user: rt.user, actor, taskId, body, now });

  const edit = (
    commentId: string,
    body: string,
    actor: TaskActor = USER,
    now = LATER,
  ) =>
    plannerUpdateComment(rt.db, {
      user: rt.user,
      actor,
      commentId,
      body,
      now,
    });

  const remove = (commentId: string, actor: TaskActor = USER, now = LATER) =>
    plannerDeleteComment(rt.db, { user: rt.user, actor, commentId, now });

  const commentEvents = async (taskId: string) =>
    (await plannerTestEvents(rt.database, taskId)).filter((event) =>
      event.type.startsWith("comment"),
    );

  // ===========================================================================

  describe("plannerNormalizeCommentBody", () => {
    it("trims, and keeps line breaks inside the text", () => {
      expect(plannerNormalizeCommentBody("  hello  ")).toBe("hello");
      expect(plannerNormalizeCommentBody("\n one\n\n two \n")).toBe(
        "one\n\n two",
      );
    });

    it("accepts 1 to 5000 characters and rejects the rest", () => {
      expect(plannerNormalizeCommentBody("x")).toBe("x");
      const longest = "y".repeat(plannerCommentBodyMax);
      expect(plannerNormalizeCommentBody(longest)).toBe(longest);
      for (const value of [
        "",
        "   ",
        "\n\t",
        "z".repeat(plannerCommentBodyMax + 1),
        undefined,
        null,
        42,
        {},
      ]) {
        expect(
          () => plannerNormalizeCommentBody(value),
          String(value).slice(0, 20),
        ).toThrowError(ValidationError);
      }
    });

    it("counts the length after trimming", () => {
      const padded = ` ${"y".repeat(plannerCommentBodyMax)} `;
      expect(plannerNormalizeCommentBody(padded)).toHaveLength(
        plannerCommentBodyMax,
      );
    });
  });

  // ===========================================================================

  describe("plannerAddComment", () => {
    it("stores the comment and writes a commented event with only its id, as the actor", async () => {
      const task = await newTask("Discuss me");

      const comment = await add(task.id, "  First thoughts  ", AGENT);

      expect(comment).toEqual({
        id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        task_id: task.id,
        body: "First thoughts",
        created_at: NOW.toISOString(),
        updated_at: NOW.toISOString(),
      });
      expect(await plannerTestComments(rt.database, task.id)).toEqual([
        {
          id: comment.id,
          user_id: rt.user.id,
          task_id: task.id,
          body: "First thoughts",
          created_at: NOW.toISOString(),
          updated_at: NOW.toISOString(),
          deleted_at: null,
        },
      ]);

      const events = await commentEvents(task.id);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "commented",
        source: "planner",
        source_ref: null,
        actor_type: "agent",
        actor_name: "pat:abcd1234",
        task_title: "Discuss me",
        occurred_at: NOW.toISOString(),
        created_at: NOW.toISOString(),
      });
      expect(JSON.parse(events[0]?.data ?? "{}")).toEqual({
        comment_id: comment.id,
      });
    });

    it("never puts the comment's text into an event", async () => {
      const task = await newTask();
      const secret = "the launch code is swordfish";
      const comment = await add(task.id, secret);
      await edit(comment.id, `${secret}, amended`);
      await remove(comment.id);

      for (const event of await plannerTestEvents(rt.database, task.id)) {
        expect(event.data).not.toContain("swordfish");
        expect(event.task_title ?? "").not.toContain("swordfish");
      }
    });

    it("keeps line breaks and gives every comment its own id", async () => {
      const task = await newTask();
      const first = await add(task.id, "line one\nline two");
      const second = await add(task.id, "line one\nline two");
      expect(first.body).toBe("line one\nline two");
      expect(second.id).not.toBe(first.id);
    });

    it("accepts a bare or a namespaced task id and stores the namespaced one", async () => {
      const task = await newTask();
      const bare = task.id.replace(/^tasks\//, "");
      const viaBare = await add(bare, "bare");
      const viaFull = await add(task.id, "full");
      expect(viaBare.task_id).toBe(task.id);
      expect(viaFull.task_id).toBe(task.id);
      expect(
        (await plannerTestComments(rt.database)).map((row) => row.task_id),
      ).toEqual([task.id, task.id]);
    });

    it("rejects an empty or too long body with a 400 and writes nothing", async () => {
      const task = await newTask();
      for (const body of [
        "",
        "   \n ",
        "x".repeat(plannerCommentBodyMax + 1),
      ]) {
        await expect(add(task.id, body)).rejects.toBeInstanceOf(
          ValidationError,
        );
      }
      expect(await plannerTestCount(rt.database, "planner_task_comment")).toBe(
        0,
      );
      expect(await plannerTestCount(rt.database, "planner_task_event")).toBe(0);
    });

    it("is a 404 for a task that is missing, deleted or someone else's, and writes nothing", async () => {
      const gone = await newTask("Binned");
      await deleteTask(rt.db, rt.user, gone.id);
      const theirs = await newTask("Theirs", rt.other);

      for (const taskId of ["tasks/no-such-task", gone.id, theirs.id]) {
        await expect(add(taskId, "hello"), taskId).rejects.toBeInstanceOf(
          NotFoundError,
        );
      }
      expect(await plannerTestCount(rt.database, "planner_task_comment")).toBe(
        0,
      );
      expect(await plannerTestCount(rt.database, "planner_task_event")).toBe(0);
    });

    it("writes the comment and its event in one batch: a failed event leaves no comment", async () => {
      const task = await newTask();
      const failing = plannerTestFailBatch(rt.db, (texts) =>
        texts.some((text) => text.includes('"planner_task_event"')),
      );

      await expect(
        plannerAddComment(failing, {
          user: rt.user,
          actor: USER,
          taskId: task.id,
          body: "never stored",
          now: NOW,
        }),
      ).rejects.toThrow(/injected failure/);

      expect(await plannerTestCount(rt.database, "planner_task_comment")).toBe(
        0,
      );
    });
  });

  // ===========================================================================

  describe("plannerListComments", () => {
    it("lists a task's comments oldest first, without the deleted ones", async () => {
      const task = await newTask();
      const first = await add(task.id, "first", USER, NOW);
      const second = await add(task.id, "second", USER, LATER);
      const third = await add(
        task.id,
        "third",
        USER,
        new Date("2026-10-07T10:00:00.000Z"),
      );
      await remove(second.id);

      const comments = await plannerListComments(rt.db, {
        userId: rt.user.id,
        taskId: task.id,
      });

      expect(comments.map((comment) => comment.id)).toEqual([
        first.id,
        third.id,
      ]);
    });

    it("is a 404 for a task that is not the caller's live task", async () => {
      const gone = await newTask("Binned");
      await deleteTask(rt.db, rt.user, gone.id);
      const theirs = await newTask("Theirs", rt.other);
      for (const taskId of ["tasks/nope", gone.id, theirs.id]) {
        await expect(
          plannerListComments(rt.db, { userId: rt.user.id, taskId }),
          taskId,
        ).rejects.toBeInstanceOf(NotFoundError);
      }
    });

    it("lists none of another user's comments on the task", async () => {
      const task = await newTask();
      await add(task.id, "mine");
      await plannerTestInsertComment(rt.database, {
        id: "foreign",
        userId: rt.other.id,
        taskId: task.id,
        body: "not mine",
      });
      const comments = await plannerListComments(rt.db, {
        userId: rt.user.id,
        taskId: task.id,
      });
      expect(comments.map((comment) => comment.body)).toEqual(["mine"]);
    });
  });

  // ===========================================================================

  describe("plannerUpdateComment", () => {
    it("changes the text and the update time, keeps the creation time and writes comment_edited", async () => {
      const task = await newTask("Edit target");
      const comment = await add(task.id, "draft");

      const edited = await edit(comment.id, "  final wording ", AGENT);

      expect(edited).toEqual({
        id: comment.id,
        task_id: task.id,
        body: "final wording",
        created_at: NOW.toISOString(),
        updated_at: LATER.toISOString(),
      });
      expect(await plannerTestComments(rt.database, task.id)).toMatchObject([
        {
          body: "final wording",
          created_at: NOW.toISOString(),
          updated_at: LATER.toISOString(),
          deleted_at: null,
        },
      ]);

      const events = await commentEvents(task.id);
      expect(events.map((event) => event.type)).toEqual([
        "commented",
        "comment_edited",
      ]);
      expect(events[1]).toMatchObject({
        source: "planner",
        actor_type: "agent",
        actor_name: "pat:abcd1234",
        task_title: "Edit target",
        occurred_at: LATER.toISOString(),
      });
      expect(JSON.parse(events[1]?.data ?? "{}")).toEqual({
        comment_id: comment.id,
      });
    });

    it("writes nothing when the text is the same after trimming", async () => {
      const task = await newTask();
      const comment = await add(task.id, "unchanged");
      const before = await plannerTestComments(rt.database, task.id);

      const result = await edit(comment.id, "  unchanged \n");

      expect(result).toEqual(comment);
      expect(await plannerTestComments(rt.database, task.id)).toEqual(before);
      expect(await commentEvents(task.id)).toHaveLength(1);
    });

    it("rejects an empty or too long body with a 400 and changes nothing", async () => {
      const task = await newTask();
      const comment = await add(task.id, "keep me");
      for (const body of ["", "  ", "x".repeat(plannerCommentBodyMax + 1)]) {
        await expect(edit(comment.id, body)).rejects.toBeInstanceOf(
          ValidationError,
        );
      }
      expect(
        (await plannerTestComments(rt.database, task.id)).map((c) => c.body),
      ).toEqual(["keep me"]);
      expect(await commentEvents(task.id)).toHaveLength(1);
    });

    it("is a 404 for a comment that is missing, deleted or someone else's", async () => {
      const task = await newTask();
      const mine = await add(task.id, "mine");
      const deleted = await add(task.id, "deleted");
      await remove(deleted.id);
      await plannerTestInsertComment(rt.database, {
        id: "foreign",
        userId: rt.other.id,
        taskId: task.id,
        body: "theirs",
      });

      for (const id of ["no-such-comment", deleted.id, "foreign"]) {
        await expect(edit(id, "changed"), id).rejects.toBeInstanceOf(
          NotFoundError,
        );
      }
      // A user cannot reach a comment through another's id either.
      await expect(
        plannerUpdateComment(rt.db, {
          user: rt.other,
          actor: USER,
          commentId: mine.id,
          body: "hijacked",
          now: LATER,
        }),
      ).rejects.toBeInstanceOf(NotFoundError);

      expect(
        (await plannerTestComments(rt.database))
          .filter((row) => row.id === mine.id || row.id === "foreign")
          .map((row) => [row.id === mine.id ? "mine" : row.id, row.body]),
      ).toEqual([
        ["mine", "mine"],
        ["foreign", "theirs"],
      ]);
      // Only the setup wrote events: two `commented` and one `comment_deleted`.
      expect((await commentEvents(task.id)).map((event) => event.type)).toEqual(
        ["commented", "commented", "comment_deleted"],
      );
    });

    it("is a 404 once its task is in the recycle bin", async () => {
      const task = await newTask();
      const comment = await add(task.id, "hello");
      await deleteTask(rt.db, rt.user, task.id);
      await expect(edit(comment.id, "changed")).rejects.toBeInstanceOf(
        NotFoundError,
      );
      await expect(remove(comment.id)).rejects.toBeInstanceOf(NotFoundError);
    });

    it("writes the change and its event in one batch: a failed event leaves the old text", async () => {
      const task = await newTask();
      const comment = await add(task.id, "old text");
      const failing = plannerTestFailBatch(rt.db, (texts) =>
        texts.some((text) => text.includes('"planner_task_event"')),
      );

      await expect(
        plannerUpdateComment(failing, {
          user: rt.user,
          actor: USER,
          commentId: comment.id,
          body: "new text",
          now: LATER,
        }),
      ).rejects.toThrow(/injected failure/);

      expect(
        (await plannerTestComments(rt.database, task.id)).map((c) => c.body),
      ).toEqual(["old text"]);
    });
  });

  // ===========================================================================

  describe("plannerDeleteComment", () => {
    it("soft-deletes: the row stays with deleted_at set, and a comment_deleted event is written", async () => {
      const task = await newTask("Delete target");
      const comment = await add(task.id, "to be removed");

      await remove(comment.id, AGENT);

      expect(await plannerTestComments(rt.database, task.id)).toEqual([
        {
          id: comment.id,
          user_id: rt.user.id,
          task_id: task.id,
          body: "to be removed",
          created_at: NOW.toISOString(),
          updated_at: LATER.toISOString(),
          deleted_at: LATER.toISOString(),
        },
      ]);
      expect(
        (
          await plannerListComments(rt.db, {
            userId: rt.user.id,
            taskId: task.id,
          })
        ).length,
      ).toBe(0);

      const events = await commentEvents(task.id);
      expect(events.map((event) => event.type)).toEqual([
        "commented",
        "comment_deleted",
      ]);
      expect(events[1]).toMatchObject({
        source: "planner",
        actor_type: "agent",
        actor_name: "pat:abcd1234",
        task_title: "Delete target",
        occurred_at: LATER.toISOString(),
      });
      expect(JSON.parse(events[1]?.data ?? "{}")).toEqual({
        comment_id: comment.id,
      });
    });

    it("deletes a comment once: a second delete is a 404 and writes no second event", async () => {
      const task = await newTask();
      const comment = await add(task.id, "once");
      await remove(comment.id);
      await expect(remove(comment.id)).rejects.toBeInstanceOf(NotFoundError);
      expect(await commentEvents(task.id)).toHaveLength(2);
    });

    it("leaves the other comments alone", async () => {
      const task = await newTask();
      const keep = await add(task.id, "keep");
      const drop = await add(task.id, "drop");
      await remove(drop.id);
      expect(
        (
          await plannerListComments(rt.db, {
            userId: rt.user.id,
            taskId: task.id,
          })
        ).map((comment) => comment.id),
      ).toEqual([keep.id]);
    });

    it("is a 404 for a comment that is missing or someone else's, and leaves theirs alone", async () => {
      const task = await newTask();
      await plannerTestInsertComment(rt.database, {
        id: "foreign",
        userId: rt.other.id,
        taskId: task.id,
        body: "theirs",
      });
      await expect(remove("no-such-comment")).rejects.toBeInstanceOf(
        NotFoundError,
      );
      await expect(remove("foreign")).rejects.toBeInstanceOf(NotFoundError);
      expect(
        (await plannerTestComments(rt.database)).map((row) => row.deleted_at),
      ).toEqual([null]);
      expect(await plannerTestCount(rt.database, "planner_task_event")).toBe(0);
    });

    it("writes the delete and its event in one batch: a failed event leaves the comment", async () => {
      const task = await newTask();
      const comment = await add(task.id, "still here");
      const failing = plannerTestFailBatch(rt.db, (texts) =>
        texts.some((text) => text.includes('"planner_task_event"')),
      );

      await expect(
        plannerDeleteComment(failing, {
          user: rt.user,
          actor: USER,
          commentId: comment.id,
          now: LATER,
        }),
      ).rejects.toThrow(/injected failure/);

      expect(
        (await plannerTestComments(rt.database, task.id))[0]?.deleted_at,
      ).toBeNull();
    });
  });

  // ===========================================================================

  describe("history and purges", () => {
    it("shows the comment events in the task's history, oldest to newest, as planner events", async () => {
      const task = await newTask();
      const comment = await add(task.id, "hello");
      await edit(comment.id, "hello again");
      await remove(comment.id);

      await plannerSyncHistory(rt.db, { userId: rt.user.id, now: LATER });
      const history = await plannerReadTaskHistory(rt.db, {
        userId: rt.user.id,
        taskId: task.id,
      });

      expect(
        history
          .filter((entry) => entry.source === "planner")
          .map((entry) => entry.type),
      ).toEqual(["comment_deleted", "comment_edited", "commented"]);
      for (const entry of history.filter((e) => e.type.startsWith("comment"))) {
        expect(entry.data).toEqual({ comment_id: comment.id });
        expect(entry.actor_type).toBe("user");
      }
    });

    it("keeps the comments, deleted ones included, after the task is purged", async () => {
      const task = await newTask("Soon purged");
      const kept = await add(task.id, "survives");
      const removed = await add(task.id, "also survives");
      await remove(removed.id);

      await deleteTask(rt.db, rt.user, task.id);
      // Purge it for real: a cutoff after the delete removes the task row.
      const purged = await hardDeleteExpiredTasks(
        rt.db,
        new Date(Date.now() + 60_000).toISOString(),
      );
      expect(purged).toBe(1);
      await plannerSyncHistory(rt.db, { userId: rt.user.id, now: LATER });

      expect(await plannerTestCount(rt.database, "tasks")).toBe(0);
      expect(
        (await plannerTestComments(rt.database, task.id)).map((row) => [
          row.id,
          row.deleted_at === null,
        ]),
      ).toEqual([
        [kept.id, true],
        [removed.id, false],
      ]);
      // And the detail of a purged task is a 404, as any task's.
      await expect(
        plannerReadTaskDetail(rt.db, { userId: rt.user.id, taskId: task.id }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });
});
