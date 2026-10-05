import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { createProject, deleteProject, restoreProject } from "../projects";
import { createTask, deleteTask, type TaskActor } from "../tasks";
import {
  type PlannerTestRuntime,
  plannerTestBeforeBatch,
  plannerTestCount,
  plannerTestFailBatch,
  plannerTestInsertEvent,
  plannerTestInsertNode,
  plannerTestInsertPlan,
  plannerTestNode,
  plannerTestRows,
  plannerTestRun,
  plannerTestRuntime,
} from "./test-support";
import {
  plannerMaxTreeDepth,
  plannerReadRollup,
  plannerReadTree,
  plannerUpsertProjectNode,
} from "./tree";

const USER: TaskActor = { type: "user" };
const NOW = new Date("2026-10-07T09:00:00.000Z");
const LATER = new Date("2026-10-07T10:00:00.000Z");

describe("the goal tree", () => {
  let rt: PlannerTestRuntime;

  beforeAll(async () => {
    rt = await plannerTestRuntime("flaremo-planner-tree");
  });
  afterAll(async () => {
    await rt.dispose();
  });
  beforeEach(async () => {
    await rt.reset();
  });

  const project = async (name: string, owner = rt.user) =>
    (await createProject(rt.db, owner, { name })).id;

  const upsert = (
    projectId: string,
    fields: Partial<Parameters<typeof plannerUpsertProjectNode>[1]> = {},
  ) =>
    plannerUpsertProjectNode(rt.db, {
      userId: rt.user.id,
      projectId,
      now: NOW,
      ...fields,
    });

  const parentOf = async (projectId: string) =>
    (await plannerTestNode(rt.database, projectId))?.parent_project_id;

  /** Projects `c1..cN`, each the parent of the next, built through the guards. */
  const chain = async (length: number, prefix = "c") => {
    const ids: string[] = [];
    for (let index = 1; index <= length; index += 1) {
      const id = await project(`${prefix}${index}`);
      ids.push(id);
      if (index > 1) await upsert(id, { parentProjectId: ids[index - 2] });
    }
    return ids;
  };

  describe("plannerReadTree", () => {
    it("lists every live project, a root with no level when it has no node", async () => {
      const a = await project("Alpha");
      await project("Beta");

      const tree = await plannerReadTree(rt.db, { userId: rt.user.id });

      expect(tree.map((node) => node.name).sort()).toEqual(["Alpha", "Beta"]);
      expect(tree.find((node) => node.id === a)).toEqual({
        id: a,
        name: "Alpha",
        status: "active",
        parent_project_id: null,
        level: null,
        period_start: null,
        period_end: null,
        sort_order: 0,
      });
    });

    it("merges node fields, links parents and orders by sort order", async () => {
      const goal = await project("Goal");
      const second = await project("Second");
      const first = await project("First");
      await upsert(goal, {
        level: "year",
        periodStart: "2026-01-01",
        periodEnd: "2026-12-31",
      });
      await upsert(second, {
        parentProjectId: goal,
        level: "quarter",
        sortOrder: 2,
      });
      await upsert(first, {
        parentProjectId: goal,
        level: "quarter",
        sortOrder: 1,
      });

      const tree = await plannerReadTree(rt.db, { userId: rt.user.id });

      expect(tree.find((node) => node.id === goal)).toMatchObject({
        level: "year",
        period_start: "2026-01-01",
        period_end: "2026-12-31",
        parent_project_id: null,
      });
      expect(tree.find((node) => node.id === first)).toMatchObject({
        parent_project_id: goal,
        sort_order: 1,
      });
      expect(tree.find((node) => node.id === second)?.parent_project_id).toBe(
        goal,
      );
      // sort_order 0 (Goal) first, then 1, then 2.
      expect(tree.map((node) => node.name)).toEqual([
        "Goal",
        "First",
        "Second",
      ]);
    });

    it("leaves out projects in the recycle bin, and shows their children as roots", async () => {
      const parent = await project("Parent");
      const child = await project("Child");
      const binned = await project("Binned");
      await upsert(child, { parentProjectId: parent });

      await deleteProject(rt.db, rt.user, parent);
      await deleteProject(rt.db, rt.user, binned);
      const during = await plannerReadTree(rt.db, { userId: rt.user.id });
      expect(during.map((node) => node.id)).toEqual([child]);
      expect(during[0]?.parent_project_id).toBeNull();
      // The node row still names the parent.
      expect(await parentOf(child)).toBe(parent);

      await restoreProject(rt.db, rt.user, parent);
      const after = await plannerReadTree(rt.db, { userId: rt.user.id });
      expect(after.find((node) => node.id === child)?.parent_project_id).toBe(
        parent,
      );
    });

    it("includes archived projects with their status, and only the user's own", async () => {
      const mine = await project("Mine");
      await project("Theirs", rt.other);
      await plannerTestRun(
        rt.database,
        "UPDATE projects SET status = 'archived' WHERE id = ?",
        mine,
      );
      const tree = await plannerReadTree(rt.db, { userId: rt.user.id });
      expect(tree.map((node) => [node.name, node.status])).toEqual([
        ["Mine", "archived"],
      ]);
    });
  });

  describe("plannerUpsertProjectNode", () => {
    it("creates a node and returns the merged project", async () => {
      const id = await project("Goal");
      const node = await upsert(id, {
        level: "goal",
        periodStart: "2026-10-01",
        periodEnd: "2026-12-31",
        sortOrder: 4,
      });
      expect(node).toEqual({
        id,
        name: "Goal",
        status: "active",
        parent_project_id: null,
        level: "goal",
        period_start: "2026-10-01",
        period_end: "2026-12-31",
        sort_order: 4,
      });
      expect(await plannerTestNode(rt.database, id)).toMatchObject({
        user_id: rt.user.id,
        created_at: NOW.toISOString(),
        updated_at: NOW.toISOString(),
      });
    });

    it("creates the parent's node row when it has none, in the same write", async () => {
      const parent = await project("Parent");
      const child = await project("Child");
      expect(await plannerTestNode(rt.database, parent)).toBeUndefined();

      await upsert(child, { parentProjectId: parent });

      expect(await plannerTestNode(rt.database, parent)).toMatchObject({
        parent_project_id: null,
        level: null,
        period_start: null,
        period_end: null,
        sort_order: 0,
        created_at: NOW.toISOString(),
      });
      expect(await parentOf(child)).toBe(parent);
    });

    it("keeps a parent's children when the parent is upserted", async () => {
      const parent = await project("Parent");
      const a = await project("A");
      const b = await project("B");
      await upsert(a, { parentProjectId: parent });
      await upsert(b, { parentProjectId: parent });

      await upsert(parent, { level: "goal", sortOrder: 5 });
      await plannerUpsertProjectNode(rt.db, {
        userId: rt.user.id,
        projectId: parent,
        level: "quarter",
        now: LATER,
      });

      expect(await parentOf(a)).toBe(parent);
      expect(await parentOf(b)).toBe(parent);
      expect(await plannerTestNode(rt.database, parent)).toMatchObject({
        level: "quarter",
        sort_order: 5,
        created_at: NOW.toISOString(),
        updated_at: LATER.toISOString(),
      });
      expect(await plannerTestCount(rt.database, "planner_project_node")).toBe(
        3,
      );
    });

    it("updates only the fields that are given, and null clears one", async () => {
      const parent = await project("Parent");
      const id = await project("Goal");
      await upsert(id, {
        parentProjectId: parent,
        level: "quarter",
        periodStart: "2026-10-01",
        periodEnd: "2026-12-31",
        sortOrder: 3,
      });
      const snapshot = () => plannerTestNode(rt.database, id);

      await plannerUpsertProjectNode(rt.db, {
        userId: rt.user.id,
        projectId: id,
        sortOrder: 9,
        now: LATER,
      });
      expect(await snapshot()).toMatchObject({
        parent_project_id: parent,
        level: "quarter",
        period_start: "2026-10-01",
        period_end: "2026-12-31",
        sort_order: 9,
        updated_at: LATER.toISOString(),
      });

      await upsert(id, { level: null });
      expect(await snapshot()).toMatchObject({
        level: null,
        parent_project_id: parent,
        sort_order: 9,
      });

      await upsert(id, { periodStart: null });
      expect(await snapshot()).toMatchObject({
        period_start: null,
        period_end: "2026-12-31",
      });

      await upsert(id, { parentProjectId: null });
      expect(await snapshot()).toMatchObject({
        parent_project_id: null,
        period_end: "2026-12-31",
        sort_order: 9,
      });
    });

    it("moves a project between parents", async () => {
      const [a, b, x] = [
        await project("A"),
        await project("B"),
        await project("X"),
      ];
      await upsert(x, { parentProjectId: a });
      expect(await parentOf(x)).toBe(a);
      await upsert(x, { parentProjectId: b });
      expect(await parentOf(x)).toBe(b);
      expect(await parentOf(a)).toBeNull();
    });

    it("accepts the slug levels the plan names and null", async () => {
      const id = await project("Goal");
      for (const level of [
        "area",
        "year",
        "quarter",
        "goal",
        "milestone",
        "a-b-1",
        "x",
        "a".repeat(24),
      ]) {
        await expect(upsert(id, { level }), level).resolves.toMatchObject({
          level,
        });
      }
      await expect(upsert(id, { level: null })).resolves.toMatchObject({
        level: null,
      });
    });

    it("rejects a level that is not a slug, and writes nothing", async () => {
      const id = await project("Goal");
      for (const level of [
        "Goal",
        "1st",
        "has space",
        "under_score",
        "",
        "-x",
        "a".repeat(25),
        "é",
      ]) {
        await expect(
          upsert(id, { level }),
          JSON.stringify(level),
        ).rejects.toBeInstanceOf(ValidationError);
      }
      expect(await plannerTestCount(rt.database, "planner_project_node")).toBe(
        0,
      );
    });

    it("rejects bad dates and sort orders, and a start after the end", async () => {
      const id = await project("Goal");
      for (const fields of [
        { periodStart: "2026-02-30" },
        { periodEnd: "soon" },
        { periodStart: "2026-10-7" },
        { periodStart: "2026-12-31", periodEnd: "2026-10-01" },
        { sortOrder: 1.5 },
        { sortOrder: Number.NaN },
      ]) {
        await expect(
          upsert(id, fields),
          JSON.stringify(fields),
        ).rejects.toBeInstanceOf(ValidationError);
      }
      // The same day on both ends is fine.
      await expect(
        upsert(id, { periodStart: "2026-10-07", periodEnd: "2026-10-07" }),
      ).resolves.toBeDefined();
      // A new start is checked against the stored end.
      await expect(
        upsert(id, { periodStart: "2026-10-08" }),
      ).rejects.toBeInstanceOf(ValidationError);
      expect((await plannerTestNode(rt.database, id))?.period_start).toBe(
        "2026-10-07",
      );
    });

    it("is a 404 for a project or parent that is missing, deleted or someone else's", async () => {
      const mine = await project("Mine");
      const theirs = await project("Theirs", rt.other);
      const binned = await project("Binned");
      await deleteProject(rt.db, rt.user, binned);

      await expect(upsert("projects/nope")).rejects.toBeInstanceOf(
        NotFoundError,
      );
      await expect(upsert(theirs)).rejects.toBeInstanceOf(NotFoundError);
      await expect(upsert(binned)).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        upsert(mine, { parentProjectId: "projects/nope" }),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        upsert(mine, { parentProjectId: theirs }),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        upsert(mine, { parentProjectId: binned }),
      ).rejects.toBeInstanceOf(NotFoundError);
      expect(await plannerTestCount(rt.database, "planner_project_node")).toBe(
        0,
      );
    });

    it("takes bare project ids", async () => {
      const parent = await project("Parent");
      const child = await project("Child");
      const node = await plannerUpsertProjectNode(rt.db, {
        userId: rt.user.id,
        projectId: child.replace(/^projects\//, ""),
        parentProjectId: parent.replace(/^projects\//, ""),
        now: NOW,
      });
      expect(node.id).toBe(child);
      expect(node.parent_project_id).toBe(parent);
    });

    describe("cycles", () => {
      it("refuses a project as its own parent", async () => {
        const id = await project("Loop");
        const error = await upsert(id, { parentProjectId: id }).catch((e) => e);
        expect(error).toBeInstanceOf(ConflictError);
        expect(error.status).toBe(409);
        expect(
          await plannerTestCount(rt.database, "planner_project_node"),
        ).toBe(0);
      });

      it("refuses to put a project under its own descendant, and changes nothing", async () => {
        const [a, b, c] = await chain(3);
        const before = await plannerTestNode(rt.database, a as string);

        for (const parent of [b, c]) {
          const error = await plannerUpsertProjectNode(rt.db, {
            userId: rt.user.id,
            projectId: a as string,
            parentProjectId: parent,
            sortOrder: 99,
            now: LATER,
          }).catch((e) => e);
          expect(error).toBeInstanceOf(ConflictError);
          expect(error.status).toBe(409);
        }

        // Neither the parent nor the other fields of the rejected write moved.
        expect(await plannerTestNode(rt.database, a as string)).toEqual(before);
        expect(await parentOf(b as string)).toBe(a);
      });

      it("catches a cycle inside the write, so two racing moves cannot make one", async () => {
        const a = await project("A");
        const b = await project("B");

        const results = await Promise.allSettled([
          upsert(a, { parentProjectId: b }),
          upsert(b, { parentProjectId: a }),
        ]);

        const rejected = results.filter(
          (result) => result.status === "rejected",
        );
        expect(rejected).toHaveLength(1);
        expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
          ConflictError,
        );
        // Exactly one of the two links exists, so there is no loop.
        const parents = [await parentOf(a), await parentOf(b)];
        expect(parents.filter((parent) => parent)).toHaveLength(1);
      });

      it("refuses in the write itself when the cycle appears after the reads", async () => {
        const a = await project("A");
        const b = await project("B");
        await plannerTestInsertNode(rt.database, {
          projectId: a,
          userId: rt.user.id,
        });
        await plannerTestInsertNode(rt.database, {
          projectId: b,
          userId: rt.user.id,
        });

        // The function reads first (no relation yet, so it sees no cycle), then
        // a competing request puts B under A, then its own batch runs.
        const racing = plannerTestBeforeBatch(rt.db, async () => {
          await plannerTestRun(
            rt.database,
            "UPDATE planner_project_node SET parent_project_id = ? WHERE project_id = ?",
            a,
            b,
          );
        });

        const error = await plannerUpsertProjectNode(racing, {
          userId: rt.user.id,
          projectId: a,
          parentProjectId: b,
          sortOrder: 7,
          now: NOW,
        }).catch((e) => e);

        expect(error).toBeInstanceOf(ConflictError);
        // The competing link stands; the refused write left no trace.
        expect(await parentOf(b)).toBe(a);
        expect(await plannerTestNode(rt.database, a)).toMatchObject({
          parent_project_id: null,
          sort_order: 0,
        });
      });

      it("rolls the parent's new row back inside D1 when the node write fails", async () => {
        const parent = await project("Parent");
        const first = await project("First");
        const second = await project("Second");
        await upsert(first, { level: "goal" });
        // A second node with the same level breaks this index, in the batch's
        // second statement, after the parent's row was created by the first.
        await plannerTestRun(
          rt.database,
          "CREATE UNIQUE INDEX planner_test_one_level ON planner_project_node (level)",
        );
        try {
          await expect(
            upsert(second, { parentProjectId: parent, level: "goal" }),
          ).rejects.toThrow(/UNIQUE/i);
          expect(await plannerTestNode(rt.database, parent)).toBeUndefined();
          expect(await plannerTestNode(rt.database, second)).toBeUndefined();
        } finally {
          await plannerTestRun(
            rt.database,
            "DROP INDEX planner_test_one_level",
          );
        }
      });

      it("writes the parent row and the node in one batch, or neither", async () => {
        const parent = await project("Parent");
        const child = await project("Child");
        const failing = plannerTestFailBatch(rt.db, (texts) =>
          texts.some((text) => text.includes("ancestors")),
        );
        await expect(
          plannerUpsertProjectNode(failing, {
            userId: rt.user.id,
            projectId: child,
            parentProjectId: parent,
            now: NOW,
          }),
        ).rejects.toThrow(/injected failure/);
        expect(
          await plannerTestCount(rt.database, "planner_project_node"),
        ).toBe(0);
      });
    });

    describe("depth", () => {
      it("allows six levels and refuses a seventh", async () => {
        expect(plannerMaxTreeDepth).toBe(6);
        const ids = await chain(6);
        expect(await parentOf(ids[5] as string)).toBe(ids[4]);

        const extra = await project("Seventh");
        const error = await upsert(extra, {
          parentProjectId: ids[5],
        }).catch((e) => e);
        expect(error).toBeInstanceOf(ValidationError);
        expect(error.status).toBe(400);
        expect(error.message).toContain("6");
        expect(await plannerTestNode(rt.database, extra)).toBeUndefined();

        // One level up is still fine.
        await expect(
          upsert(extra, { parentProjectId: ids[4] }),
        ).resolves.toBeDefined();
      });

      it("counts the height of the subtree being moved, not just the parent's depth", async () => {
        const q = await chain(5, "q"); // depth 5
        const x = await project("X");
        const y = await project("Y");
        await upsert(y, { parentProjectId: x }); // X <- Y: a subtree of height 1
        const leaf = await project("Leaf");

        // Under q5: 5 + 1 + 1 = 7. Under q4: 4 + 1 + 1 = 6.
        await expect(
          upsert(x, { parentProjectId: q[4] }),
        ).rejects.toBeInstanceOf(ValidationError);
        await expect(
          upsert(x, { parentProjectId: q[3] }),
        ).resolves.toBeDefined();
        // A leaf under q5 reaches exactly 6.
        await expect(
          upsert(leaf, { parentProjectId: q[4] }),
        ).resolves.toBeDefined();
      });

      it("refuses a tall subtree even under a parent with no node, and creates no node for it", async () => {
        const s = await chain(6, "s"); // a six-level subtree on its own
        const parent = await project("Bare parent");
        expect(await plannerTestNode(rt.database, parent)).toBeUndefined();

        // 1 (parent) + 1 + 5 (height) = 7.
        await expect(
          upsert(s[0] as string, { parentProjectId: parent }),
        ).rejects.toBeInstanceOf(ValidationError);
        expect(await plannerTestNode(rt.database, parent)).toBeUndefined();
        expect(await parentOf(s[0] as string)).toBeNull();
      });

      it("never limits a move to the top level, and skips the check when the parent does not change", async () => {
        // A chain forced to eight levels, bypassing the guards.
        const ids: string[] = [];
        for (let index = 0; index < 8; index += 1) {
          ids.push(await project(`deep${index}`));
          await plannerTestInsertNode(rt.database, {
            projectId: ids[index] as string,
            userId: rt.user.id,
            parentProjectId: index === 0 ? null : (ids[index - 1] as string),
          });
        }
        // Editing a deep node without moving it is allowed.
        await expect(
          upsert(ids[7] as string, {
            level: "milestone",
            parentProjectId: ids[6],
          }),
        ).resolves.toMatchObject({ level: "milestone" });
        await expect(
          upsert(ids[7] as string, { sortOrder: 2 }),
        ).resolves.toBeDefined();
        // Moving anything to the top level is always fine.
        await expect(
          upsert(ids[3] as string, { parentProjectId: null }),
        ).resolves.toMatchObject({ parent_project_id: null });
      });

      it("does not walk forever when the data already holds a cycle", async () => {
        const a = await project("A");
        const b = await project("B");
        const target = await project("Target");
        await plannerTestInsertNode(rt.database, {
          projectId: a,
          userId: rt.user.id,
        });
        await plannerTestInsertNode(rt.database, {
          projectId: b,
          userId: rt.user.id,
          parentProjectId: a,
        });
        await plannerTestRun(
          rt.database,
          "UPDATE planner_project_node SET parent_project_id = ? WHERE project_id = ?",
          b,
          a,
        );

        // Moving a member of the damaged loop is refused, not hung.
        await expect(
          upsert(target, { parentProjectId: a }),
        ).rejects.toBeInstanceOf(ValidationError);
      });
    });
  });

  describe("plannerReadRollup", () => {
    const FROM = "2026-10-01";
    const TO = "2026-10-07";

    type Fixture = {
      root: string;
      q1: string;
      q2: string;
      m1: string;
    };

    const task = async (
      projectId: string,
      title: string,
      status: "todo" | "in_progress" | "done" = "todo",
      completedAt: string | null = null,
    ) => {
      const created = await createTask(rt.db, rt.user, USER, {
        title,
        status,
        project_id: projectId,
      });
      if (status === "done") {
        await plannerTestRun(
          rt.database,
          "UPDATE tasks SET completed_at = ? WHERE id = ?",
          completedAt,
          created.id,
        );
      }
      return created.id;
    };

    /** root <- q1 <- m1, root <- q2, with a spread of tasks. */
    const fixture = async (): Promise<Fixture> => {
      const root = await project("Root");
      const q1 = await project("Q1");
      const q2 = await project("Q2");
      const m1 = await project("M1");
      await upsert(root, { level: "goal", sortOrder: 0 });
      await upsert(q2, {
        parentProjectId: root,
        level: "quarter",
        sortOrder: 2,
      });
      await upsert(q1, {
        parentProjectId: root,
        level: "quarter",
        sortOrder: 1,
      });
      await upsert(m1, { parentProjectId: q1, level: "milestone" });

      await task(root, "root open");
      await task(root, "root done", "done", "2026-10-03T10:00:00.000Z");

      await task(q1, "q1 doing", "in_progress");
      await task(q1, "q1 done in", "done", "2026-10-07T23:59:59.999Z");
      await task(q1, "q1 done out", "done", "2026-10-08T00:00:00.000Z");
      const deleted = await task(q1, "q1 deleted");
      await deleteTask(rt.db, rt.user, deleted);
      const dropped = await task(q1, "q1 dropped");
      await plannerTestInsertPlan(rt.database, {
        taskId: dropped,
        userId: rt.user.id,
        horizon: "week",
        periodStart: "2026-10-05",
        droppedAt: "2026-10-06T00:00:00.000Z",
      });

      const planned = await task(m1, "m1 planned");
      await plannerTestInsertPlan(rt.database, {
        taskId: planned,
        userId: rt.user.id,
        horizon: "week",
        periodStart: "2026-10-05",
      });
      const earlier = await task(m1, "m1 planned earlier");
      await plannerTestInsertPlan(rt.database, {
        taskId: earlier,
        userId: rt.user.id,
        horizon: "week",
        periodStart: "2026-09-28",
      });

      const carried = (
        taskId: string,
        occurredAt: string,
        userId = rt.user.id,
      ) =>
        plannerTestInsertEvent(rt.database, {
          userId,
          taskId,
          type: "carried_over",
          occurredAt,
        });
      await carried(planned, "2026-10-06T09:00:00.000Z"); // in range
      await carried(planned, "2026-10-08T00:00:00.000Z"); // the day after
      await carried(earlier, "2026-10-01T00:00:00.000Z"); // first instant
      await carried(dropped, "2026-10-02T00:00:00.000Z"); // dropped plan
      await carried(deleted, "2026-10-02T00:00:00.000Z"); // deleted task
      await plannerTestInsertEvent(rt.database, {
        userId: rt.user.id,
        taskId: planned,
        type: "planned",
        occurredAt: "2026-10-02T00:00:00.000Z",
      }); // not a carry
      return { root, q1, q2, m1 };
    };

    const counts = (
      open: number,
      done: number,
      planned: number,
      doneIn: number,
      carried: number,
    ) => ({
      open_tasks: open,
      done_tasks: done,
      planned_in_range: planned,
      done_in_range: doneIn,
      carried_in_range: carried,
    });

    it("counts per node and in total, over the whole subtree", async () => {
      const { root, q1, q2, m1 } = await fixture();

      const rollup = await plannerReadRollup(rt.db, {
        userId: rt.user.id,
        projectId: root,
        from: FROM,
        to: TO,
      });

      expect(rollup).toMatchObject({ project_id: root, from: FROM, to: TO });
      // Parents before children; siblings by sort order (Q1 before Q2).
      expect(rollup.nodes.map((node) => [node.name, node.depth])).toEqual([
        ["Root", 0],
        ["Q1", 1],
        ["M1", 2],
        ["Q2", 1],
      ]);
      const byName = Object.fromEntries(
        rollup.nodes.map((node) => [node.name, node]),
      );
      expect(byName.Root).toMatchObject({
        id: root,
        level: "goal",
        ...counts(1, 1, 0, 1, 0),
      });
      // q1: doing is open; q1 done in/out are done; deleted and dropped are not counted.
      expect(byName.Q1).toMatchObject({
        id: q1,
        parent_project_id: root,
        level: "quarter",
        ...counts(1, 2, 0, 1, 0),
      });
      expect(byName.Q2).toMatchObject({ id: q2, ...counts(0, 0, 0, 0, 0) });
      // m1: two open tasks, one planned inside the range, two carries inside it.
      expect(byName.M1).toMatchObject({
        id: m1,
        parent_project_id: q1,
        level: "milestone",
        ...counts(2, 0, 1, 0, 2),
      });
      expect(rollup.total).toEqual(counts(4, 3, 1, 2, 2));
    });

    it("rolls up just a subtree when asked for a child", async () => {
      const { q1 } = await fixture();
      const rollup = await plannerReadRollup(rt.db, {
        userId: rt.user.id,
        projectId: q1,
        from: FROM,
        to: TO,
      });
      expect(rollup.nodes.map((node) => node.name)).toEqual(["Q1", "M1"]);
      expect(rollup.nodes[0]?.depth).toBe(0);
      expect(rollup.total).toEqual(counts(3, 2, 1, 1, 2));
    });

    it("treats the range as inclusive on both days", async () => {
      const { root } = await fixture();
      const day = (from: string, to: string) =>
        plannerReadRollup(rt.db, {
          userId: rt.user.id,
          projectId: root,
          from,
          to,
        });

      // 2026-10-07 holds q1's 23:59:59.999 completion; 2026-10-08 holds the next one.
      expect((await day("2026-10-07", "2026-10-07")).total.done_in_range).toBe(
        1,
      );
      expect((await day("2026-10-08", "2026-10-08")).total.done_in_range).toBe(
        1,
      );
      expect((await day("2026-10-07", "2026-10-08")).total.done_in_range).toBe(
        2,
      );
      // The carry at 2026-10-01T00:00:00.000Z is inside a range starting that day.
      expect(
        (await day("2026-10-01", "2026-10-01")).total.carried_in_range,
      ).toBe(1);
      expect(
        (await day("2026-09-30", "2026-09-30")).total.carried_in_range,
      ).toBe(0);
      // Plans are counted by their period start.
      expect(
        (await day("2026-09-28", "2026-09-28")).total.planned_in_range,
      ).toBe(1);
      expect(
        (await day("2026-10-05", "2026-10-05")).total.planned_in_range,
      ).toBe(1);
      expect(
        (await day("2026-10-06", "2026-10-06")).total.planned_in_range,
      ).toBe(0);
    });

    it("counts a project with no node as a tree of one", async () => {
      const lone = await project("Lone");
      await task(lone, "only open");
      const rollup = await plannerReadRollup(rt.db, {
        userId: rt.user.id,
        projectId: lone,
        from: FROM,
        to: TO,
      });
      expect(rollup.nodes).toHaveLength(1);
      expect(rollup.nodes[0]).toMatchObject({
        id: lone,
        parent_project_id: null,
        level: null,
        depth: 0,
        open_tasks: 1,
      });
    });

    it("does not walk through a project in the recycle bin", async () => {
      const { root, q1 } = await fixture();
      await deleteProject(rt.db, rt.user, q1);

      const rollup = await plannerReadRollup(rt.db, {
        userId: rt.user.id,
        projectId: root,
        from: FROM,
        to: TO,
      });

      // Q1 and M1 (which hangs off Q1) are out; Root and Q2 remain.
      expect(rollup.nodes.map((node) => node.name)).toEqual(["Root", "Q2"]);
      expect(rollup.total).toEqual(counts(1, 1, 0, 1, 0));
    });

    it("cannot be sent round a cycle that is already in the data", async () => {
      const a = await project("A");
      const b = await project("B");
      const c = await project("C");
      await plannerTestInsertNode(rt.database, {
        projectId: a,
        userId: rt.user.id,
      });
      await plannerTestInsertNode(rt.database, {
        projectId: b,
        userId: rt.user.id,
        parentProjectId: a,
      });
      await plannerTestInsertNode(rt.database, {
        projectId: c,
        userId: rt.user.id,
        parentProjectId: b,
      });
      // The guards would refuse this; force it.
      await plannerTestRun(
        rt.database,
        "UPDATE planner_project_node SET parent_project_id = ? WHERE project_id = ?",
        c,
        a,
      );
      await task(a, "in a");
      await task(b, "in b");
      await task(c, "in c");

      const rollup = await plannerReadRollup(rt.db, {
        userId: rt.user.id,
        projectId: a,
        from: FROM,
        to: TO,
      });

      expect(rollup.nodes.map((node) => node.name).sort()).toEqual([
        "A",
        "B",
        "C",
      ]);
      expect(rollup.nodes[0]?.id).toBe(a);
      // Every task is counted once.
      expect(rollup.total.open_tasks).toBe(3);

      // A project that is its own parent, too.
      const solo = await project("Solo");
      await plannerTestInsertNode(rt.database, {
        projectId: solo,
        userId: rt.user.id,
        parentProjectId: null,
      });
      await plannerTestRun(
        rt.database,
        "UPDATE planner_project_node SET parent_project_id = project_id WHERE project_id = ?",
        solo,
      );
      const self = await plannerReadRollup(rt.db, {
        userId: rt.user.id,
        projectId: solo,
        from: FROM,
        to: TO,
      });
      expect(self.nodes.map((node) => node.name)).toEqual(["Solo"]);
    });

    it("reads a damaged tree without looping the flat tree read either", async () => {
      const a = await project("A");
      const b = await project("B");
      await plannerTestInsertNode(rt.database, {
        projectId: a,
        userId: rt.user.id,
      });
      await plannerTestInsertNode(rt.database, {
        projectId: b,
        userId: rt.user.id,
        parentProjectId: a,
      });
      await plannerTestRun(
        rt.database,
        "UPDATE planner_project_node SET parent_project_id = ? WHERE project_id = ?",
        b,
        a,
      );
      const tree = await plannerReadTree(rt.db, { userId: rt.user.id });
      expect(tree).toHaveLength(2);
    });

    it("is a 404 for a project that is missing, deleted or someone else's", async () => {
      const mine = await project("Mine");
      const theirs = await project("Theirs", rt.other);
      await deleteProject(rt.db, rt.user, mine);
      for (const projectId of ["projects/nope", theirs, mine]) {
        await expect(
          plannerReadRollup(rt.db, {
            userId: rt.user.id,
            projectId,
            from: FROM,
            to: TO,
          }),
          projectId,
        ).rejects.toBeInstanceOf(NotFoundError);
      }
    });

    it("rejects an invalid or inverted range", async () => {
      const id = await project("Range");
      for (const [from, to] of [
        ["2026-10-07", "2026-10-01"],
        ["2026-02-30", "2026-03-01"],
        ["x", "y"],
        ["", ""],
      ] as const) {
        await expect(
          plannerReadRollup(rt.db, {
            userId: rt.user.id,
            projectId: id,
            from,
            to,
          }),
          `${from}..${to}`,
        ).rejects.toBeInstanceOf(ValidationError);
      }
    });

    it("never counts another user's tasks or events", async () => {
      const { root } = await fixture();
      const their = await createTask(rt.db, rt.other, USER, {
        title: "theirs",
      });
      await plannerTestInsertEvent(rt.database, {
        userId: rt.other.id,
        taskId: their.id,
        type: "carried_over",
        occurredAt: "2026-10-03T00:00:00.000Z",
      });
      const rollup = await plannerReadRollup(rt.db, {
        userId: rt.user.id,
        projectId: root,
        from: FROM,
        to: TO,
      });
      expect(rollup.total).toEqual(counts(4, 3, 1, 2, 2));
      expect(
        await plannerTestRows(
          rt.database,
          "SELECT 1 FROM planner_task_event WHERE user_id = ?",
          rt.other.id,
        ),
      ).toHaveLength(1);
    });
  });
});
