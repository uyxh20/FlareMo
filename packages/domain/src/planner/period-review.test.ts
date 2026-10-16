import { plannerPeriodMemoClientId } from "@flaremo/contracts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ValidationError } from "../errors";
import { createMemo } from "../memos-write";
import { plannerCreateGoal, plannerUpsertWeek } from "./goals";
import {
  plannerPeriodStatus,
  plannerReadPeriodReview,
  plannerSavePeriodReview,
  plannerSavePeriodState,
  plannerStartPeriodOver,
} from "./period-review";
import {
  plannerReadPeriodContext,
  plannerVerifyQuote,
} from "./period-review-context";
import {
  plannerCleanPeriodMemo,
  plannerMergePeriodThemes,
  plannerParsePeriodChecks,
  plannerPeriodChecksMessages,
  plannerPeriodCoachMessages,
  plannerPeriodMemoMessages,
  plannerRewriteRate,
} from "./period-review-prompts";
import {
  type PlannerTestRuntime,
  plannerTestInsertTask,
  plannerTestRows,
  plannerTestRun,
  plannerTestRuntime,
} from "./test-support";

// The month, quarter and year reviews (period-review.ts, migration 9013):
// what they read, how receipts are checked, and what saving writes.

const OCTOBER = "2026-10-01";
const SUNDAY = "2026-11-01";
const W41 = "2026-10-05";
const W42 = "2026-10-12";

describe("the period review", () => {
  let rt: PlannerTestRuntime;

  beforeAll(async () => {
    rt = await plannerTestRuntime("flaremo-planner-period-review");
  });
  afterAll(async () => {
    await rt.dispose();
  });
  beforeEach(async () => {
    await rt.reset();
    await rt.database.batch(
      ["memo_tags", "memo_revisions", "memos", "health_entry"].map((table) =>
        rt.database.prepare(`DELETE FROM ${table}`),
      ),
    );
  });

  const entry = (content: string, createdAt: string) =>
    createMemo(rt.db, rt.user, {
      content,
      visibility: "private",
      source: "web",
    }).then((memo) =>
      plannerTestRun(
        rt.database,
        "UPDATE memos SET created_at = ?, updated_at = ? WHERE id = ?",
        createdAt,
        createdAt,
        memo.id,
      ),
    );

  const read = (level?: "month" | "quarter" | "year", period?: string) =>
    plannerReadPeriodReview(rt.db, {
      userId: rt.user.id,
      ownerName: rt.user.name,
      today: SUNDAY,
      level,
      period,
      ai: true,
    });

  it("reads the month's weeks with their records and raw counts", async () => {
    await entry(
      "Shipped the exporter on Tuesday, late night.",
      "2026-10-06T21:00:00.000Z",
    );
    await entry("Rest day. Walked the harbour.", "2026-10-14T10:00:00.000Z");
    await plannerUpsertWeek(rt.db, {
      userId: rt.user.id,
      weekStart: W41,
      patch: { auth: 4, ach: 3.5, question: "Did the exporter ship?" },
    });
    await plannerTestInsertTask(rt.database, {
      id: "tasks/done-1",
      userId: rt.user.id,
      title: "Write the exporter",
      status: "done",
      completedAt: "2026-10-07T12:00:00.000Z",
    });
    await plannerTestRun(
      rt.database,
      `INSERT INTO health_entry (id, user_id, kind, day, variant, feel, source, created_at, updated_at)
       VALUES ('h1', ?, 'training', '2026-10-13', 'crossfit', 'legs like lead', 'manual', '2026-10-13T08:00:00.000Z', '2026-10-13T08:00:00.000Z')`,
      rt.user.id,
    );
    const goal = await plannerCreateGoal(rt.db, {
      userId: rt.user.id,
      goal: {
        level: "month",
        periodStart: OCTOBER,
        pillar: "work",
        title: "Ship the exporter",
      },
    });

    const review = await read("month", OCTOBER);
    expect(review.level).toBe("month");
    expect(review.label).toBe("October 2026");
    expect(review.weeks.map((week) => week.week_start)).toEqual([
      "2026-09-28",
      W41,
      W42,
      "2026-10-19",
      "2026-10-26",
    ]);
    const w41 = review.weeks[1];
    expect(w41?.auth).toBe(4);
    expect(w41?.question).toBe("Did the exporter ship?");
    expect(w41?.entries).toBe(1);
    expect(w41?.tasks_done).toBe(1);
    const w42 = review.weeks[2];
    expect(w42?.entries).toBe(1);
    expect(w42?.health_rows).toBe(1);
    expect(w42?.training).toBe(1);
    expect(w42?.first_lines[0]).toBe("Rest day. Walked the harbour.");
    expect(review.goals.map((item) => item.id)).toEqual([goal.id]);
    expect(review.due).toEqual([
      { level: "month", period_start: OCTOBER, done: false },
    ]);
    expect(review.look_back_done).toBe(false);
    expect(review.done_at).toBeNull();
  });

  it("checks a quote word for word against the raw rows", async () => {
    await entry(
      "Shipped the exporter on Tuesday, late night.",
      "2026-10-06T21:00:00.000Z",
    );
    await plannerTestRun(
      rt.database,
      `INSERT INTO health_entry (id, user_id, kind, day, feel, source, created_at, updated_at)
       VALUES ('h1', ?, 'training', '2026-10-13', 'Legs like lead, still went', 'manual', '2026-10-13T08:00:00.000Z', '2026-10-13T08:00:00.000Z')`,
      rt.user.id,
    );
    const context = await plannerReadPeriodContext(rt.db, {
      userId: rt.user.id,
      ownerName: "Owner",
      level: "month",
      periodStart: OCTOBER,
      today: SUNDAY,
    });
    expect(
      plannerVerifyQuote("shipped the exporter on tuesday", context.raw),
    ).toMatchObject({
      verified: true,
      source: { source: "memo", day: "2026-10-06" },
    });
    expect(
      plannerVerifyQuote("Legs like lead, still went!", context.raw),
    ).toMatchObject({
      verified: true,
      source: { source: "health", id: "h1" },
    });
    expect(
      plannerVerifyQuote("shipped the importer on tuesday", context.raw)
        .verified,
    ).toBe(false);
    // Too short to mean anything.
    expect(plannerVerifyQuote("the", context.raw).verified).toBe(false);

    const parsed = plannerParsePeriodChecks(
      JSON.stringify({
        checks: [
          {
            week_start: W41,
            claim: "The exporter shipped",
            quote: "Shipped the exporter on Tuesday",
            holds: true,
          },
          {
            week_start: W41,
            claim: "Rested all week",
            quote: "slept all week",
            holds: true,
          },
        ],
        left_out: [
          { quote: "Tuesday, late night", why: "No summary says it ran late." },
        ],
      }),
      context,
    );
    expect(parsed.checks.map((check) => [check.holds, check.verified])).toEqual(
      [
        [true, true],
        [false, false],
      ],
    );
    expect(parsed.left_out[0]?.verified).toBe(true);
  });

  it("merges two readers' themes and counts their agreement", async () => {
    await entry(
      "Late nights after shipping, again.",
      "2026-10-06T21:00:00.000Z",
    );
    const context = await plannerReadPeriodContext(rt.db, {
      userId: rt.user.id,
      ownerName: "Owner",
      level: "quarter",
      periodStart: OCTOBER,
      today: SUNDAY,
    });
    const merged = plannerMergePeriodThemes(
      JSON.stringify({
        themes: [
          {
            label: "late nights after shipping",
            pillar: "work",
            quote: "Late nights after shipping",
          },
          { label: "training slips", pillar: "health", quote: "" },
        ],
      }),
      JSON.stringify({
        themes: [
          {
            label: "shipping means late nights",
            pillar: "work",
            quote: "nights after shipping, again",
          },
        ],
      }),
      context,
    );
    expect(
      merged.themes.map((theme) => [theme.readers, theme.verified]),
    ).toEqual([
      [2, true],
      [1, false],
    ]);
    expect(merged.agreement).toBe(0.5);
  });

  it("builds prompts from the raw rows and never asks the model for goals", async () => {
    await entry("Shipped the exporter on Tuesday.", "2026-10-06T21:00:00.000Z");
    const context = await plannerReadPeriodContext(rt.db, {
      userId: rt.user.id,
      ownerName: "Owner",
      level: "month",
      periodStart: OCTOBER,
      today: SUNDAY,
      diaryChars: 60_000,
    });
    const checks = plannerPeriodChecksMessages(context)
      .map((m) => m.content)
      .join("\n");
    expect(checks).toContain("Shipped the exporter on Tuesday.");
    expect(checks).toContain("October 2026");
    const coach = plannerPeriodCoachMessages(context, {
      step: "fold",
      messages: [{ role: "user", content: "Work: the exporter shipped." }],
      answers: { check: ["The summaries skipped the late nights."] },
    });
    expect(coach.at(-1)).toEqual({
      role: "user",
      content: "Work: the exporter shipped.",
    });
    expect(coach[0]?.content).toContain("never suggest goals");
    expect(coach[1]?.content).toContain(
      "The summaries skipped the late nights.",
    );
    const memo = plannerPeriodMemoMessages(context, {
      answers: { fold: ["Work: shipped the exporter."] },
      goalResults: [],
      verdict: { kind: "continue", text: "Keep shipping." },
      forecast: "November ships the importer.",
    });
    expect(memo[1]?.content).toContain("# Month review: October 2026");
    expect(memo[1]?.content).toContain("November ships the importer.");
  });

  it("cleans a memo and reads the rewrite rate", () => {
    const cleaned = plannerCleanPeriodMemo(
      "Here is the memo:\n```markdown\n# Month review: October 2026\n\n## The fold\n- Work: shipped\n```",
      "month",
      OCTOBER,
    );
    expect(cleaned.startsWith("# Month review: October 2026")).toBe(true);
    expect(cleaned.endsWith("_month review · 2026-10-01_")).toBe(true);
    expect(plannerRewriteRate(null, cleaned)).toBeNull();
    expect(plannerRewriteRate(cleaned, cleaned)).toBe(0);
    expect(
      plannerRewriteRate(
        cleaned,
        `${cleaned}\n- Health: trained twice\n- AI: nothing`,
      ),
    ).toBe(0.5);
  });

  it("saves the memo, the goal results, the receipts, the forecast and the last period's grade", async () => {
    await entry("Shipped the exporter on Tuesday.", "2026-10-06T21:00:00.000Z");
    const goal = await plannerCreateGoal(rt.db, {
      userId: rt.user.id,
      goal: {
        level: "month",
        periodStart: OCTOBER,
        pillar: "work",
        title: "Ship the exporter",
      },
    });
    await plannerTestRun(
      rt.database,
      `INSERT INTO planner_period_review (user_id, level, period_start, forecast, created_at, updated_at)
       VALUES (?, 'month', '2026-09-01', 'October ships the exporter.', '2026-10-04T10:00:00.000Z', '2026-10-04T10:00:00.000Z')`,
      rt.user.id,
    );
    const before = await read("month", OCTOBER);
    expect(before.previous).toMatchObject({
      period_start: "2026-09-01",
      forecast: "October ships the exporter.",
      forecast_grade: null,
    });

    const saved = await plannerSavePeriodReview(rt.db, {
      user: rt.user,
      level: "month",
      periodStart: OCTOBER,
      body: {
        today: SUNDAY,
        memo: "# Month review: October 2026\n\n## The fold\n- Work: shipped the exporter.",
        draft_memo:
          "# Month review: October 2026\n\n## The fold\n(not answered)",
        verdict: { kind: "continue", text: "Keep shipping." },
        forecast: "November ships the importer.",
        previous_grade: "held",
        goal_results: [
          { goal_id: goal.id, result: "met", note: "entry of 6 Oct" },
          { goal_id: "goals/elsewhere", result: "met" },
        ],
        evidence: [
          {
            pillar: "work",
            claim: "The exporter shipped",
            quote: "Shipped the exporter on Tuesday",
          },
          {
            pillar: "work",
            claim: "Slept well",
            quote: "slept like a log all month",
          },
        ],
      },
    });
    expect(saved.rewrite_rate).toBe(0.5);
    expect(saved.evidence.map((item) => [item.verified, item.source])).toEqual([
      [true, "memo"],
      [false, null],
    ]);

    const memos = await plannerTestRows<{ content: string; source: string }>(
      rt.database,
      "SELECT content, source FROM memos WHERE client_id = ?",
      plannerPeriodMemoClientId("month", OCTOBER),
    );
    expect(memos).toHaveLength(1);
    expect(memos[0]?.source).toBe("period-review");
    expect(memos[0]?.content).toContain("_month review · 2026-10-01_");
    const tags = await plannerTestRows<{ tag: string }>(
      rt.database,
      "SELECT tag FROM memo_tags WHERE memo_id = ?",
      saved.memo_id,
    );
    expect(tags.map((row) => row.tag)).toContain("vault-summary");

    const after = await read("month", OCTOBER);
    expect(after.done_at).toBe(saved.done_at);
    expect(after.verdict).toBe("continue: Keep shipping.");
    expect(after.forecast).toBe("November ships the importer.");
    expect(after.goals[0]?.result).toBe("met");
    expect(after.goals[0]?.note).toBe("entry of 6 Oct");
    expect(after.previous?.forecast_grade).toBe("held");
    expect(after.memo?.content).toContain("## The fold");
    expect(after.due).toEqual([
      { level: "month", period_start: OCTOBER, done: true },
    ]);

    // Saving again replaces the receipts and keeps one memo.
    await plannerSavePeriodReview(rt.db, {
      user: rt.user,
      level: "month",
      periodStart: OCTOBER,
      body: {
        today: SUNDAY,
        memo: "# Month review: October 2026\n\n## The fold\n- Work: shipped it, late.",
        draft_memo: null,
        verdict: null,
        forecast: null,
        previous_grade: null,
        goal_results: [],
        evidence: [],
      },
    });
    const again = await read("month", OCTOBER);
    expect(again.evidence).toEqual([]);
    expect(again.rewrite_rate).toBeNull();
    expect(
      await plannerTestRows(
        rt.database,
        "SELECT id FROM memos WHERE client_id = ?",
        plannerPeriodMemoClientId("month", OCTOBER),
      ),
    ).toHaveLength(1);
  });

  it("keeps the page's state, starts over, and reports what is due", async () => {
    await plannerSavePeriodState(rt.db, {
      userId: rt.user.id,
      level: "month",
      periodStart: OCTOBER,
      state: { step: 3, answers: { fold: ["Work: shipped"] } },
    });
    expect((await read("month", OCTOBER)).state).toEqual({
      step: 3,
      answers: { fold: ["Work: shipped"] },
    });
    const status = await plannerPeriodStatus(rt.db, {
      userId: rt.user.id,
      today: SUNDAY,
    });
    expect(status).toEqual({
      review_week: "2026-10-26",
      look_back_done: false,
      due: [{ level: "month", period_start: OCTOBER, done: false }],
      any_due: true,
    });
    // A Wednesday: nothing is due, and the default level is still the month.
    const midweek = await plannerPeriodStatus(rt.db, {
      userId: rt.user.id,
      today: "2026-11-04",
    });
    expect(midweek.any_due).toBe(false);
    expect(midweek.due).toHaveLength(1);

    await plannerStartPeriodOver(rt.db, {
      userId: rt.user.id,
      level: "month",
      periodStart: OCTOBER,
    });
    expect((await read("month", OCTOBER)).state).toEqual({});

    await expect(
      plannerSavePeriodState(rt.db, {
        userId: rt.user.id,
        level: "month",
        periodStart: "2026-10-02",
        state: {},
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(read("year", "2027-01-01")).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect((await read()).level).toBe("month");
    expect((await read("quarter")).period_start).toBe("2026-07-01");
  });
});
