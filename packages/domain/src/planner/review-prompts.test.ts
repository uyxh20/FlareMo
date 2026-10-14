import type { PlannerGoalDto } from "@flaremo/contracts";
import { describe, expect, it } from "vitest";
import type { PlannerReviewContext } from "./review-context";
import {
  plannerCheckMessages,
  plannerCleanMemo,
  plannerCloseMessages,
  plannerCoachMessages,
  plannerCoachStreamFilter,
  plannerCoachSystem,
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
  // Week 41 plans week 42: still October, Q4 2026.
  planCascade: {
    year: 2026,
    quarter: 4,
    month: 9,
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
  },
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
  previousSteps: {},
  tasks: { done: ["Call Acme"], doing: [], todo: ["Email Zeta"] },
  openFlags: [],
  keptFlags: [],
  diary: [{ at: "2026-10-07T20:00:00.000Z", text: "Long talk with Acme." }],
  health: null,
  memories: [],
};

const ANSWERS = {
  lastAnswer: ["Partly"],
  answers: [["Met Acme"], [], [], [], [], [], []],
  goalResults: [{ goalId: "w-work", result: "met" as const }],
  coachNotes: [],
};

const MEMO_REQUEST = {
  ...ANSWERS,
  reviewedOn: "2026-10-11",
  scores: { auth: 4, ach: 3 },
  question: "Did I get the terms on paper?",
  verdict: { kind: "pivot" as const, text: "Pivot toward the terms. Fast." },
  recommended: "continue" as const,
  drafts: {
    auth_evidence: "",
    ach_evidence: "",
    pattern: "",
    risk: "",
    opportunity: "",
  },
};

/** Every message's text, as the model reads it. */
const said = (messages: ReadonlyArray<{ content: string }>) =>
  messages.map((message) => message.content).join("\n");

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
      plannerMemoMessages(CONTEXT, MEMO_REQUEST),
      plannerCheckMessages(
        CONTEXT,
        [{ id: "g1", pillar: "work", title: "Sign with Acme", tasks: [] }],
        [],
      ),
    ]) {
      expect(messages[0]?.role).toBe("system");
      expect(messages.at(-1)?.role).toBe("user");
      expect(said(messages)).toContain("Stay on better terms");
    }
  });

  it("starts with how to read it, and marks what is last week's or cut", () => {
    const block = plannerReviewContextBlock({
      ...CONTEXT,
      weekGoals: [],
      previousSummary: "# Week 40: September 28 - October 4, 2026…",
      previousSteps: {
        of: "Compare Acme and Zeta on numbers",
        ai: "Ship the first public artifact",
      },
      diary: [
        { at: "2026-10-06T08:00:00.000Z", text: "Gym." },
        { at: "2026-10-07T20:00:00.000Z", text: "Long talk with Acme…" },
      ],
    });
    expect(block.startsWith("How to read this material:\n")).toBe(true);
    expect(block).toContain("or Anon's answers in this review, say so.");
    expect(block).toContain(
      [
        "Week 41 (5–11 October 2026): no weekly goals were set.",
        "Last week's Next Steps, the plan written for W41 in last week's summary:",
        "- Objective Function: Compare Acme and Zeta on numbers",
        "- AI Chops: Ship the first public artifact",
        'Last week\'s review question: "Did I compare the offers on numbers?"',
      ].join("\n"),
    );
    expect(block).toContain(
      "Last week's summary (W40), as written then. It is about last week, not this one, and only its start is shown:",
    );
    expect(block).toContain(
      "Anon's diary entries this week, oldest first, in their own words. The day in brackets is when each was written; an entry ending in … was cut to fit:\n[Tue 6 Oct] Gym.\n[Wed 7 Oct] Long talk with Acme…",
    );

    const plain = plannerReviewContextBlock(CONTEXT);
    expect(plain).not.toContain("Last week's Next Steps");
    expect(plain).toContain(
      "The day in brackets is when each was written:\n[Wed 7 Oct] Long talk with Acme.",
    );
  });
});

describe("health and memories in the context", () => {
  const health = {
    entries: [
      {
        kind: "training" as const,
        day: "2026-10-05",
        variant: "crossfit",
        minutes: null,
        home_at: null,
        units: null,
        bender: false,
        needs_check: false,
        feel: "heavy legs",
      },
      {
        kind: "breath" as const,
        day: "2026-10-06",
        variant: "wim_hof",
        minutes: 10,
        home_at: null,
        units: null,
        bender: false,
        needs_check: false,
        feel: null,
      },
      {
        kind: "night_out" as const,
        day: "2026-10-10",
        variant: null,
        minutes: null,
        home_at: "04:30",
        units: 1,
        bender: true,
        needs_check: false,
        feel: null,
      },
    ],
    summary: {
      training: { sessions: 1, target: 3 },
      breath: { days: 1, sessions: 1, minutes: 10, target: 7 },
      night_out: {
        units: 1,
        nights: 1,
        needs_check: 0,
        year_target: 12,
        year_used: 5,
      },
    },
    trackers: [],
  };

  it("gives the tracker's week with targets, days and bender nights", () => {
    const block = plannerReviewContextBlock({ ...CONTEXT, health });
    expect(block).toContain(
      '- Training: 1 session, target 3 a week. Mon 5 Oct crossfit ("heavy legs")',
    );
    expect(block).toContain(
      "- Breathwork: 1 of 7 days (1 session, 10 min). Tue 6 Oct Wim Hof 10 min",
    );
    expect(block).toContain(
      "- Nights out: 1 night, 1 unit this week. Sat 10 Oct (home 04:30, 1 unit, bender). Year so far: 5 of 12 units.",
    );
    // In every look back prompt.
    expect(said(plannerOpeningMessages({ ...CONTEXT, health }))).toContain(
      "Health tracker for this week",
    );
  });

  it("says an empty tracker week is unrecorded, and skips a tracker it could not read", () => {
    const empty = plannerReviewContextBlock({
      ...CONTEXT,
      health: { entries: [], summary: health.summary, trackers: [] },
    });
    expect(empty).toContain("Nothing was logged in the tracker this week.");
    expect(plannerReviewContextBlock(CONTEXT)).not.toContain("Health tracker");
  });

  it("gives the owner's own trackers with their linked goal's progress", () => {
    const block = plannerReviewContextBlock({
      ...CONTEXT,
      health: {
        entries: [],
        summary: health.summary,
        trackers: [
          {
            label: "Fasting",
            measure: "hours",
            days: 2,
            minutes: 34 * 60,
            entries: [
              { day: "2026-10-05", minutes: 16 * 60, feel: null },
              { day: "2026-10-07", minutes: 18 * 60, feel: "easy" },
            ],
            goal: {
              level: "quarter",
              from: "2026-10-01",
              to: "2026-12-31",
              days: 5,
              minutes: 85 * 60,
              timed: 5,
            },
          },
          {
            label: "Cold shower",
            measure: "days",
            days: 0,
            minutes: 0,
            entries: [],
            goal: null,
          },
        ],
      },
    });
    expect(block).toContain(
      '- Fasting (the owner\'s own tracker): 2 days this week, 34 h in total. Mon 5 Oct 16 h; Wed 7 Oct 18 h ("easy"). Linked to the quarter goal; 2026-10-01 to 2026-12-31 so far: 5 days, avg 17 h.',
    );
    expect(block).toContain(
      "- Cold shower (the owner's own tracker): 0 days this week",
    );
    expect(block).not.toContain("Nothing was logged");
  });

  it("lists the week's memories as conclusions, marking unconfirmed ones", () => {
    const block = plannerReviewContextBlock({
      ...CONTEXT,
      memories: [
        {
          kind: "preference",
          content: "Trains best mornings",
          unconfirmed: false,
        },
        { kind: "fact", content: "Moved to Acme talks", unconfirmed: true },
      ],
    });
    expect(block).toContain(
      "Memories the app noted or updated about Anon this week.",
    );
    expect(block).toContain("- preference: Trains best mornings");
    expect(block).toContain("- fact, unconfirmed: Moved to Acme talks");
    expect(plannerReviewContextBlock(CONTEXT)).not.toContain(
      "Memories the app",
    );
  });

  it("dates a diary entry by the owner's local day, not the UTC day", () => {
    const block = plannerReviewContextBlock({
      ...CONTEXT,
      // 23:30 UTC on Sunday 11 Oct is 01:30 on Monday 12 Oct in Copenhagen.
      diary: [{ at: "2026-10-11T23:30:00.000Z", text: "Late note." }],
    });
    expect(block).toContain("[Mon 12 Oct] Late note.");
  });
});

describe("the look forward check reads the plan week's goals", () => {
  it("checks the plan against next month's goals at a month change", () => {
    const check = said(
      plannerCheckMessages(
        {
          ...CONTEXT,
          weekStart: "2026-10-26",
          planWeek: "2026-11-02",
          monthGoals: [
            goal({
              id: "oct-work",
              level: "month",
              period_start: "2026-10-01",
              pillar: "work",
              title: "October work goal",
            }),
          ],
          planCascade: {
            ...CONTEXT.planCascade,
            month: 10,
            monthGoals: [
              goal({
                id: "nov-work",
                level: "month",
                period_start: "2026-11-01",
                pillar: "work",
                title: "November work goal",
              }),
            ],
          },
        },
        [{ id: "g1", pillar: "work", title: "Sign", tasks: [] }],
        [],
      ),
    );
    expect(check).toContain("Month November: Work: November work goal");
    expect(check).not.toContain("October work goal");
  });

  it("ties a flag to the plan week's goal, not the reviewed week's", () => {
    const flags = plannerParseCheck(
      JSON.stringify({
        flags: [
          { goal: "work", with_level: "year", with_goal: "work", why: "Pull." },
        ],
      }),
      {
        ...CONTEXT,
        planCascade: {
          ...CONTEXT.planCascade,
          year: 2027,
          yearGoals: [
            goal({
              id: "year-2027-work",
              level: "year",
              period_start: "2027-01-01",
              pillar: "work",
              title: "2027 work",
            }),
          ],
        },
      },
      [{ id: "g1", pillar: "work", title: "Sign", tasks: [] }],
    );
    expect(flags[0]?.with_goal_id).toBe("year-2027-work");
  });
});

describe("what each call asks for", () => {
  it("asks for answers to last week's question only when there was one", () => {
    expect(said(plannerOpeningMessages(CONTEXT))).toContain(
      '{"recap": string, "lastq": [three answer options for last week\'s key question], "prompts":',
    );
    const none = said(
      plannerOpeningMessages({ ...CONTEXT, lastQuestion: null }),
    );
    expect(none).toContain('{"recap": string, "prompts":');
    expect(none).not.toContain("lastq");
    expect(none).not.toContain("last week's key question");
  });

  it("judges Achievement against what the week had to go on", () => {
    const close = (context: PlannerReviewContext) =>
      said(plannerCloseMessages(context, ANSWERS));
    expect(close(CONTEXT)).toContain(
      "Judge Achievement against the W41 goals and the results Anon recorded.",
    );
    expect(
      close({
        ...CONTEXT,
        weekGoals: [],
        previousSteps: { work: "Ask Acme for the terms" },
      }),
    ).toContain(
      "No W41 goals were set, so judge Achievement against last week's Next Steps (listed in the context) and what the diary and tasks show was done.",
    );
    expect(close({ ...CONTEXT, weekGoals: [] })).toContain(
      "No W41 goals or Next Steps were set, so judge Achievement against what the diary and tasks show Anon set out to do and did.",
    );
  });

  it("keeps the coach's changing line last, after the same instructions and context", () => {
    const free = plannerCoachSystem(CONTEXT, "free");
    const force = plannerCoachSystem(CONTEXT, "force");
    expect(free).toContain(
      "When the diary or tasks hold something that bears on it, point at it",
    );
    expect(
      free.endsWith(
        "[Wed 7 Oct] Long talk with Acme.\n\nFor this reply you may ask one probing question if the answer is vague.",
      ),
    ).toBe(true);
    expect(force.endsWith('end with @@ {"advance": true}.')).toBe(true);
    const shared = free.slice(0, free.lastIndexOf("\n\n"));
    expect(force.startsWith(shared)).toBe(true);
  });

  it("asks the memo for specifics, and to rewrite the basis of a changed score", () => {
    const memo = (drafted?: { auth: number; ach: number } | null) =>
      said(plannerMemoMessages(CONTEXT, { ...MEMO_REQUEST, drafted }));
    const kept = memo({ auth: 4, ach: 3 });
    expect(kept).toContain(
      "quote Anon's own words, copied exactly inside quotation marks, at least once for each objective the diary covers.",
    );
    expect(kept).toContain(
      "Scores Anon set: Authenticity 4.0, Achievement 3.0, Gap 1.0.\nAuthenticity basis (draft): none",
    );
    expect(kept).not.toContain("changed the drafted scores");
    expect(memo(null)).not.toContain("Drafted scores");

    const changed = memo({ auth: 3.5, ach: 2 });
    expect(changed).toContain(
      "- Anon changed the drafted scores, and the drafts below were written for the old ones. Write the basis of each changed score afresh from the evidence, and keep nothing from the drafts that contradicts Anon's scores.",
    );
    expect(changed).toContain(
      "Scores Anon set: Authenticity 4.0, Achievement 3.0, Gap 1.0.\nDrafted scores, which the drafts were written for: Authenticity 3.5, Achievement 2.0.",
    );
  });

  it("says in the memo what a week without goals is judged against", () => {
    const memo = (context: PlannerReviewContext) =>
      said(plannerMemoMessages(context, MEMO_REQUEST));
    expect(memo(CONTEXT)).toContain(
      "W41 had 1 weekly goals, judged in the review",
    );
    expect(
      memo({
        ...CONTEXT,
        weekGoals: [],
        previousSteps: { work: "Ask Acme for the terms" },
      }),
    ).toContain(
      "no W41 goals were set in advance, so the week is judged against last week's Next Steps",
    );
    expect(memo({ ...CONTEXT, weekGoals: [] })).toContain(
      "no W41 goals or Next Steps were set in advance, so the week is judged on what the diary and tasks show",
    );
  });

  it("tells the check that a kept clash covers every level", () => {
    const check = said(
      plannerCheckMessages(
        {
          ...CONTEXT,
          keptFlags: [
            {
              pillar: "work",
              label: "Year · Work",
              why: "The year goal says stay; the note says go.",
            },
          ],
        },
        [{ id: "g1", pillar: "work", title: "Sign with Acme", tasks: [] }],
        [],
      ),
    );
    expect(check).toContain(
      "Anon already reviewed these clashes. Don't flag them again. A clash kept for now covers that objective's weekly goal at every level: don't flag it for the same reason against another goal or level:\n- Work weekly goal against Year · Work: The year goal says stay; the note says go. Kept for now in an earlier review.",
    );
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
