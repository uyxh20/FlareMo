import type {
  PlannerBoardCard,
  PlannerBoardResponse,
  PlannerGoalDto,
} from "@flaremo/contracts";
import { describe, expect, it } from "vitest";
import {
  plannerMorningDateLabel,
  plannerMorningDue,
  plannerMorningDueWindow,
  plannerMorningGoals,
  plannerMorningGoalsHeading,
  plannerMorningLateLabel,
} from "./morning-model";

// The morning page's panels, read from the cockpit's board.

const TODAY = "2026-11-11";

function card(overrides: Partial<PlannerBoardCard>): PlannerBoardCard {
  return {
    id: "tasks/x",
    project_id: null,
    project_name: null,
    title: "Task",
    status: "todo",
    priority: "none",
    due_at: null,
    sort_order: 0,
    completed_at: null,
    created_at: "2026-11-01T00:00:00Z",
    updated_at: "2026-11-01T00:00:00Z",
    horizon: "week",
    period_start: "2026-11-09",
    carry_count: 0,
    dropped_at: null,
    start_date: null,
    board_rank: null,
    goal_id: null,
    ...overrides,
  };
}

function board(
  cards: PlannerBoardCard[],
  goals: Array<Partial<PlannerGoalDto>> = [],
): PlannerBoardResponse {
  return {
    columns: {
      backlog: [],
      todo: cards.filter((c) => c.status === "todo"),
      doing: cards.filter((c) => c.status === "in_progress"),
      done: cards.filter((c) => c.status === "done"),
      other: [],
    },
    today: TODAY,
    periods: { day: TODAY, week: "2026-11-09", month: "2026-11-01" },
    history: "ok",
    truncated: false,
    week: {
      start: "2026-11-09",
      goals: goals as PlannerGoalDto[],
    },
  };
}

describe("plannerMorningDue", () => {
  const cards = [
    card({ id: "a", title: "Due today", due_at: TODAY }),
    card({ id: "b", title: "Two days late", due_at: "2026-11-09" }),
    card({ id: "c", title: "Tomorrow", due_at: "2026-11-12" }),
    card({ id: "d", title: "No date" }),
    card({ id: "e", title: "Done", due_at: TODAY, status: "done" }),
    card({ id: "f", title: "Dropped", due_at: TODAY, dropped_at: TODAY }),
  ];

  it("lists open tasks due today or overdue, oldest first", () => {
    expect(plannerMorningDue(board(cards), TODAY)).toEqual([
      { id: "b", title: "Two days late", daysLate: 2, done: false },
      { id: "a", title: "Due today", daysLate: 0, done: false },
    ]);
  });

  it("keeps a task ticked on the page, shown done", () => {
    const due = plannerMorningDue(board(cards), TODAY, new Set(["e"]));
    expect(due.map((task) => [task.id, task.done])).toEqual([
      ["b", false],
      ["e", true],
      ["a", false],
    ]);
  });

  it("lists up to thirty", () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      card({ id: `t${i}`, title: `T${i}`, due_at: TODAY }),
    );
    expect(plannerMorningDue(board(many), TODAY)).toHaveLength(30);
  });
});

describe("plannerMorningGoals", () => {
  it("counts each goal's tasks and how many are done", () => {
    const goals = plannerMorningGoals(
      board(
        [
          card({ id: "1", goal_id: "g1", status: "done" }),
          card({ id: "2", goal_id: "g1", status: "done" }),
          card({ id: "3", goal_id: "g1" }),
          card({ id: "4", goal_id: "g1", dropped_at: TODAY }),
          card({ id: "5", goal_id: "g2" }),
        ],
        [
          { id: "g1", title: "Train 3 times", pillar: "health" },
          { id: "g2", title: "Ship it", pillar: "work" },
          { id: "g3", title: "Empty", pillar: null },
        ],
      ),
    );
    expect(goals.map((g) => [g.id, g.done, g.total])).toEqual([
      ["g1", 2, 3],
      ["g2", 0, 1],
      ["g3", 0, 0],
    ]);
  });
});

describe("labels", () => {
  it("names the date, the week and the lateness", () => {
    expect(plannerMorningDateLabel("2026-11-10")).toBe("Tuesday, 10 Nov");
    expect(plannerMorningGoalsHeading(board([]))).toBe("Week 46 goals");
    expect(plannerMorningLateLabel(2)).toBe("2d late");
    expect(plannerMorningLateLabel(0)).toBeNull();
  });
});

describe("plannerMorningDueWindow", () => {
  it("pages three at a time, with arrows only when there are more", () => {
    expect(plannerMorningDueWindow(3, 0)).toMatchObject({
      from: 0,
      to: 3,
      paged: false,
      canUp: false,
      canDown: false,
    });
    const first = plannerMorningDueWindow(7, 0);
    expect(first).toMatchObject({
      from: 0,
      to: 3,
      paged: true,
      canUp: false,
      canDown: true,
    });
    const second = plannerMorningDueWindow(7, first.downStart);
    expect(second).toMatchObject({
      from: 3,
      to: 6,
      canUp: true,
      canDown: true,
    });
    const last = plannerMorningDueWindow(7, second.downStart);
    expect(last).toMatchObject({
      from: 6,
      to: 7,
      canDown: false,
      canUp: true,
      upStart: 3,
    });
  });

  it("never shows an empty page after the list shrinks", () => {
    expect(plannerMorningDueWindow(6, 6)).toMatchObject({ from: 3, to: 6 });
    expect(plannerMorningDueWindow(0, 3)).toMatchObject({
      from: 0,
      to: 0,
      paged: false,
    });
  });
});
