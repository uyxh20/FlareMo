import type { UserRow } from "@flaremo/db";
import {
  applyFlaremoMigrations,
  createDb,
  projects,
  taskActivity,
  tasks,
} from "@flaremo/db";
import { eq } from "drizzle-orm";
import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NotFoundError, ValidationError } from "./errors";
import {
  archiveProject,
  createProject,
  deleteProject,
  getProject,
  hardDeleteExpiredProjects,
  listProjects,
  restoreProject,
} from "./projects";
import {
  createTask,
  deleteTask,
  getTask,
  hardDeleteExpiredTasks,
  listTaskActivity,
  listTasks,
  reorderTasks,
  restoreTask,
  type TaskActor,
  updateTask,
} from "./tasks";
import { createFlaremoMember, ensureSingleUser } from "./users";

let mf: Miniflare;
let db: ReturnType<typeof createDb>;
let user: UserRow;
let other: UserRow;

const USER: TaskActor = { type: "user" };
const AGENT: TaskActor = { type: "agent", name: "codex" };

describe("projects and tasks domain services", () => {
  beforeEach(async () => {
    mf = new Miniflare({
      script: "export default { fetch() { return new Response('ok') } }",
      modules: true,
      compatibilityDate: "2026-07-10",
      compatibilityFlags: ["nodejs_compat"],
      d1Databases: { DB: "flaremo-projects-test" },
    });
    const database = await mf.getD1Database("DB");
    db = createDb(database);
    await applyFlaremoMigrations(database);
    user = await ensureSingleUser(db, {
      email: "owner@example.com",
      name: "Owner",
    });
    // Second identity for the isolation assertions: every cross-user access
    // below must surface as 404/400, never as leaked data.
    other = await createFlaremoMember(db, {
      email: "other@example.com",
      name: "Other",
    });
  });

  afterEach(async () => {
    await mf.dispose();
  });

  it("creates a project and reports task counts", async () => {
    const project = await createProject(db, user, { name: "FlareMo" });
    expect(project.task_count_total).toBe(0);
    expect(project.task_count_open).toBe(0);

    await createTask(db, user, USER, {
      project_id: project.id,
      title: "写文档",
    });
    await createTask(db, user, AGENT, {
      project_id: project.id,
      title: "跑测试",
      status: "done",
    });

    const listed = await listProjects(db, user);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.task_count_total).toBe(2);
    expect(listed[0]?.task_count_open).toBe(1);
  });

  it("creates unassigned tasks when no project is given (D1)", async () => {
    const task = await createTask(db, user, USER, { title: "无项目任务" });
    expect(task.project_id).toBeNull();
    expect((await listTasks(db, user)).tasks.map((t) => t.id)).toContain(
      task.id,
    );
    // Only tasks assigned to projects are counted per project.
    expect(await listProjects(db, user)).toHaveLength(0);
  });

  it("unassigns a task when project_id is cleared", async () => {
    const project = await createProject(db, user, { name: "FlareMo" });
    const task = await createTask(db, user, USER, {
      project_id: project.id,
      title: "搬家",
    });
    const cleared = await updateTask(db, user, USER, task.id, {
      project_id: null,
    });
    expect(cleared.project_id).toBeNull();
    expect(
      (await listTasks(db, user, { projectId: project.id })).tasks,
    ).toHaveLength(0);
  });

  it("tracks status transitions through completed_at and the activity trail", async () => {
    const project = await createProject(db, user, { name: "FlareMo" });
    const task = await createTask(db, user, USER, {
      project_id: project.id,
      title: "实现项目",
    });
    expect(task.completed_at).toBeNull();

    const done = await updateTask(db, user, AGENT, task.id, {
      status: "done",
    });
    expect(done.status).toBe("done");
    expect(done.completed_at).not.toBeNull();

    const reopened = await updateTask(db, user, USER, task.id, {
      status: "todo",
    });
    expect(reopened.completed_at).toBeNull();

    const activity = await listTaskActivity(db, user, task.id);
    const actions = activity.map((entry) => entry.action);
    expect(actions).toContain("created");
    expect(actions).toContain("status_changed");
    // Agent and user writes are both recorded and attributable.
    expect(activity.some((entry) => entry.actor_type === "agent")).toBe(true);
    expect(activity.some((entry) => entry.actor_type === "user")).toBe(true);
  });

  it("reorders tasks within a project in one batch", async () => {
    const project = await createProject(db, user, { name: "FlareMo" });
    const a = await createTask(db, user, USER, {
      project_id: project.id,
      title: "A",
    });
    const b = await createTask(db, user, USER, {
      project_id: project.id,
      title: "B",
    });
    const c = await createTask(db, user, USER, {
      project_id: project.id,
      title: "C",
    });

    const ordered = await reorderTasks(db, user, USER, project.id, [
      c.id,
      a.id,
      b.id,
    ]);
    expect(ordered.map((task) => task.title)).toEqual(["C", "A", "B"]);

    // Duplicate ids are a client bug, not a reorder.
    await expect(
      reorderTasks(db, user, USER, project.id, [a.id, a.id]),
    ).rejects.toBeInstanceOf(ValidationError);
    // A stray id from outside this project is a hard error, not a silent
    // ignore — an unassigned task cannot be reordered through a project.
    const stray = await createTask(db, user, USER, { title: "游离任务" });
    await expect(
      reorderTasks(db, user, USER, project.id, [stray.id]),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("filters tasks by project, status, priority and due range", async () => {
    const project = await createProject(db, user, { name: "FlareMo" });
    await createTask(db, user, USER, {
      project_id: project.id,
      title: "进行中",
      status: "in_progress",
      priority: "high",
      due_at: "2026-09-12",
    });
    await createTask(db, user, USER, {
      project_id: project.id,
      title: "待办",
    });

    const open = await listTasks(db, user, {
      projectId: project.id,
      status: "todo",
    });
    expect(open.tasks).toHaveLength(1);
    expect(open.tasks[0]?.title).toBe("待办");

    const high = await listTasks(db, user, { priority: "high" });
    expect(high.tasks.map((t) => t.title)).toEqual(["进行中"]);

    const ranged = await listTasks(db, user, {
      dueFrom: "2026-09-12",
      dueTo: "2026-09-12",
    });
    expect(ranged.tasks.map((t) => t.title)).toEqual(["进行中"]);
  });

  it("paginates tasks with the cursor token", async () => {
    for (let i = 0; i < 5; i += 1) {
      await createTask(db, user, USER, { title: `任务 ${i}` });
    }
    const first = await listTasks(db, user, { pageSize: 2 });
    expect(first.tasks).toHaveLength(2);
    expect(first.nextPageToken).toBeDefined();

    const second = await listTasks(db, user, {
      pageSize: 2,
      pageToken: first.nextPageToken,
    });
    expect(second.tasks).toHaveLength(2);

    const third = await listTasks(db, user, {
      pageSize: 2,
      pageToken: second.nextPageToken,
    });
    expect(third.tasks).toHaveLength(1);
    expect(third.nextPageToken).toBeUndefined();

    const all = await listTasks(db, user);
    expect([...first.tasks, ...second.tasks, ...third.tasks]).toEqual(
      all.tasks,
    );
  });

  it("soft deletes a project and its live tasks, then restores them together", async () => {
    const project = await createProject(db, user, { name: "FlareMo" });
    const task = await createTask(db, user, USER, {
      project_id: project.id,
      title: "任务",
    });

    await deleteProject(db, user, project.id);
    expect(await listProjects(db, user)).toHaveLength(0);
    // The whole project 404s to live reads, tasks included.
    await expect(getProject(db, user, project.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(getTask(db, user, task.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    // Physically nothing was removed: rows are binned with the stamp.
    const rows = await db.select().from(tasks);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.deletedAt).not.toBeNull();
    // The activity trail survives while the task sits in the bin.
    expect(await db.select().from(taskActivity)).toHaveLength(1);

    await restoreProject(db, user, project.id);
    expect((await listProjects(db, user))[0]?.id).toBe(project.id);
    expect((await getTask(db, user, task.id)).title).toBe("任务");
  });

  it("keeps a task's own bin stamp when its project is deleted later", async () => {
    const project = await createProject(db, user, { name: "FlareMo" });
    const solo = await createTask(db, user, USER, {
      project_id: project.id,
      title: "先删的",
    });
    const withProject = await createTask(db, user, USER, {
      project_id: project.id,
      title: "随项目的",
    });
    await deleteTask(db, user, solo.id);

    await deleteProject(db, user, project.id);
    await restoreProject(db, user, project.id);

    // The task deleted before the project keeps its own (older) stamp and
    // stays in the bin; restoring the project must not resurrect it.
    await expect(getTask(db, user, solo.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect((await getTask(db, user, withProject.id)).title).toBe("随项目的");
  });

  it("soft deletes and restores a single task", async () => {
    const project = await createProject(db, user, { name: "FlareMo" });
    const task = await createTask(db, user, USER, {
      project_id: project.id,
      title: "删除我",
    });
    await deleteTask(db, user, task.id);

    expect(
      (await listTasks(db, user, { projectId: project.id })).tasks,
    ).toHaveLength(0);
    // The trail stays readable while the task is binned.
    const activity = await db.select().from(taskActivity);
    expect(activity.length).toBeGreaterThan(0);

    const restored = await restoreTask(db, user, task.id);
    expect(restored.deleted_at).toBeNull();
    expect(
      (await listTasks(db, user, { projectId: project.id })).tasks,
    ).toHaveLength(1);
  });

  it("archives a project without touching the bin", async () => {
    const project = await createProject(db, user, { name: "FlareMo" });
    const archived = await archiveProject(db, user, project.id, true);
    expect(archived.status).toBe("archived");
    expect(archived.deleted_at).toBeNull();
  });

  it("hard deletes expired bin rows through the TTL sweeps", async () => {
    const project = await createProject(db, user, { name: "FlareMo" });
    const task = await createTask(db, user, USER, {
      project_id: project.id,
      title: "过期任务",
    });
    // Cutoff strictly after the stamp (`lt`), mirroring the cron usage.
    const stale = "2026-01-01T00:00:00.000Z";
    const cutoff = "2026-02-01T00:00:00.000Z";
    await db
      .update(tasks)
      .set({ deletedAt: stale })
      .where(eq(tasks.id, task.id));
    await db
      .update(projects)
      .set({ deletedAt: stale })
      .where(eq(projects.id, project.id));

    // Projects first: the FK cascade removes the binned tasks and their
    // trail, so the task sweep below has nothing left to do.
    expect(await hardDeleteExpiredProjects(db, cutoff)).toBe(1);
    expect(await hardDeleteExpiredTasks(db, cutoff)).toBe(0);
    expect(await db.select().from(tasks)).toHaveLength(0);
    expect(await db.select().from(taskActivity)).toHaveLength(0);
  });

  it("hard deletes standalone expired tasks through the task sweep", async () => {
    const task = await createTask(db, user, USER, { title: "散件过期" });
    await db
      .update(tasks)
      .set({ deletedAt: "2026-01-01T00:00:00.000Z" })
      .where(eq(tasks.id, task.id));

    expect(await hardDeleteExpiredTasks(db, "2026-02-01T00:00:00.000Z")).toBe(
      1,
    );
    expect(await db.select().from(tasks)).toHaveLength(0);
  });

  it("drains TTL rows in bounded batches while preserving project cascades", async () => {
    const stale = "2026-01-01T00:00:00.000Z";
    const cutoff = "2026-02-01T00:00:00.000Z";
    const projectRows = Array.from({ length: 101 }, (_, index) => ({
      id: `projects/expired-${index}`,
      userId: user.id,
      name: `Expired ${index}`,
      description: null,
      status: "active" as const,
      deletedAt: stale,
      createdAt: stale,
      updatedAt: stale,
    }));
    const taskRows = [
      ...projectRows.map((project, index) => ({
        id: `tasks/project-${index}`,
        userId: user.id,
        projectId: project.id,
        sourceMemoId: null,
        title: `Project task ${index}`,
        notes: null,
        status: "todo" as const,
        priority: "none" as const,
        dueAt: null,
        sortOrder: 0,
        completedAt: null,
        deletedAt: stale,
        createdAt: stale,
        updatedAt: stale,
      })),
      ...Array.from({ length: 101 }, (_, index) => ({
        id: `tasks/standalone-${index}`,
        userId: user.id,
        projectId: null,
        sourceMemoId: null,
        title: `Standalone task ${index}`,
        notes: null,
        status: "todo" as const,
        priority: "none" as const,
        dueAt: null,
        sortOrder: 0,
        completedAt: null,
        deletedAt: stale,
        createdAt: stale,
        updatedAt: stale,
      })),
    ];

    // Keep test fixtures under D1's 100-binding statement limit too.
    for (let index = 0; index < projectRows.length; index += 10) {
      await db.insert(projects).values(projectRows.slice(index, index + 10));
    }
    for (let index = 0; index < taskRows.length; index += 7) {
      await db.insert(tasks).values(taskRows.slice(index, index + 7));
    }

    expect(await hardDeleteExpiredProjects(db, cutoff)).toBe(101);
    // The first sweep removed 101 project tasks by FK cascade; this sweep
    // should report only the 101 independent tasks it physically deleted.
    expect(await hardDeleteExpiredTasks(db, cutoff)).toBe(101);
    expect(await db.select().from(projects)).toHaveLength(0);
    expect(await db.select().from(tasks)).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Cross-user isolation
  // ---------------------------------------------------------------------------

  it("never leaks or accepts resources across users", async () => {
    const project = await createProject(db, user, { name: "我的项目" });
    const task = await createTask(db, user, USER, {
      project_id: project.id,
      title: "我的任务",
    });

    // Reading someone else's task/project is a 404, not a leak.
    await expect(getProject(db, other, project.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(getTask(db, other, task.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    // Creating a task under someone else's project is a 404.
    await expect(
      createTask(db, other, USER, {
        project_id: project.id,
        title: "越权任务",
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    // Reorder under someone else's project is a 404 on the project itself.
    await expect(
      reorderTasks(db, other, USER, project.id, [task.id]),
    ).rejects.toBeInstanceOf(NotFoundError);
    // Someone else's listing stays empty.
    expect(await listProjects(db, other)).toHaveLength(0);
    expect((await listTasks(db, other)).tasks).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Boundary values
  // ---------------------------------------------------------------------------

  it("accepts a 200-char title", async () => {
    const ok = "好".repeat(200);
    const created = await createTask(db, user, USER, { title: ok });
    expect(created.title).toHaveLength(200);
  });

  it("lists projects by name substring with LIKE escaping", async () => {
    await createProject(db, user, { name: "网站改版" });
    await createProject(db, user, { name: "日常记录" });

    const hits = await listProjects(db, user, { query: "改版" });
    expect(hits).toHaveLength(1);
    // % and _ in the query are literals, not wildcards.
    expect(await listProjects(db, user, { query: "%版" })).toHaveLength(0);
  });
});
