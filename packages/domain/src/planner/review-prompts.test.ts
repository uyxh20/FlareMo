import type { PlannerGoalDto } from "@flaremo/contracts";
import { describe, expect, it } from "vitest";
import type { PlannerReviewContext } from "./review-context";
import {
  plannerCheckMessages,
  plannerCleanMemo,
  plannerCloseMessages,
  plannerCoachMessages,
  plannerCoachStreamFilter,
  plannerExtractJson,
  plannerFlagLabel,
  plannerMemoMessages,
  plannerMemoStreamFilter,
  plannerOpeningMessages,
  plannerParseCheck,
  plannerParseClose,
  plannerParseOpening,
  plannerReviewContextBlock,
  plannerWeekRangeText,
} from "./review-prompts";

// The weekly review's prompts and parsers (review-prompts.ts). Pure functions.

function goal(
  overrides: Partial<PlannerGoalDto> & Pick<PlannerGoalDto, "id" | "level">,
): PlannerGoalDto {
  return {
    period_start: null,
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
  weekStart: "2026-10-05",
  planWeek: "2026-10-12",
  today: "2026-10-11",
  northStar: goal({ id: "ns", level: "north_star", title: "Freedom" }),
  yearGoals: [
    goal({
      id: "year-work",
      level: "year",
      period_start: "2026-01-01",
      pillar: "work",
      title: "Stay on better terms",
      status: "contested",
      note: "6 Oct: join Acme",
    }),
  ],
  quarterGoals: [
    goal({
      id: "q4-ai",
      level: "quarter",
      period_start: "2026-10-01",
      pillar: "ai",
      title: "Ship one public artifact",
    }),
  ],
  monthGoals: [],
  weekGoals: [
    goal({
      id: "w-work",
      level: "week",
      period_start: "2026-10-05",
      pillar: "work",
      title: "Ask Acme for the terms",
    }),
  ],
  scores: [{ weekStart: "2026-09-28", auth: 4, ach: 3.5 }],
  lastQuestion: "Did I compare the offers on numbers?",
  previousSummary: null,
  tasks: { done: ["Call Acme"], doing: [], todo: ["Email Zeta"] },
  openFlags: [],
  keptFlags: [],
  diary: [{ at: "2026-10-07T20:00:00.000Z", text: "Long talk with Acme." }],
};

const ANSWERS = {
  lastAnswer: ["Partly"],
  answers: [["Met Acme"], [], [], [], [], [], []],
  goalResults: [{ goalId: "w-work", result: "met" as const }],
  coachNotes: [],
};

describe("the context block", () => {
  it("writes the cascade, the scores, the week and the diary", () => {
    const block = plannerReviewContextBlock(CONTEXT);
    expect(plannerWeekRangeText("2026-10-05")).toBe("5–11 October 2026");
    expect(plannerWeekRangeText("2026-09-28")).toBe(
      "28 September – 4 October 2026",
    );
    expect(block).toContain("North star: Freedom");
    expect(block).toContain(
      "Year goals 2026: Work: Stay on better terms [contested: 6 Oct: join Acme]",
    );
    expect(block).toContain(
      "Q4 2026 goals: AI Chops: Ship one public artifact",
    );
    expect(block).toContain("October goals: none written");
    expect(block).toContain("W40 4.0/3.5");
    expect(block).toContain(
      "Week 41 (5–11 October 2026) weekly goals: Work: Ask Acme for the terms",
    );
    expect(block).toContain("[Wed 7 Oct] Long talk with Acme.");
  });

  it("puts the goal cascade into every prompt", () => {
    for (const messages of [
      plannerOpeningMessages(CONTEXT),
      plannerCloseMessages(CONTEXT, ANSWERS),
      plannerMemoMessages(CONTEXT, {
        ...ANSWERS,
        reviewedOn: "2026-10-11",
        scores: { auth: 4, ach: 3 },
        question: "Did I get the terms on paper?",
        verdict: { kind: "pivot", text: "Pivot toward the terms. Fast." },
        recommended: "continue",
        drafts: {
          auth_evidence: "",
          ach_evidence: "",
          pattern: "",
          risk: "",
          opportunity: "",
        },
      }),
      plannerCheckMessages(
        CONTEXT,
        [{ id: "g1", pillar: "work", title: "Sign with Acme", tasks: [] }],
        [],
      ),
    ]) {
      expect(messages[0]?.role).toBe("system");
      expect(messages.at(-1)?.role).toBe("user");
      expect(messages.map((message) => message.content).join("\n")).toContain(
        "Stay on better terms",
      );
    }
  });
});

describe("reading what the model wrote", () => {
  it("finds the JSON in a fenced or chatty reply and repairs a trailing comma", () => {
    expect(plannerExtractJson('Sure!\n```json\n{"a": [1, 2,],}\n```')).toEqual({
      a: [1, 2],
    });
    expect(plannerExtractJson('{"text": "a } inside"} trailing')).toEqual({
      text: "a } inside",
    });
    expect(plannerExtractJson("no json here")).toBeNull();
    expect(plannerExtractJson("[1, 2]")).toBeNull();
  });

  it("keeps up to three options per prompt and empties what it cannot read", () => {
    const draft = plannerParseOpening(
      JSON.stringify({
        recap: "  Two offers  moved. ",
        lastq: ["Yes", "Partly", "No", "Extra"],
        prompts: [
          ["a", "b"],
          { options: ["c", "d", "e"] },
          "bad",
          ["only one"],
        ],
      }),
    );
    expect(draft.recap).toBe("Two offers moved.");
    expect(draft.lastq).toEqual(["Yes", "Partly", "No"]);
    expect(draft.prompts).toHaveLength(7);
    expect(draft.prompts.slice(0, 4)).toEqual([
      ["a", "b"],
      ["c", "d", "e"],
      [],
      [],
    ]);
    expect(plannerParseOpening("garbage")).toEqual({
      recap: "",
      lastq: [],
      prompts: [[], [], [], [], [], [], []],
    });
  });

  it("snaps scores to half steps and keeps only a known verdict", () => {
    const close = plannerParseClose(
      JSON.stringify({
        scores: { auth: 4.3, ach: "3", auth_evidence: "Named it." },
        trajectory: {
          pattern: "Shape helps.",
          questions: ["Did I sign?"],
          verdicts: { continue: "Continue. Moving." },
          recommended: "maybe",
        },
      }),
    );
    expect(close.scores).toEqual({
      auth: 4.5,
      ach: 3,
      auth_evidence: "Named it.",
      ach_evidence: "",
    });
    expect(close.trajectory).toMatchObject({
      pattern: "Shape helps.",
      risk: "",
      questions: ["Did I sign?"],
      verdicts: { continue: "Continue. Moving.", pivot: "", pause: "" },
      recommended: null,
    });
    expect(plannerParseClose("{}").scores.auth).toBeNull();
  });

  it("sends the coach the chat from the owner's first turn, merging neighbours", () => {
    const messages = plannerCoachMessages(CONTEXT, "free", [
      { role: "assistant", content: "Opening" },
      { role: "user", content: "One" },
      { role: "user", content: "Two" },
      { role: "assistant", content: "Probe" },
    ]);
    expect(messages.map((message) => [message.role, message.content])).toEqual([
      ["system", expect.stringContaining("one probing question")],
      ["user", "One\n\nTwo"],
      ["assistant", "Probe"],
    ]);
  });

  it("cleans a memo before saving it", () => {
    const marker = "<!-- flaremo:diary 2026-10-05..2026-10-11 -->";
    expect(
      plannerCleanMemo(
        "Here is the memo:\n\n# Week 41: October 5 - October 11, 2026\n\nBody",
        "2026-10-05",
      ),
    ).toBe(`# Week 41: October 5 - October 11, 2026\n\nBody\n\n${marker}`);
    expect(
      plannerCleanMemo(
        `\`\`\`markdown\n# Week 41: x\n\nBody\n\n${marker}\n\`\`\``,
        "2026-10-05",
      ),
    ).toBe(`# Week 41: x\n\nBody\n\n${marker}`);
  });

  it("ties the conflict check's flags to real goals, three at most", () => {
    const plan = [
      {
        id: "g-work",
        pillar: "work" as const,
        title: "Sign with Acme",
        tasks: [],
      },
      { id: "g-ai", pillar: "ai" as const, title: "Demo", tasks: [] },
    ];
    const flags = plannerParseCheck(
      JSON.stringify({
        flags: [
          {
            goal: "work",
            with_level: "year",
            with_goal: "work",
            why: "The year goal says stay.",
          },
          {
            goal: "ai",
            with_level: "north_star",
            with_goal: null,
            why: "Off path.",
          },
          {
            goal: "ai",
            with_level: "week",
            with_goal: "work",
            why: "Same hours.",
          },
          { goal: "of", with: "Something", why: "Unknown pairing." },
          {
            goal: "work",
            with_level: "month",
            with_goal: "work",
            why: "Fourth.",
          },
        ],
      }),
      CONTEXT,
      plan,
    );
    expect(flags).toEqual([
      {
        goal_id: "g-work",
        pillar: "work",
        with_goal_id: "year-work",
        with_label: "Year · Work",
        why: "The year goal says stay.",
      },
      {
        goal_id: "g-ai",
        pillar: "ai",
        with_goal_id: "ns",
        with_label: "North star",
        why: "Off path.",
      },
      {
        goal_id: "g-ai",
        pillar: "ai",
        with_goal_id: "g-work",
        with_label: "Week · Work",
        why: "Same hours.",
      },
    ]);
    expect(plannerFlagLabel("quarter", "ai", "2026-10-01")).toBe(
      "Q4 · AI Chops",
    );
    expect(plannerFlagLabel("month", null, "2026-10-01")).toBe(
      "October · Theme",
    );
    expect(plannerParseCheck("no", CONTEXT, plan)).toEqual([]);
  });
});

describe("streaming", () => {
  const run = <T>(
    filter: { push(piece: string): string; finish(): T },
    pieces: string[],
  ) => {
    const out = pieces.map((piece) => filter.push(piece)).join("");
    return { out, end: filter.finish() };
  };

  it("holds the coach's control line back, even split across pieces", () => {
    const { out, end } = run(plannerCoachStreamFilter("free"), [
      "Which number",
      "? Ask",
      " him. @",
      '@ {"adv',
      'ance": true}',
    ]);
    expect(out).toBe("Which number? Ask him. ");
    expect(end).toEqual({ tail: "", advance: true });
    expect(run(plannerCoachStreamFilter("free"), ["Why?"]).end.advance).toBe(
      false,
    );
    expect(run(plannerCoachStreamFilter("free"), ["Got it."]).end.advance).toBe(
      true,
    );
    expect(
      run(plannerCoachStreamFilter("force"), ['Why? @@ {"advance": false}']).end
        .advance,
    ).toBe(true);
    expect(run(plannerCoachStreamFilter("chat"), ["Sure."]).end.advance).toBe(
      false,
    );
    // A lone "@" that is not a control line comes out at the end.
    expect(run(plannerCoachStreamFilter("chat"), ["mail me @"]).end.tail).toBe(
      "@",
    );
  });

  it("starts the memo at its title", () => {
    expect(
      run(plannerMemoStreamFilter(), [
        "Sure!\n```markdown\n#",
        " Week 41",
        "\nBody",
      ]).out,
    ).toBe("# Week 41\nBody");
    const untitled = run(plannerMemoStreamFilter(), ["```md\nNo title"]);
    expect(untitled.out + untitled.end).toBe("No title");
  });
});
