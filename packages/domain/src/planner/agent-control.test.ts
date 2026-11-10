import { plannerAgentEditBaseline } from "@flaremo/contracts";
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
  plannerAgentAddAction,
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

const accept = (id: string, edit?: unknown) =>
  plannerAgentAcceptAction(rt.db, { user: rt.user, id, today: TODAY, edit });

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

  it("flags an entry, writes the owner's own text on accept, refuses a stale one, and puts it back on undo", async () => {
    const memo = await entry("Went to the gym on Tuesday.\nFelt slow. #gym");
    await asking();
    await expect(
      call("propose_entry_edit", {
        entry_id: "memos/nope",
        flag: "x",
        why: "x",
      }),
    ).rejects.toThrow(/No diary entry/);
    // The agent writes no text any more.
    await expect(
      call("propose_entry_edit", {
        entry_id: memo.id,
        content: "Went to the gym on Monday.",
        why: "x",
      }),
    ).rejects.toThrow(/flag|Unrecognized key/);
    // A quote must be the entry's own words, word for word.
    await expect(
      call("propose_entry_edit", {
        entry_id: memo.id,
        flag: "Says Tuesday, but the gym was Monday",
        quote: "Went to the gym on Wednesday",
        why: "x",
      }),
    ).rejects.toThrow(/not found word for word/);
    await call("propose_entry_edit", {
      entry_id: memo.id,
      flag: "Says Tuesday, but the gym was Monday",
      quote: "Went to the gym on Tuesday",
      why: "The owner asked me to check the gym days.",
    });
    const [flag] = await actions();
    expect(flag).toMatchObject({ kind: "entry_edit", entry_id: memo.id });
    expect(flag?.change).toMatchObject({
      flag: "Says Tuesday, but the gym was Monday",
      quote: "Went to the gym on Tuesday",
      was: "Went to the gym on Tuesday.\nFelt slow. #gym",
    });
    expect(flag?.change.content).toBeUndefined();

    // Accept needs the owner's text, and a text that changes something.
    await expect(accept(flag?.id ?? "")).rejects.toThrow(/Rewrite the entry/);
    await expect(
      accept(flag?.id ?? "", {
        text: "Went to the gym on Tuesday.\nFelt slow. #gym",
      }),
    ).rejects.toThrow(/Rewrite the entry/);
    expect((await actions())[0]?.state).toBe("open");
    const accepted = await accept(flag?.id ?? "", {
      text: "Went to the gym on Monday.\nFelt slow. #gym",
    });
    expect(accepted.change).toMatchObject({
      content: "Went to the gym on Monday.\nFelt slow. #gym",
      edited: { text: "Went to the gym on Monday.\nFelt slow. #gym" },
    });
    expect((await memoRow(memo.id))?.content).toBe(
      "Went to the gym on Monday.\nFelt slow. #gym",
    );
    const revisions = await plannerTestRows<{ id: string }>(
      rt.database,
      `SELECT id FROM memo_revisions WHERE memo_id = '${memo.id}'`,
    );
    expect(revisions.length).toBeGreaterThan(0);
    // The learning log: the owner wrote the words, by field name only.
    const log = await plannerTestRows<{ kind: string; data: string }>(
      rt.database,
      "SELECT kind, data FROM planner_event WHERE kind = 'proposal.accepted_edited'",
    );
    expect(log).toHaveLength(1);
    expect(JSON.parse(log[0]?.data ?? "{}")).toMatchObject({
      action_kind: "entry_edit",
      fields: "text",
    });
    expect(log[0]?.data).not.toContain("gym");
    await undo(flag?.id ?? "");
    expect((await memoRow(memo.id))?.content).toBe(
      "Went to the gym on Tuesday.\nFelt slow. #gym",
    );

    // A flag on text that changed since refuses the owner's rewrite.
    await call("propose_entry_edit", {
      entry_id: memo.id,
      flag: "Felt slow, but the log says a PR",
      why: "Asked.",
    });
    const stale = (await actions()).find((action) => action.state === "open");
    await updateMemo(rt.db, rt.user, memo.id, { content: "Rewritten by me." });
    await expect(
      accept(stale?.id ?? "", { text: "Went to the gym. Great." }),
    ).rejects.toThrow(PLANNER_AGENT_STALE);
    expect((await memoRow(memo.id))?.content).toBe("Rewritten by me.");
  });

  it("an open entry edit from before the flags is accepted only with the owner's text, never the agent's", async () => {
    const memo = await entry("Slept badly. #sleep");
    const run = await asking();
    // A row as the old tool filed it: the agent's whole new text in `content`.
    await plannerAgentAddAction(rt.db, {
      userId: rt.user.id,
      runId: run.id,
      conversationId: CONVERSATION,
      kind: "entry_edit",
      taskId: null,
      field: null,
      change: {
        entry_id: memo.id,
        content: "The agent's own rewrite. #sleep",
        was: "Slept badly. #sleep",
      },
      why: "Old row.",
      now: NOW,
    });
    const [old] = await actions();
    await expect(accept(old?.id ?? "")).rejects.toThrow(/Rewrite the entry/);
    expect((await memoRow(memo.id))?.content).toBe("Slept badly. #sleep");
    // The card starts from the entry's own text, not the agent's.
    expect(
      plannerAgentEditBaseline(
        { kind: "entry_edit", field: null, change: old?.change ?? {} },
        "text",
      ),
    ).toBe("Slept badly. #sleep");
    await accept(old?.id ?? "", { text: "Slept badly, woke at 4. #sleep" });
    expect((await memoRow(memo.id))?.content).toBe(
      "Slept badly, woke at 4. #sleep",
    );
    await undo(old?.id ?? "");
    expect((await memoRow(memo.id))?.content).toBe("Slept badly. #sleep");
  });

  it("adds and removes #tags as values, and Undo puts the entry back", async () => {
    const memo = await entry("Long run by the lake.\n#run #outside");
    await asking();
    await expect(
      call("propose_entry_tags", { entry_id: memo.id, why: "x" }),
    ).rejects.toThrow(/at least one tag/);
    await expect(
      call("propose_entry_tags", {
        entry_id: memo.id,
        add: ["run"],
        why: "x",
      }),
    ).rejects.toThrow(/already has #run/);
    await expect(
      call("propose_entry_tags", {
        entry_id: memo.id,
        remove: ["gym"],
        why: "x",
      }),
    ).rejects.toThrow(/has no #gym/);
    await expect(
      call("propose_entry_tags", {
        entry_id: memo.id,
        add: ["not a tag"],
        why: "x",
      }),
    ).rejects.toThrow(/tag/);
    await call("propose_entry_tags", {
      entry_id: memo.id,
      add: ["#Health/cardio"],
      remove: ["outside"],
      why: "Asked to retag.",
    });
    const [tags] = await actions();
    expect(tags?.change).toMatchObject({
      tags: { add: ["health/cardio"], remove: ["outside"] },
      content: "Long run by the lake.\n#run #health/cardio",
    });
    // A tag change is a value: no words to write, and no edit taken.
    await expect(accept(tags?.id ?? "", { text: "x" })).rejects.toThrow(
      /cannot be changed/,
    );
    await accept(tags?.id ?? "");
    expect((await memoRow(memo.id))?.content).toBe(
      "Long run by the lake.\n#run #health/cardio",
    );
    await undo(tags?.id ?? "");
    expect((await memoRow(memo.id))?.content).toBe(
      "Long run by the lake.\n#run #outside",
    );
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

  it("undoes a place that re-spread a column nobody had ranked: every card's rank is null again", async () => {
    const a = await task("First");
    const b = await task("Second");
    const c = await task("Third");
    for (const id of [a, b, c]) {
      await plannerChangeTask(rt.db, {
        user: rt.user,
        actor: USER,
        taskId: id,
        today: TODAY,
        change: { column: "todo" },
      });
    }
    const board = async () =>
      (
        await plannerReadBoard(rt.db, {
          userId: rt.user.id,
          today: TODAY,
          doneDays: 14,
        })
      ).columns.todo;
    const original = (await board()).map((card) => card.title);
    expect((await board()).every((card) => card.board_rank === null)).toBe(
      true,
    );
    const last = (await board()).at(-1)?.id ?? "";
    // Between the first and second card: the card above has no key, so it re-spreads.
    const second = (await board())[1]?.id ?? "";

    await asking();
    await call("propose_task_change", {
      task_id: last,
      column: "todo",
      before_id: second,
      why: "Second place.",
    });
    const [place] = await actions();
    await accept(place?.id ?? "");
    const moved = await board();
    expect(moved[1]?.id).toBe(last);
    expect(moved.every((card) => card.board_rank !== null)).toBe(true);

    await undo(place?.id ?? "");
    const restored = await board();
    expect(restored.map((card) => card.title)).toEqual(original);
    expect(restored.every((card) => card.board_rank === null)).toBe(true);
    const stored = await plannerTestRows<{ board_rank: string | null }>(
      rt.database,
      "SELECT board_rank FROM planner_task_plan",
    );
    expect(stored.every((row) => row.board_rank === null)).toBe(true);
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
