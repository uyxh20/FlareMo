import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ValidationError } from "../errors";
import { plannerAgentSettleAction } from "./agent-store";
import {
  plannerAddTuningProposal,
  plannerCurrentTuning,
  plannerEditChars,
  plannerFlywheelProposalsPaused,
  plannerFlywheelRollup,
  plannerParseTuningProposal,
  plannerReadFlywheel,
  plannerSaveTuningNote,
  plannerSettleTuning,
  plannerTuningBlock,
  plannerTuningProposalDue,
  plannerTuningProposalMessages,
  plannerTuningVerdict,
} from "./flywheel";
import { plannerCreateGoal, plannerUpdateGoal } from "./goals";
import {
  type PlannerTestRuntime,
  plannerTestInsertTask,
  plannerTestRows,
  plannerTestRun,
  plannerTestRuntime,
} from "./test-support";

// The flywheel (flywheel.ts, migration 9017, docs/fork-flywheel.md): the log of
// goal changes, the weekly scorecard built from the record, and the owner's
// tuning of the agent with its four-week verdict.

let rt: PlannerTestRuntime;
const WEEK = "2026-10-19";
const NOW = new Date("2026-11-04T10:00:00.000Z");
const DAY = 86_400_000;

type EventRow = {
  kind: string;
  subject: string;
  subject_id: string | null;
  origin: string;
  data: string;
};

const events = () =>
  plannerTestRows<EventRow>(
    rt.database,
    "SELECT kind, subject, subject_id, origin, data FROM planner_event WHERE user_id = ? ORDER BY occurred_at, rowid",
    rt.user.id,
  );

async function action(input: {
  kind: string;
  state: string;
  createdAt: string;
  shownAt?: string | null;
  settledAt?: string | null;
  landedId?: string | null;
  taskId?: string | null;
  /** The Ask chat it came from; null for a file read the owner started. */
  conversationId?: string | null;
}) {
  const id = crypto.randomUUID();
  await plannerTestRun(
    rt.database,
    `INSERT INTO planner_agent_action (id, user_id, conversation_id, kind, task_id, state, landed_id, created_at, shown_at, settled_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    rt.user.id,
    input.conversationId === undefined ? "chat-1" : input.conversationId,
    input.kind,
    input.taskId ?? null,
    input.state,
    input.landedId ?? null,
    input.createdAt,
    input.shownAt ?? null,
    input.settledAt ?? null,
  );
  return id;
}

const value = (
  week: Awaited<ReturnType<typeof plannerFlywheelRollup>>,
  metric: string,
  origin: string,
) =>
  week.values.find(
    (entry) => entry.metric === metric && entry.origin === origin,
  );

describe("the flywheel", () => {
  beforeAll(async () => {
    rt = await plannerTestRuntime("planner-flywheel-test");
  });

  afterAll(async () => {
    await rt.dispose();
  });

  beforeEach(async () => {
    await rt.reset();
  });

  it("logs a goal's creation, rewrite and result with sizes, never its words", async () => {
    const goal = await plannerCreateGoal(rt.db, {
      userId: rt.user.id,
      goal: { level: "week", periodStart: WEEK, title: "Ship the guide" },
      now: new Date("2026-10-19T08:00:00.000Z"),
    });
    await plannerUpdateGoal(rt.db, {
      userId: rt.user.id,
      goalId: goal.id,
      patch: { title: "Ship the guide's first part" },
      now: new Date("2026-10-19T09:00:00.000Z"),
    });
    await plannerUpdateGoal(rt.db, {
      userId: rt.user.id,
      goalId: goal.id,
      patch: { result: "met" },
      now: new Date("2026-10-25T20:00:00.000Z"),
    });
    const rows = await events();
    expect(rows.map((row) => row.kind)).toEqual([
      "goal.created",
      "goal.rewritten",
      "goal.judged",
    ]);
    for (const row of rows) {
      expect(row.subject).toBe("goal");
      expect(row.subject_id).toBe(goal.id);
      expect(row.origin).toBe("manual");
      expect(row.data).not.toContain("guide");
    }
    const rewrite = JSON.parse(rows[1]?.data ?? "{}");
    expect(rewrite.edit_chars).toBeGreaterThan(0);
    expect(JSON.parse(rows[2]?.data ?? "{}").result).toBe("met");
  });

  it("measures an edit by the characters that changed", () => {
    expect(plannerEditChars("abc", "abc")).toBe(0);
    expect(plannerEditChars("", "abcd")).toBe(4);
    expect(plannerEditChars("the cat sat", "the dog sat")).toBeGreaterThan(0);
  });

  it("builds a week's scorecard from tasks, goals and the agent's proposals", async () => {
    // Five tasks due in the week: three done by their day, one late, one open.
    const due = [
      ["t1", "2026-10-20", "2026-10-20T10:00:00.000Z"],
      ["t2", "2026-10-21", "2026-10-21T23:00:00.000Z"],
      ["t3", "2026-10-22", "2026-10-21T09:00:00.000Z"],
      ["t4", "2026-10-22", "2026-10-24T09:00:00.000Z"],
      ["t5", "2026-10-23", null],
    ] as const;
    for (const [id, dueAt, completedAt] of due) {
      await plannerTestInsertTask(rt.database, {
        id,
        userId: rt.user.id,
        dueAt,
        completedAt,
        status: completedAt ? "done" : "todo",
      });
    }
    // The agent added t1 through an accepted proposal.
    await action({
      kind: "task_new",
      state: "accepted",
      createdAt: "2026-10-19T08:00:00.000Z",
      shownAt: "2026-10-19T08:01:00.000Z",
      settledAt: "2026-10-19T08:02:00.000Z",
      landedId: "t1",
    });
    // Three more proposals: two seen and dismissed, one never shown.
    await action({
      kind: "task_change",
      state: "dismissed",
      createdAt: "2026-10-20T08:00:00.000Z",
      shownAt: "2026-10-20T08:01:00.000Z",
      settledAt: "2026-10-20T08:02:00.000Z",
    });
    await action({
      kind: "task_change",
      state: "dismissed",
      createdAt: "2026-10-20T09:00:00.000Z",
      shownAt: "2026-10-20T09:01:00.000Z",
      settledAt: "2026-10-20T09:02:00.000Z",
    });
    await action({
      kind: "entry_new",
      state: "expired",
      createdAt: "2026-10-21T09:00:00.000Z",
      settledAt: "2026-10-22T09:00:00.000Z",
    });
    for (const result of ["met", "partial"] as const) {
      await plannerCreateGoal(rt.db, {
        userId: rt.user.id,
        goal: { level: "week", periodStart: WEEK, title: "Goal", result },
      });
    }

    const week = await plannerFlywheelRollup(rt.db, {
      userId: rt.user.id,
      weekStart: WEEK,
      now: NOW,
    });
    expect(value(week, "proposals_seen", "ai")).toMatchObject({
      num: 3,
      den: 4,
      value: 0.75,
    });
    expect(value(week, "proposals_accepted", "ai")).toMatchObject({
      num: 1,
      den: 4,
    });
    // t1 had no owner edit within the week after the accept: kept.
    expect(value(week, "kept_7d", "ai")).toMatchObject({ num: 1, den: 1 });
    expect(value(week, "tasks_done_by_due", "all")).toMatchObject({
      num: 3,
      den: 5,
    });
    expect(value(week, "tasks_done_by_due", "ai")).toMatchObject({
      num: 1,
      den: 1,
    });
    expect(value(week, "tasks_done_by_due", "manual")).toMatchObject({
      num: 2,
      den: 4,
    });
    expect(value(week, "goals_met", "manual")).toMatchObject({
      num: 1,
      den: 2,
    });
    expect(value(week, "goals_met", "ai")).toMatchObject({ num: 0, den: 0 });

    const stored = await plannerTestRows<{ count: number }>(
      rt.database,
      "SELECT count(*) AS count FROM planner_metric_week WHERE user_id = ? AND week_start = ?",
      rt.user.id,
      WEEK,
    );
    expect(stored[0]?.count).toBe(week.values.length);
    // A rebuild replaces the week's rows rather than adding to them.
    await plannerFlywheelRollup(rt.db, {
      userId: rt.user.id,
      weekStart: WEEK,
      now: NOW,
    });
    const again = await plannerTestRows<{ count: number }>(
      rt.database,
      "SELECT count(*) AS count FROM planner_metric_week WHERE user_id = ?",
      rt.user.id,
    );
    expect(again[0]?.count).toBe(week.values.length);
    // The other member's scorecard is untouched and empty.
    const other = await plannerTestRows(
      rt.database,
      "SELECT * FROM planner_metric_week WHERE user_id = ?",
      rt.other.id,
    );
    expect(other).toEqual([]);
  });

  it("pauses proposing when almost none of the agent's proposals were seen", async () => {
    for (let index = 0; index < 10; index += 1) {
      await action({
        kind: "task_change",
        state: "expired",
        createdAt: new Date(
          NOW.getTime() - DAY - (index + 1) * 3_600_000,
        ).toISOString(),
      });
    }
    expect(
      await plannerFlywheelProposalsPaused(rt.db, {
        userId: rt.user.id,
        now: NOW,
      }),
    ).toBe(true);
    await plannerTestRun(
      rt.database,
      "UPDATE planner_agent_action SET shown_at = created_at WHERE user_id = ? AND rowid IN (SELECT rowid FROM planner_agent_action LIMIT 2)",
      rt.user.id,
    );
    expect(
      await plannerFlywheelProposalsPaused(rt.db, {
        userId: rt.user.id,
        now: NOW,
      }),
    ).toBe(false);
  });

  it("saves the week's note to the agent, or a pass", async () => {
    await plannerSaveTuningNote(rt.db, {
      userId: rt.user.id,
      weekStart: WEEK,
      note: "  Fewer task proposals on weekends. ",
      now: NOW,
    });
    let card = await plannerReadFlywheel(rt.db, {
      userId: rt.user.id,
      weekStart: WEEK,
      canPropose: false,
      now: NOW,
    });
    expect(card.note).toBe("Fewer task proposals on weekends.");
    expect(card.note_skipped).toBe(false);
    expect(card.last_viewed_days).toBeNull();
    await plannerSaveTuningNote(rt.db, {
      userId: rt.user.id,
      weekStart: WEEK,
      note: null,
      now: NOW,
    });
    card = await plannerReadFlywheel(rt.db, {
      userId: rt.user.id,
      weekStart: WEEK,
      canPropose: true,
      now: new Date(NOW.getTime() + 2 * DAY),
    });
    expect(card.note).toBeNull();
    expect(card.note_skipped).toBe(true);
    expect(card.last_viewed_days).toBe(2);
    expect(card.can_propose).toBe(true);
    expect(card.weeks[0]?.week_start).toBe(WEEK);
    const kinds = (await events()).map((row) => row.kind);
    expect(kinds).toEqual([
      "review.tuning_note",
      "scorecard.viewed",
      "review.tuning_skipped",
      "scorecard.viewed",
    ]);
    expect(JSON.stringify(await events())).not.toContain("weekends");
  });

  it("runs a tuning version from proposal to verdict and rollback", async () => {
    expect(
      await plannerTuningProposalDue(rt.db, { userId: rt.user.id, now: NOW }),
    ).toBe(true);
    const first = await plannerAddTuningProposal(rt.db, {
      userId: rt.user.id,
      instructions: "Propose at most three tasks a day.",
      why: "",
      metric: null,
      proposedBy: "owner",
      now: NOW,
    });
    expect(first.state).toBe("proposed");
    expect(
      await plannerTuningProposalDue(rt.db, { userId: rt.user.id, now: NOW }),
    ).toBe(false);
    await plannerSettleTuning(rt.db, {
      userId: rt.user.id,
      id: first.id,
      decision: "accept",
      instructions: "Propose at most two tasks a day.",
      now: NOW,
    });
    const v1 = await plannerCurrentTuning(rt.db, rt.user.id);
    expect(v1).toMatchObject({
      version: 1,
      state: "active",
      instructions: "Propose at most two tasks a day.",
    });
    expect(plannerTuningBlock(v1)).toContain("version 1");
    expect(plannerTuningBlock(v1)).toContain("at most two tasks");
    expect(plannerTuningBlock(null)).toBe("");
    await expect(
      plannerSettleTuning(rt.db, {
        userId: rt.user.id,
        id: first.id,
        decision: "dismiss",
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    const later = new Date(NOW.getTime() + 30 * DAY);
    const second = await plannerAddTuningProposal(rt.db, {
      userId: rt.user.id,
      instructions: "Propose at most two tasks a day. Skip weekends.",
      why: "Weekend proposals were rarely kept.",
      metric: "kept_7d",
      proposedBy: "agent",
      model: "test-model",
      now: later,
    });
    await plannerSettleTuning(rt.db, {
      userId: rt.user.id,
      id: second.id,
      decision: "accept",
      now: later,
    });
    const v2 = await plannerCurrentTuning(rt.db, rt.user.id);
    expect(v2).toMatchObject({ version: 2, state: "active", parentId: v1?.id });
    const states = await plannerTestRows<{ version: number; state: string }>(
      rt.database,
      "SELECT version, state FROM planner_tuning WHERE user_id = ? ORDER BY version",
      rt.user.id,
    );
    expect(states).toEqual([
      { version: 1, state: "superseded" },
      { version: 2, state: "active" },
    ]);

    // No verdict before its four weeks; one after.
    expect(
      await plannerTuningVerdict(rt.db, { userId: rt.user.id, now: later }),
    ).toBeNull();
    const judged = new Date(later.getTime() + 29 * DAY);
    const verdict = await plannerTuningVerdict(rt.db, {
      userId: rt.user.id,
      now: judged,
    });
    expect(verdict).toMatchObject({ metric: "kept_7d", after_den: 0 });
    await plannerSettleTuning(rt.db, {
      userId: rt.user.id,
      id: second.id,
      decision: "roll_back",
      now: judged,
    });
    const v3 = await plannerCurrentTuning(rt.db, rt.user.id);
    expect(v3).toMatchObject({
      version: 3,
      state: "kept",
      instructions: "Propose at most two tasks a day.",
    });
    expect(
      await plannerTuningVerdict(rt.db, { userId: rt.user.id, now: judged }),
    ).toBeNull();
    const kinds = (await events()).map((row) => row.kind);
    expect(kinds).toEqual([
      "tuning.proposed",
      "tuning.accepted",
      "tuning.proposed",
      "tuning.accepted",
      "tuning.rolled_back",
    ]);
  });

  it("asks for a tuning proposal with numbers and notes, and reads the answer", () => {
    const messages = plannerTuningProposalMessages({
      ownerName: "Anon",
      current: { version: 2, instructions: "Be brief." },
      weeks: [
        {
          week_start: WEEK,
          values: [
            {
              metric: "kept_7d",
              origin: "ai",
              value: 0.5,
              num: 6,
              den: 12,
            },
          ],
        },
      ],
      notes: [{ week: WEEK, note: "Stop proposing errands." }],
    });
    const user = messages[1]?.content ?? "";
    expect(user).toContain("kept_7d/ai=50% of 12");
    expect(user).toContain("Stop proposing errands.");
    expect(user).toContain("Be brief.");

    expect(
      plannerParseTuningProposal(
        'Here: {"instructions": "Be brief.\\nNo errands.", "why": "Errands were dismissed.", "metric": "proposals_accepted"}',
      ),
    ).toEqual({
      instructions: "Be brief.\nNo errands.",
      why: "Errands were dismissed.",
      metric: "proposals_accepted",
    });
    expect(
      plannerParseTuningProposal('{"instructions": "x", "metric": "nope"}')
        ?.metric,
    ).toBeNull();
    expect(plannerParseTuningProposal('{"why": "x"}')).toBeNull();
    expect(plannerParseTuningProposal("no json")).toBeNull();
  });
  it("never pauses on file reads the owner started, and counts a settled card as seen", async () => {
    for (let index = 0; index < 12; index += 1) {
      await action({
        kind: "comment_new",
        state: "expired",
        conversationId: null,
        createdAt: new Date(
          NOW.getTime() - DAY - (index + 1) * 3_600_000,
        ).toISOString(),
      });
    }
    expect(
      await plannerFlywheelProposalsPaused(rt.db, {
        userId: rt.user.id,
        now: NOW,
      }),
    ).toBe(false);
    const open = await action({
      kind: "comment_new",
      state: "open",
      conversationId: null,
      createdAt: "2026-11-03T09:00:00.000Z",
    });
    await plannerAgentSettleAction(rt.db, {
      userId: rt.user.id,
      id: open,
      state: "accepted",
      now: new Date("2026-11-03T10:00:00.000Z"),
    });
    await plannerAgentSettleAction(rt.db, {
      userId: rt.user.id,
      id: open,
      state: "reverted",
      now: new Date("2026-11-20T10:00:00.000Z"),
    });
    const [row] = await plannerTestRows<{
      shown_at: string | null;
      settled_at: string | null;
      state: string;
    }>(
      rt.database,
      "SELECT shown_at, settled_at, state FROM planner_agent_action WHERE id = ?",
      open,
    );
    // Seen when it was settled; the revert keeps the accept's time and week.
    expect(row).toEqual({
      shown_at: "2026-11-03T10:00:00.000Z",
      settled_at: "2026-11-03T10:00:00.000Z",
      state: "reverted",
    });
  });

  it("logs the open proposal a new one replaces as dismissed", async () => {
    const first = await plannerAddTuningProposal(rt.db, {
      userId: rt.user.id,
      instructions: "One.",
      why: "",
      metric: null,
      proposedBy: "agent",
      now: NOW,
    });
    await plannerAddTuningProposal(rt.db, {
      userId: rt.user.id,
      instructions: "Two.",
      why: "",
      metric: null,
      proposedBy: "owner",
      now: NOW,
    });
    const rows = await events();
    expect(rows.map((row) => [row.kind, row.subject_id])).toEqual([
      ["tuning.proposed", first.id],
      ["tuning.dismissed", first.id],
      ["tuning.proposed", expect.any(String)],
    ]);
  });

  it("logs a goal's note edit by size", async () => {
    const goal = await plannerCreateGoal(rt.db, {
      userId: rt.user.id,
      goal: { level: "week", periodStart: WEEK, title: "Ship" },
    });
    await plannerUpdateGoal(rt.db, {
      userId: rt.user.id,
      goalId: goal.id,
      patch: { note: "Private words" },
    });
    const noted = (await events()).find((row) => row.kind === "goal.noted");
    expect(JSON.parse(noted?.data ?? "{}")).toMatchObject({
      length_before: 0,
      length_after: 13,
    });
    expect(noted?.data).not.toContain("Private");
  });
});
