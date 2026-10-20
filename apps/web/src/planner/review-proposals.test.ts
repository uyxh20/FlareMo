import type {
  PlannerAgentProposalDto,
  PlannerBoardCard,
  PlannerBoardResponse,
} from "@flaremo/contracts";
import { describe, expect, it } from "vitest";
import type { PlannerForwardState, PlannerPlanGoal } from "./review-model";
import {
  plannerAddProposedGoal,
  plannerFindBoardCard,
  plannerProposalGoalId,
} from "./review-proposals";

function proposal(
  overrides: Partial<PlannerAgentProposalDto> = {},
): PlannerAgentProposalDto {
  return {
    id: "p-goal",
    kind: "goal",
    week_start: "2026-10-19",
    pillar: "work",
    title: "Ship the agent",
    lines: [],
    goal_ref: null,
    serves: null,
    why: "It came up three times.",
    quote: null,
    source_day: null,
    state: "open",
    ...overrides,
  };
}

function forward(goals: PlannerPlanGoal[]): PlannerForwardState {
  return {
    seen: true,
    step: 1,
    settled: {},
    goals,
    tasks: [],
    toBacklog: [],
    question: null,
    edited: false,
    prefilled: false,
    knownGoalIds: [],
  };
}

function card(id: string, title: string): PlannerBoardCard {
  return { id, title } as PlannerBoardCard;
}

function board(
  columns: Partial<PlannerBoardResponse["columns"]>,
): Pick<PlannerBoardResponse, "columns"> {
  return {
    columns: {
      backlog: [],
      todo: [],
      doing: [],
      done: [],
      other: [],
      ...columns,
    },
  };
}

describe("plannerAddProposedGoal", () => {
  it("fills its objective's empty slot first", () => {
    const next = plannerAddProposedGoal(
      forward([
        { id: "g1", pillar: "work", title: "", fromSummary: "2026-10-12" },
        { id: "g2", pillar: "health", title: "Run twice" },
      ]),
      proposal(),
    );
    expect(next.edited).toBe(true);
    expect(next.goals).toEqual([
      { id: "g1", pillar: "work", title: "Ship the agent" },
      { id: "g2", pillar: "health", title: "Run twice" },
    ]);
  });

  it("adds a goal of its own under the proposal's id, up to twelve", () => {
    const one = plannerAddProposedGoal(
      forward([{ id: "g1", pillar: "work", title: "Close a deal" }]),
      proposal(),
    );
    expect(one.goals.at(-1)).toEqual({
      id: "p-goal",
      pillar: "work",
      title: "Ship the agent",
      custom: true,
    });
    const full = forward(
      Array.from({ length: 12 }, (_, index) => ({
        id: `g${index}`,
        pillar: "work" as const,
        title: `Goal ${index}`,
      })),
    );
    expect(plannerAddProposedGoal(full, proposal())).toBe(full);
  });
});

describe("plannerFindBoardCard", () => {
  it("matches a live card by title, To Do and Doing before Backlog", () => {
    const found = plannerFindBoardCard(
      board({
        backlog: [card("b", "Write  the memo")],
        doing: [card("d", "write the MEMO")],
        done: [card("x", "Write the memo")],
      }),
      " Write the memo ",
    );
    expect(found).toEqual({
      card: card("d", "write the MEMO"),
      column: "doing",
    });
    expect(plannerFindBoardCard(board({}), "Write the memo")).toBeNull();
  });
});

describe("plannerProposalGoalId", () => {
  const goals = forward([
    { id: "g1", pillar: "health", title: "Run twice" },
    { id: "g2", pillar: "work", title: "Close a deal" },
    { id: "p-goal", pillar: "work", title: "Ship the agent", custom: true },
    { id: "g4", pillar: "ai", title: "" },
  ]);

  it("follows the goal it names, then the proposed goal it names", () => {
    expect(
      plannerProposalGoalId(
        proposal({ kind: "task", goal_ref: "g1" }),
        goals,
        [],
      ),
    ).toBe("g1");
    const parent = proposal({ id: "p-other", title: "close a DEAL" });
    expect(
      plannerProposalGoalId(
        proposal({ kind: "task", goal_ref: "p-other", pillar: null }),
        goals,
        [parent],
      ),
    ).toBe("g2");
  });

  it("falls back to its objective, then the first named goal", () => {
    expect(
      plannerProposalGoalId(
        proposal({ kind: "task", goal_ref: null, pillar: "work" }),
        goals,
        [],
      ),
    ).toBe("g2");
    expect(
      plannerProposalGoalId(
        proposal({ kind: "task", goal_ref: "gone", pillar: "ai" }),
        goals,
        [],
      ),
    ).toBe("g1");
    expect(
      plannerProposalGoalId(proposal({ kind: "task" }), forward([]), []),
    ).toBeNull();
  });
});
