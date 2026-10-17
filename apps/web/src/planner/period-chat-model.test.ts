import type { PlannerPeriodReviewResponse } from "@flaremo/contracts";
import { describe, expect, it } from "vitest";
import {
  plannerPeriodChatBase,
  plannerPeriodChatReview,
  plannerPeriodChatSaveInput,
  plannerPeriodChatTemplate,
  plannerPeriodStats,
  plannerRestorePeriodChat,
} from "./period-chat-model";

// The month and quarter chat's pure parts (period-chat-model.ts).

const GOAL = "8f0c8a52-6c43-4d4c-9b55-1f3c2b6a7d10";

const week = (
  week_start: string,
  auth: number | null,
  ach: number | null,
  extra: Partial<PlannerPeriodReviewResponse["weeks"][number]> = {},
): PlannerPeriodReviewResponse["weeks"][number] => ({
  week_start,
  number: 40,
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
  ...extra,
});

const period: PlannerPeriodReviewResponse = {
  level: "month",
  period_start: "2026-10-01",
  period_end: "2026-10-31",
  label: "October 2026",
  review_week: "2026-10-26",
  look_back_done: true,
  due: [],
  weeks: [
    week("2026-09-28", 4, 3, { entries: 6, tasks_done: 3, memo_id: "m1" }),
    week("2026-10-05", 4.5, 4, { entries: 5, tasks_done: 4, memo_id: "m2" }),
    week("2026-10-12", null, null, { entries: 2 }),
    week("2026-10-19", 3.5, 3, { entries: 7, tasks_done: 1, memo_id: "m3" }),
  ],
  goals: [
    {
      id: GOAL,
      level: "month",
      period_start: "2026-10-01",
      pillar: "work",
      title: "Ship the exporter",
      lines: [],
      status: "active",
      note: null,
      result: null,
      tasks_linked: 0,
      tasks_done: 0,
    },
  ],
  child_goals: [],
  north_star: null,
  previous: {
    period_start: "2026-09-01",
    question: "Did I ship the exporter?",
    verdict: null,
    forecast: null,
    forecast_grade: null,
    memo_id: null,
  },
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

const happened = [
  {
    pillar: "work" as const,
    claim: "The exporter shipped.",
    quote: "shipped the exporter on Tuesday",
    source: "memo" as const,
    source_id: "memo-1",
    source_day: "2026-10-06",
  },
];

describe("the period read as a week", () => {
  it("gives the weekly chat the period's goals, question and scores", () => {
    const review = plannerPeriodChatReview(period, "2026-11-01");
    expect(review.week_goals.map((goal) => goal.id)).toEqual([GOAL]);
    expect(review.last_question).toBe("Did I ship the exporter?");
    expect(review.scores).toHaveLength(4);
    // The steppers start from the weeks' mean, on the half-step scale.
    expect(review.week).toMatchObject({ auth: 4, ach: 3.5 });
    expect(review.plan_goals).toEqual([]);
  });

  it("counts what the review reads", () => {
    expect(plannerPeriodStats(period)).toEqual({
      entries: 20,
      memos: 3,
      tasksDone: 8,
      goals: 1,
    });
  });

  it("asks the period's own chat routes", () => {
    expect(plannerPeriodChatBase("quarter", "2026-10-01")).toBe(
      "/api/app/planner/period-review/quarter/2026-10-01/chat",
    );
  });
});

describe("the saved chat", () => {
  const review = plannerPeriodChatReview(period, "2026-11-01");

  it("starts fresh from a review saved by the step-by-step page", () => {
    const state = plannerRestorePeriodChat(
      { step: 3, answers: { check: ["x"] }, happened },
      review,
    );
    expect(state.back.stage).toBe("start");
    expect(state.happened).toBeNull();
  });

  it("keeps what happened once the chat has started", () => {
    const started = plannerRestorePeriodChat({}, review);
    const saved = {
      ...started,
      back: { ...started.back, stage: "p" },
      happened: [...happened, { claim: "no quote" }],
      dropped: 2,
    };
    const state = plannerRestorePeriodChat(saved, review);
    expect(state.happened).toEqual(happened);
    expect(state.dropped).toBe(2);
  });

  it("saves the memo, the verdict, the results and the receipts, no forecast", () => {
    const fresh = plannerRestorePeriodChat({}, review);
    const state = {
      ...fresh,
      happened,
      draftMemo: "# Month review: October 2026",
      back: {
        ...fresh.back,
        stage: "done" as const,
        memoBy: "model" as const,
        goalResults: { [GOAL]: "met" as const },
        verdict: { kind: "continue" as const, text: "Continue. It shipped." },
      },
    };
    const input = plannerPeriodChatSaveInput({
      state,
      review,
      today: "2026-11-01",
      memo: "# Month review: October 2026\n\nEdited.",
    });
    expect(input.forecast).toBeNull();
    expect(input.previous_grade).toBeNull();
    expect(input.draft_memo).toBe("# Month review: October 2026");
    expect(input.verdict).toEqual({
      kind: "continue",
      text: "Continue. It shipped.",
    });
    expect(input.goal_results).toEqual([
      { goal_id: GOAL, result: "met", decision: null, note: null },
    ]);
    expect(input.evidence).toEqual([
      {
        pillar: "work",
        claim: "The exporter shipped.",
        quote: "shipped the exporter on Tuesday",
      },
    ]);
  });

  it("writes its own memo from the answers when no model does", () => {
    const fresh = plannerRestorePeriodChat({}, review);
    const memo = plannerPeriodChatTemplate({
      period,
      back: {
        ...fresh.back,
        lastAnswer: ["Yes, on the 6th."],
        question: "Did I sleep before midnight?",
      },
      review,
      happened,
      today: "2026-11-01",
    });
    expect(memo).toContain("# Month review: October 2026");
    expect(memo).toContain(
      '- The exporter shipped. "shipped the exporter on Tuesday" (2026-10-06)',
    );
    expect(memo).toContain("Yes, on the 6th.");
    expect(memo).toContain(
      "**Key question for next month:** Did I sleep before midnight?",
    );
    expect(memo).not.toMatch(/forecast/i);
  });
});
