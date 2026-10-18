import { describe, expect, it } from "vitest";
import { plannerAgentPeriodOpeningMessage } from "./agent-prompts";
import {
  plannerParsePeriodOpening,
  plannerPeriodAgentKey,
  plannerPeriodChatMemoParts,
  plannerPeriodCoachSystem,
  plannerPeriodOpeningMessages,
  plannerPeriodPromptText,
} from "./period-review-chat";
import type { PlannerPeriodContext } from "./period-review-context";

// The month and quarter chat (period-review-chat.ts): the weekly review's
// prompts over a period, and what happened, kept only where the owner's own
// words back it.

const context = (
  overrides: Partial<PlannerPeriodContext> = {},
): PlannerPeriodContext => ({
  ownerName: "Sam",
  level: "month",
  periodStart: "2026-10-01",
  periodEnd: "2026-10-31",
  today: "2026-11-01",
  weeks: [],
  goals: [
    {
      id: "8f0c8a52-6c43-4d4c-9b55-1f3c2b6a7d10",
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
  childGoals: [],
  northStar: null,
  previous: null,
  memories: { created: 0, revised: 0, createdLines: [], revisedLines: [] },
  raw: [
    {
      source: "memo",
      id: "memo-1",
      day: "2026-10-06",
      text: "Shipped the exporter on Tuesday, late night, and slept badly.",
    },
    {
      source: "health",
      id: "h1",
      day: "2026-10-13",
      text: "training crossfit: legs like lead after the long session",
    },
  ],
  row: null,
  evidence: [],
  memo: null,
  ...overrides,
});

const answers = {
  lastAnswer: [],
  answers: [[], [], [], [], [], [], []],
  goalResults: [],
  coachNotes: [],
};

describe("the period chat's opening", () => {
  it("keeps the claims its words back and counts the rest", () => {
    const raw = JSON.stringify({
      happened: [
        {
          claim: "The exporter shipped.",
          quote: "shipped the exporter on Tuesday, late night",
          pillar: "work",
        },
        {
          claim: "Felt more focused than September.",
          quote: "I felt far more focused than in September",
          pillar: "of",
        },
        { claim: "Trained hard.", quote: "", pillar: "health" },
        {
          claim: "Training was heavy.",
          quote: "legs like lead after the long session",
          pillar: "nonsense",
        },
      ],
      recap: "A shipping month.",
      prompts: [],
    });
    const opening = plannerParsePeriodOpening(raw, context());
    expect(opening.recap).toBe("A shipping month.");
    expect(opening.dropped).toBe(2);
    expect(opening.happened).toEqual([
      {
        pillar: "work",
        claim: "The exporter shipped.",
        quote: "shipped the exporter on Tuesday, late night",
        source: "memo",
        source_id: "memo-1",
        source_day: "2026-10-06",
      },
      {
        pillar: null,
        claim: "Training was heavy.",
        quote: "legs like lead after the long session",
        source: "health",
        source_id: "h1",
        source_day: "2026-10-13",
      },
    ]);
  });

  it("reads an answer with no claims as nothing happened", () => {
    const opening = plannerParsePeriodOpening("not json", context());
    expect(opening.happened).toEqual([]);
    expect(opening.dropped).toBe(0);
    expect(opening.prompts).toHaveLength(7);
  });

  it("asks for last period's question only when there was one", () => {
    const without = plannerPeriodOpeningMessages(context())[1]?.content ?? "";
    expect(without).not.toContain('"lastq"');
    const withQuestion =
      plannerPeriodOpeningMessages(
        context({
          previous: {
            periodStart: "2026-09-01",
            verdict: null,
            forecast: null,
            forecastGrade: null,
            memo: null,
            question: "Did I ship the exporter?",
          },
        }),
      )[1]?.content ?? "";
    expect(withQuestion).toContain('"lastq"');
    expect(withQuestion).toContain("last month's key question");
    expect(withQuestion).toContain("Did I ship the exporter?");
  });
});

describe("the period chat's words", () => {
  it("says the weekly prompts of the period", () => {
    expect(
      plannerPeriodPromptText(
        "What is the one big thing you delivered this week?",
        "quarter",
      ),
    ).toBe("What is the one big thing you delivered this quarter?");
    expect(plannerPeriodCoachSystem(context(), "free")).toContain(
      "October 2026 review",
    );
  });

  it("keys the agent's session by the period, never a week", () => {
    expect(plannerPeriodAgentKey("month", "2026-10-01")).toBe(
      "month:2026-10-01",
    );
    const opening = plannerAgentPeriodOpeningMessage(context());
    expect(opening).toContain("Use your period-review skill.");
    expect(opening).toContain(
      "(read it with review_period for the month starting 2026-10-01;",
    );
  });

  it("writes the memo with the month's scores, question and verdict", () => {
    const parts = plannerPeriodChatMemoParts(context(), {
      ...answers,
      reviewedOn: "2026-11-01",
      scores: { auth: 4, ach: 3.5 },
      question: "Did I sleep before midnight?",
      verdict: {
        kind: "pivot",
        text: "Pivot toward sleep, away from late nights.",
      },
      recommended: "continue",
      drafts: {
        auth_evidence: "",
        ach_evidence: "",
        pattern: "",
        risk: "",
        opportunity: "",
      },
    });
    expect(parts.template).toContain("# Month review: October 2026");
    expect(parts.template).toContain("## 1. What happened");
    expect(parts.template).toContain(
      "**Key question for next month:** Did I sleep before midnight?",
    );
    expect(parts.template).toContain(
      "**Verdict:** Pivot toward sleep, away from late nights.",
    );
    expect(parts.template).not.toMatch(/forecast/i);
    expect(parts.material).toContain("October 2026 goals");
  });
});
