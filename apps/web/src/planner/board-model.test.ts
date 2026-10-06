import type {
  PlannerBoardCard,
  PlannerBoardResponse,
  PlannerColumn,
  TaskDto,
} from "@flaremo/contracts";
import { describe, expect, it } from "vitest";
import {
  plannerBoardCardCount,
  plannerCardColumn,
  plannerCardFromTask,
  plannerColumns,
  plannerFindCard,
  plannerHasPlan,
  plannerIsOverdue,
  plannerPlaceCard,
  plannerPredictDrop,
  plannerPredictDue,
  plannerPredictMove,
  plannerPredictPlan,
  plannerPredictUndrop,
  plannerSortCards,
  plannerUpdateCard,
} from "./board-model";

// Wednesday 7 October 2026: its week starts Monday the 5th, its month the 1st.
const TODAY = "2026-10-07";
const WEEK = "2026-10-05";
const NOW = new Date("2026-10-07T09:00:00.000Z");
const CONTEXT = { today: TODAY, week: WEEK, now: NOW };

let sequence = 0;

function card(overrides: Partial<PlannerBoardCard> = {}): PlannerBoardCard {
  sequence += 1;
  const id = overrides.id ?? `tasks/t${String(sequence).padStart(3, "0")}`;
  return {
    id,
    project_id: null,
    project_name: null,
    title: `Task ${id}`,
    status: "todo",
    priority: "none",
    due_at: null,
    sort_order: 0,
    completed_at: null,
    created_at: "2026-10-01T08:00:00.000Z",
    updated_at: "2026-10-01T08:00:00.000Z",
    horizon: null,
    period_start: null,
    carry_count: 0,
    dropped_at: null,
    ...overrides,
  };
}

const planned = (overrides: Partial<PlannerBoardCard> = {}) =>
  card({ horizon: "week", period_start: WEEK, ...overrides });

function board(
  columns: Partial<PlannerBoardResponse["columns"]> = {},
): PlannerBoardResponse {
  return {
    columns: {
      backlog: [],
      todo: [],
      doing: [],
      done: [],
      other: [],
      ...columns,
    },
    today: TODAY,
    periods: { day: TODAY, week: WEEK, month: "2026-10-01" },
    history: "ok",
    truncated: false,
  };
}

const ids = (cards: readonly PlannerBoardCard[] | undefined) =>
  (cards ?? []).map((entry) => entry.id);

describe("plannerCardColumn", () => {
  it("puts a todo task in To Do with a plan and in Backlog without", () => {
    expect(plannerCardColumn(planned())).toBe("todo");
    expect(plannerCardColumn(card())).toBe("backlog");
  });

  it("treats a horizon with no start (or a start with no horizon) as no plan", () => {
    expect(plannerHasPlan(card({ horizon: "day", period_start: null }))).toBe(
      false,
    );
    expect(
      plannerCardColumn(card({ horizon: "day", period_start: null })),
    ).toBe("backlog");
    expect(plannerHasPlan(card({ horizon: null, period_start: WEEK }))).toBe(
      false,
    );
  });

  it("maps the other statuses onto Doing, Done and Other, whatever the plan", () => {
    expect(plannerCardColumn(planned({ status: "in_progress" }))).toBe("doing");
    expect(plannerCardColumn(card({ status: "in_progress" }))).toBe("doing");
    expect(plannerCardColumn(planned({ status: "done" }))).toBe("done");
    expect(plannerCardColumn(card({ status: "blocked" }))).toBe("other");
  });

  it("lets Dropped win over every status", () => {
    for (const status of ["todo", "in_progress", "done", "blocked"]) {
      expect(
        plannerCardColumn(planned({ status, dropped_at: "2026-10-06T08:00Z" })),
      ).toBe("dropped");
    }
  });

  it("lists the four move targets in board order", () => {
    expect(plannerColumns).toEqual(["backlog", "todo", "doing", "done"]);
  });
});

describe("plannerSortCards", () => {
  it("orders Backlog newest first, ties by id", () => {
    const sorted = plannerSortCards("backlog", [
      card({ id: "tasks/b", created_at: "2026-10-02T00:00:00Z" }),
      card({ id: "tasks/c", created_at: "2026-10-03T00:00:00Z" }),
      card({ id: "tasks/a", created_at: "2026-10-02T00:00:00Z" }),
    ]);
    expect(ids(sorted)).toEqual(["tasks/c", "tasks/a", "tasks/b"]);
  });

  it("orders To Do by the plan that ends soonest: days, then weeks, then months", () => {
    const sorted = plannerSortCards("todo", [
      planned({
        id: "tasks/month",
        horizon: "month",
        period_start: "2026-10-01",
      }),
      planned({ id: "tasks/next-week", period_start: "2026-10-12" }),
      planned({ id: "tasks/week" }),
      planned({
        id: "tasks/tomorrow",
        horizon: "day",
        period_start: "2026-10-08",
      }),
      planned({ id: "tasks/today", horizon: "day", period_start: TODAY }),
    ]);
    expect(ids(sorted)).toEqual([
      "tasks/today",
      "tasks/tomorrow",
      "tasks/week",
      "tasks/next-week",
      "tasks/month",
    ]);
  });

  it("breaks a To Do tie by upstream order, then creation time", () => {
    const sorted = plannerSortCards("todo", [
      planned({
        id: "tasks/late",
        sort_order: 0,
        created_at: "2026-10-03T00:00:00Z",
      }),
      planned({
        id: "tasks/first",
        sort_order: -1,
        created_at: "2026-10-04T00:00:00Z",
      }),
      planned({
        id: "tasks/early",
        sort_order: 0,
        created_at: "2026-10-02T00:00:00Z",
      }),
    ]);
    expect(ids(sorted)).toEqual(["tasks/first", "tasks/early", "tasks/late"]);
  });

  it("puts a day plan before a week plan that ends the same day", () => {
    // Sunday the 11th ends this week; a day plan for it ends the same moment.
    const sorted = plannerSortCards("todo", [
      planned({ id: "tasks/week" }),
      planned({
        id: "tasks/sunday",
        horizon: "day",
        period_start: "2026-10-11",
      }),
    ]);
    expect(ids(sorted)).toEqual(["tasks/sunday", "tasks/week"]);
  });

  it("orders Doing by upstream order, Done by completion newest first, Dropped by drop time", () => {
    expect(
      ids(
        plannerSortCards("doing", [
          card({ id: "tasks/b", sort_order: 2 }),
          card({ id: "tasks/a", sort_order: 1 }),
        ]),
      ),
    ).toEqual(["tasks/a", "tasks/b"]);
    expect(
      ids(
        plannerSortCards("done", [
          card({ id: "tasks/old", completed_at: "2026-10-02T00:00:00Z" }),
          card({ id: "tasks/new", completed_at: "2026-10-05T00:00:00Z" }),
          card({
            id: "tasks/none",
            completed_at: null,
            updated_at: "2026-10-04T00:00:00Z",
          }),
        ]),
      ),
    ).toEqual(["tasks/new", "tasks/none", "tasks/old"]);
    expect(
      ids(
        plannerSortCards("dropped", [
          card({ id: "tasks/x", dropped_at: "2026-10-01T00:00:00Z" }),
          card({ id: "tasks/y", dropped_at: "2026-10-06T00:00:00Z" }),
        ]),
      ),
    ).toEqual(["tasks/y", "tasks/x"]);
  });

  it("does not touch the array it is given", () => {
    const input = [
      card({ created_at: "2026-10-01T00:00:00Z" }),
      card({ created_at: "2026-10-09T00:00:00Z" }),
    ];
    const before = ids(input);
    plannerSortCards("backlog", input);
    expect(ids(input)).toEqual(before);
  });
});

describe("plannerPlaceCard", () => {
  it("moves a card into the column its fields put it in", () => {
    const a = card({ id: "tasks/a" });
    const before = board({ backlog: [a] });
    const after = plannerPlaceCard(before, {
      ...a,
      horizon: "week",
      period_start: WEEK,
    });
    expect(ids(after.columns.backlog)).toEqual([]);
    expect(ids(after.columns.todo)).toEqual(["tasks/a"]);
  });

  it("leaves the columns it does not touch as the same arrays", () => {
    const a = card({ id: "tasks/a" });
    const before = board({
      backlog: [a],
      doing: [card({ status: "in_progress" })],
    });
    const after = plannerPlaceCard(before, {
      ...a,
      horizon: "week",
      period_start: WEEK,
    });
    expect(after.columns.doing).toBe(before.columns.doing);
    expect(before.columns.backlog).toEqual([a]);
  });

  it("keeps a column sorted when a card lands in it", () => {
    const newest = planned({
      id: "tasks/today",
      horizon: "day",
      period_start: TODAY,
    });
    const before = board({
      todo: [
        planned({ id: "tasks/week" }),
        planned({
          id: "tasks/month",
          horizon: "month",
          period_start: "2026-10-01",
        }),
      ],
      backlog: [card({ id: "tasks/today" })],
    });
    const after = plannerPlaceCard(before, newest);
    expect(ids(after.columns.todo)).toEqual([
      "tasks/today",
      "tasks/week",
      "tasks/month",
    ]);
  });

  it("drops a card from the board when Dropped was not asked for", () => {
    const a = planned({ id: "tasks/a" });
    const after = plannerPlaceCard(
      board({ todo: [a] }),
      plannerPredictDrop(a, NOW),
    );
    expect(plannerFindCard(after, "tasks/a")).toBeUndefined();
    expect(after.columns.dropped).toBeUndefined();
  });

  it("files a dropped card under Dropped when that list is on the board", () => {
    const a = planned({ id: "tasks/a" });
    const after = plannerPlaceCard(
      board({ todo: [a], dropped: [] }),
      plannerPredictDrop(a, NOW),
    );
    expect(ids(after.columns.todo)).toEqual([]);
    expect(ids(after.columns.dropped)).toEqual(["tasks/a"]);
  });
});

describe("plannerUpdateCard and plannerFindCard", () => {
  it("rewrites one card and re-places it", () => {
    const a = card({ id: "tasks/a" });
    const after = plannerUpdateCard(
      board({ backlog: [a] }),
      "tasks/a",
      (entry) => plannerPredictMove(entry, "doing", CONTEXT),
    );
    expect(ids(after.columns.doing)).toEqual(["tasks/a"]);
    expect(plannerFindCard(after, "tasks/a")?.status).toBe("in_progress");
  });

  it("leaves the board alone for a task that is not on it", () => {
    const before = board({ backlog: [card()] });
    expect(plannerUpdateCard(before, "tasks/missing", (entry) => entry)).toBe(
      before,
    );
  });

  it("finds a card in Dropped too, and counts every column but Dropped", () => {
    const dropped = card({ id: "tasks/d", dropped_at: "2026-10-06T00:00:00Z" });
    const b = board({
      backlog: [card()],
      todo: [planned(), planned()],
      doing: [card({ status: "in_progress" })],
      done: [card({ status: "done" })],
      other: [card({ status: "blocked" })],
      dropped: [dropped],
    });
    expect(plannerFindCard(b, "tasks/d")).toBe(dropped);
    expect(plannerBoardCardCount(b)).toBe(6);
  });

  it("rolls an edit back by placing the card as it was", () => {
    const a = planned({ id: "tasks/a" });
    const original = board({ todo: [a], backlog: [card({ id: "tasks/b" })] });
    const edited = plannerUpdateCard(original, "tasks/a", (entry) =>
      plannerPredictMove(entry, "done", CONTEXT),
    );
    expect(ids(edited.columns.done)).toEqual(["tasks/a"]);
    const restored = plannerPlaceCard(edited, a);
    expect(restored.columns).toEqual(original.columns);
  });
});

describe("plannerPredictMove", () => {
  const move = (from: PlannerBoardCard, to: PlannerColumn) =>
    plannerPredictMove(from, to, CONTEXT);

  it("does nothing for the column it is already in, and for a dropped card", () => {
    const a = planned();
    expect(move(a, "todo")).toBe(a);
    const dropped = planned({ dropped_at: "2026-10-06T00:00:00Z" });
    expect(move(dropped, "doing")).toBe(dropped);
  });

  it("Backlog to To Do plans this week", () => {
    const next = move(card(), "todo");
    expect(next).toMatchObject({
      status: "todo",
      horizon: "week",
      period_start: WEEK,
    });
    expect(plannerCardColumn(next)).toBe("todo");
  });

  it("To Do to Backlog clears the plan", () => {
    const next = move(
      planned({ horizon: "day", period_start: TODAY }),
      "backlog",
    );
    expect(next).toMatchObject({
      status: "todo",
      horizon: null,
      period_start: null,
    });
    expect(plannerCardColumn(next)).toBe("backlog");
  });

  it("Backlog or To Do to Doing keeps the plan", () => {
    expect(move(planned(), "doing")).toMatchObject({
      status: "in_progress",
      horizon: "week",
      period_start: WEEK,
    });
    expect(move(card(), "doing")).toMatchObject({
      status: "in_progress",
      horizon: null,
    });
  });

  it("any column to Done completes it now and keeps the plan", () => {
    for (const from of [
      card(),
      planned(),
      planned({ status: "in_progress" }),
    ]) {
      expect(move(from, "done")).toMatchObject({
        status: "done",
        completed_at: NOW.toISOString(),
        horizon: from.horizon,
        period_start: from.period_start,
      });
    }
  });

  it("Doing to To Do keeps a plan and gives a planless card this week", () => {
    const day = planned({
      status: "in_progress",
      horizon: "day",
      period_start: "2026-10-09",
    });
    expect(move(day, "todo")).toMatchObject({
      status: "todo",
      horizon: "day",
      period_start: "2026-10-09",
    });
    expect(move(card({ status: "in_progress" }), "todo")).toMatchObject({
      status: "todo",
      horizon: "week",
      period_start: WEEK,
    });
  });

  it("Doing or Done to Backlog clears the plan and the completion", () => {
    const done = planned({
      status: "done",
      completed_at: "2026-10-06T00:00:00Z",
    });
    expect(move(done, "backlog")).toMatchObject({
      status: "todo",
      completed_at: null,
      horizon: null,
      period_start: null,
    });
    expect(move(planned({ status: "in_progress" }), "backlog")).toMatchObject({
      status: "todo",
      horizon: null,
    });
  });

  it("Done to To Do reopens it, and re-plans only a missing or past plan", () => {
    const finished = (overrides: Partial<PlannerBoardCard>) =>
      card({
        status: "done",
        completed_at: "2026-10-06T00:00:00Z",
        ...overrides,
      });
    // The plan is current: it stays.
    expect(
      move(finished({ horizon: "day", period_start: "2026-10-09" }), "todo"),
    ).toMatchObject({
      status: "todo",
      completed_at: null,
      horizon: "day",
      period_start: "2026-10-09",
    });
    // The plan is past: this week.
    expect(
      move(finished({ horizon: "day", period_start: "2026-10-02" }), "todo"),
    ).toMatchObject({ horizon: "week", period_start: WEEK });
    // A week plan that started last week is past too.
    expect(
      move(finished({ horizon: "week", period_start: "2026-09-28" }), "todo"),
    ).toMatchObject({ horizon: "week", period_start: WEEK });
    // No plan at all.
    expect(move(finished({}), "todo")).toMatchObject({
      horizon: "week",
      period_start: WEEK,
    });
  });

  it("Done to Doing reopens it with the plan kept", () => {
    expect(
      move(
        planned({ status: "done", completed_at: "2026-10-06T00:00:00Z" }),
        "doing",
      ),
    ).toMatchObject({
      status: "in_progress",
      completed_at: null,
      horizon: "week",
    });
  });

  it("moves a card with an unknown status like any other", () => {
    expect(move(card({ status: "blocked" }), "doing").status).toBe(
      "in_progress",
    );
    expect(move(planned({ status: "blocked" }), "todo")).toMatchObject({
      status: "todo",
      horizon: "week",
    });
  });

  it("never changes the carry count or the title", () => {
    const carried = planned({ carry_count: 3, title: "Keep me" });
    const next = move(carried, "doing");
    expect(next.carry_count).toBe(3);
    expect(next.title).toBe("Keep me");
  });
});

describe("the other predictions", () => {
  it("re-plans a card, which moves Backlog to To Do and back", () => {
    const a = card();
    const next = plannerPredictPlan(
      a,
      { horizon: "day", day: "2026-10-09" },
      NOW,
    );
    expect(next).toMatchObject({ horizon: "day", period_start: "2026-10-09" });
    expect(plannerCardColumn(next)).toBe("todo");
    const cleared = plannerPredictPlan(next, null, NOW);
    expect(cleared).toMatchObject({ horizon: null, period_start: null });
    expect(plannerCardColumn(cleared)).toBe("backlog");
  });

  it("stores a week plan as its Monday, and keeps the carry count", () => {
    const next = plannerPredictPlan(
      planned({ carry_count: 2 }),
      { horizon: "week", day: "2026-10-14" },
      NOW,
    );
    expect(next.period_start).toBe("2026-10-12");
    expect(next.carry_count).toBe(2);
  });

  it("leaves a Doing card in Doing when its plan changes", () => {
    const next = plannerPredictPlan(
      card({ status: "in_progress" }),
      { horizon: "day", day: TODAY },
      NOW,
    );
    expect(plannerCardColumn(next)).toBe("doing");
  });

  it("sets and clears a due date", () => {
    const a = card();
    expect(plannerPredictDue(a, "2026-10-20", NOW).due_at).toBe("2026-10-20");
    expect(
      plannerPredictDue(plannerPredictDue(a, "2026-10-20", NOW), null, NOW)
        .due_at,
    ).toBeNull();
  });

  it("drops a card, keeping its plan and clearing its due date", () => {
    const next = plannerPredictDrop(
      planned({ due_at: "2026-10-09", horizon: "day", period_start: TODAY }),
      NOW,
    );
    expect(next).toMatchObject({
      dropped_at: NOW.toISOString(),
      due_at: null,
      horizon: "day",
    });
  });

  it("undrops a card back to where its status and kept plan put it, without the old due date", () => {
    const dropped = plannerPredictDrop(planned({ due_at: "2026-10-09" }), NOW);
    const back = plannerPredictUndrop(dropped, NOW);
    expect(back.dropped_at).toBeNull();
    expect(back.due_at).toBeNull();
    expect(plannerCardColumn(back)).toBe("todo");
    expect(
      plannerCardColumn(
        plannerPredictUndrop(plannerPredictDrop(card(), NOW), NOW),
      ),
    ).toBe("backlog");
  });
});

describe("plannerCardFromTask", () => {
  const task: TaskDto = {
    id: "tasks/new",
    project_id: "projects/p1",
    source_memo_id: null,
    title: "From the server",
    notes: "ignored",
    status: "todo",
    priority: "high",
    due_at: "2026-10-09",
    sort_order: 3,
    completed_at: null,
    deleted_at: null,
    created_at: "2026-10-07T09:00:00.000Z",
    updated_at: "2026-10-07T09:00:01.000Z",
  };

  it("flattens a task and its plan into a board card", () => {
    expect(
      plannerCardFromTask(
        task,
        {
          task_id: "tasks/new",
          horizon: "day",
          period_start: TODAY,
          carry_count: 2,
          dropped_at: null,
          effort: null,
          created_at: "2026-10-07T09:00:00.000Z",
          updated_at: "2026-10-07T09:00:00.000Z",
        },
        "Home",
      ),
    ).toEqual({
      id: "tasks/new",
      project_id: "projects/p1",
      project_name: "Home",
      title: "From the server",
      status: "todo",
      priority: "high",
      due_at: "2026-10-09",
      sort_order: 3,
      completed_at: null,
      created_at: "2026-10-07T09:00:00.000Z",
      updated_at: "2026-10-07T09:00:01.000Z",
      horizon: "day",
      period_start: TODAY,
      carry_count: 2,
      dropped_at: null,
    });
  });

  it("reads a task with no plan row as unplanned, and drops the project name with the project", () => {
    const flat = plannerCardFromTask(
      { ...task, project_id: null },
      null,
      "Home",
    );
    expect(flat).toMatchObject({
      horizon: null,
      period_start: null,
      carry_count: 0,
      dropped_at: null,
      project_id: null,
      project_name: null,
    });
  });
});

describe("plannerIsOverdue", () => {
  it("is true only for an open card past its due date", () => {
    expect(plannerIsOverdue(card({ due_at: "2026-10-06" }), TODAY)).toBe(true);
    expect(plannerIsOverdue(card({ due_at: TODAY }), TODAY)).toBe(false);
    expect(plannerIsOverdue(card({ due_at: "2026-10-08" }), TODAY)).toBe(false);
    expect(plannerIsOverdue(card({ due_at: null }), TODAY)).toBe(false);
  });

  it("is false for a finished or a dropped card", () => {
    expect(
      plannerIsOverdue(card({ due_at: "2026-10-01", status: "done" }), TODAY),
    ).toBe(false);
    expect(
      plannerIsOverdue(
        card({ due_at: "2026-10-01", dropped_at: "2026-10-06T00:00:00Z" }),
        TODAY,
      ),
    ).toBe(false);
  });
});
