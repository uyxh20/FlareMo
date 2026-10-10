import { describe, expect, it } from "vitest";
import {
  plannerComposeSummaryMemo,
  plannerDiaryMarker,
  plannerMemoKeyQuestion,
  plannerMemoNextSteps,
  plannerMemoRange,
  plannerMemoTitle,
  plannerMemoWeekOf,
  plannerScoresTable,
  plannerVerdictLine,
  plannerWeekCode,
} from "./planner";

// The weekly summary memo's format (planner-review-memo.ts).

const WEEK = "2026-10-05";

function compose(
  overrides: Partial<Parameters<typeof plannerComposeSummaryMemo>[0]> = {},
) {
  return plannerComposeSummaryMemo({
    weekStart: WEEK,
    reviewedOn: "2026-10-11",
    recap: "Two offers moved to real terms.",
    lastQuestion: "Did I compare the offers on numbers?",
    lastAnswer: ["Partly"],
    goals: [
      {
        pillar: "work",
        title: "Ask Acme for the terms in writing",
        result: "met",
      },
      { pillar: "health", title: "Gym runs twice", result: null },
    ],
    answers: [
      ["Met Acme"],
      [],
      ["Every thread myself"],
      ["Clarity"],
      [],
      [],
      [],
    ],
    scores: { auth: 4, ach: 3 },
    authBasis: "Named the missing goals.",
    achBasis: "Most goals met | some misses.",
    trajectory: {
      pattern: "Shape helps.",
      risk: "Drift.",
      opportunity: "Terms.",
    },
    question: "Did I get the terms on paper?",
    verdict: {
      kind: "pivot",
      text: "Pivot toward the terms. They moved fast.",
    },
    recommended: "continue",
    ...overrides,
  });
}

describe("week labels", () => {
  it("writes the week as the past summaries do", () => {
    expect(plannerWeekCode(WEEK)).toBe("W41");
    expect(plannerMemoRange(WEEK)).toBe("October 5 - October 11, 2026");
    expect(plannerMemoRange("2026-09-28")).toBe(
      "September 28 - October 4, 2026",
    );
    expect(plannerMemoTitle(WEEK)).toBe(
      "# Week 41: October 5 - October 11, 2026",
    );
    expect(plannerDiaryMarker(WEEK)).toBe(
      "<!-- flaremo:diary 2026-10-05..2026-10-11 -->",
    );
  });
});

describe("the verdict and the scores table", () => {
  it("bolds the verdict's first sentence and notes an override", () => {
    expect(
      plannerVerdictLine(
        { kind: "continue", text: "Continue. The offers moved." },
        "continue",
      ),
    ).toBe("**Verdict: Continue.** The offers moved.");
    expect(
      plannerVerdictLine(
        { kind: "pause", text: "Pause for numbers." },
        "continue",
      ),
    ).toBe(
      "**Verdict: Pause for numbers.** The user chose Pause over the assistant's recommended Continue.",
    );
    expect(plannerVerdictLine(null, "continue")).toBe("**Verdict:** —");
  });

  it("writes the gap and the floors it meets", () => {
    const table = plannerScoresTable({
      weekStart: WEEK,
      scores: { auth: 3.5, ach: 4 },
      authBasis: "a | b",
      achBasis: "",
    });
    expect(table).toContain("- **Scores (W41, user-calibrated):**");
    expect(table).toContain("| Authenticity | 3.5/5 | a / b |");
    expect(table).toContain("| Achievement | 4.0/5 | None stated. |");
    expect(table).toContain(
      "| Gap | 0.5 | Authenticity is below the 4.0 floor. |",
    );
  });
});

describe("the template", () => {
  it("has every section of the past summaries, in order", () => {
    const memo = compose();
    const headings = memo.split("\n").filter((line) => /^#{1,3} /.test(line));
    expect(headings).toEqual([
      "# Week 41: October 5 - October 11, 2026",
      "## Review status and sources",
      "## Executive Summary",
      "## 1. High-Level Summary",
      "## 2. Guided Reflection Prompts",
      "## 3. Goal Progress Update",
      "### I. Objective Function",
      "### II. Work",
      "### III. AI Chops",
      "### IV. Health & Fitness",
      "## Trajectory into W42",
      "## 4. Raw Logs for this Week",
    ]);
    expect(memo).toContain("- **Impact:** Met Acme.");
    expect(memo).toContain("- **Lesson:** Skipped.");
    expect(memo).toContain(
      "- **Evidence:** Ask Acme for the terms in writing: Met.",
    );
    expect(memo).toContain("- **Evidence:** Gym runs twice: not recorded.");
    expect(memo).toContain(
      "**Key question for W42's review:** Did I get the terms on paper?",
    );
    expect(memo).toContain(
      "The user chose Pivot over the assistant's recommended Continue.",
    );
    expect(memo).toContain(
      "**Last week's key question:** *Did I compare the offers on numbers?* Partly.",
    );
    expect(memo.endsWith("<!-- flaremo:diary 2026-10-05..2026-10-11 -->")).toBe(
      true,
    );
    expect(memo).toContain(
      "Created in the Schizo Diary weekly review on Sunday 2026-10-11.",
    );
  });

  it("says when the week had no goals and no last question", () => {
    const memo = compose({ goals: [], lastQuestion: null, lastAnswer: [] });
    expect(memo).toContain("No W41 goals were set in advance.");
    expect(memo).not.toContain("Last week's key question");
  });
});

describe("reading a past summary", () => {
  const past = [
    "# Week 40: September 28 - October 4, 2026",
    "",
    "### I. Objective Function",
    "- **Evidence:** x",
    "- **Next Steps:** Compare Acme and **Zeta** on numbers",
    "",
    "### II. Work",
    "- **Next Steps:** See Trajectory.",
    "",
    "### III. AI Chops",
    "- **Next Steps:**   Ship the first   public artifact",
    "",
    "### IV. Health & Fitness",
    "- **Next Steps:** None stated.",
    "",
    "**Key question for W41's review:** *Did I compare Acme and Zeta on numbers, not feelings?*",
  ].join("\n");

  it("reads Next Steps per objective, leaving out empty ones", () => {
    expect(plannerMemoNextSteps(past)).toEqual({
      of: "Compare Acme and Zeta on numbers",
      ai: "Ship the first public artifact",
    });
  });

  it("reads the key question and the week the summary is about", () => {
    expect(plannerMemoKeyQuestion(past)).toBe(
      "Did I compare Acme and Zeta on numbers, not feelings?",
    );
    expect(plannerMemoKeyQuestion("No question here")).toBeNull();
    expect(plannerMemoWeekOf(past)).toEqual({ year: 2026, week: 40 });
    expect(
      plannerMemoWeekOf("# Week 1: December 29 - January 4, 2026\nmore"),
    ).toEqual({ year: 2026, week: 1 });
    expect(plannerMemoWeekOf("# Weekly notes")).toBeNull();
  });

  it("reads back what the template wrote", () => {
    const memo = compose();
    expect(plannerMemoKeyQuestion(memo)).toBe("Did I get the terms on paper?");
    expect(plannerMemoNextSteps(memo)).toEqual({});
    expect(plannerMemoWeekOf(memo)).toEqual({ year: 2026, week: 41 });
  });
});
