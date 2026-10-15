import type {
  PlannerBoardCard,
  PlannerBoardResponse,
  PlannerTaskDetailResponse,
} from "@flaremo/contracts";
import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { plannerFindCard, plannerPlaceCard } from "./board-model";
import { plannerQueryKeys } from "./query-keys";
import {
  createPlannerTaskStore,
  type PlannerTaskChangeView,
  type PlannerTaskStore,
} from "./task-store";

// The task store on its own (task-store.ts): the screen shows the last saved copy
// with every change in flight on top, and a change that fails takes away only
// itself (fork review C01, C02).

const TODAY = "2026-10-07";
const TASK_ID = "tasks/t1";

const CARD: PlannerBoardCard = {
  id: TASK_ID,
  project_id: null,
  project_name: null,
  title: "Task",
  status: "todo",
  priority: "none",
  due_at: null,
  sort_order: 0,
  completed_at: null,
  created_at: "2026-10-01T08:00:00.000Z",
  updated_at: "2026-10-01T08:00:00.000Z",
  horizon: "day",
  period_start: TODAY,
  carry_count: 0,
  dropped_at: null,
  start_date: null,
  board_rank: null,
  goal_id: null,
};

const BOARD: PlannerBoardResponse = plannerPlaceCard(
  {
    columns: { backlog: [], todo: [], doing: [], done: [], other: [] },
    today: TODAY,
    periods: { day: TODAY, week: "2026-10-05", month: "2026-10-01" },
    history: "ok",
    truncated: false,
  },
  CARD,
);

const DETAIL = {
  task: { id: TASK_ID, notes: "Old notes", priority: "none" },
  plan: null,
  project: null,
  comments: [],
} as unknown as PlannerTaskDetailResponse;

const boardKey = plannerQueryKeys.board(TODAY, false);
const detailKey = plannerQueryKeys.detail(TASK_ID);

let queryClient: QueryClient;
let refresh: Mock<() => void>;
let store: PlannerTaskStore;

beforeEach(() => {
  queryClient = new QueryClient();
  queryClient.setQueryData(boardKey, BOARD);
  queryClient.setQueryData(detailKey, DETAIL);
  refresh = vi.fn<() => void>();
  store = createPlannerTaskStore(queryClient, refresh);
});

const card = () =>
  plannerFindCard(
    queryClient.getQueryData<PlannerBoardResponse>(
      boardKey,
    ) as PlannerBoardResponse,
    TASK_ID,
  );
const detail = () =>
  queryClient.getQueryData<PlannerTaskDetailResponse>(detailKey);

/** A change that rewrites the card's fields on the board. */
function cardView(fields: Partial<PlannerBoardCard>): PlannerTaskChangeView {
  return {
    board: (board) => {
      const current = plannerFindCard(board, TASK_ID);
      return current
        ? plannerPlaceCard(board, { ...current, ...fields })
        : board;
    },
  };
}

/** A change that rewrites the panel's task fields. */
function taskView(
  fields: Partial<PlannerTaskDetailResponse["task"]>,
): PlannerTaskChangeView {
  return {
    detail: (shown) => ({ ...shown, task: { ...shown.task, ...fields } }),
  };
}

describe("the task store", () => {
  it("shows a change at once and keeps it once saved", () => {
    const change = store.begin(TASK_ID);
    change.show(cardView({ priority: "high" }));
    expect(card()?.priority).toBe("high");
    change.saved(cardView({ priority: "high", updated_at: "server" }));
    expect(card()).toMatchObject({ priority: "high", updated_at: "server" });
  });

  it("lets a failed change undo only itself, never a change saved meanwhile", () => {
    const move = store.begin(TASK_ID);
    const priority = store.begin(TASK_ID);
    move.show(cardView({ status: "in_progress" }));
    priority.show(cardView({ priority: "high" }));
    expect(card()).toMatchObject({ status: "in_progress", priority: "high" });

    // The move is saved, then the priority is refused: the card stays in Doing.
    move.saved(cardView({ status: "in_progress" }));
    priority.failed();
    expect(card()).toMatchObject({ status: "in_progress", priority: "none" });
    expect(
      queryClient.getQueryData<PlannerBoardResponse>(boardKey)?.columns.doing,
    ).toHaveLength(1);
  });

  it("keeps a later change in flight on screen when an earlier one fails", () => {
    const first = store.begin(TASK_ID);
    const second = store.begin(TASK_ID);
    first.show(cardView({ priority: "high" }));
    second.show(cardView({ title: "Renamed" }));
    first.failed();
    expect(card()).toMatchObject({ priority: "none", title: "Renamed" });
    second.saved(cardView({ title: "Renamed" }));
    expect(card()).toMatchObject({ priority: "none", title: "Renamed" });
  });

  it("never puts saved notes back when another edit of the task fails", () => {
    const notes = store.begin(TASK_ID, { refresh: false });
    notes.saved(taskView({ notes: "New notes" }));
    const priority = store.begin(TASK_ID);
    priority.show(taskView({ priority: "high" }));
    priority.failed();
    expect(detail()?.task).toMatchObject({
      notes: "New notes",
      priority: "none",
    });
  });

  it("refreshes once, after the last change settles, and only when one asked", () => {
    const quiet = store.begin(TASK_ID, { refresh: false });
    quiet.saved(taskView({ notes: "x" }));
    expect(refresh).not.toHaveBeenCalled();

    const first = store.begin(TASK_ID);
    const second = store.begin(TASK_ID, { refresh: false });
    first.show(cardView({ priority: "high" }));
    first.saved(cardView({ priority: "high" }));
    expect(store.inFlight).toBe(1);
    expect(refresh).not.toHaveBeenCalled();
    second.failed();
    expect(store.inFlight).toBe(0);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("lets go of its copies when nothing is in flight, so a refetch is the server's", () => {
    const change = store.begin(TASK_ID);
    change.show(cardView({ priority: "high" }));
    change.saved(cardView({ priority: "high" }));
    // Fresh data from the server, then a new change on top of it.
    queryClient.setQueryData(
      boardKey,
      plannerPlaceCard(BOARD, { ...CARD, title: "From the server" }),
    );
    const next = store.begin(TASK_ID);
    next.show(cardView({ priority: "low" }));
    next.failed();
    expect(card()).toMatchObject({
      title: "From the server",
      priority: "none",
    });
  });

  it("ignores a second settle of the same change", () => {
    const change = store.begin(TASK_ID);
    change.show(cardView({ priority: "high" }));
    change.failed();
    change.saved(cardView({ priority: "high" }));
    expect(card()?.priority).toBe("none");
    expect(store.inFlight).toBe(0);
  });
});
