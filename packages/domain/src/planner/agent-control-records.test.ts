import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { healthRescan } from "../health/sync";
import { createMemory } from "../memory";
import { createMemo } from "../memos-write";
import type { TaskActor } from "../tasks";
import {
  PLANNER_AGENT_STALE,
  plannerAgentAcceptAction,
  plannerAgentRevertAction,
} from "./agent-apply";
import { plannerAgentCreateRun, plannerAgentListActions } from "./agent-store";
import { plannerAgentCallTool } from "./agent-tools";
import { plannerReadGoalVersions } from "./goal-version";
import {
  plannerCreateGoal,
  plannerReadWeekGoals,
  plannerUpdateGoal,
} from "./goals";
import {
  type PlannerTestRuntime,
  plannerTestInsertPlan,
  plannerTestInsertTask,
  plannerTestRows,
  plannerTestRun,
  plannerTestRuntime,
} from "./test-support";

// The agent correcting or forgetting a memory, and fixing or adding a health
// row, and a weekly goal added or rewritten (docs/fork-general-agent.md): proposed in an Ask chat, written through
// the owner's own code on accept, stale-checked, and put back by Undo.

let rt: PlannerTestRuntime;
const NOW = new Date("2026-10-28T10:00:00.000Z");
const TODAY = "2026-10-28";
const USER: TaskActor = { type: "user" };
const CONVERSATION = "44444444-4444-4444-8444-444444444444";

const call = (name: string, args: unknown) =>
  plannerAgentCallTool({ db: rt.db, user: rt.user, now: NOW }, name, args);

const actions = () =>
  plannerAgentListActions(rt.db, {
    userId: rt.user.id,
    conversationId: CONVERSATION,
    now: NOW,
  });

const accept = (id: string) =>
  plannerAgentAcceptAction(rt.db, { user: rt.user, id, today: TODAY });

const undo = (id: string) =>
  plannerAgentRevertAction(rt.db, {
    user: rt.user,
    actor: USER,
    id,
    today: TODAY,
  });

async function memory(content: string) {
  const made = await createMemory(
    rt.db,
    rt.user,
    { type: "agent", name: "test" },
    {
      content,
      type: "semantic",
      kind: "fact",
      scopeType: "global",
      scopeKey: null,
      tier: "normal",
      importance: 50,
      confidence: 60,
    },
  );
  return made.memory.id;
}

const memoryRow = async (id: string) =>
  (
    await plannerTestRows<{
      content: string;
      status: string;
      verification: string;
    }>(
      rt.database,
      `SELECT content, status, verification FROM memory_items WHERE id = '${id}'`,
    )
  )[0];

async function seedHealth(id: string, patch: Record<string, unknown> = {}) {
  const row = {
    kind: "training",
    day: "2026-10-26",
    variant: "push",
    minutes: 30,
    source: "memo",
    memo_id: "memo-1",
    ...patch,
  };
  await plannerTestRun(
    rt.database,
    `INSERT INTO health_entry (id, user_id, kind, day, variant, minutes, home_at, units, bender, needs_check, source, memo_id, dismissed, edited, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, 0, 0, ?, ?)`,
    id,
    rt.user.id,
    row.kind,
    row.day,
    row.variant,
    row.minutes,
    patch.home_at ?? null,
    patch.units ?? null,
    row.source,
    row.memo_id,
    NOW.toISOString(),
    NOW.toISOString(),
  );
}

const healthRow = async (id: string) =>
  (
    await plannerTestRows<{
      day: string;
      kind: string;
      variant: string | null;
      minutes: number | null;
      home_at: string | null;
      units: number | null;
      source: string;
      memo_id: string | null;
      edited: number;
      dismissed: number;
      deleted_at: string | null;
    }>(
      rt.database,
      `SELECT day, kind, variant, minutes, home_at, units, source, memo_id, edited, dismissed, deleted_at FROM health_entry WHERE id = '${id}'`,
    )
  )[0];

describe("the agent correcting records", () => {
  beforeAll(async () => {
    rt = await plannerTestRuntime("planner-agent-control-records-test");
  });

  afterAll(async () => {
    await rt.dispose();
  });

  beforeEach(async () => {
    await rt.reset();
    await rt.database.batch(
      [
        "memory_events",
        "memory_revisions",
        "memory_relations",
        "memory_evidence",
        "memory_items",
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

  describe("memory", () => {
    it("corrects a memory on accept, and Undo puts the words back", async () => {
      const id = await memory("Lives in Hull.");
      await expect(
        call("propose_memory_change", {
          memory_id: id,
          action: "correct",
          content: "  Lives in   Hull. ",
          why: "x",
        }),
      ).rejects.toThrow(/already reads like that/);
      await call("propose_memory_change", {
        memory_id: id,
        action: "correct",
        content: "Lives in Leeds.",
        why: "Moved.",
      });
      const [proposal] = await actions();
      expect(proposal?.kind).toBe("memory_change");
      expect(proposal?.change).toMatchObject({
        was: { content: "Lives in Hull.", status: "active" },
        label: "Lives in Hull.",
      });
      expect((await memoryRow(id))?.content).toBe("Lives in Hull.");

      const accepted = await accept(proposal?.id ?? "");
      expect(accepted.landed_id).toBe(id);
      expect(await memoryRow(id)).toMatchObject({
        content: "Lives in Leeds.",
        verification: "confirmed",
      });

      await undo(proposal?.id ?? "");
      // Undo puts the words back; no owner function lowers verification, so the
      // memory stays marked as confirmed (the card says so).
      expect(await memoryRow(id)).toMatchObject({
        content: "Lives in Hull.",
        verification: "confirmed",
      });
    });

    it("refuses a stale correction, and an Undo after the words changed again", async () => {
      const id = await memory("Lives in Hull.");
      await call("propose_memory_change", {
        memory_id: id,
        action: "correct",
        content: "Lives in Leeds.",
        why: "x",
      });
      const [proposal] = await actions();
      await plannerTestRun(
        rt.database,
        "UPDATE memory_items SET content = 'Lives in York.' WHERE id = ?",
        id,
      );
      await expect(accept(proposal?.id ?? "")).rejects.toThrow(
        PLANNER_AGENT_STALE,
      );
      await plannerTestRun(
        rt.database,
        "UPDATE memory_items SET content = 'Lives in Hull.' WHERE id = ?",
        id,
      );
      await accept(proposal?.id ?? "");
      await plannerTestRun(
        rt.database,
        "UPDATE memory_items SET content = 'Lives in Bath.' WHERE id = ?",
        id,
      );
      await expect(undo(proposal?.id ?? "")).rejects.toThrow(/changed since/);
    });

    it("refuses a correction that would twin another memory", async () => {
      const id = await memory("Lives in Hull.");
      await memory("Lives in Leeds.");
      await call("propose_memory_change", {
        memory_id: id,
        action: "correct",
        content: "Lives in Leeds.",
        why: "x",
      });
      const [proposal] = await actions();
      await expect(accept(proposal?.id ?? "")).rejects.toThrow(
        /already exists/,
      );
      expect((await memoryRow(id))?.content).toBe("Lives in Hull.");
      expect((await actions())[0]?.state).toBe("open");
    });

    it("forgets a memory by archiving it, and Undo restores it", async () => {
      const id = await memory("Hates mornings.");
      await call("propose_memory_change", {
        memory_id: id,
        action: "forget",
        why: "Not true any more.",
      });
      const [proposal] = await actions();
      await accept(proposal?.id ?? "");
      expect((await memoryRow(id))?.status).toBe("archived");
      await undo(proposal?.id ?? "");
      expect((await memoryRow(id))?.status).toBe("active");
      await expect(
        call("propose_memory_change", {
          memory_id: "memories/none",
          action: "forget",
          why: "x",
        }),
      ).rejects.toThrow(/No memory/);
    });

    it("will not propose for an archived memory, and refuses an Undo of a forget that was restored by hand", async () => {
      const id = await memory("Hates mornings.");
      await call("propose_memory_change", {
        memory_id: id,
        action: "forget",
        why: "x",
      });
      const [proposal] = await actions();
      await accept(proposal?.id ?? "");
      await expect(
        call("propose_memory_change", {
          memory_id: id,
          action: "forget",
          why: "x",
        }),
      ).rejects.toThrow(/archived/);
      await plannerTestRun(
        rt.database,
        "UPDATE memory_items SET status = 'active' WHERE id = ?",
        id,
      );
      await expect(undo(proposal?.id ?? "")).rejects.toThrow(
        /not archived any more/,
      );
    });
  });

  describe("health", () => {
    it("lists row ids for the agent", async () => {
      await seedHealth("h-1");
      const text = await call("read_health", {
        from: "2026-10-26",
        to: "2026-11-01",
      });
      expect(text).toContain("h-1 | 2026-10-26 training (push), 30 min");
    });

    it("fixes a misread row on accept, keeps it past the nightly read, and Undo restores it", async () => {
      await seedHealth("h-1");
      await expect(
        call("propose_health_change", {
          action: "fix",
          entry_id: "h-1",
          minutes: 30,
          why: "x",
        }),
      ).rejects.toThrow(/already holds/);
      await call("propose_health_change", {
        action: "fix",
        entry_id: "h-1",
        minutes: 45,
        variant: "legs",
        why: "It was legs, 45 minutes.",
      });
      const [proposal] = await actions();
      expect(proposal?.change).toMatchObject({
        was: { variant: "push", minutes: 30 },
        label: "2026-10-26 training",
      });
      expect((await healthRow("h-1"))?.minutes).toBe(30);

      const accepted = await accept(proposal?.id ?? "");
      expect(accepted.landed_id).toBe("h-1");
      expect(await healthRow("h-1")).toMatchObject({
        minutes: 45,
        variant: "legs",
        edited: 1,
      });
      // `edited` is what the nightly read of the diary respects.

      await undo(proposal?.id ?? "");
      expect(await healthRow("h-1")).toMatchObject({
        minutes: 30,
        variant: "push",
        edited: 0,
      });
      const events = await plannerTestRows<{ action: string }>(
        rt.database,
        "SELECT action FROM health_entry_event WHERE entry_id = 'h-1' ORDER BY at, rowid",
      );
      expect(events.map((event) => event.action)).toEqual(
        expect.arrayContaining(["update", "restore"]),
      );
    });

    it("refuses a stale fix, and an Undo after the owner fixed the row again", async () => {
      await seedHealth("h-1");
      await call("propose_health_change", {
        action: "fix",
        entry_id: "h-1",
        minutes: 45,
        why: "x",
      });
      const [proposal] = await actions();
      await plannerTestRun(
        rt.database,
        "UPDATE health_entry SET minutes = 50 WHERE id = 'h-1'",
      );
      await expect(accept(proposal?.id ?? "")).rejects.toThrow(
        PLANNER_AGENT_STALE,
      );
      await plannerTestRun(
        rt.database,
        "UPDATE health_entry SET minutes = 30 WHERE id = 'h-1'",
      );
      await accept(proposal?.id ?? "");
      await plannerTestRun(
        rt.database,
        "UPDATE health_entry SET minutes = 60 WHERE id = 'h-1'",
      );
      await expect(undo(proposal?.id ?? "")).rejects.toThrow(/changed since/);
    });

    it("fixes a night's home time and its units", async () => {
      await seedHealth("n-1", {
        kind: "night_out",
        variant: null,
        minutes: null,
        home_at: "23:00",
        units: 0,
        memo_id: "memo-2",
      });
      await call("propose_health_change", {
        action: "fix",
        entry_id: "n-1",
        home_at: "04:30",
        why: "Got in at half past four.",
      });
      const [proposal] = await actions();
      await accept(proposal?.id ?? "");
      expect(await healthRow("n-1")).toMatchObject({
        home_at: "04:30",
        units: 1,
      });
      await undo(proposal?.id ?? "");
      expect(await healthRow("n-1")).toMatchObject({
        home_at: "23:00",
        units: 0,
      });
    });

    it("removes a false row through the owner's dismiss, the nightly re-read leaves it dismissed, and Undo brings it back", async () => {
      // A row the diary really read, so the re-read has a memo to read again.
      await createMemo(rt.db, rt.user, {
        content: "crossfit done",
        visibility: "private",
        source: "web",
      });
      await healthRescan(rt.db, rt.user.id, NOW);
      const [read] = await plannerTestRows<{ id: string }>(
        rt.database,
        "SELECT id FROM health_entry WHERE memo_id IS NOT NULL",
      );
      const rowId = read?.id ?? "";
      expect(rowId).not.toBe("");
      const day = (await healthRow(rowId))?.day ?? "";
      await expect(
        call("propose_health_change", {
          action: "remove",
          entry_id: rowId,
          minutes: 20,
          why: "x",
        }),
      ).rejects.toThrow(/remove takes only entry_id/);
      await call("propose_health_change", {
        action: "remove",
        entry_id: rowId,
        why: "The diary said skipped the gym, but a session was logged.",
      });
      const [proposal] = await actions();
      expect(proposal?.change).toMatchObject({
        action: "remove",
        was: { day, kind: "training" },
        label: expect.stringContaining(`${day} training`),
      });
      expect((await healthRow(rowId))?.dismissed).toBe(0);

      await accept(proposal?.id ?? "");
      expect((await healthRow(rowId))?.dismissed).toBe(1);
      await healthRescan(rt.db, rt.user.id, NOW);
      expect((await healthRow(rowId))?.dismissed).toBe(1);
      // A dismissed row is not proposed again.
      await expect(
        call("propose_health_change", {
          action: "remove",
          entry_id: rowId,
          why: "x",
        }),
      ).rejects.toThrow(/already dismissed/);

      await undo(proposal?.id ?? "");
      expect(await healthRow(rowId)).toMatchObject({
        dismissed: 0,
        deleted_at: null,
      });
      const events = await plannerTestRows<{ action: string }>(
        rt.database,
        `SELECT action FROM health_entry_event WHERE entry_id = '${rowId}' ORDER BY at, rowid`,
      );
      expect(events.map((event) => event.action)).toEqual(
        expect.arrayContaining(["dismiss", "restore"]),
      );
    });

    it("refuses a stale remove, and an Undo after the row changed", async () => {
      await seedHealth("h-1");
      await call("propose_health_change", {
        action: "remove",
        entry_id: "h-1",
        why: "x",
      });
      const [proposal] = await actions();
      await plannerTestRun(
        rt.database,
        "UPDATE health_entry SET minutes = 50 WHERE id = 'h-1'",
      );
      await expect(accept(proposal?.id ?? "")).rejects.toThrow(
        PLANNER_AGENT_STALE,
      );
      await plannerTestRun(
        rt.database,
        "UPDATE health_entry SET minutes = 30 WHERE id = 'h-1'",
      );
      await accept(proposal?.id ?? "");
      await plannerTestRun(
        rt.database,
        "UPDATE health_entry SET minutes = 60 WHERE id = 'h-1'",
      );
      await expect(undo(proposal?.id ?? "")).rejects.toThrow(/changed since/);
    });

    it("adds a manual row on accept, and Undo soft-deletes it", async () => {
      await call("propose_health_change", {
        action: "add",
        day: "2026-10-27",
        kind: "night_out",
        home_at: "02:15",
        why: "Went out Tuesday, home at 02:15.",
      });
      await expect(
        call("propose_health_change", {
          action: "add",
          day: "2026-10-27",
          kind: "training",
          home_at: "02:15",
          why: "x",
        }),
      ).rejects.toThrow(/home time/);
      const [proposal] = await actions();
      const accepted = await accept(proposal?.id ?? "");
      const id = accepted.landed_id ?? "";
      expect(await healthRow(id)).toMatchObject({
        kind: "night_out",
        day: "2026-10-27",
        home_at: "02:15",
        units: 0.5,
        source: "manual",
        memo_id: null,
        edited: 1,
        deleted_at: null,
      });
      // A re-read of the diary leaves a manual row alone.
      await healthRescan(rt.db, rt.user.id, NOW);
      expect((await healthRow(id))?.deleted_at).toBeNull();
      // Proposing the same row again is refused.
      await expect(
        call("propose_health_change", {
          action: "add",
          day: "2026-10-27",
          kind: "night_out",
          why: "x",
        }),
      ).rejects.toThrow(/already has/);

      await undo(proposal?.id ?? "");
      expect((await healthRow(id))?.deleted_at).not.toBeNull();
      const events = await plannerTestRows<{ action: string }>(
        rt.database,
        `SELECT action FROM health_entry_event WHERE entry_id = '${id}' ORDER BY rowid`,
      );
      expect(events.map((event) => event.action)).toEqual(["create", "delete"]);
    });
  });

  describe("weekly goals", () => {
    const WEEK = "2026-11-02";
    const versions = (goalId: string) =>
      plannerReadGoalVersions(rt.db, { userId: rt.user.id, goalId });
    const weekGoals = () =>
      plannerReadWeekGoals(rt.db, { userId: rt.user.id, weekStart: WEEK });
    const seedGoal = (patch: Record<string, unknown> = {}) =>
      plannerCreateGoal(rt.db, {
        userId: rt.user.id,
        now: NOW,
        goal: {
          level: "week",
          periodStart: WEEK,
          pillar: "work",
          title: "Ship the invoice flow",
          lines: [
            { text: "Draft", note: "v1" },
            { text: "Send", struck: true },
          ],
          ...patch,
        },
      });

    it("adds and edits only this week's goals and later ones, by the tool's today", async () => {
      // NOW is 2026-10-28, so this week starts 2026-10-26.
      for (const past of ["2026-10-19", "2026-09-07"]) {
        await expect(
          call("propose_goal_change", {
            action: "add",
            period_start: past,
            pillar: "work",
            title: "Too late",
            why: "x",
          }),
        ).rejects.toThrow(/past week/);
      }
      await call("propose_goal_change", {
        action: "add",
        period_start: "2026-10-26",
        pillar: "work",
        title: "This week is fine",
        why: "x",
      });
      expect(await actions()).toHaveLength(1);

      const old = await seedGoal({ periodStart: "2026-10-19" });
      await expect(
        call("propose_goal_change", {
          action: "edit",
          goal_id: old.id,
          title: "Rewritten",
          why: "x",
        }),
      ).rejects.toThrow(/past/);
      const next = await seedGoal({ periodStart: "2026-11-02" });
      await call("propose_goal_change", {
        action: "edit",
        goal_id: next.id,
        title: "Rewritten",
        why: "x",
      });
      expect(await actions()).toHaveLength(2);

      // The replay's cut day counts as today: from 2026-12-01, 2026-11-02 is past.
      const replay = (args: unknown) =>
        plannerAgentCallTool(
          {
            db: rt.db,
            user: rt.user,
            now: NOW,
            asOf: { at: "2026-12-01T00:00:00.000Z" } as never,
          },
          "propose_goal_change",
          args,
        );
      await expect(
        replay({
          action: "add",
          period_start: "2026-11-02",
          pillar: "work",
          title: "Replay",
          why: "x",
        }),
      ).rejects.toThrow(/past week/);
    });

    it("adds a weekly goal on accept as the proposal, and Undo soft-deletes it", async () => {
      await expect(
        call("propose_goal_change", {
          action: "add",
          period_start: "2026-11-03",
          pillar: "work",
          title: "x",
          why: "x",
        }),
      ).rejects.toThrow(/Monday/);
      await expect(
        call("propose_goal_change", {
          action: "add",
          period_start: "2030-11-04",
          pillar: "work",
          title: "x",
          why: "x",
        }),
      ).rejects.toThrow(/too far/);
      await call("propose_goal_change", {
        action: "add",
        period_start: WEEK,
        pillar: "ai",
        title: "Read the agents paper",
        lines: ["Skim", "Notes"],
        why: "Asked for it.",
      });
      const [proposal] = await actions();
      expect(proposal?.kind).toBe("goal_change");
      expect(proposal?.change).toMatchObject({
        action: "add",
        week: WEEK,
        goal_title: "Read the agents paper",
      });
      expect(await weekGoals()).toHaveLength(0);

      const accepted = await accept(proposal?.id ?? "");
      const goalId = accepted.landed_id ?? "";
      const [goal] = await weekGoals();
      expect(goal).toMatchObject({
        id: goalId,
        level: "week",
        pillar: "ai",
        title: "Read the agents paper",
        lines: [{ text: "Skim" }, { text: "Notes" }],
      });
      const [created] = await versions(goalId);
      expect(created).toMatchObject({
        action: "create",
        actor: `proposal:${proposal?.id}`,
        beforeJson: null,
      });

      await undo(proposal?.id ?? "");
      expect(await weekGoals()).toHaveLength(0);
      expect((await versions(goalId)).map((v) => [v.action, v.actor])).toEqual([
        ["create", `proposal:${proposal?.id}`],
        ["delete", `proposal:${proposal?.id}`],
      ]);
    });

    it("refuses to undo an added goal that was edited or given tasks since", async () => {
      await call("propose_goal_change", {
        action: "add",
        period_start: WEEK,
        pillar: "work",
        title: "Close the quarter",
        why: "x",
      });
      await call("propose_goal_change", {
        action: "add",
        period_start: WEEK,
        pillar: "health",
        title: "Sleep before midnight",
        why: "x",
      });
      const [first, second] = await actions();
      const a = await accept(first?.id ?? "");
      const b = await accept(second?.id ?? "");
      await plannerUpdateGoal(rt.db, {
        userId: rt.user.id,
        goalId: a.landed_id ?? "",
        patch: { title: "Close the quarter, really" },
        now: NOW,
      });
      await expect(undo(first?.id ?? "")).rejects.toThrow(/changed since/);
      await plannerTestInsertTask(rt.database, {
        id: "t-goal",
        userId: rt.user.id,
      });
      await plannerTestInsertPlan(rt.database, {
        taskId: "t-goal",
        userId: rt.user.id,
      });
      await plannerTestRun(
        rt.database,
        "UPDATE planner_task_plan SET goal_id = ? WHERE task_id = 't-goal'",
        b.landed_id,
      );
      await expect(undo(second?.id ?? "")).rejects.toThrow(/linked/);
      expect(await weekGoals()).toHaveLength(2);
    });

    it("rewrites a goal on accept, keeps the notes of unchanged lines, and Undo restores the words", async () => {
      const goal = await seedGoal();
      await expect(
        call("propose_goal_change", {
          action: "edit",
          goal_id: goal.id,
          title: "Ship the invoice flow",
          why: "x",
        }),
      ).rejects.toThrow(/already reads like that/);
      await call("propose_goal_change", {
        action: "edit",
        goal_id: goal.id,
        title: "Ship invoices",
        lines: ["Draft", "Review with Dana"],
        note: "Due Friday",
        why: "Reworded.",
      });
      const [proposal] = await actions();
      expect(proposal?.change).toMatchObject({
        action: "edit",
        goal_id: goal.id,
        title: "Ship invoices",
        lines: [{ text: "Draft", note: "v1" }, { text: "Review with Dana" }],
        was: {
          title: "Ship the invoice flow",
          lines: [
            { text: "Draft", note: "v1" },
            { text: "Send", struck: true },
          ],
          note: null,
          pillar: "work",
        },
        week: WEEK,
        goal_title: "Ship the invoice flow",
      });

      const accepted = await accept(proposal?.id ?? "");
      expect(accepted.landed_id).toBe(goal.id);
      const [after] = await weekGoals();
      expect(after).toMatchObject({
        title: "Ship invoices",
        note: "Due Friday",
        lines: [{ text: "Draft", note: "v1" }, { text: "Review with Dana" }],
      });
      const [, updated] = await versions(goal.id);
      expect(updated).toMatchObject({
        action: "update",
        actor: `proposal:${proposal?.id}`,
      });
      expect(updated?.beforeJson).toMatchObject({
        title: "Ship the invoice flow",
      });
      expect(updated?.afterJson).toMatchObject({ title: "Ship invoices" });

      await undo(proposal?.id ?? "");
      const [back] = await weekGoals();
      expect(back).toMatchObject({
        title: "Ship the invoice flow",
        note: null,
        lines: [
          { text: "Draft", note: "v1" },
          { text: "Send", struck: true },
        ],
      });
      const log = await versions(goal.id);
      expect(log.map((v) => v.action)).toEqual(["create", "update", "restore"]);
      expect(log[2]?.actor).toBe(`proposal:${proposal?.id}`);
    });

    it("refuses a stale edit, and an Undo after the goal changed again", async () => {
      const goal = await seedGoal();
      await call("propose_goal_change", {
        action: "edit",
        goal_id: goal.id,
        title: "Ship invoices",
        why: "x",
      });
      const [proposal] = await actions();
      await plannerUpdateGoal(rt.db, {
        userId: rt.user.id,
        goalId: goal.id,
        patch: { title: "Ship the billing flow" },
        now: NOW,
      });
      await expect(accept(proposal?.id ?? "")).rejects.toThrow(
        PLANNER_AGENT_STALE,
      );
      expect((await weekGoals())[0]?.title).toBe("Ship the billing flow");

      await call("propose_goal_change", {
        action: "edit",
        goal_id: goal.id,
        pillar: "ai",
        why: "x",
      });
      const open = (await actions()).find((a) => a.id !== proposal?.id);
      await accept(open?.id ?? "");
      await plannerUpdateGoal(rt.db, {
        userId: rt.user.id,
        goalId: goal.id,
        patch: { note: "Edited by hand" },
        now: NOW,
      });
      await expect(undo(open?.id ?? "")).rejects.toThrow(/changed since/);
      expect((await weekGoals())[0]).toMatchObject({
        pillar: "ai",
        note: "Edited by hand",
      });
    });

    it("refuses what is not the agent's to change", async () => {
      const goal = await seedGoal();
      for (const extra of [
        { status: "closed" },
        { result: "met" },
        { score: 4 },
      ]) {
        await expect(
          call("propose_goal_change", {
            action: "edit",
            goal_id: goal.id,
            title: "Ship invoices",
            ...extra,
            why: "x",
          }),
        ).rejects.toThrow(/Unrecognized key/);
      }
      await expect(
        call("propose_goal_change", {
          action: "delete",
          goal_id: goal.id,
          why: "x",
        }),
      ).rejects.toThrow();
      // Only weekly goals.
      const month = await plannerCreateGoal(rt.db, {
        userId: rt.user.id,
        now: NOW,
        goal: { level: "month", periodStart: "2026-11-01", title: "November" },
      });
      await expect(
        call("propose_goal_change", {
          action: "edit",
          goal_id: month.id,
          title: "Nov",
          why: "x",
        }),
      ).rejects.toThrow(/No weekly goal/);
      await expect(
        call("propose_goal_change", {
          action: "edit",
          goal_id: "nope",
          title: "Nov",
          why: "x",
        }),
      ).rejects.toThrow(/No weekly goal/);
      expect(await actions()).toHaveLength(0);
    });
  });
});
