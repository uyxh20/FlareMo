import type { PlannerPeriodReviewResponse } from "@flaremo/contracts";
import { describe, expect, it } from "vitest";
import {
  plannerGradeAboveReceipts,
  plannerPeriodScoreStats,
  plannerPeriodTemplate,
  plannerRestorePeriodState,
} from "./period-model";

// The period review page's state helpers (period-model.ts).

const week = (
  week_start: string,
  number: number,
  auth: number | null,
  ach: number | null,
): PlannerPeriodReviewResponse["weeks"][number] => ({
  week_start,
  number,
  auth,
  ach,
  question: null,
  verdict: null,
  memo_id: null,
  entries: 0,
  entry_chars: 0,
  health_rows: 0,
  training: 0,
  breath_days: 0,
  nights_out: 0,
  tasks_done: 0,
  goal_results: { met: 0, partial: 0, missed: 0, open: 0 },
  first_lines: [],
});

const review: PlannerPeriodReviewResponse = {
  level: "month",
  period_start: "2026-10-01",
  period_end: "2026-10-31",
  label: "October 2026",
  review_week: "2026-10-26",
  look_back_done: true,
  due: [{ level: "month", period_start: "2026-10-01", done: false }],
  weeks: [
    week("2026-09-28", 40, 4, 3),
    week("2026-10-05", 41, 4.5, 4),
    week("2026-10-12", 42, null, null),
    week("2026-10-19", 43, 3.5, 3.5),
  ],
  goals: [
    {
      id: "g1",
      level: "month",
      period_start: "2026-10-01",
      pillar: "work",
      title: "Ship the exporter",
      lines: [],
      status: "active",
      note: null,
      result: "partial",
      tasks_linked: 2,
      tasks_done: 0,
    },
  ],
  child_goals: [],
  north_star: null,
  previous: null,
  memories: { created: 0, revised: 0, created_lines: [], revised_lines: [] },
  state: {},
  done_at: null,
  memo: null,
  verdict: null,
  forecast: null,
  rewrite_rate: null,
  evidence: [],
  ai: true,
};

describe("restoring the saved state", () => {
  it("keeps what fits the review and drops the rest", () => {
    const state = plannerRestorePeriodState(
      {
        step: 9,
        answers: { fold: ["Work: shipped", 3], nope: ["x"] },
        chat: {
          fold: [
            { role: "user", content: "hi" },
            { role: "robot", content: "no" },
          ],
        },
        goals: {
          g1: { result: "met", decision: "kill", note: "n" },
          g9: { result: "met" },
        },
        weekMarks: {
          "2026-10-05": "repeat",
          "2026-10-06": "never",
          "2026-10-12": "maybe",
        },
        evidence: [
          { claim: "a", quote: "b", pillar: "work" },
          { claim: "", quote: "b" },
        ],
        verdict: { kind: "pivot", text: "t" },
        forecast: "f",
        previousGrade: "held",
        memo: "# m",
        draftMemo: "# d",
        memoBy: "model",
        memoSaved: true,
      },
      review,
    );
    expect(state.step).toBe(5);
    expect(state.answers).toEqual({ fold: ["Work: shipped"] });
    expect(state.chat).toEqual({ fold: [{ role: "user", content: "hi" }] });
    expect(state.goals).toEqual({
      g1: { result: "met", decision: "kill", note: "n" },
    });
    expect(state.weekMarks).toEqual({ "2026-10-05": "repeat" });
    expect(state.evidence).toEqual([
      { claim: "a", quote: "b", pillar: "work" },
    ]);
    expect(state.verdict).toEqual({ kind: "pivot", text: "t" });
    expect(state.previousGrade).toBe("held");
    expect(state.memo).toBe("# m");
    expect(state.memoBy).toBe("model");
    expect(state.memoSaved).toBe(true);
  });

  it("starts from the goals' recorded results and the saved memo", () => {
    const state = plannerRestorePeriodState(
      {},
      { ...review, memo: { id: "memos/1", content: "# saved" } },
    );
    expect(state.step).toBe(1);
    expect(state.goals).toEqual({
      g1: { result: "partial", decision: null, note: "" },
    });
    expect(state.memo).toBe("# saved");
    expect(state.memoBy).toBe("page");
    expect(state.memoSaved).toBe(true);
  });
});

describe("score stats", () => {
  it("reads mean, spread and weeks under the floors from the scored weeks", () => {
    const stats = plannerPeriodScoreStats(review.weeks);
    expect(stats.scored).toBe(3);
    expect(stats.auth).toEqual({ mean: 4, spread: 1, below: 1 });
    expect(stats.ach).toEqual({ mean: 3.5, spread: 1, below: 1 });
  });
});

describe("the page's own memo", () => {
  it("lays the owner's words under the steps' headings", () => {
    const state = plannerRestorePeriodState(
      {
        answers: { fold: ["Work: shipped the exporter."] },
        goals: { g1: { result: "met", decision: null, note: "6 Oct" } },
        verdict: { kind: "continue", text: "" },
        forecast: "November ships the importer.",
      },
      review,
    );
    const memo = plannerPeriodTemplate(review, state);
    expect(memo.startsWith("# Month review: October 2026")).toBe(true);
    expect(memo).toContain("## Write the fold\n- Work: shipped the exporter.");
    expect(memo).toContain("- Ship the exporter: met — 6 Oct");
    expect(memo).toContain("## Verdict\ncontinue");
    expect(memo).toContain("## Forecast\nNovember ships the importer.");
    expect(memo.endsWith("_month review · 2026-10-01_")).toBe(true);
  });
});

describe("a grade above its receipts", () => {
  it("flags met with no done task, no note and no receipt", () => {
    const goal = { tasks_linked: 2, tasks_done: 0 };
    expect(
      plannerGradeAboveReceipts(
        goal,
        { result: "met", decision: null, note: "" },
        0,
      ),
    ).toBe(true);
    expect(
      plannerGradeAboveReceipts(
        goal,
        { result: "met", decision: null, note: "" },
        1,
      ),
    ).toBe(false);
    expect(
      plannerGradeAboveReceipts(
        goal,
        { result: "met", decision: null, note: "entry" },
        0,
      ),
    ).toBe(false);
    expect(
      plannerGradeAboveReceipts(
        { tasks_linked: 1, tasks_done: 1 },
        { result: "met", decision: null, note: "" },
        0,
      ),
    ).toBe(false);
    expect(
      plannerGradeAboveReceipts(
        goal,
        { result: "partial", decision: null, note: "" },
        0,
      ),
    ).toBe(false);
    expect(plannerGradeAboveReceipts(goal, undefined, 0)).toBe(false);
  });
});
