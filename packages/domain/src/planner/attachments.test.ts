import {
  plannerAttachmentMaxBytes,
  plannerAttachmentsPerTask,
} from "@flaremo/contracts";
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
import { DomainError, NotFoundError, ValidationError } from "../errors";
import { createTask, type TaskActor } from "../tasks";
import {
  plannerAddAttachment,
  plannerAssertAttachmentSize,
  plannerAttachmentPath,
  plannerAttachmentsToPurge,
  plannerFinishAttachmentPurge,
  plannerListAttachments,
  plannerLoadAttachment,
  plannerNormalizeAttachmentName,
  plannerRemoveAttachment,
} from "./attachments";
import { plannerReadTaskDetail } from "./task-detail";
import {
  type PlannerTestRuntime,
  plannerTestCount,
  plannerTestEvents,
  plannerTestRun,
  plannerTestRuntime,
} from "./test-support";

// Files on tasks (fork-owned add-on, docs/fork-task-attachments.md): the index
// rows, their limits, their History events and the sweep. The bucket is the
// Worker's; here an object key is just a string.

const USER: TaskActor = { type: "user" };
const NOW = new Date("2026-11-02T09:00:00.000Z");
const DAYS = 24 * 60 * 60 * 1000;

describe("planner task attachments", () => {
  let rt: PlannerTestRuntime;

  beforeAll(async () => {
    rt = await plannerTestRuntime("flaremo-planner-attachments");
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
    filename = "quote.pdf",
    extra: Partial<Parameters<typeof plannerAddAttachment>[1]> = {},
  ) =>
    plannerAddAttachment(rt.db, {
      user: rt.user,
      actor: USER,
      taskId,
      filename,
      contentType: "application/pdf",
      size: 1234,
      r2Key: `planner/${rt.user.id}/${crypto.randomUUID()}/${filename}`,
      etag: "etag-1",
      now: NOW,
      ...extra,
    });

  const fileEvents = async (taskId: string) =>
    (await plannerTestEvents(rt.database, taskId)).filter((event) =>
      event.type.startsWith("attachment"),
    );

  // ===========================================================================

  describe("names and sizes", () => {
    it("keeps a file name, without path separators or control characters, at most 200 characters", () => {
      expect(plannerNormalizeAttachmentName("  Quote 2025.pdf ")).toBe(
        "Quote 2025.pdf",
      );
      expect(plannerNormalizeAttachmentName("../etc/pass\u0007wd")).toBe(
        ".._etc_pass_wd",
      );
      expect(plannerNormalizeAttachmentName("")).toBe("file");
      expect(plannerNormalizeAttachmentName(42)).toBe("file");
      expect(plannerNormalizeAttachmentName("x".repeat(300))).toHaveLength(200);
    });

    it("refuses an empty file, an unknown size and anything over 10 MB (as a 413)", () => {
      expect(() => plannerAssertAttachmentSize(1)).not.toThrow();
      expect(() =>
        plannerAssertAttachmentSize(plannerAttachmentMaxBytes),
      ).not.toThrow();
      expect(() => plannerAssertAttachmentSize(0)).toThrowError(
        ValidationError,
      );
      expect(() => plannerAssertAttachmentSize(Number.NaN)).toThrowError(
        ValidationError,
      );
      try {
        plannerAssertAttachmentSize(plannerAttachmentMaxBytes + 1);
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(DomainError);
        expect((error as DomainError).status).toBe(413);
      }
    });

    it("serves a file under its task, with the name percent-encoded", () => {
      expect(
        plannerAttachmentPath({
          taskId: "tasks/abc",
          id: "f1",
          filename: "my quote.pdf",
        }),
      ).toBe("/api/app/planner/tasks/abc/attachments/f1/my%20quote.pdf");
    });
  });

  // ===========================================================================

  describe("plannerAddAttachment", () => {
    it("records the file, shows it in the detail and writes attachment_added with the name and size", async () => {
      const task = await newTask("Renew the insurance");

      const file = await add(task.id, "insurance-quote.pdf");

      expect(file).toEqual({
        id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        task_id: task.id,
        filename: "insurance-quote.pdf",
        content_type: "application/pdf",
        size: 1234,
        read_state: "stored",
        action_id: null,
        created_at: NOW.toISOString(),
        url: `/api/app/planner/tasks/${task.id.replace(/^tasks\//, "")}/attachments/${file.id}/insurance-quote.pdf`,
      });
      const detail = await plannerReadTaskDetail(rt.db, {
        userId: rt.user.id,
        taskId: task.id,
      });
      expect(detail.attachments).toEqual([file]);

      const events = await fileEvents(task.id);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "attachment_added",
        task_title: "Renew the insurance",
        actor_type: "user",
        source: "planner",
        occurred_at: NOW.toISOString(),
      });
      expect(JSON.parse(events[0]?.data ?? "{}")).toEqual({
        attachment_id: file.id,
        filename: "insurance-quote.pdf",
        size: 1234,
      });
    });

    it("stops at ten files a task", async () => {
      const task = await newTask();
      for (let n = 0; n < plannerAttachmentsPerTask; n++) {
        await add(task.id, `file-${n}.txt`);
      }
      await expect(add(task.id, "one-too-many.txt")).rejects.toThrowError(
        ValidationError,
      );
      expect(
        await plannerTestCount(rt.database, "planner_task_attachment"),
      ).toBe(plannerAttachmentsPerTask);
      // A removed file frees its slot.
      const files = await plannerListAttachments(rt.db, {
        userId: rt.user.id,
        taskId: task.id,
      });
      await plannerRemoveAttachment(rt.db, {
        user: rt.user,
        actor: USER,
        attachmentId: files[0]?.id ?? "",
        now: NOW,
      });
      await expect(add(task.id, "fits-now.txt")).resolves.toMatchObject({
        filename: "fits-now.txt",
      });
    });

    it("refuses another user's task, a binned task and an oversized file, writing nothing", async () => {
      const theirs = await newTask("Theirs", rt.other);
      await expect(add(theirs.id)).rejects.toThrowError(NotFoundError);
      const mine = await newTask();
      await expect(
        add(mine.id, "big.bin", { size: plannerAttachmentMaxBytes + 1 }),
      ).rejects.toThrowError(DomainError);
      expect(
        await plannerTestCount(rt.database, "planner_task_attachment"),
      ).toBe(0);
      expect(await fileEvents(mine.id)).toEqual([]);
    });
  });

  // ===========================================================================

  describe("plannerRemoveAttachment and plannerLoadAttachment", () => {
    it("takes the file off the task, writes attachment_removed, and keeps the row for the sweep", async () => {
      const task = await newTask("With a file");
      const file = await add(task.id, "photo.jpg", {
        contentType: "image/jpeg",
      });
      const later = new Date(NOW.getTime() + 60_000);

      await plannerRemoveAttachment(rt.db, {
        user: rt.user,
        actor: USER,
        attachmentId: file.id,
        now: later,
      });

      expect(
        await plannerListAttachments(rt.db, {
          userId: rt.user.id,
          taskId: task.id,
        }),
      ).toEqual([]);
      expect(
        await plannerTestCount(rt.database, "planner_task_attachment"),
      ).toBe(1);
      const events = await fileEvents(task.id);
      expect(events.map((event) => event.type)).toEqual([
        "attachment_added",
        "attachment_removed",
      ]);
      expect(JSON.parse(events[1]?.data ?? "{}")).toEqual({
        attachment_id: file.id,
        filename: "photo.jpg",
        size: 1234,
      });
      // Removed, so gone for every reader; a second removal is a 404.
      await expect(
        plannerLoadAttachment(rt.db, {
          userId: rt.user.id,
          attachmentId: file.id,
        }),
      ).rejects.toThrowError(NotFoundError);
      await expect(
        plannerRemoveAttachment(rt.db, {
          user: rt.user,
          actor: USER,
          attachmentId: file.id,
        }),
      ).rejects.toThrowError(NotFoundError);
    });

    it("answers 404 for another user's file, exactly like a missing one", async () => {
      const task = await newTask();
      const file = await add(task.id);
      await expect(
        plannerLoadAttachment(rt.db, {
          userId: rt.other.id,
          attachmentId: file.id,
        }),
      ).rejects.toThrowError(NotFoundError);
      await expect(
        plannerRemoveAttachment(rt.db, {
          user: rt.other,
          actor: USER,
          attachmentId: file.id,
        }),
      ).rejects.toThrowError(NotFoundError);
      await expect(
        plannerLoadAttachment(rt.db, {
          userId: rt.user.id,
          attachmentId: "nope",
        }),
      ).rejects.toThrowError(NotFoundError);
    });
  });

  // ===========================================================================

  describe("the nightly sweep", () => {
    it("hands over files removed over seven days ago and files of purged tasks, then forgets them", async () => {
      const task = await newTask("Kept");
      const kept = await add(task.id, "kept.txt");
      const recent = await add(task.id, "recent.txt");
      const old = await add(task.id, "old.txt");
      await plannerRemoveAttachment(rt.db, {
        user: rt.user,
        actor: USER,
        attachmentId: recent.id,
        now: new Date(NOW.getTime() - 2 * DAYS),
      });
      await plannerRemoveAttachment(rt.db, {
        user: rt.user,
        actor: USER,
        attachmentId: old.id,
        now: new Date(NOW.getTime() - 8 * DAYS),
      });
      // A task the bin sweep hard-deleted: its row is gone from `tasks`.
      const purged = await newTask("Purged");
      const orphan = await add(purged.id, "orphan.txt");
      await plannerTestRun(
        rt.database,
        "DELETE FROM tasks WHERE id = ?",
        purged.id,
      );

      const first = await plannerAttachmentsToPurge(rt.db, { now: NOW });
      expect(first.map((row) => row.id)).toEqual([old.id]);
      await plannerFinishAttachmentPurge(rt.db, [old.id]);
      expect(
        await plannerTestCount(rt.database, "planner_task_attachment"),
      ).toBe(3);
      // The orphan was marked removed by the first call, so it goes a week later.
      const inAWeek = new Date(NOW.getTime() + 8 * DAYS);
      const second = await plannerAttachmentsToPurge(rt.db, { now: inAWeek });
      expect(second.map((row) => row.id).sort()).toEqual(
        [recent.id, orphan.id].sort(),
      );
      expect(
        await plannerListAttachments(rt.db, {
          userId: rt.user.id,
          taskId: task.id,
        }),
      ).toEqual([kept]);
    });
  });
});
