import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { TaskActor } from "../tasks";
import {
  PLANNER_AGENT_STALE,
  plannerAgentAcceptAction,
  plannerAgentRevertAction,
} from "./agent-apply";
import { plannerAgentCreateRun, plannerAgentListActions } from "./agent-store";
import { plannerAgentCallTool } from "./agent-tools";
import { plannerReadBoard } from "./board";
import { plannerFlywheelRollup } from "./flywheel";
import { plannerCreateGoal } from "./goals";
import { plannerSyncHistory } from "./history-sync";
import { plannerReadTaskPlan } from "./plans";
import { plannerAddTask, plannerChangeTask } from "./task-change";
import {
  type PlannerTestRuntime,
  plannerTestRows,
  plannerTestRuntime,
} from "./test-support";

// Edit before Accept (docs/fork-general-agent.md): the owner changes the values
// on a card, the accept writes their version over the proposal, the stale check
// still reads the agent's `was`, Undo puts back what was really written, and the
// learning log keeps the agent's values beside the owner's.

let rt: PlannerTestRuntime;
const NOW = new Date("2026-10-28T10:00:00.000Z");
const TODAY = "2026-10-28";
const WEEK = "2026-10-26";
const USER: TaskActor = { type: "user" };
const CONVERSATION = "55555555-5555-4555-8555-555555555555";

const call = (name: string, args: unknown) =>
  plannerAgentCallTool({ db: rt.db, user: rt.user, now: NOW }, name, args);

const actions = () =>
  plannerAgentListActions(rt.db, {
    userId: rt.user.id,
    conversationId: CONVERSATION,
    now: NOW,
  });

const accept = (id: string, edit?: unknown) =>
  plannerAgentAcceptAction(rt.db, {
    user: rt.user,
    id,
    today: TODAY,
    edit,
    now: NOW,
  });

const undo = async (id: string) => {
  await plannerSyncHistory(rt.db, {
    userId: rt.user.id,
    now: NOW,
    force: true,
  });
  return plannerAgentRevertAction(rt.db, {
    user: rt.user,
    actor: USER,
    id,
    today: TODAY,
  });
};

async function task(title: string) {
  return (
    await plannerAddTask(rt.db, {
      user: rt.user,
      actor: USER,
      title,
      today: TODAY,
    })
  ).task.id;
}

const weekGoal = (title: string) =>
  plannerCreateGoal(rt.db, {
    userId: rt.user.id,
    now: NOW,
    goal: {
      level: "week",
      periodStart: WEEK,
      pillar: "work",
      title,
      lines: [],
    },
  });

const healthRow = async (id: string) =>
  (
    await plannerTestRows<{
      kind: string;
      variant: string | null;
      minutes: number | null;
      deleted_at: string | null;
      dismissed: number;
    }>(
      rt.database,
      `SELECT kind, variant, minutes, deleted_at, dismissed FROM health_entry WHERE id = '${id}'`,
    )
  )[0];

describe("editing a card before Accept", () => {
  beforeAll(async () => {
    rt = await plannerTestRuntime("planner-agent-edit-test");
  });

  afterAll(async () => {
    await rt.dispose();
  });

  beforeEach(async () => {
    await rt.reset();
    await rt.database.batch(
      [
        "memos",
        "memo_tags",
        "memo_revisions",
        "embedding_tasks",
        "health_entry_event",
        "health_entry",
      ].map((table) => rt.database.prepare(`DELETE FROM ${table}`)),
    );
    await plannerAgentCreateRun(rt.db, {
      userId: rt.user.id,
      job: "ask",
      ownerKey: `ask:${CONVERSATION}`,
      budgetCents: 500,
      step: "ask",
      now: NOW,
    });
  });

  it("writes a new task as the owner edited it, keeps both versions, and drops it on Undo", async () => {
    const goal = await weekGoal("Ship the invoice flow");
    await call("propose_add_task", {
      title: "Call the bank",
      column: "backlog",
      due_at: "2026-11-05",
      why: "You said so on Sunday.",
    });
    const [proposal] = await actions();
    const accepted = await accept(proposal?.id ?? "", {
      title: "Call the bank about the card",
      column: "todo",
      due_at: "2026-11-06",
      goal_id: goal.id,
    });
    expect(accepted.state).toBe("accepted");
    const made = await plannerReadTaskPlan(rt.db, {
      user: rt.user,
      taskId: accepted.landed_id ?? "",
    });
    expect(made.task.title).toBe("Call the bank about the card");
    expect(made.task.due_at).toBe("2026-11-06");
    expect(made.plan?.horizon).toBe("day");
    expect(made.plan?.goal_id).toBe(goal.id);
    expect(accepted.change).toMatchObject({
      title: "Call the bank about the card",
      goal_id: goal.id,
      goal_title: "Ship the invoice flow",
      proposed: {
        title: "Call the bank",
        column: "backlog",
        due_at: "2026-11-05",
        goal_id: null,
      },
      edited: {
        title: "Call the bank about the card",
        column: "todo",
        due_at: "2026-11-06",
        goal_id: goal.id,
      },
    });

    expect(await undo(proposal?.id ?? "")).toMatchObject({ state: "reverted" });
    const back = await plannerReadTaskPlan(rt.db, {
      user: rt.user,
      taskId: accepted.landed_id ?? "",
    });
    expect(back.plan?.dropped_at).not.toBeNull();
  });

  it("can clear a new task's due day and goal, and an edit equal to the proposal is no edit", async () => {
    await call("propose_add_task", {
      title: "Plain",
      due_at: "2026-11-05",
      why: "x",
    });
    const [plain] = await actions();
    const same = await accept(plain?.id ?? "", {
      title: "Plain",
      column: "backlog",
      due_at: "2026-11-05",
    });
    expect(same.change.edited).toBeUndefined();
    expect(same.change.proposed).toBeUndefined();

    await call("propose_add_task", {
      title: "Dated",
      due_at: "2026-11-05",
      why: "x",
    });
    const dated = (await actions()).find((a) => a.change.title === "Dated");
    const cleared = await accept(dated?.id ?? "", { due_at: null });
    const made = await plannerReadTaskPlan(rt.db, {
      user: rt.user,
      taskId: cleared.landed_id ?? "",
    });
    expect(made.task.due_at).toBeNull();
    expect(cleared.change.edited).toEqual({ due_at: null });
  });

  it("writes an edited due date for a task change, and Undo restores what the field held", async () => {
    const id = await task("Renew passport");
    await call("propose_task_change", {
      task_id: id,
      due_at: "2026-11-07",
      why: "Friday, as asked.",
    });
    const [proposal] = await actions();
    await accept(proposal?.id ?? "", { due_at: "2026-11-09" });
    let now = await plannerReadTaskPlan(rt.db, { user: rt.user, taskId: id });
    expect(now.task.due_at).toBe("2026-11-09");
    const [row] = await actions();
    expect(row?.change).toMatchObject({
      due_at: "2026-11-09",
      was: null,
      proposed: { due_at: "2026-11-07" },
      edited: { due_at: "2026-11-09" },
    });

    await undo(proposal?.id ?? "");
    now = await plannerReadTaskPlan(rt.db, { user: rt.user, taskId: id });
    expect(now.task.due_at).toBeNull();
  });

  it("keeps the stale check on the original was, even with an edit, and leaves the card open", async () => {
    const id = await task("Tax return");
    await call("propose_task_change", {
      task_id: id,
      due_at: "2026-11-07",
      why: "x",
    });
    const [proposal] = await actions();
    await plannerChangeTask(rt.db, {
      user: rt.user,
      actor: USER,
      taskId: id,
      today: TODAY,
      change: { dueAt: "2026-11-02" },
    });
    await expect(
      accept(proposal?.id ?? "", { due_at: "2026-11-09" }),
    ).rejects.toThrow(PLANNER_AGENT_STALE);
    const [after] = await actions();
    expect(after?.state).toBe("open");
    expect(after?.change.edited).toBeUndefined();
    const now = await plannerReadTaskPlan(rt.db, { user: rt.user, taskId: id });
    expect(now.task.due_at).toBe("2026-11-02");
  });

  it("places a task where the owner picked: another column, top or bottom, and Undo puts column and rank back", async () => {
    const a = await task("Anchor A");
    const mover = await task("Mover");
    const x = await task("Doing X");
    const y = await task("Doing Y");
    for (const [taskId, column] of [
      [a, "todo"],
      [mover, "todo"],
      [x, "doing"],
      [y, "doing"],
    ] as const) {
      await plannerChangeTask(rt.db, {
        user: rt.user,
        actor: USER,
        taskId,
        today: TODAY,
        change: { column },
      });
    }
    await plannerChangeTask(rt.db, {
      user: rt.user,
      actor: USER,
      taskId: y,
      today: TODAY,
      change: { column: "doing", afterId: x },
    });
    await plannerChangeTask(rt.db, {
      user: rt.user,
      actor: USER,
      taskId: mover,
      today: TODAY,
      change: { column: "todo", afterId: a },
    });
    const order = async (column: "todo" | "doing") =>
      (
        await plannerReadBoard(rt.db, {
          userId: rt.user.id,
          today: TODAY,
          doneDays: 14,
        })
      ).columns[column].map((card) => card.title);
    expect(await order("todo")).toEqual(["Anchor A", "Mover"]);
    const rankOf = async () =>
      (await plannerReadTaskPlan(rt.db, { user: rt.user, taskId: mover })).plan
        ?.board_rank;
    const oldRank = await rankOf();

    await call("propose_task_change", {
      task_id: mover,
      column: "todo",
      before_id: a,
      why: "Top of the list.",
    });
    const [proposal] = await actions();
    expect(proposal?.field).toBe("place");
    // The agent's anchor in another column is refused; top and bottom are fine.
    await expect(
      accept(proposal?.id ?? "", { column: "doing", spot: "anchor" }),
    ).rejects.toThrow(/another column/);
    expect((await actions())[0]?.state).toBe("open");

    const accepted = await accept(proposal?.id ?? "", {
      column: "doing",
      spot: "bottom",
    });
    expect(await order("doing")).toEqual(["Doing X", "Doing Y", "Mover"]);
    expect(accepted.change).toMatchObject({
      column: "doing",
      after_id: y,
      anchor_title: "Doing Y",
      proposed: { column: "todo", spot: "anchor" },
      edited: { column: "doing", spot: "bottom" },
    });
    expect(accepted.change.before_id).toBeUndefined();

    await undo(proposal?.id ?? "");
    expect(await order("todo")).toEqual(["Anchor A", "Mover"]);
    expect(await order("doing")).toEqual(["Doing X", "Doing Y"]);
    expect(await rankOf()).toBe(oldRank);
  });

  it("adds a health row as the owner edited it (kind, variant, minutes), and Undo removes it", async () => {
    await call("propose_health_change", {
      action: "add",
      day: "2026-10-27",
      kind: "training",
      variant: "push",
      minutes: 30,
      why: "The diary says you trained.",
    });
    const [proposal] = await actions();
    const accepted = await accept(proposal?.id ?? "", {
      kind: "breath",
      variant: "wim_hof",
      minutes: 15,
    });
    expect(await healthRow(accepted.landed_id ?? "")).toMatchObject({
      kind: "breath",
      variant: "wim_hof",
      minutes: 15,
    });
    expect(accepted.change).toMatchObject({
      kind: "breath",
      label: "2026-10-27 breath",
      proposed: { kind: "training", variant: "push", minutes: 30 },
      edited: { kind: "breath", variant: "wim_hof", minutes: 15 },
    });

    await undo(proposal?.id ?? "");
    const gone = await healthRow(accepted.landed_id ?? "");
    expect(gone?.deleted_at !== null || gone?.dismissed === 1).toBe(true);
  });

  it("fixes only minutes when the owner edits a health fix", async () => {
    const id = "h-edit-1";
    await rt.database
      .prepare(
        `INSERT INTO health_entry (id, user_id, kind, day, variant, minutes, home_at, units, bender, needs_check, source, memo_id, dismissed, edited, created_at, updated_at)
         VALUES (?, ?, 'training', '2026-10-26', 'push', 30, NULL, NULL, 0, 0, 'memo', 'memo-1', 0, 0, ?, ?)`,
      )
      .bind(id, rt.user.id, NOW.toISOString(), NOW.toISOString())
      .run();
    await call("propose_health_change", {
      action: "fix",
      entry_id: id,
      minutes: 45,
      why: "45 minutes.",
    });
    const [proposal] = await actions();
    await expect(
      accept(proposal?.id ?? "", { kind: "breath" }),
    ).rejects.toThrow(/cannot be changed/);
    await accept(proposal?.id ?? "", { minutes: 50 });
    expect(await healthRow(id)).toMatchObject({ minutes: 50 });
    await undo(proposal?.id ?? "");
    expect(await healthRow(id)).toMatchObject({ minutes: 30, variant: "push" });
  });

  it("refuses an edit the owner's own code would refuse, writes nothing and leaves the card open", async () => {
    const id = await task("Pay rent");
    await call("propose_task_change", {
      task_id: id,
      due_at: "2026-11-07",
      why: "x",
    });
    await call("propose_task_change", {
      task_id: id,
      priority: "high",
      why: "x",
    });
    await call("propose_add_task", { title: "Fix bike", why: "x" });
    await call("propose_health_change", {
      action: "add",
      day: "2026-10-27",
      kind: "training",
      variant: "push",
      minutes: 30,
      why: "x",
    });
    await call("propose_goal_change", {
      action: "add",
      period_start: "2026-11-02",
      pillar: "work",
      flag: "A goal",
      why: "x",
    });
    await call("propose_entry", { content: "New entry", why: "x" });
    const list = await actions();
    const byKind = (kind: string, field?: string) =>
      list.find((a) => a.kind === kind && (!field || a.field === field));
    const due = byKind("task_change", "due_at");
    const priority = byKind("task_change", "priority");
    const added = byKind("task_new");
    const health = byKind("health_change");
    const goal = byKind("goal_change");
    const entry = byKind("entry_new");

    // A key the card does not offer, and an unknown key.
    await expect(accept(due?.id ?? "", { title: "Nope" })).rejects.toThrow(
      /cannot be changed/,
    );
    await expect(accept(due?.id ?? "", { notes: "x" })).rejects.toThrow(
      /not valid/,
    );
    // A due date change needs a day.
    await expect(accept(due?.id ?? "", { due_at: null })).rejects.toThrow(
      /needs a day/,
    );
    await expect(accept(due?.id ?? "", { due_at: "soon" })).rejects.toThrow(
      /not valid/,
    );
    // A goal that is not a weekly goal.
    await expect(
      accept(added?.id ?? "", { goal_id: "goal-nope" }),
    ).rejects.toThrow(/weekly goals/);
    // Words are never editable: a diary entry takes no edit.
    await expect(accept(entry?.id ?? "", { title: "x" })).rejects.toThrow(
      /cannot be changed/,
    );
    // A variant that does not fit the kind; a night out has no minutes.
    await expect(
      accept(health?.id ?? "", { kind: "breath", variant: "push" }),
    ).rejects.toThrow(/variant must be one of/);
    await expect(
      accept(health?.id ?? "", { kind: "night_out", minutes: 20 }),
    ).rejects.toThrow(/no variant or minutes/);
    // A goal week in the past.
    await expect(
      accept(goal?.id ?? "", { period_start: "2026-10-19" }),
    ).rejects.toThrow(/past/);
    await expect(
      accept(goal?.id ?? "", { period_start: "2026-11-03" }),
    ).rejects.toThrow(/not valid/);
    // A priority card takes only a priority.
    await expect(
      accept(priority?.id ?? "", { due_at: "2026-11-09" }),
    ).rejects.toThrow(/cannot be changed/);

    expect((await actions()).every((a) => a.state === "open")).toBe(true);
    const now = await plannerReadTaskPlan(rt.db, { user: rt.user, taskId: id });
    expect(now.task.due_at).toBeNull();
    expect(now.task.priority).toBe("none");
    expect(
      await plannerTestRows(rt.database, "SELECT id FROM health_entry"),
    ).toHaveLength(0);
  });

  it("moves a new weekly goal to a later week and objective, and refuses a twin", async () => {
    await weekGoal("Twin");
    await call("propose_goal_change", {
      action: "add",
      period_start: "2026-11-02",
      pillar: "work",
      flag: "You wrote about a twin",
      why: "x",
    });
    const [proposal] = await actions();
    await expect(
      accept(proposal?.id ?? "", { period_start: WEEK, title: "Twin" }),
    ).rejects.toThrow(/already has a goal/);
    const accepted = await accept(proposal?.id ?? "", {
      pillar: "health",
      period_start: "2026-11-09",
      title: "Twin",
    });
    expect(accepted.change).toMatchObject({
      pillar: "health",
      period_start: "2026-11-09",
      week: "2026-11-09",
      proposed: { pillar: "work", period_start: "2026-11-02" },
    });
    const goals = await plannerTestRows<{
      pillar: string;
      period_start: string;
    }>(
      rt.database,
      "SELECT pillar, period_start FROM planner_goal WHERE title = 'Twin' ORDER BY period_start",
    );
    expect(goals.map((g) => [g.pillar, g.period_start])).toEqual([
      ["work", WEEK],
      ["health", "2026-11-09"],
    ]);
    await undo(proposal?.id ?? "");
  });

  it("logs the edit by field names only, and the scorecard counts accepted-with-edit", async () => {
    await call("propose_add_task", {
      title: "A private title",
      why: "x",
    });
    await call("propose_add_task", { title: "Another", why: "x" });
    const [first, second] = await actions();
    await accept(first?.id ?? "", { title: "My own private words" });
    await accept(second?.id ?? "");

    const log = await plannerTestRows<{
      kind: string;
      subject: string;
      subject_id: string;
      origin: string;
      proposal_id: string;
      data: string;
    }>(
      rt.database,
      "SELECT kind, subject, subject_id, origin, proposal_id, data FROM planner_event WHERE user_id = ?",
      rt.user.id,
    );
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      kind: "proposal.accepted_edited",
      subject: "proposal",
      subject_id: first?.id,
      origin: "proposal",
      proposal_id: first?.id,
    });
    expect(JSON.parse(log[0]?.data ?? "{}")).toEqual({
      action_kind: "task_new",
      field: null,
      fields: "title",
      count: 1,
      from_diary: false,
      title_chars: expect.any(Number),
    });
    expect(log[0]?.data).not.toContain("private");

    const week = await plannerFlywheelRollup(rt.db, {
      userId: rt.user.id,
      weekStart: WEEK,
      now: NOW,
    });
    expect(
      week.values.find(
        (v) => v.metric === "proposals_edited" && v.origin === "ai",
      ),
    ).toMatchObject({ num: 1, den: 2 });
  });
});
