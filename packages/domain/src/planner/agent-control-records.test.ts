import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { healthRescan } from "../health/sync";
import { createMemory } from "../memory";
import type { TaskActor } from "../tasks";
import {
  PLANNER_AGENT_STALE,
  plannerAgentAcceptAction,
  plannerAgentRevertAction,
} from "./agent-apply";
import { plannerAgentCreateRun, plannerAgentListActions } from "./agent-store";
import { plannerAgentCallTool } from "./agent-tools";
import {
  type PlannerTestRuntime,
  plannerTestRows,
  plannerTestRun,
  plannerTestRuntime,
} from "./test-support";

// The agent correcting or forgetting a memory, and fixing or adding a health
// row (docs/fork-general-agent.md): proposed in an Ask chat, written through
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
      deleted_at: string | null;
    }>(
      rt.database,
      `SELECT day, kind, variant, minutes, home_at, units, source, memo_id, edited, deleted_at FROM health_entry WHERE id = '${id}'`,
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
      expect((await memoryRow(id))?.content).toBe("Lives in Hull.");
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
});
