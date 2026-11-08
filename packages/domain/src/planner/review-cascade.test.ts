import { plannerMemoNextSteps } from "@flaremo/contracts";
import { describe, expect, it } from "vitest";
import {
  plannerAgentCloseMessage,
  plannerAgentMemoMessage,
} from "./agent-prompts";
import {
  plannerCascadeLadderLines,
  plannerCascadeStyleOf,
  plannerCascadeWeeksLeft,
} from "./review-cascade";
import type { PlannerReviewContext } from "./review-context";
import {
  plannerCloseMessages,
  plannerMemoParts,
  plannerReviewContextBlock,
} from "./review-prompts";

// The cascade ladder (fork-owned, review-cascade.ts): what the review's
// context, memo and scores step get when FLAREMO_REVIEW_CASCADE=ladder.

function goal(
  overrides: Partial<PlannerReviewContext["yearGoals"][number]>,
): PlannerReviewContext["yearGoals"][number] {
  return {
    id: "g",
    level: "year",
    period_start: "2026-01-01",
    pillar: null,
    title: "",
    lines: [],
    status: "active",
    note: null,
    result: null,
    sort_order: 0,
    created_at: "2026-10-01T00:00:00.000Z",
    updated_at: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

const CONTEXT: PlannerReviewContext = {
  ownerName: "Anon",
  weekStart: "2026-10-12",
  planWeek: "2026-10-19",
  today: "2026-10-18",
  northStar: goal({ id: "ns", level: "north_star", title: "Freedom" }),
  yearGoals: [
    goal({
      id: "y-work",
      pillar: "work",
      title: "Stay on better terms",
      lines: [
        { text: "Agree the scope", struck: true },
        { text: "Agree the price" },
        { text: "Sign" },
      ],
    }),
  ],
  quarterGoals: [
    goal({
      id: "q4-work",
      level: "quarter",
      period_start: "2026-10-01",
      pillar: "work",
      title: "Decide go or no go",
      lines: [{ text: "Three user talks" }, { text: "Costed plan" }],
    }),
    goal({
      id: "q4-theme",
      level: "quarter",
      period_start: "2026-10-01",
      pillar: null,
      title: "Consolidate",
    }),
  ],
  monthGoals: [
    goal({
      id: "oct-work",
      level: "month",
      period_start: "2026-10-01",
      pillar: "work",
      title: "Prototype in front of users",
      lines: [{ text: "Parser" }, { text: "One user sees it" }],
    }),
  ],
  planCascade: {
    year: 2026,
    quarter: 4,
    month: 9,
    yearGoals: [],
    quarterGoals: [],
    monthGoals: [],
  },
  weekGoals: [
    goal({
      id: "w-work",
      level: "week",
      period_start: "2026-10-12",
      pillar: "work",
      title: "Ship the parser",
      result: "met",
    }),
  ],
  scores: [{ weekStart: "2026-10-05", auth: 4, ach: 4 }],
  lastQuestion: null,
  previousSummary: null,
  previousSteps: {},
  tasks: { done: [], doing: [], todo: [] },
  taskDetails: [],
  openFlags: [],
  keptFlags: [],
  diary: [],
  health: null,
  memories: [],
  cascade: "ladder",
};

const REQUEST = {
  lastAnswer: [],
  answers: [[], [], [], [], [], [], []],
  goalResults: [],
  coachNotes: [],
  reviewedOn: "2026-10-18",
  scores: { auth: 4, ach: 3 },
  drafted: null,
  question: null,
  verdict: null,
  recommended: "continue" as const,
  drafts: {
    auth_evidence: "",
    ach_evidence: "",
    pattern: "",
    risk: "",
    opportunity: "",
  },
};

describe("the style", () => {
  it("is ladder only when the var says so", () => {
    expect(plannerCascadeStyleOf("ladder")).toBe("ladder");
    expect(plannerCascadeStyleOf(" Ladder ")).toBe("ladder");
    expect(plannerCascadeStyleOf("flat")).toBe("flat");
    expect(plannerCascadeStyleOf(undefined)).toBe("flat");
    expect(plannerCascadeStyleOf("")).toBe("flat");
  });
});

describe("weeks left", () => {
  it("counts a month's weeks by their Thursday", () => {
    // October 2026: Thursday 1 Oct, so the week of 28 Sep is October's,
    // and so are 5, 12, 19 and 26 Oct: five weeks. The week of 12 Oct
    // leaves two.
    expect(plannerCascadeWeeksLeft("2026-10-12", "month")).toEqual({
      left: 2,
      total: 5,
    });
    expect(plannerCascadeWeeksLeft("2026-09-28", "month")).toEqual({
      left: 4,
      total: 5,
    });
    expect(plannerCascadeWeeksLeft("2026-10-26", "month")).toEqual({
      left: 0,
      total: 5,
    });
  });
  it("counts the quarter and the year", () => {
    // Q4 2026 runs from the week of 28 Sep to the week of 28 Dec: 14 weeks.
    expect(plannerCascadeWeeksLeft("2026-10-12", "quarter")).toEqual({
      left: 11,
      total: 14,
    });
    // 2026 has 53 ISO weeks; week 42 leaves 11.
    expect(plannerCascadeWeeksLeft("2026-10-12", "year")).toEqual({
      left: 11,
      total: 53,
    });
  });
});

describe("the ladder", () => {
  const lines = plannerCascadeLadderLines(CONTEXT);
  const text = lines.join("\n");
  it("shows the time left, counted by the app", () => {
    expect(text).toContain(
      "Time: week 42 of 2026. October: 2 of 5 weeks left after this one. Q4 2026: 11 of 14 weeks left after this one. 2026: 11 of 53 weeks left after this one.",
    );
  });
  it("runs each objective from the year down to the week's goal", () => {
    const work = lines.indexOf("- Work");
    expect(lines[work + 1]).toBe(
      "  · Year 2026: Stay on better terms: [struck] Agree the scope; Agree the price; Sign — 1 of 3 points struck",
    );
    expect(lines[work + 2]).toBe(
      "  · Q4 2026: Decide go or no go: Three user talks; Costed plan — 0 of 2 points struck",
    );
    expect(lines[work + 3]).toBe(
      "  · October: Prototype in front of users: Parser; One user sees it — 0 of 2 points struck",
    );
    expect(lines[work + 4]).toBe("  · W42 goal: Ship the parser [result: met]");
  });
  it("says where nothing is set", () => {
    const health = lines.indexOf("- Health");
    expect(lines.slice(health + 1, health + 5)).toEqual([
      "  · Year 2026: none set",
      "  · Q4 2026: none set",
      "  · October: none set",
      "  · W42 goal: none set",
    ]);
  });
  it("keeps the north star and theme lines", () => {
    expect(text).toContain("North star: Freedom");
    expect(text).toContain("Theme (quarter): Consolidate");
  });
  it("says when a goal has no points", () => {
    const lines = plannerCascadeLadderLines({
      ...CONTEXT,
      monthGoals: [
        goal({ level: "month", pillar: "work", title: "Just a title" }),
      ],
    });
    expect(lines.join("\n")).toContain("October: Just a title — no points set");
  });
});

describe("the context block", () => {
  it("shows the ladder instead of the four flat lines", () => {
    const block = plannerReviewContextBlock(CONTEXT);
    expect(block).toContain("Goal cascade for W42, by objective");
    expect(block).not.toContain("Year goals 2026:");
    expect(block).not.toContain("October goals:");
  });
  it("stays flat by default", () => {
    const block = plannerReviewContextBlock({ ...CONTEXT, cascade: undefined });
    expect(block).toContain("Year goals 2026: Work: Stay on better terms");
    expect(block).not.toContain("Goal cascade for W42");
  });
});

describe("the memo", () => {
  it("gets two more bullets per objective and the rules for them", () => {
    const parts = plannerMemoParts(CONTEXT, REQUEST);
    expect(parts.template).toContain(
      "- **Serves:** (text)\n- **Moved:** (text)\n- **Evidence:** (text)",
    );
    expect(parts.template).toContain("(the same six bullets)");
    expect(parts.rules).toContain("**Moved:** one word first");
    expect(parts.rules).toContain("Be direct about the gap");
  });
  it("keeps today's memo when the cascade is flat", () => {
    const parts = plannerMemoParts({ ...CONTEXT, cascade: "flat" }, REQUEST);
    expect(parts.template).not.toContain("Serves");
    expect(parts.template).toContain("(the same four bullets)");
    expect(parts.rules).not.toContain("Moved");
  });
  it("still yields its Next Steps with the new bullets in front", () => {
    const memo = [
      "### II. Work",
      "- **Serves:** October goal, 0 of 2 points, 2 weeks left.",
      "- **Moved:** Maintained. The parser shipped; no user saw it.",
      "- **Evidence:** Two sessions.",
      "- **Learnings:** None stated.",
      "- **Blockers:** None stated.",
      "- **Next Steps:** Show the parser to one user.",
    ].join("\n");
    expect(plannerMemoNextSteps(memo)).toEqual({
      work: "Show the parser to one user.",
    });
  });
  it("reaches the agent's memo step", () => {
    const message = plannerAgentMemoMessage(CONTEXT, REQUEST);
    expect(message).toContain("- **Serves:** (text)");
    expect(message).toContain("**Moved:** one word first");
  });
});

describe("the scores step", () => {
  it("asks the trajectory and the key question to name a cascade goal", () => {
    const [, user] = plannerCloseMessages(CONTEXT, REQUEST);
    expect(user?.content).toContain(
      "also weigh whether the week moved the month goal's open points",
    );
    const flat = plannerCloseMessages({ ...CONTEXT, cascade: "flat" }, REQUEST);
    expect(flat[1]?.content).not.toContain("The cascade:");
  });
  it("reaches the agent's scores step with the context swapped for the pointer", () => {
    const message = plannerAgentCloseMessage(CONTEXT, REQUEST);
    expect(message).toContain("The cascade:");
    expect(message).not.toContain("Goal cascade for W42, by objective");
    expect(message).toContain("read it with review_week");
  });
});
