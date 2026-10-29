import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ValidationError } from "../errors";
import { type TaskActor, updateTask } from "../tasks";
import { plannerAgentAcceptAction } from "./agent-apply";
import {
  plannerAgentActionsToday,
  plannerAgentAddAction,
  plannerAgentCreateRun,
  plannerAgentExpireActions,
  plannerAgentListActions,
  plannerAgentSettleAction,
  plannerAgentStepDone,
} from "./agent-store";
import { PlannerAgentToolError, plannerAgentCallTool } from "./agent-tools";
import { plannerAddComment } from "./comments";
import { plannerReadTaskHistory } from "./history-read";
import { plannerRevertEvent } from "./history-revert";
import { plannerSyncHistory } from "./history-sync";
import { plannerReadTaskPlan, plannerSetEffort } from "./plans";
import { plannerAddTask, plannerChangeTask } from "./task-change";
import {
  type PlannerTestRuntime,
  plannerTestRows,
  plannerTestRuntime,
} from "./test-support";

// The agent proposing into tasks and the diary (agent-tools.ts, agent-store.ts,
// agent-apply.ts; migration 9015) and the owner reverting History lines
// (history-revert.ts). The tools file their proposals only while an Ask chat
// is answering; the accept is the write, as the proposal; a revert is a new
// change that names the line put back, and the archive only grows.

let rt: PlannerTestRuntime;
const NOW = new Date("2026-10-28T10:00:00.000Z");
const TODAY = "2026-10-28";
const USER: TaskActor = { type: "user" };

const call = (name: string, args: unknown) =>
  plannerAgentCallTool({ db: rt.db, user: rt.user, now: NOW }, name, args);

/** An Ask chat whose last question is being answered, as the Worker records it. */
async function asking(conversation = "11111111-1111-4111-8111-111111111111") {
  return plannerAgentCreateRun(rt.db, {
    userId: rt.user.id,
    job: "ask",
    ownerKey: `ask:${conversation}`,
    budgetCents: 500,
    step: "ask",
    now: NOW,
  });
}

async function task(title: string, notes?: string) {
  const created = await plannerAddTask(rt.db, {
    user: rt.user,
    actor: USER,
    title,
    notes,
    today: TODAY,
  });
  return created.task.id;
}

/** The task's archive, synced first as the routes do before a History read. */
const events = async (taskId: string) => {
  await plannerSyncHistory(rt.db, {
    userId: rt.user.id,
    now: NOW,
    force: true,
  });
  return plannerReadTaskHistory(rt.db, { userId: rt.user.id, taskId });
};

describe("the agent's proposed actions", () => {
  beforeAll(async () => {
    rt = await plannerTestRuntime("planner-agent-actions-test");
  });

  afterAll(async () => {
    await rt.dispose();
  });

  beforeEach(async () => {
    await rt.reset();
    await rt.database.batch(
      ["memos", "memo_tags", "embedding_tasks"].map((table) =>
        rt.database.prepare(`DELETE FROM ${table}`),
      ),
    );
  });

  it("reads one task whole, and refuses an id that is not the owner's", async () => {
    const id = await task("Write the guide", "Four parts.");
    await plannerAddComment(rt.db, {
      user: rt.user,
      actor: USER,
      taskId: id,
      body: "Start with the first week.",
    });
    const text = await call("read_task", { task_id: id });
    expect(text).toContain("Title: Write the guide");
    expect(text).toContain("Column: Backlog");
    expect(text).toContain("Four parts.");
    expect(text).toContain("Start with the first week.");
    expect(text).toContain("created");
    await expect(call("read_task", { task_id: "tasks/nope" })).rejects.toThrow(
      "No task has that id",
    );
  });

  it("files a task change only in an Ask chat, one field per call, under that chat", async () => {
    const id = await task("Write the guide");
    const change = {
      task_id: id,
      notes: "1. Outline\n2. Draft",
      why: "The diary names four parts.",
    };
    await expect(call("propose_task_change", change)).rejects.toThrow(
      "Actions are proposed only in an Ask chat.",
    );
    const run = await asking();
    await expect(
      call("propose_task_change", { ...change, due_at: "2026-11-07" }),
    ).rejects.toThrow(/exactly one field/);
    await expect(
      call("propose_task_change", { task_id: id, why: "x" }),
    ).rejects.toThrow(/exactly one field/);
    await expect(
      call("propose_task_change", { ...change, task_id: "tasks/nope" }),
    ).rejects.toThrow("No task has that id");
    expect(await call("propose_task_change", change)).toContain(
      "Proposed notes change",
    );
    // The same proposal again is not filed twice.
    await call("propose_task_change", change);
    const listed = await plannerAgentListActions(rt.db, {
      userId: rt.user.id,
      conversationId: "11111111-1111-4111-8111-111111111111",
      now: NOW,
    });
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      kind: "task_change",
      task_id: id,
      field: "notes",
      change: { notes: "1. Outline\n2. Draft" },
      state: "open",
    });
    // Once the chat's answer is in, the tools refuse again.
    await plannerAgentStepDone(rt.db, { runId: run.id });
    await expect(
      call("propose_add_task", { title: "Call the bank", why: "Asked." }),
    ).rejects.toThrow(PlannerAgentToolError);
  });

  it("stops at thirty proposals a day", async () => {
    await asking();
    for (let n = 0; n < 30; n++) {
      await call("propose_add_task", { title: `Task ${n}`, why: "Asked." });
    }
    expect(
      await plannerAgentActionsToday(rt.db, { userId: rt.user.id, now: NOW }),
    ).toBe(30);
    await expect(
      call("propose_entry", { content: "One more.", why: "Asked." }),
    ).rejects.toThrow(/30 proposals are used up/);
  });

  it("writes an accepted task change as the proposal, and a dismissed one not at all", async () => {
    const id = await task("Write the guide");
    await asking();
    await call("propose_task_change", {
      task_id: id,
      notes: "Four parts, one page.",
      why: "Asked.",
    });
    await call("propose_task_change", {
      task_id: id,
      due_at: "2026-11-07",
      why: "A week of buffer.",
    });
    const [notes, due] = await plannerAgentListActions(rt.db, {
      userId: rt.user.id,
      conversationId: "11111111-1111-4111-8111-111111111111",
      now: NOW,
    });
    const accepted = await plannerAgentAcceptAction(rt.db, {
      user: rt.user,
      id: notes?.id ?? "",
      today: TODAY,
      now: NOW,
    });
    expect(accepted).toMatchObject({ state: "accepted", landed_id: id });
    const after = await plannerReadTaskPlan(rt.db, {
      user: rt.user,
      taskId: id,
    });
    expect(after.task.notes).toBe("Four parts, one page.");
    // The archive names the proposal; the field reads as the owner's.
    const [edit] = (await events(id)).filter((e) => e.type === "updated");
    expect(edit).toMatchObject({
      actor_type: "agent",
      actor_name: `proposal:${notes?.id}`,
      data: { notes: "Four parts, one page." },
    });
    // Accepting twice writes once.
    await expect(
      plannerAgentAcceptAction(rt.db, {
        user: rt.user,
        id: notes?.id ?? "",
        today: TODAY,
      }),
    ).rejects.toThrow(ValidationError);
    expect(
      await plannerAgentSettleAction(rt.db, {
        userId: rt.user.id,
        id: due?.id ?? "",
        state: "dismissed",
      }),
    ).toMatchObject({ state: "dismissed" });
    expect(after.task.due_at).toBeNull();
    // Another member cannot settle it.
    await expect(
      plannerAgentAcceptAction(rt.db, {
        user: rt.other,
        id: due?.id ?? "",
        today: TODAY,
      }),
    ).rejects.toThrow("Proposal not found.");
  });

  it("adds an accepted task and saves an accepted entry as a memo of the agent's drafting", async () => {
    await asking();
    await call("propose_add_task", {
      title: "Call the bank",
      due_at: "2026-11-02",
      column: "todo",
      why: "Asked.",
    });
    await call("propose_entry", {
      content: "Spoke to the bank today. #admin",
      why: "Asked for a note.",
    });
    const [newTask, entry] = await plannerAgentListActions(rt.db, {
      userId: rt.user.id,
      conversationId: "11111111-1111-4111-8111-111111111111",
      now: NOW,
    });
    const added = await plannerAgentAcceptAction(rt.db, {
      user: rt.user,
      id: newTask?.id ?? "",
      today: TODAY,
    });
    const landed = await plannerReadTaskPlan(rt.db, {
      user: rt.user,
      taskId: added.landed_id ?? "",
    });
    expect(landed.task).toMatchObject({
      title: "Call the bank",
      due_at: "2026-11-02",
    });
    expect(landed.plan?.horizon).toBe("day");
    const saved = await plannerAgentAcceptAction(rt.db, {
      user: rt.user,
      id: entry?.id ?? "",
      today: TODAY,
    });
    const memos = await plannerTestRows<{
      id: string;
      content: string;
      source: string;
      user_id: string;
    }>(rt.database, "SELECT id, content, source, user_id FROM memos");
    expect(memos).toEqual([
      {
        id: saved.landed_id,
        content: "Spoke to the bank today. #admin",
        source: "agent-draft",
        user_id: rt.user.id,
      },
    ]);
  });

  it("expires open proposals after seven days, and lists them no more", async () => {
    await asking();
    await call("propose_add_task", { title: "Old", why: "Asked." });
    const later = new Date(NOW.getTime() + 8 * 86_400_000);
    expect(
      await plannerAgentListActions(rt.db, {
        userId: rt.user.id,
        conversationId: "11111111-1111-4111-8111-111111111111",
        now: later,
      }),
    ).toEqual([]);
    expect(await plannerAgentExpireActions(rt.db, later)).toBe(1);
    expect(await plannerAgentExpireActions(rt.db, later)).toBe(0);
  });
});

describe("reverting a History line", () => {
  beforeAll(async () => {
    rt = await plannerTestRuntime("planner-history-revert-test");
  });

  afterAll(async () => {
    await rt.dispose();
  });

  beforeEach(async () => {
    await rt.reset();
  });

  const revert = (taskId: string, eventId: number) =>
    plannerRevertEvent(rt.db, {
      user: rt.user,
      actor: USER,
      taskId,
      eventId,
      today: TODAY,
      now: NOW,
    });

  const latest = async (taskId: string, type: string) => {
    const found = (await events(taskId)).find((e) => e.type === type);
    if (!found) throw new Error(`no ${type} event`);
    return found;
  };

  it("puts back an effort, a plan, a drop and a comment, and records the revert", async () => {
    const id = await task("Write the guide");
    await plannerSetEffort(rt.db, {
      user: rt.user,
      actor: USER,
      taskId: id,
      effort: 2,
    });
    await plannerSetEffort(rt.db, {
      user: rt.user,
      actor: USER,
      taskId: id,
      effort: 5,
    });
    const effort = await latest(id, "effort_changed");
    expect((await revert(id, effort.id)).plan?.effort).toBe(2);
    expect((await latest(id, "reverted")).data).toEqual({
      event_id: effort.id,
      type: "effort_changed",
    });

    await plannerChangeTask(rt.db, {
      user: rt.user,
      actor: USER,
      taskId: id,
      today: TODAY,
      change: { column: "todo" },
    });
    const planned = await latest(id, "planned");
    expect((await revert(id, planned.id)).plan?.horizon).toBeNull();

    await plannerChangeTask(rt.db, {
      user: rt.user,
      actor: USER,
      taskId: id,
      today: TODAY,
      change: { dropped: true },
    });
    const dropped = await latest(id, "dropped");
    expect((await revert(id, dropped.id)).plan?.dropped_at).toBeNull();

    const comment = await plannerAddComment(rt.db, {
      user: rt.user,
      actor: USER,
      taskId: id,
      body: "A thought.",
    });
    const commented = await latest(id, "commented");
    await revert(id, commented.id);
    const live = await plannerTestRows<{ deleted_at: string | null }>(
      rt.database,
      "SELECT deleted_at FROM planner_task_comment WHERE id = ?",
      comment.id,
    );
    expect(live[0]?.deleted_at).not.toBeNull();
    // The archive only grew.
    const all = await events(id);
    expect(all.filter((e) => e.type === "reverted")).toHaveLength(4);
  });

  it("puts back a status and an upstream edit from what the archive holds", async () => {
    const id = await task("First title", "Draft notes");
    // Notes written at creation are not in upstream's log; this edit is.
    await updateTask(rt.db, rt.user, USER, id, { notes: "First notes" });
    await updateTask(rt.db, rt.user, USER, id, { status: "in_progress" });
    await updateTask(rt.db, rt.user, USER, id, { status: "done" });
    const done = await latest(id, "status_changed");
    expect((await revert(id, done.id)).task.status).toBe("in_progress");

    await updateTask(rt.db, rt.user, USER, id, {
      title: "Second title",
      notes: "Second notes",
    });
    const edit = await latest(id, "updated");
    const back = await revert(id, edit.id);
    // The title and notes come from the earlier events (created, updated).
    expect(back.task).toMatchObject({
      title: "First title",
      notes: "First notes",
    });
    // A due date set for the first time: what it was before (set at creation,
    // or never) is not in upstream's log, so the archive cannot put it back.
    await updateTask(rt.db, rt.user, USER, id, { due_at: "2026-11-01" });
    const due = await latest(id, "updated");
    await expect(revert(id, due.id)).rejects.toThrow("not in the archive");
  });

  it("refuses what the archive cannot put back, and marks an agent-drafted change reverted", async () => {
    const id = await task("Write the guide");
    const created = await latest(id, "created");
    await expect(revert(id, created.id)).rejects.toThrow(ValidationError);
    await expect(revert(id, 999_999)).rejects.toThrow(
      "History event not found.",
    );

    const run = await plannerAgentCreateRun(rt.db, {
      userId: rt.user.id,
      job: "ask",
      ownerKey: "ask:x",
      budgetCents: 500,
      step: "ask",
      now: NOW,
    });
    const action = await plannerAgentAddAction(rt.db, {
      userId: rt.user.id,
      runId: run.id,
      conversationId: "x",
      kind: "task_change",
      taskId: id,
      field: "notes",
      change: { notes: "Agent's notes" },
      why: "Asked.",
      now: NOW,
    });
    await plannerAgentAcceptAction(rt.db, {
      user: rt.user,
      id: action.id,
      today: TODAY,
    });
    const edit = await latest(id, "updated");
    expect(edit.actor_name).toBe(`proposal:${action.id}`);
    expect((await revert(id, edit.id)).task.notes).toBeNull();
    const rows = await plannerTestRows<{ state: string }>(
      rt.database,
      "SELECT state FROM planner_agent_action WHERE id = ?",
      action.id,
    );
    expect(rows[0]?.state).toBe("reverted");
  });
});
