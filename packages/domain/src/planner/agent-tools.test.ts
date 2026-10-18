import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  plannerAgentBudget,
  plannerAgentCreateRun,
  plannerAgentEndRun,
  plannerAgentListProposals,
  plannerAgentMonthSpend,
  plannerAgentSettleProposal,
} from "./agent-store";
import { PlannerAgentToolError, plannerAgentCallTool } from "./agent-tools";
import {
  type PlannerTestRuntime,
  plannerTestRows,
  plannerTestRun,
  plannerTestRuntime,
} from "./test-support";

// The general agent's tools and its run bookkeeping (agent-tools.ts,
// agent-store.ts): reads see the owner's rows only, and the propose tools
// refuse what the owner did not write.

let rt: PlannerTestRuntime;
const NOW = new Date("2026-10-18T12:00:00.000Z"); // a Sunday
const WEEK = "2026-10-12";
const NEXT_WEEK = "2026-10-19";
let sequence = 0;

async function entry(
  content: string,
  options: { at?: string; source?: string; userId?: string } = {},
): Promise<string> {
  const id = `memos/agent-${++sequence}`;
  const at = options.at ?? "2026-10-14T08:00:00.000Z";
  await plannerTestRun(
    rt.database,
    `INSERT INTO memos (id, user_id, content, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    id,
    options.userId ?? rt.user.id,
    content,
    options.source ?? "web",
    at,
    at,
  );
  return id;
}

const call = (name: string, args: unknown) =>
  plannerAgentCallTool({ db: rt.db, user: rt.user, now: NOW }, name, args);

describe("the general agent's tools", () => {
  beforeAll(async () => {
    rt = await plannerTestRuntime("planner-agent-tools-test");
  });

  afterAll(async () => {
    await rt.dispose();
  });

  beforeEach(async () => {
    await rt.reset();
    await rt.database.batch(
      ["memory_evidence", "memory_events", "memory_items", "memos"].map(
        (table) => rt.database.prepare(`DELETE FROM ${table}`),
      ),
    );
  });

  it("refuses an unknown tool and a bad input with a message the agent can act on", async () => {
    await expect(call("delete_everything", {})).rejects.toThrow(
      PlannerAgentToolError,
    );
    await expect(call("review_week", { week: "2026-10-14" })).rejects.toThrow(
      /week: Expected the Monday/,
    );
    await expect(
      call("list_entries", { from: "2024-01-01", to: "2026-10-18" }),
    ).rejects.toThrow("Ask for at most 400 days at a time.");
  });

  it("indexes and opens the owner's entries only, marking review memos", async () => {
    const own = await entry("Ran ten kilometres before work.");
    await entry("# Week 41\n\nA summary.", { source: "weekly-review" });
    await entry("Someone else's entry.", { userId: rt.other.id });
    const index = await call("list_entries", {
      from: "2026-10-12",
      to: "2026-10-18",
    });
    expect(index).toContain(
      `${own} | 2026-10-14 10:00 | Owner | 31 chars | Ran ten kilometres before work.`,
    );
    expect(index).toContain("review memo (a model wrote it)");
    expect(index).not.toContain("Someone else");
    const opened = await call("read_entries", { ids: [own, "memos/nope"] });
    expect(opened).toContain("Written 2026-10-14 10:00 by Owner.");
    expect(opened).toContain("Not found: memos/nope");
    const week = await call("review_week", { week: WEEK });
    expect(week).toContain("Ran ten kilometres before work.");
    expect(week).not.toContain("Someone else");
  });

  it("proposes a memory only on the owner's own words, as a proposal", async () => {
    await entry("I always train better in the morning than at night.");
    await entry("# Week 41\n\nYou train better in the evening.", {
      source: "weekly-review",
    });
    await expect(
      call("propose_memory", {
        content: "Trains better in the evening.",
        kind: "preference",
        quote: "You train better in the evening.",
      }),
    ).rejects.toThrow(/not found word for word/);
    const result = await call("propose_memory", {
      content: "Trains better in the morning than at night.",
      kind: "preference",
      quote: "I always train better in the morning",
    });
    expect(result).toContain("It waits on the Memory page");
    const [memory] = await plannerTestRows<{
      needs_review: number;
      source_agent: string;
      verification: string;
    }>(
      rt.database,
      "SELECT needs_review, source_agent, verification FROM memory_items",
    );
    expect(memory).toEqual({
      needs_review: 1,
      source_agent: "agent",
      verification: "inferred",
    });
  });

  it("proposes goals and tasks for the week being planned, with checked receipts", async () => {
    await entry("Need to finally call the accountant about the VAT.");
    await expect(
      call("propose_task", {
        week: "2026-11-30",
        title: "Call the accountant",
        why: "Open for weeks.",
      }),
    ).rejects.toThrow("Propose only for the week being planned");
    await expect(
      call("propose_task", {
        week: NEXT_WEEK,
        title: "Call the accountant",
        goal_ref: "no-such-goal",
        why: "Open for weeks.",
      }),
    ).rejects.toThrow(/goal_ref names no goal/);

    const goal = await call("propose_goal", {
      week: NEXT_WEEK,
      pillar: "work",
      title: "Close the VAT question",
      why: "It has come up every week.",
    });
    const goalId = /Proposed goal (\S+) /.exec(goal)?.[1];
    expect(goalId).toBeTruthy();
    await call("propose_task", {
      week: NEXT_WEEK,
      title: "Call the accountant",
      goal_ref: goalId,
      why: "The diary says it is overdue.",
      quote: "finally call the accountant about the VAT",
    });
    // The same title again is the same proposal.
    await call("propose_task", {
      week: NEXT_WEEK,
      title: "call the  Accountant",
      why: "Again.",
    });
    const proposals = await plannerAgentListProposals(rt.db, {
      userId: rt.user.id,
      weekStart: NEXT_WEEK,
    });
    expect(proposals.map((p) => [p.kind, p.title, p.goal_ref])).toEqual([
      ["goal", "Close the VAT question", null],
      ["task", "Call the accountant", goalId],
    ]);
    expect(proposals[1]).toMatchObject({
      quote: "finally call the accountant about the VAT",
      source_day: "2026-10-14",
      state: "open",
    });
    const settled = await plannerAgentSettleProposal(rt.db, {
      userId: rt.user.id,
      id: proposals[1]?.id ?? "",
      state: "dismissed",
    });
    expect(settled.state).toBe("dismissed");
    await expect(
      plannerAgentSettleProposal(rt.db, {
        userId: rt.other.id,
        id: proposals[0]?.id ?? "",
        state: "accepted",
      }),
    ).rejects.toThrow("Proposal not found.");
  });
});

describe("the agent's spend", () => {
  beforeAll(async () => {
    rt = await plannerTestRuntime("planner-agent-spend-test");
  });

  afterAll(async () => {
    await rt.dispose();
  });

  it("caps a run at the per-run stop or what is left of the month", () => {
    const base = { runCents: 500, monthCents: 3000 };
    expect(plannerAgentBudget({ ...base, spentCents: 0, reservedCents: 0 })).toBe(
      500,
    );
    expect(
      plannerAgentBudget({ ...base, spentCents: 2600, reservedCents: 100 }),
    ).toBe(300);
    expect(
      plannerAgentBudget({ ...base, spentCents: 2960, reservedCents: 0 }),
    ).toBe(0);
  });

  it("counts this month's cost and what open sessions may still spend", async () => {
    const userId = rt.user.id;
    const old = await plannerAgentCreateRun(rt.db, {
      userId,
      job: "review",
      ownerKey: "week:2026-09-21",
      budgetCents: 500,
      step: "memo",
      now: new Date("2026-09-27T18:00:00.000Z"),
    });
    await plannerAgentEndRun(rt.db, {
      runId: old.id,
      state: "ended",
      costCents: 400,
    });
    const ended = await plannerAgentCreateRun(rt.db, {
      userId,
      job: "ask",
      ownerKey: "ask:a",
      budgetCents: 500,
      step: "ask",
      now: new Date("2026-10-02T18:00:00.000Z"),
    });
    await plannerAgentEndRun(rt.db, {
      runId: ended.id,
      state: "ended",
      costCents: 120,
    });
    await plannerAgentCreateRun(rt.db, {
      userId,
      job: "review",
      ownerKey: "week:2026-10-12",
      budgetCents: 500,
      step: "opening",
      now: new Date("2026-10-18T10:00:00.000Z"),
    });
    expect(await plannerAgentMonthSpend(rt.db, { userId, now: NOW })).toEqual({
      spentCents: 120,
      reservedCents: 500,
    });
  });
});
