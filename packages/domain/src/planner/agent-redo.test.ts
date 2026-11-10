import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  plannerAgentRecordRedo,
  plannerAgentRedoDismiss,
  plannerAgentRedoQuestion,
  plannerAgentRedoRestore,
} from "./agent-redo";
import { plannerAgentCreateRun, plannerAgentListActions } from "./agent-store";
import { plannerAgentCallTool } from "./agent-tools";
import { plannerFlywheelRollup } from "./flywheel";
import {
  type PlannerTestRuntime,
  plannerTestRows,
  plannerTestRuntime,
} from "./test-support";

// The one-line redo (docs/fork-general-agent.md, "Redo"): the card's open rows
// are dismissed with the reason redo and kept, the agent's new turn lists them,
// a failed send opens them again, and the flywheel counts redos by kind only.

let rt: PlannerTestRuntime;
const NOW = new Date("2026-10-28T10:00:00.000Z");
const WEEK = "2026-10-26";
const CONVERSATION = "66666666-6666-4666-8666-666666666666";
const OTHER = "77777777-7777-4777-8777-777777777777";

const call = (name: string, args: unknown) =>
  plannerAgentCallTool({ db: rt.db, user: rt.user, now: NOW }, name, args);

const actions = (conversationId = CONVERSATION) =>
  plannerAgentListActions(rt.db, {
    userId: rt.user.id,
    conversationId,
    now: NOW,
  });

describe("the one-line redo", () => {
  beforeAll(async () => {
    rt = await plannerTestRuntime("planner-agent-redo-test");
  });

  afterAll(async () => {
    await rt.dispose();
  });

  beforeEach(async () => {
    await rt.reset();
    await plannerAgentCreateRun(rt.db, {
      userId: rt.user.id,
      job: "ask",
      ownerKey: `ask:${CONVERSATION}`,
      budgetCents: 500,
      step: "ask",
      now: NOW,
    });
  });

  it("dismisses the card's open rows as redo, keeps them, and lists them for the agent", async () => {
    await call("propose_add_task", {
      title: "Call the bank about the private card",
      due_at: "2026-10-30",
      why: "x",
    });
    await call("propose_goal_change", {
      action: "add",
      period_start: "2026-11-02",
      pillar: "health",
      flag: "You wrote you'd train three times",
      why: "x",
    });
    const [task, goal] = await actions();
    const dismissed = await plannerAgentRedoDismiss(rt.db, {
      userId: rt.user.id,
      conversationId: CONVERSATION,
      ids: [task?.id ?? "", goal?.id ?? "", "nope"],
      now: NOW,
    });
    expect(dismissed.map((a) => a.id)).toEqual([task?.id, goal?.id]);
    const after = await actions();
    expect(after).toHaveLength(2);
    expect(after.every((a) => a.state === "dismissed")).toBe(true);
    expect(after.every((a) => a.change.settled_reason === "redo")).toBe(true);
    // A settled row, or another conversation's, is not redone again.
    expect(
      await plannerAgentRedoDismiss(rt.db, {
        userId: rt.user.id,
        conversationId: OTHER,
        ids: [task?.id ?? ""],
        now: NOW,
      }),
    ).toEqual([]);

    const question = plannerAgentRedoQuestion({
      ownerName: "Sam",
      note: "only the work ones, all Thursday",
      actions: dismissed,
    });
    expect(question).toContain('"only the work ones, all Thursday"');
    expect(question).toContain(`${task?.id} task_new`);
    expect(question).toContain('"due_at":"2026-10-30"');
    expect(question).toContain(`${goal?.id} goal_change`);
    expect(question).not.toContain("settled_reason");

    // A failed send opens them again, without the reason.
    await plannerAgentRedoRestore(rt.db, {
      userId: rt.user.id,
      actions: dismissed,
    });
    const back = await actions();
    expect(back.every((a) => a.state === "open")).toBe(true);
    expect(back.some((a) => "settled_reason" in a.change)).toBe(false);
  });

  it("logs the redo by counts and kinds only, and the scorecard counts redone rows", async () => {
    await call("propose_add_task", { title: "A private title", why: "x" });
    await call("propose_add_task", { title: "Another one", why: "x" });
    await call("propose_add_task", { title: "Third", why: "x" });
    const [first, second, third] = await actions();
    const dismissed = await plannerAgentRedoDismiss(rt.db, {
      userId: rt.user.id,
      conversationId: CONVERSATION,
      ids: [first?.id ?? "", second?.id ?? ""],
      now: NOW,
    });
    await plannerAgentRecordRedo(rt.db, {
      userId: rt.user.id,
      conversationId: CONVERSATION,
      actions: dismissed,
      now: NOW,
    });
    const log = await plannerTestRows<{
      kind: string;
      subject: string;
      origin: string;
      data: string;
    }>(
      rt.database,
      "SELECT kind, subject, origin, data FROM planner_event WHERE user_id = ?",
      rt.user.id,
    );
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      kind: "proposal.redo",
      subject: "proposal",
      origin: "proposal",
    });
    expect(JSON.parse(log[0]?.data ?? "{}")).toEqual({
      count: 2,
      kinds: "task_new",
    });
    expect(log[0]?.data).not.toContain("private");

    await plannerTestRows(
      rt.database,
      "UPDATE planner_agent_action SET state = 'dismissed', settled_at = ? WHERE id = ?",
      NOW.toISOString(),
      third?.id,
    );
    const week = await plannerFlywheelRollup(rt.db, {
      userId: rt.user.id,
      weekStart: WEEK,
      now: NOW,
    });
    expect(
      week.values.find(
        (v) => v.metric === "proposals_redone" && v.origin === "ai",
      ),
    ).toMatchObject({ num: 2, den: 3 });
  });
});
