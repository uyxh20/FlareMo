import { describe, expect, it } from "vitest";
import type { PlannerReviewContext } from "./review-context";
import { plannerParseWeekOpening, plannerWeekRawRows } from "./review-happened";
import {
  PLANNER_WEEK_HAPPENED_MAX,
  plannerOpeningMessages,
} from "./review-prompts";

// The weekly opening's receipts (review-happened.ts): what happened, kept only
// where the owner's own words back it, checked against the rows the prompt
// showed the model.

const CONTEXT: PlannerReviewContext = {
  ownerName: "Sam",
  weekStart: "2026-10-12",
  planWeek: "2026-10-19",
  today: "2026-10-18",
  northStar: null,
  yearGoals: [],
  quarterGoals: [],
  monthGoals: [],
  planCascade: {
    year: 2026,
    quarter: 4,
    month: 10,
    yearGoals: [],
    quarterGoals: [],
    monthGoals: [],
  },
  weekGoals: [],
  scores: [],
  lastQuestion: null,
  previousSummary: null,
  previousSteps: {},
  tasks: { done: ["Call Acme", "Book the dentist"], doing: [], todo: [] },
  taskDetails: [
    {
      title: "Call Acme",
      status: "done",
      notes: "They want the numbers on paper before Friday.",
      comments: [
        {
          at: "2026-10-14T09:00:00.000Z",
          text: "Sent the sheet, no reply yet.",
        },
      ],
      history: [{ at: "2026-10-15T17:00:00.000Z", what: "done" }],
    },
  ],
  openFlags: [],
  keptFlags: [],
  diary: [
    {
      at: "2026-10-13T20:00:00.000Z",
      text: "Long talk with Acme, they want the numbers on paper.",
    },
  ],
  health: {
    entries: [
      {
        kind: "training",
        day: "2026-10-14",
        variant: "crossfit",
        minutes: 50,
        home_at: null,
        units: null,
        bender: false,
        needs_check: false,
        feel: "legs like lead after the long session",
      },
    ],
    summary: {
      training: { sessions: 1, target: 3 },
      breath: { days: 0, sessions: 0, minutes: 0, target: 7 },
      night_out: {
        units: 0,
        nights: 0,
        needs_check: 0,
        year_target: 12,
        year_used: 0,
      },
    },
    trackers: [],
  },
  memories: [],
};

describe("the weekly opening's receipts", () => {
  it("asks for what happened with a quote per claim", () => {
    const text = plannerOpeningMessages(CONTEXT)[1]?.content ?? "";
    expect(text).toContain(`up to ${PLANNER_WEEK_HAPPENED_MAX} claims`);
    expect(text).toContain('"happened": [{"claim": string, "quote": string');
  });

  it("lists the diary, the health notes and the tasks as rows", () => {
    const rows = plannerWeekRawRows(CONTEXT);
    expect(rows.map((row) => `${row.source}:${row.id}:${row.day}`)).toEqual([
      "memo:2026-10-13T20:00:00.000Z:2026-10-13",
      "health:training:2026-10-14:2026-10-14",
      "task_event:Call Acme:2026-10-15",
      "task_event:Call Acme:2026-10-15",
      "task_event:Call Acme:2026-10-14",
      "task_event:Book the dentist:2026-10-12",
    ]);
  });

  it("keeps the claims it can find word for word and counts the rest", () => {
    const raw = JSON.stringify({
      recap: "Acme week.",
      prompts: [],
      happened: [
        {
          claim: "Acme asked for numbers on paper.",
          quote: "they want the numbers on paper",
          pillar: "work",
        },
        {
          claim: "The sheet went out.",
          quote: "Sent the sheet, no reply yet",
          pillar: "work",
        },
        {
          claim: "Training was heavy.",
          quote: "Legs like lead after the long session.",
          pillar: "health",
        },
        { claim: "Won the lottery.", quote: "won the lottery on Tuesday" },
        { claim: "No words.", quote: "" },
      ],
    });
    const opening = plannerParseWeekOpening(raw, CONTEXT);
    expect(opening.recap).toBe("Acme week.");
    expect(opening.prompts).toHaveLength(7);
    expect(opening.dropped).toBe(2);
    expect(opening.happened).toEqual([
      {
        pillar: "work",
        claim: "Acme asked for numbers on paper.",
        quote: "they want the numbers on paper",
        source: "memo",
        source_id: "2026-10-13T20:00:00.000Z",
        source_day: "2026-10-13",
      },
      {
        pillar: "work",
        claim: "The sheet went out.",
        quote: "Sent the sheet, no reply yet",
        source: "task_event",
        source_id: "Call Acme",
        source_day: "2026-10-14",
      },
      {
        pillar: "health",
        claim: "Training was heavy.",
        quote: "Legs like lead after the long session.",
        source: "health",
        source_id: "training:2026-10-14",
        source_day: "2026-10-14",
      },
    ]);
  });

  it("reads an answer with no claims as nothing happened", () => {
    const opening = plannerParseWeekOpening("not json", CONTEXT);
    expect(opening.happened).toEqual([]);
    expect(opening.dropped).toBe(0);
  });
});
