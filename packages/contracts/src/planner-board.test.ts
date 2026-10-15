import { describe, expect, it } from "vitest";
import {
  type PlannerBoardColumnKey,
  type PlannerColumnFields,
  type PlannerSortFields,
  plannerCardColumn,
  plannerColumnMove,
  plannerColumnStatus,
  plannerColumns,
  plannerHasPlan,
  plannerIsColumn,
  plannerIsPastPlan,
  plannerSortCards,
} from "./planner-board";

// The board's rules, as one table each. The server's board read and column move
// and the web board's predictions all call these, so this file is the one place
// their behaviour is pinned.

// Wednesday 7 October 2026: its week starts Monday the 5th, its month the 1st.
const TODAY = "2026-10-07";
const WEEK = "2026-10-05";

describe("plannerCardColumn", () => {
  const rows: [string, PlannerColumnFields, PlannerBoardColumnKey][] = [
    ["todo with a plan", fields("todo", "week", WEEK), "todo"],
    ["todo without a plan", fields("todo", null, null), "backlog"],
    [
      "todo with a horizon and no start",
      fields("todo", "day", null),
      "backlog",
    ],
    ["todo with a start and no horizon", fields("todo", null, WEEK), "backlog"],
    ["in_progress with a plan", fields("in_progress", "week", WEEK), "doing"],
    ["in_progress without a plan", fields("in_progress", null, null), "doing"],
    ["done with a plan", fields("done", "week", WEEK), "done"],
    ["an unknown status", fields("blocked", null, null), "other"],
    ["todo, dropped", fields("todo", "week", WEEK, "x"), "dropped"],
    ["in_progress, dropped", fields("in_progress", null, null, "x"), "dropped"],
    ["done, dropped", fields("done", "week", WEEK, "x"), "dropped"],
    ["unknown, dropped", fields("blocked", null, null, "x"), "dropped"],
  ];
  it.each(rows)("puts %s in %s", (_, card, column) => {
    expect(plannerCardColumn(card)).toBe(column);
  });

  it("counts a plan only with both a horizon and a start", () => {
    expect(plannerHasPlan({ horizon: "day", period_start: TODAY })).toBe(true);
    expect(plannerHasPlan({ horizon: "day", period_start: null })).toBe(false);
    expect(plannerHasPlan({ horizon: null, period_start: TODAY })).toBe(false);
  });

  it("lists the four move targets in board order, with their statuses", () => {
    expect(plannerColumns).toEqual(["backlog", "todo", "doing", "done"]);
    expect(plannerColumnStatus).toEqual({
      backlog: "todo",
      todo: "todo",
      doing: "in_progress",
      done: "done",
    });
    expect(plannerColumns.every(plannerIsColumn)).toBe(true);
    for (const value of ["other", "dropped", "", null, 3]) {
      expect(plannerIsColumn(value)).toBe(false);
    }
  });
});

describe("plannerSortCards", () => {
  // Each row: a column, its cards in a scrambled order, and the order the board
  // shows them in.
  const rows: [string, PlannerBoardColumnKey, PlannerSortFields[], string[]][] =
    [
      [
        "Backlog: newest created first, ties by id",
        "backlog",
        [
          card("b", { created_at: "2026-10-02T00:00:00Z" }),
          card("c", { created_at: "2026-10-03T00:00:00Z" }),
          card("a", { created_at: "2026-10-02T00:00:00Z" }),
        ],
        ["c", "a", "b"],
      ],
      [
        "To Do: the plan that ends soonest, days before weeks before months",
        "todo",
        [
          card("month", { horizon: "month", period_start: "2026-10-01" }),
          card("next-week", { horizon: "week", period_start: "2026-10-12" }),
          card("week", { horizon: "week", period_start: WEEK }),
          card("tomorrow", { horizon: "day", period_start: "2026-10-08" }),
          card("today", { horizon: "day", period_start: TODAY }),
        ],
        ["today", "tomorrow", "week", "next-week", "month"],
      ],
      [
        "To Do: a day before a week that ends the same day",
        "todo",
        [
          card("week", { horizon: "week", period_start: WEEK }),
          card("sunday", { horizon: "day", period_start: "2026-10-11" }),
        ],
        ["sunday", "week"],
      ],
      [
        "To Do: a tie by upstream order, then creation time",
        "todo",
        [
          card("late", { ...weekPlan, created_at: "2026-10-03T00:00:00Z" }),
          card("first", {
            ...weekPlan,
            sort_order: -1,
            created_at: "2026-10-04T00:00:00Z",
          }),
          card("early", { ...weekPlan, created_at: "2026-10-02T00:00:00Z" }),
        ],
        ["first", "early", "late"],
      ],
      [
        "To Do: a damaged plan sorts by its start and never throws",
        "todo",
        [
          card("week", { horizon: "week", period_start: WEEK }),
          card("damaged", { horizon: "week", period_start: "not-a-day" }),
        ],
        ["week", "damaged"],
      ],
      [
        "Doing: upstream order",
        "doing",
        [card("b", { sort_order: 2 }), card("a", { sort_order: 1 })],
        ["a", "b"],
      ],
      [
        "Done: newest finished first, the last change standing in",
        "done",
        [
          card("old", { completed_at: "2026-10-02T00:00:00Z" }),
          card("new", { completed_at: "2026-10-05T00:00:00Z" }),
          card("none", { updated_at: "2026-10-04T00:00:00Z" }),
        ],
        ["new", "none", "old"],
      ],
      [
        "Dropped: newest dropped first",
        "dropped",
        [
          card("x", { dropped_at: "2026-10-01T00:00:00Z" }),
          card("y", { dropped_at: "2026-10-06T00:00:00Z" }),
        ],
        ["y", "x"],
      ],
      [
        "Other: newest created first, ranks ignored",
        "other",
        [
          card("x", { board_rank: "z", created_at: "2026-10-09T00:00:00Z" }),
          card("y", { board_rank: "a", created_at: "2026-10-01T00:00:00Z" }),
        ],
        ["x", "y"],
      ],
      ...(["backlog", "todo", "doing", "done"] as const).map(
        (
          column,
        ): [string, PlannerBoardColumnKey, PlannerSortFields[], string[]] => [
          `${column}: ranked cards first, in key order`,
          column,
          [
            card("n1", { ...weekPlan, created_at: "2026-10-03T00:00:00Z" }),
            card("b", { ...weekPlan, board_rank: "b" }),
            card("a", { ...weekPlan, board_rank: "a" }),
          ],
          ["a", "b", "n1"],
        ],
      ),
    ];
  it.each(rows)("%s", (_, column, cards, order) => {
    expect(plannerSortCards(column, cards).map((entry) => entry.id)).toEqual(
      order,
    );
  });

  it("does not touch the array it is given", () => {
    const input = [
      card("a"),
      card("b", { created_at: "2026-10-09T00:00:00Z" }),
    ];
    plannerSortCards("backlog", input);
    expect(input.map((entry) => entry.id)).toEqual(["a", "b"]);
  });
});

describe("plannerColumnMove", () => {
  const backlog = fields("todo", null, null);
  const todo = fields("todo", "day", TODAY);
  const doing = fields("in_progress", "week", WEEK);
  const doingNoPlan = fields("in_progress", null, null);
  const done = fields("done", "week", WEEK);
  const donePast = fields("done", "week", "2026-09-28");
  const doneNoPlan = fields("done", null, null);
  const other = fields("blocked", null, null);

  // [from, card, to, status, plan]; null when the move changes nothing.
  const rows: [
    string,
    PlannerColumnFields,
    (typeof plannerColumns)[number],
    ReturnType<typeof plannerColumnMove>,
  ][] = [
    ["Backlog", backlog, "todo", { status: "todo", plan: "todo-marker" }],
    ["Backlog", backlog, "doing", { status: "in_progress", plan: "keep" }],
    ["Backlog", backlog, "done", { status: "done", plan: "keep" }],
    ["To Do", todo, "backlog", { status: "todo", plan: "clear" }],
    ["To Do", todo, "doing", { status: "in_progress", plan: "keep" }],
    ["To Do", todo, "done", { status: "done", plan: "keep" }],
    ["Doing", doing, "todo", { status: "todo", plan: "keep" }],
    [
      "Doing, no plan",
      doingNoPlan,
      "todo",
      { status: "todo", plan: "todo-marker" },
    ],
    ["Doing", doing, "backlog", { status: "todo", plan: "clear" }],
    ["Doing", doing, "done", { status: "done", plan: "keep" }],
    ["Done, this week", done, "todo", { status: "todo", plan: "keep" }],
    ["Done, past", donePast, "todo", { status: "todo", plan: "todo-marker" }],
    [
      "Done, no plan",
      doneNoPlan,
      "todo",
      { status: "todo", plan: "todo-marker" },
    ],
    ["Done", done, "doing", { status: "in_progress", plan: "keep" }],
    ["Done", done, "backlog", { status: "todo", plan: "clear" }],
    ["Other", other, "doing", { status: "in_progress", plan: "keep" }],
    ["Other", other, "todo", { status: "todo", plan: "todo-marker" }],
    ["Backlog", backlog, "backlog", null],
    ["To Do", todo, "todo", null],
    ["Doing", doing, "doing", null],
    ["Done", done, "done", null],
    ["Dropped", fields("todo", "week", WEEK, "x"), "doing", null],
  ];
  it.each(rows)("%s to %s", (_, from, to, expected) => {
    expect(plannerColumnMove(from, to, TODAY)).toEqual(expected);
  });

  it("calls a plan past only when its period starts before today's", () => {
    expect(
      plannerIsPastPlan({ horizon: "week", period_start: WEEK }, TODAY),
    ).toBe(false);
    expect(
      plannerIsPastPlan({ horizon: "week", period_start: "2026-09-28" }, TODAY),
    ).toBe(true);
    expect(
      plannerIsPastPlan({ horizon: "day", period_start: "2026-10-06" }, TODAY),
    ).toBe(true);
    expect(
      plannerIsPastPlan({ horizon: null, period_start: null }, TODAY),
    ).toBe(false);
    expect(
      plannerIsPastPlan({ horizon: "fortnight", period_start: WEEK }, TODAY),
    ).toBe(false);
  });
});

function fields(
  status: string,
  horizon: string | null,
  period_start: string | null,
  dropped_at: string | null = null,
): PlannerColumnFields {
  return { status, horizon, period_start, dropped_at };
}

const weekPlan = { horizon: "week", period_start: WEEK } as const;

function card(
  id: string,
  overrides: Partial<PlannerSortFields> = {},
): PlannerSortFields {
  return {
    id,
    sort_order: 0,
    created_at: "2026-10-01T08:00:00.000Z",
    updated_at: "2026-10-01T08:00:00.000Z",
    completed_at: null,
    horizon: null,
    period_start: null,
    dropped_at: null,
    board_rank: null,
    ...overrides,
  };
}
