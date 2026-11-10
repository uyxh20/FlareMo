import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createMemo, updateMemo } from "../memos-write";
import { listMemoRelations } from "../relations";
import type { TaskActor } from "../tasks";
import {
  PLANNER_AGENT_STALE,
  plannerAgentAcceptAction,
  plannerAgentRevertAction,
} from "./agent-apply";
import {
  plannerAgentAddChat,
  plannerAgentCreateRun,
  plannerAgentListActions,
} from "./agent-store";
import { plannerAgentCallTool } from "./agent-tools";
import { plannerReadBoard } from "./board";
import { plannerSyncHistory } from "./history-sync";
import { plannerReadTaskPlan } from "./plans";
import { plannerAddTask, plannerChangeTask } from "./task-change";
import {
  type PlannerTestRuntime,
  plannerTestRows,
  plannerTestRuntime,
} from "./test-support";

// The agent as a control panel (docs/fork-general-agent.md, "One card per
// answer" and "Undo"): every field of a task, a drop, a comment, an edit,
// archive or pin of a diary entry, each proposed and written only on accept;
// a change the record made after the proposal refuses the accept; and Undo
// puts back what any accepted proposal wrote, as new changes.

let rt: PlannerTestRuntime;
const NOW = new Date("2026-10-28T10:00:00.000Z");
const TODAY = "2026-10-28";
const USER: TaskActor = { type: "user" };
const CONVERSATION = "22222222-2222-4222-8222-222222222222";

const call = (name: string, args: unknown) =>
  plannerAgentCallTool({ db: rt.db, user: rt.user, now: NOW }, name, args);

async function asking() {
  return plannerAgentCreateRun(rt.db, {
    userId: rt.user.id,
    job: "ask",
    ownerKey: `ask:${CONVERSATION}`,
    budgetCents: 500,
    step: "ask",
    now: NOW,
  });
}

async function task(title: string) {
  const created = await plannerAddTask(rt.db, {
    user: rt.user,
    actor: USER,
    title,
    today: TODAY,
  });
  return created.task.id;
}

const actions = () =>
  plannerAgentListActions(rt.db, {
    userId: rt.user.id,
    conversationId: CONVERSATION,
    now: NOW,
  });

const accept = (id: string) =>
  plannerAgentAcceptAction(rt.db, { user: rt.user, id, today: TODAY });

const sync = () =>
  plannerSyncHistory(rt.db, { userId: rt.user.id, now: NOW, force: true });

const undo = async (id: string) => {
  await sync();
  return plannerAgentRevertAction(rt.db, {
    user: rt.user,
    actor: USER,
    id,
    today: TODAY,
  });
};

async function entry(content: string) {
  return createMemo(rt.db, rt.user, {
    content,
    visibility: "private",
    source: "web",
  });
}

const memoRow = async (id: string) =>
  (
    await plannerTestRows<{ content: string; status: string; pinned: number }>(
      rt.database,
      `SELECT content, status, pinned FROM memos WHERE id = '${id}'`,
    )
  )[0];

describe("the agent as a control panel", () => {
  beforeAll(async () => {
    rt = await plannerTestRuntime("planner-agent-control-test");
  });

  afterAll(async () => {
    await rt.dispose();
  });

  beforeEach(async () => {
    await rt.reset();
    await rt.database.batch(
      ["memos", "memo_tags", "memo_revisions", "embedding_tasks"].map((table) =>
        rt.database.prepare(`DELETE FROM ${table}`),
      ),
    );
  });

  it("records what a field held, with the task's title, and refuses a change to the same value", async () => {
    const id = await task("Call the landlord");
    await asking();
    await expect(
      call("propose_task_change", { task_id: id, priority: "none", why: "x" }),
    ).rejects.toThrow(/already holds that/);
    await call("propose_task_change", {
      task_id: id,
      due_at: "2026-11-07",
      why: "Friday, as asked.",
    });
    const [due] = await actions();
    expect(due?.change).toMatchObject({
      due_at: "2026-11-07",
      was: null,
      task_title: "Call the landlord",
    });
  });

  it("holds at most 25 proposals in one answer, and starts again at the next question", async () => {
    await asking();
    await plannerAgentAddChat(rt.db, {
      userId: rt.user.id,
      conversationId: CONVERSATION,
      role: "owner",
      text: "Tidy everything.",
      runId: null,
    });
    // The chat's messages carry the real clock, so these proposals do too.
    const live = (name: string, args: unknown) =>
      plannerAgentCallTool({ db: rt.db, user: rt.user }, name, args);
    for (let n = 0; n < 25; n++) {
      await live("propose_add_task", { title: `Task ${n}`, why: "Asked." });
    }
    await expect(
      live("propose_add_task", { title: "One more", why: "Asked." }),
    ).rejects.toThrow(/at most 25 proposals/);
    // A new question opens a new card.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await plannerAgentAddChat(rt.db, {
      userId: rt.user.id,
      conversationId: CONVERSATION,
      role: "owner",
      text: "And one more.",
      runId: null,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await live("propose_add_task", { title: "One more", why: "Asked." });
  });

  it("refuses an accept when the field changed after the proposal, and leaves it open", async () => {
    const id = await task("Call the landlord");
    await asking();
    await call("propose_task_change", {
      task_id: id,
      due_at: "2026-11-07",
      why: "Asked.",
    });
    const [due] = await actions();
    await plannerChangeTask(rt.db, {
      user: rt.user,
      actor: USER,
      taskId: id,
      today: TODAY,
      change: { dueAt: "2026-11-01" },
    });
    await expect(accept(due?.id ?? "")).rejects.toThrow(PLANNER_AGENT_STALE);
    const [after] = await actions();
    expect(after?.state).toBe("open");
  });

  it("undoes an accepted due date, column move and drop through the task's own History", async () => {
    const id = await task("Renew passport");
    await asking();
    await call("propose_task_change", {
      task_id: id,
      due_at: "2026-11-07",
      why: "Asked.",
    });
    await call("propose_task_change", {
      task_id: id,
      column: "todo",
      why: "Asked.",
    });
    const [due, move] = await actions();
    await accept(due?.id ?? "");
    await accept(move?.id ?? "");
    let now = await plannerReadTaskPlan(rt.db, { user: rt.user, taskId: id });
    expect(now.task.due_at).toBe("2026-11-07");
    expect(now.plan?.horizon).toBe("day");

    expect(await undo(move?.id ?? "")).toMatchObject({ state: "reverted" });
    expect(await undo(due?.id ?? "")).toMatchObject({ state: "reverted" });
    now = await plannerReadTaskPlan(rt.db, { user: rt.user, taskId: id });
    expect(now.task.due_at).toBeNull();
    expect(now.plan?.horizon ?? null).toBeNull();
    await expect(undo(due?.id ?? "")).rejects.toThrow(/Only an accepted/);

    await call("propose_task_change", {
      task_id: id,
      dropped: true,
      why: "Asked.",
    });
    const drop = (await actions()).find((action) => action.field === "dropped");
    await accept(drop?.id ?? "");
    now = await plannerReadTaskPlan(rt.db, { user: rt.user, taskId: id });
    expect(now.plan?.dropped_at).not.toBeNull();
    await undo(drop?.id ?? "");
    now = await plannerReadTaskPlan(rt.db, { user: rt.user, taskId: id });
    expect(now.plan?.dropped_at ?? null).toBeNull();
  });

  it("drops a new task on undo instead of deleting it, and refuses a goal that is not a weekly goal", async () => {
    await asking();
    await call("propose_add_task", { title: "Fix the bike", why: "Asked." });
    const [added] = await actions();
    const accepted = await accept(added?.id ?? "");
    await undo(accepted.id);
    const now = await plannerReadTaskPlan(rt.db, {
      user: rt.user,
      taskId: accepted.landed_id ?? "",
    });
    expect(now.task.title).toBe("Fix the bike");
    expect(now.plan?.dropped_at).not.toBeNull();

    const id = await task("Tax return");
    await expect(
      call("propose_task_change", {
        task_id: id,
        goal_id: "goal-nope",
        why: "x",
      }),
    ).rejects.toThrow(/no weekly goal/);
  });

  it("adds a comment on accept and removes it on undo", async () => {
    const id = await task("Tax return");
    await asking();
    await call("propose_task_comment", {
      task_id: id,
      body: "Receipts are in the blue folder.",
      why: "Asked.",
    });
    const [comment] = await actions();
    expect(comment?.change.task_title).toBe("Tax return");
    await accept(comment?.id ?? "");
    let detail = await plannerReadTaskPlan(rt.db, {
      user: rt.user,
      taskId: id,
    });
    const comments = () =>
      plannerTestRows<{ body: string }>(
        rt.database,
        `SELECT body FROM planner_task_comment WHERE task_id = '${id}' AND deleted_at IS NULL`,
      );
    expect(await comments()).toHaveLength(1);
    await undo(comment?.id ?? "");
    expect(await comments()).toHaveLength(0);
    detail = await plannerReadTaskPlan(rt.db, { user: rt.user, taskId: id });
    expect(detail.task.title).toBe("Tax return");
  });

  it("edits an entry on accept, keeps the old version, refuses a stale edit, and puts it back on undo", async () => {
    const memo = await entry("Went to the gym.\nFelt slow. #gym");
    await asking();
    await expect(
      call("propose_entry_edit", {
        entry_id: "memos/nope",
        content: "x",
        why: "x",
      }),
    ).rejects.toThrow(/No diary entry/);
    await call("propose_entry_edit", {
      entry_id: memo.id,
      content: "Went to the gym.\nFelt strong. #gym #crossfit",
      why: "Fix the word and add the tag, as asked.",
    });
    const [edit] = await actions();
    expect(edit).toMatchObject({ kind: "entry_edit", entry_id: memo.id });
    expect(edit?.change.was).toBe("Went to the gym.\nFelt slow. #gym");
    await accept(edit?.id ?? "");
    expect((await memoRow(memo.id))?.content).toBe(
      "Went to the gym.\nFelt strong. #gym #crossfit",
    );
    const revisions = await plannerTestRows<{ id: string }>(
      rt.database,
      `SELECT id FROM memo_revisions WHERE memo_id = '${memo.id}'`,
    );
    expect(revisions.length).toBeGreaterThan(0);
    await undo(edit?.id ?? "");
    expect((await memoRow(memo.id))?.content).toBe(
      "Went to the gym.\nFelt slow. #gym",
    );

    // An edit proposed against text that changed since is refused.
    await call("propose_entry_edit", {
      entry_id: memo.id,
      content: "Went to the gym. Great.",
      why: "Asked.",
    });
    const stale = (await actions()).find((action) => action.state === "open");
    await updateMemo(rt.db, rt.user, memo.id, { content: "Rewritten by me." });
    await expect(accept(stale?.id ?? "")).rejects.toThrow(PLANNER_AGENT_STALE);
  });

  it("archives and pins an entry on accept, and undoes each; never trashes", async () => {
    const memo = await entry("A night out. #out");
    await asking();
    await expect(
      call("propose_entry_state", {
        entry_id: memo.id,
        archived: true,
        pinned: true,
        why: "x",
      }),
    ).rejects.toThrow(/one per call/);
    await call("propose_entry_state", {
      entry_id: memo.id,
      archived: true,
      why: "Asked.",
    });
    await call("propose_entry_state", {
      entry_id: memo.id,
      pinned: true,
      why: "Asked.",
    });
    const [archive, pin] = await actions();
    expect(archive?.change.preview).toBe("A night out. #out");
    await accept(archive?.id ?? "");
    await accept(pin?.id ?? "");
    expect(await memoRow(memo.id)).toMatchObject({
      status: "archived",
      pinned: 1,
    });
    await undo(pin?.id ?? "");
    await undo(archive?.id ?? "");
    expect(await memoRow(memo.id)).toMatchObject({
      status: "normal",
      pinned: 0,
    });
  });

  it("archives an accepted new entry on undo", async () => {
    await asking();
    await call("propose_entry", { content: "Slept well.", why: "Asked." });
    const [made] = await actions();
    const accepted = await accept(made?.id ?? "");
    await undo(accepted.id);
    expect((await memoRow(accepted.landed_id ?? ""))?.status).toBe("archived");
  });

  it("places a task at an exact spot: records where it was, accepts, refuses when its rank moved, and undoes column and rank", async () => {
    const a = await task("Anchor A");
    const b = await task("Anchor B");
    const moved = await task("Mover");
    for (const id of [a, b, moved]) {
      await plannerChangeTask(rt.db, {
        user: rt.user,
        actor: USER,
        taskId: id,
        today: TODAY,
        change: { column: "todo" },
      });
    }
    // Pin an order: A, B, Mover.
    await plannerChangeTask(rt.db, {
      user: rt.user,
      actor: USER,
      taskId: b,
      today: TODAY,
      change: { column: "todo", afterId: a },
    });
    await plannerChangeTask(rt.db, {
      user: rt.user,
      actor: USER,
      taskId: moved,
      today: TODAY,
      change: { column: "todo", afterId: b },
    });
    const order = async (column: "todo" | "doing") =>
      (
        await plannerReadBoard(rt.db, {
          userId: rt.user.id,
          today: TODAY,
          doneDays: 14,
        })
      ).columns[column].map((card) => card.title);
    expect(await order("todo")).toEqual(["Anchor A", "Anchor B", "Mover"]);
    const rankOf = async (id: string) =>
      (await plannerReadTaskPlan(rt.db, { user: rt.user, taskId: id })).plan
        ?.board_rank;
    const oldRank = await rankOf(moved);

    await asking();
    await expect(
      call("propose_task_change", {
        task_id: moved,
        column: "todo",
        after_id: b,
        why: "x",
      }),
    ).rejects.toThrow(/already at that spot/);
    await expect(
      call("propose_task_change", {
        task_id: moved,
        column: "doing",
        before_id: a,
        why: "x",
      }),
    ).rejects.toThrow(/not on the board in doing/);
    await call("propose_task_change", {
      task_id: moved,
      column: "todo",
      before_id: a,
      why: "Top of the list, as asked.",
    });
    const [place] = await actions();
    expect(place).toMatchObject({ kind: "task_change", field: "place" });
    expect(place?.change).toMatchObject({
      column: "todo",
      before_id: a,
      was: { column: "todo", board_rank: oldRank },
      task_title: "Mover",
      anchor_title: "Anchor A",
    });

    await accept(place?.id ?? "");
    expect(await order("todo")).toEqual(["Mover", "Anchor A", "Anchor B"]);
    await undo(place?.id ?? "");
    expect(await order("todo")).toEqual(["Anchor A", "Anchor B", "Mover"]);
    expect(await rankOf(moved)).toBe(oldRank);

    // A rank that moved after the proposal refuses the accept.
    await call("propose_task_change", {
      task_id: moved,
      column: "todo",
      before_id: b,
      why: "Asked.",
    });
    const stale = (await actions()).find((action) => action.state === "open");
    await plannerChangeTask(rt.db, {
      user: rt.user,
      actor: USER,
      taskId: moved,
      today: TODAY,
      change: { column: "todo", beforeId: a },
    });
    await expect(accept(stale?.id ?? "")).rejects.toThrow(PLANNER_AGENT_STALE);

    // Across columns: the column move is logged and Undo puts column and rank back.
    const doing = await task("In doing");
    await plannerChangeTask(rt.db, {
      user: rt.user,
      actor: USER,
      taskId: doing,
      today: TODAY,
      change: { column: "doing" },
    });
    const beforeColumn = await rankOf(a);
    await call("propose_task_change", {
      task_id: a,
      column: "doing",
      before_id: doing,
      why: "Start it.",
    });
    const cross = (await actions()).find(
      (action) => action.state === "open" && action.task_id === a,
    );
    await accept(cross?.id ?? "");
    expect(await order("doing")).toEqual(["Anchor A", "In doing"]);
    await undo(cross?.id ?? "");
    expect(await order("doing")).toEqual(["In doing"]);
    expect(await rankOf(a)).toBe(beforeColumn);
    expect(await order("todo")).toContain("Anchor A");
  });

  it("links two entries on accept, refuses a duplicate and a stale link, and undoes just that link", async () => {
    const one = await entry("Slept badly. #sleep");
    const two = await entry("Skipped the gym. #gym");
    const three = await entry("Called mum.");
    const refs = async (id: string) =>
      (await listMemoRelations(rt.db, rt.user, id))
        .filter((row) => row.type === "reference")
        .map((row) => row.relatedMemoId)
        .sort();
    await asking();
    await expect(
      call("propose_entry_link", {
        entry_id: one.id,
        related_entry_id: one.id,
        why: "x",
      }),
    ).rejects.toThrow(/itself/);
    await expect(
      call("propose_entry_link", {
        entry_id: one.id,
        related_entry_id: two.id,
        remove: true,
        why: "x",
      }),
    ).rejects.toThrow(/not linked/);
    await call("propose_entry_link", {
      entry_id: one.id,
      related_entry_id: two.id,
      why: "Both about the bad week.",
    });
    const [link] = await actions();
    expect(link).toMatchObject({ kind: "entry_link" });
    expect(link?.change).toMatchObject({
      entry_id: one.id,
      related_entry_id: two.id,
      was: [],
    });
    await accept(link?.id ?? "");
    expect(await refs(one.id)).toEqual([two.id]);
    await expect(
      call("propose_entry_link", {
        entry_id: one.id,
        related_entry_id: two.id,
        why: "x",
      }),
    ).rejects.toThrow(/already linked/);

    // A later link stays when this one is undone.
    await call("propose_entry_link", {
      entry_id: one.id,
      related_entry_id: three.id,
      why: "Asked.",
    });
    const second = (await actions()).find((action) => action.state === "open");
    await accept(second?.id ?? "");
    expect(await refs(one.id)).toEqual([two.id, three.id].sort());
    await undo(link?.id ?? "");
    expect(await refs(one.id)).toEqual([three.id]);

    // Unlinking: proposed from the current set, stale when the set changes.
    await call("propose_entry_link", {
      entry_id: one.id,
      related_entry_id: three.id,
      remove: true,
      why: "Asked.",
    });
    const unlink = (await actions()).find((action) => action.state === "open");
    await call("propose_entry_link", {
      entry_id: one.id,
      related_entry_id: two.id,
      why: "Asked.",
    });
    const add = (await actions()).find(
      (action) => action.state === "open" && action.id !== unlink?.id,
    );
    await accept(add?.id ?? "");
    await expect(accept(unlink?.id ?? "")).rejects.toThrow(PLANNER_AGENT_STALE);
    await undo(add?.id ?? "");
  });
});
