// @vitest-environment jsdom
import type {
  PlannerBoardCard,
  PlannerBoardResponse,
  PlannerCreateTaskResponse,
  PlannerTaskDetailResponse,
  PlannerTaskPlanResponse,
  TaskDto,
} from "@flaremo/contracts";
import { QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";
import { ApiError } from "@/api/client";
import { plannerCreateTaskRequest, plannerUpdateTaskRequest } from "./api";
import { plannerFindCard, plannerPlaceCard } from "./board-model";
import { plannerCardFromDetail } from "./panel-model";
import { plannerQueryKeys } from "./query-keys";
import { type PlannerTestMount, plannerTestMount } from "./test-render";
import { type PlannerActions, usePlannerActions } from "./use-planner-actions";

// The cockpit's optimistic edits (fork-owned add-on,
// docs/planning-cockpit-implementation-plan.md, sections 5 and 13), with the
// network and the toasts replaced and the real query cache: an edit shows on the
// board AND in the open task panel before the server answers, settles on the
// server's answer, and is put back with a toast when the server refuses.

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  plannerUpdateTaskRequest: vi.fn(),
  plannerCreateTaskRequest: vi.fn(),
}));

const update = vi.mocked(plannerUpdateTaskRequest);
const create = vi.mocked(plannerCreateTaskRequest);

// Wednesday 7 October 2026: its week starts Monday the 5th.
const TODAY = "2026-10-07";
const WEEK = "2026-10-05";
const TASK_ID = "tasks/t1";

const TASK: TaskDto = {
  id: TASK_ID,
  project_id: "projects/web",
  source_memo_id: null,
  title: "Write the launch announcement",
  notes: "Draft in the doc",
  status: "todo",
  priority: "none",
  due_at: null,
  sort_order: 0,
  completed_at: null,
  deleted_at: null,
  created_at: "2026-10-01T08:00:00.000Z",
  updated_at: "2026-10-01T08:00:00.000Z",
};

const PLAN = {
  task_id: TASK_ID,
  horizon: "week",
  period_start: WEEK,
  carry_count: 0,
  dropped_at: null,
  start_date: null,
  board_rank: null,
  goal_id: null,
  effort: null,
  created_at: "2026-10-02T08:00:00.000Z",
  updated_at: "2026-10-02T08:00:00.000Z",
} as const;

const DETAIL: PlannerTaskDetailResponse = {
  task: TASK,
  plan: PLAN,
  project: { id: "projects/web", name: "Website relaunch", ancestors: [] },
  comments: [],
};

const EMPTY_BOARD: PlannerBoardResponse = {
  columns: { backlog: [], todo: [], doing: [], done: [], other: [] },
  today: TODAY,
  periods: { day: TODAY, week: WEEK, month: "2026-10-01" },
  history: "ok",
  truncated: false,
};

/** A board with the card in whichever column its own fields put it in. */
function boardWith(card: PlannerBoardCard): PlannerBoardResponse {
  return plannerPlaceCard(EMPTY_BOARD, card);
}

const boardKey = plannerQueryKeys.board(TODAY, false);
const detailKey = plannerQueryKeys.detail(TASK_ID);

/** A request the test settles by hand, so the state in between can be looked at. */
function pendingRequest<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

let mounted: PlannerTestMount | undefined;
let queryClient: QueryClient;
let actions: PlannerActions;
let reveal: Mock<(taskId: string) => void>;

function Harness() {
  actions = usePlannerActions({ today: TODAY, reveal });
  return null;
}

/** Lets promises that are already settled, and the code waiting on them, run. */
async function flush() {
  const { act } = await import("react");
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Number.POSITIVE_INFINITY },
    },
  });
  reveal = vi.fn<(taskId: string) => void>();
  mounted = plannerTestMount(<Harness />, { queryClient });
});

afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
  queryClient.clear();
});

/** The seeded task's card, wherever the board has put it. */
const boardCard = () => {
  const board = queryClient.getQueryData<PlannerBoardResponse>(boardKey);
  return board ? plannerFindCard(board, TASK_ID) : undefined;
};
const detail = () =>
  queryClient.getQueryData<PlannerTaskDetailResponse>(detailKey);

/** Seeds a board with the task's card and the task panel's detail for the same task. */
function seed(overrides: Partial<PlannerTaskDetailResponse> = {}) {
  const seeded = { ...DETAIL, ...overrides };
  queryClient.setQueryData(boardKey, boardWith(plannerCardFromDetail(seeded)));
  queryClient.setQueryData(detailKey, seeded);
  return plannerCardFromDetail(seeded);
}

describe("an edit made from the panel", () => {
  it("shows on the board and in the open panel before the server answers, then takes the server's answer", async () => {
    const card = seed();
    const request = pendingRequest<PlannerTaskPlanResponse>();
    update.mockReturnValue(request.promise);

    actions.setPriority(card, "high");
    await flush();

    // Not answered yet: both views already say High.
    expect(update).toHaveBeenCalledWith(TASK_ID, {
      today: TODAY,
      priority: "high",
    });
    expect(boardCard()?.priority).toBe("high");
    expect(detail()?.task.priority).toBe("high");
    expect(toast.success).not.toHaveBeenCalled();

    request.resolve({
      task: {
        ...TASK,
        priority: "high",
        updated_at: "2026-10-07T09:00:05.000Z",
      },
      plan: PLAN,
    });
    await flush();

    expect(boardCard()?.priority).toBe("high");
    expect(boardCard()?.updated_at).toBe("2026-10-07T09:00:05.000Z");
    expect(detail()?.task.updated_at).toBe("2026-10-07T09:00:05.000Z");
    // The panel shows the new value in place, so a success toast would only repeat it.
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("puts the board and the panel back, and says why, when the server refuses", async () => {
    const card = seed();
    update.mockRejectedValue(new ApiError("Priority is not allowed.", 400));

    actions.setPriority(card, "high");
    await flush();

    expect(boardCard()?.priority).toBe("none");
    expect(detail()?.task.priority).toBe("none");
    expect(toast.error).toHaveBeenCalledWith("Priority is not allowed.", {
      id: "planner-edit",
    });
  });

  it("explains a throttled edit in its own words, and undoes it", async () => {
    const card = seed();
    update.mockRejectedValue(new ApiError("Too many requests.", 429));

    actions.setTitle(card, "Renamed");
    await flush();

    expect(detail()?.task.title).toBe("Write the launch announcement");
    expect(boardCard()?.title).toBe("Write the launch announcement");
    expect(toast.error).toHaveBeenCalledWith(
      "Too many changes at once. Your edit was undone; try again in a moment.",
      { id: "planner-edit" },
    );
  });

  it("falls back to its own wording when the failure carries no message", async () => {
    const card = seed();
    update.mockRejectedValue(new TypeError(""));
    actions.setEffort(card, 3);
    await flush();
    expect(toast.error).toHaveBeenCalledWith("Couldn't save the effort", {
      id: "planner-edit",
    });
  });

  it("trims a new title on both views and sends it as it is", async () => {
    const card = seed();
    update.mockResolvedValue({
      task: { ...TASK, title: "Launch post" },
      plan: PLAN,
    });

    actions.setTitle(card, "  Launch post  ");
    await flush();

    expect(update).toHaveBeenCalledWith(TASK_ID, {
      today: TODAY,
      title: "  Launch post  ",
    });
    expect(boardCard()?.title).toBe("Launch post");
    expect(detail()?.task.title).toBe("Launch post");
  });

  it("sets an effort in the panel only: the board's card does not change", async () => {
    const card = seed();
    const before = boardCard();
    const request = pendingRequest<PlannerTaskPlanResponse>();
    update.mockReturnValue(request.promise);

    actions.setEffort(card, 3.5);
    await flush();

    expect(update).toHaveBeenCalledWith(TASK_ID, { today: TODAY, effort: 3.5 });
    expect(detail()?.plan?.effort).toBe(3.5);
    expect(boardCard()).toEqual(before);

    request.resolve({
      task: TASK,
      plan: { ...PLAN, effort: 3.5, updated_at: "2026-10-07T09:00:00.000Z" },
    });
    await flush();
    expect(detail()?.plan?.effort).toBe(3.5);
    expect(detail()?.plan?.updated_at).toBe("2026-10-07T09:00:00.000Z");
  });

  it("makes the plan row for a task that has none, so an effort has somewhere to live", async () => {
    const card = seed({ plan: null });
    update.mockReturnValue(pendingRequest<PlannerTaskPlanResponse>().promise);

    actions.setEffort(card, 2);
    await flush();

    expect(detail()?.plan).toMatchObject({
      task_id: TASK_ID,
      horizon: null,
      period_start: null,
      effort: 2,
    });
    // It plans nothing: the card is still a Backlog card.
    expect(boardCard()).toMatchObject({ horizon: null, period_start: null });
  });

  it("clears an effort with null", async () => {
    const card = seed({ plan: { ...PLAN, effort: 4 } });
    update.mockReturnValue(pendingRequest<PlannerTaskPlanResponse>().promise);
    actions.setEffort(card, null);
    await flush();
    expect(update).toHaveBeenCalledWith(TASK_ID, {
      today: TODAY,
      effort: null,
    });
    expect(detail()?.plan?.effort).toBeNull();
  });

  it("restores the estimate when saving it fails", async () => {
    const card = seed({ plan: { ...PLAN, effort: 4 } });
    update.mockRejectedValue(new ApiError("Nope", 400));
    actions.setEffort(card, 9);
    await flush();
    expect(detail()?.plan?.effort).toBe(4);
  });

  it("moves the task to another goal on both views, with the path the panel asked for", async () => {
    const card = seed();
    const home = {
      id: "projects/home",
      name: "Home",
      ancestors: [{ id: "projects/life", name: "Life" }],
    };
    const request = pendingRequest<PlannerTaskPlanResponse>();
    update.mockReturnValue(request.promise);

    actions.setProject(card, home);
    await flush();

    expect(update).toHaveBeenCalledWith(TASK_ID, {
      today: TODAY,
      project_id: "projects/home",
    });
    expect(boardCard()).toMatchObject({
      project_id: "projects/home",
      project_name: "Home",
    });
    expect(detail()?.project).toEqual(home);
    expect(detail()?.task.project_id).toBe("projects/home");

    request.resolve({
      task: { ...TASK, project_id: "projects/home" },
      plan: PLAN,
    });
    await flush();
    // The answer has no project name: the card keeps the new one, not the old.
    expect(boardCard()?.project_name).toBe("Home");
    expect(detail()?.project).toEqual(home);
  });

  it("takes the task out of its goal with null", async () => {
    const card = seed();
    update.mockResolvedValue({
      task: { ...TASK, project_id: null },
      plan: PLAN,
    });
    actions.setProject(card, null);
    await flush();
    expect(update).toHaveBeenCalledWith(TASK_ID, {
      today: TODAY,
      project_id: null,
    });
    expect(boardCard()).toMatchObject({ project_id: null, project_name: null });
    expect(detail()?.project).toBeNull();
  });

  it("puts a goal back after a refusal, name and path included", async () => {
    const card = seed();
    update.mockRejectedValue(new ApiError("No such project", 404));
    actions.setProject(card, {
      id: "projects/gone",
      name: "Gone",
      ancestors: [],
    });
    await flush();
    expect(boardCard()).toMatchObject({
      project_id: "projects/web",
      project_name: "Website relaunch",
    });
    expect(detail()?.project).toEqual(DETAIL.project);
  });
});

describe("the board's own actions, with the panel open", () => {
  it("moves the task on both views, and toasts the move", async () => {
    const card = seed();
    update.mockResolvedValue({
      task: { ...TASK, status: "in_progress" },
      plan: PLAN,
    });

    actions.move(card, "doing");
    await flush();

    expect(update).toHaveBeenCalledWith(TASK_ID, {
      today: TODAY,
      column: "doing",
    });
    expect(
      queryClient.getQueryData<PlannerBoardResponse>(boardKey)?.columns.doing,
    ).toHaveLength(1);
    expect(detail()?.task.status).toBe("in_progress");
    expect(toast.success).toHaveBeenCalledWith("Moved to Doing", {
      id: "planner-edit",
    });
    // A move can put the card out of sight, so it is pointed out.
    expect(reveal).toHaveBeenCalledWith(TASK_ID);
  });

  it("shows a move before the server answers, then undoes it on a refusal", async () => {
    const card = seed();
    const request = pendingRequest<PlannerTaskPlanResponse>();
    update.mockReturnValue(request.promise);

    actions.move(card, "done");
    await flush();
    expect(detail()?.task.status).toBe("done");
    expect(detail()?.task.completed_at).not.toBeNull();

    request.reject(new ApiError("The task is dropped. Undrop it first.", 400));
    await flush();
    expect(detail()?.task.status).toBe("todo");
    expect(detail()?.task.completed_at).toBeNull();
    expect(boardCard()?.status).toBe("todo");
    expect(toast.error).toHaveBeenCalledWith(
      "The task is dropped. Undrop it first.",
      { id: "planner-edit" },
    );
  });

  it("sets the due date on the panel's detail too", async () => {
    const card = seed();
    update.mockResolvedValue({
      task: { ...TASK, due_at: "2026-10-12" },
      plan: PLAN,
    });
    actions.setDue(card, "2026-10-12");
    await flush();
    expect(detail()?.task.due_at).toBe("2026-10-12");
    expect(boardCard()?.due_at).toBe("2026-10-12");
  });

  it("drops and undrops, on both views", async () => {
    const card = seed();
    update.mockResolvedValueOnce({
      task: { ...TASK },
      plan: { ...PLAN, dropped_at: "2026-10-07T09:00:00.000Z" },
    });
    actions.drop(card);
    await flush();
    expect(detail()?.plan?.dropped_at).toBe("2026-10-07T09:00:00.000Z");

    update.mockResolvedValueOnce({ task: TASK, plan: PLAN });
    actions.undrop(card);
    await flush();
    expect(detail()?.plan?.dropped_at).toBeNull();
  });

  it("still works when no panel is open: no detail is invented", async () => {
    const card = seed();
    queryClient.removeQueries({ queryKey: detailKey });
    update.mockResolvedValue({
      task: { ...TASK, priority: "low" },
      plan: PLAN,
    });
    actions.setPriority(card, "low");
    await flush();
    expect(boardCard()?.priority).toBe("low");
    expect(detail()).toBeUndefined();
  });
});

describe("refreshing after a change", () => {
  it("refreshes the cockpit, upstream's tasks and the projects once the last change has settled", async () => {
    const card = seed();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const first = pendingRequest<PlannerTaskPlanResponse>();
    const second = pendingRequest<PlannerTaskPlanResponse>();
    update
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    actions.setPriority(card, "high");
    actions.setEffort(card, 2);
    await flush();
    expect(invalidate).not.toHaveBeenCalled();

    first.resolve({ task: { ...TASK, priority: "high" }, plan: PLAN });
    await flush();
    // One edit is still in flight: refreshing now could snap its card back.
    expect(invalidate).not.toHaveBeenCalled();

    second.resolve({ task: TASK, plan: { ...PLAN, effort: 2 } });
    await flush();
    expect(invalidate.mock.calls.map((call) => call[0]?.queryKey)).toEqual([
      ["planner"],
      ["tasks"],
      ["projects"],
    ]);
  });
});

describe("adding into a column", () => {
  const createdTask: TaskDto = {
    ...TASK,
    id: "tasks/new",
    title: "Draft the changelog",
    project_id: null,
    notes: null,
    status: "in_progress",
  };
  const response = (
    extra: Partial<PlannerCreateTaskResponse> = {},
  ): PlannerCreateTaskResponse => ({
    task: createdTask,
    plan: null,
    ...extra,
  });
  const doing = () =>
    queryClient.getQueryData<PlannerBoardResponse>(boardKey)?.columns.doing ??
    [];

  it("puts a pending card in the column at once, then swaps it for the real one", async () => {
    seed();
    const request = pendingRequest<PlannerCreateTaskResponse>();
    create.mockReturnValue(request.promise);

    const added = actions.createIn({
      title: "Draft the changelog",
      column: "doing",
      plan: null,
    });
    await flush();

    // On the board before the server has heard of it, in the column it is for.
    expect(doing()).toHaveLength(1);
    expect(doing()[0]).toMatchObject({
      id: "tasks/pending-1",
      title: "Draft the changelog",
      status: "in_progress",
    });
    expect(create).toHaveBeenCalledWith({
      title: "Draft the changelog",
      today: TODAY,
      column: "doing",
    });
    expect(reveal).toHaveBeenCalledWith("tasks/pending-1");

    request.resolve(response());
    expect(await added).toBe(true);

    expect(doing()).toHaveLength(1);
    expect(doing()[0]).toMatchObject({
      id: "tasks/new",
      title: "Draft the changelog",
    });
    expect(reveal).toHaveBeenLastCalledWith("tasks/new");
    expect(toast.success).toHaveBeenCalledWith("Added to Doing", {
      id: "planner-edit",
    });
  });

  it("sends the plan with the column, and shows the plan on the pending card", async () => {
    seed();
    create.mockReturnValue(pendingRequest<PlannerCreateTaskResponse>().promise);
    void actions.createIn({
      title: "Weekly review",
      column: "todo",
      plan: { horizon: "week", day: WEEK },
    });
    await flush();
    expect(create).toHaveBeenCalledWith({
      title: "Weekly review",
      today: TODAY,
      column: "todo",
      plan: { horizon: "week", day: WEEK },
    });
    const todo =
      queryClient.getQueryData<PlannerBoardResponse>(boardKey)?.columns.todo ??
      [];
    expect(todo.find((entry) => entry.title === "Weekly review")).toMatchObject(
      {
        status: "todo",
        horizon: "week",
        period_start: WEEK,
      },
    );
  });

  it("numbers pending cards so two quick adds never share an id", async () => {
    seed();
    create.mockReturnValue(pendingRequest<PlannerCreateTaskResponse>().promise);
    void actions.createIn({ title: "One", column: "doing", plan: null });
    void actions.createIn({ title: "Two", column: "doing", plan: null });
    await flush();
    expect(
      doing()
        .map((entry) => entry.id)
        .sort(),
    ).toEqual(["tasks/pending-1", "tasks/pending-2"]);
  });

  it("takes the pending card away and reports the failure, resolving false", async () => {
    seed();
    create.mockRejectedValue(
      new ApiError("A task created in To Do needs a plan.", 400),
    );

    const added = await actions.createIn({
      title: "Doomed",
      column: "doing",
      plan: null,
    });

    expect(added).toBe(false);
    expect(doing()).toEqual([]);
    expect(toast.error).toHaveBeenCalledWith(
      "A task created in To Do needs a plan.",
      { id: "planner-edit" },
    );
    // The rest of the board was not touched by the rollback.
    expect(
      queryClient.getQueryData<PlannerBoardResponse>(boardKey)?.columns.todo,
    ).toHaveLength(1);
  });

  it("explains a throttled add in its own words", async () => {
    seed();
    create.mockRejectedValue(new ApiError("Too many requests.", 429));
    await actions.createIn({
      title: "Throttled",
      column: "backlog",
      plan: null,
    });
    expect(toast.error).toHaveBeenCalledWith(
      "Too many changes at once. Your edit was undone; try again in a moment.",
      { id: "planner-edit" },
    );
  });

  it("keeps the task but offers to retry when only its plan could not be saved", async () => {
    seed();
    create.mockResolvedValue(
      response({ plan_error: "The plan could not be saved." }),
    );
    const added = await actions.createIn({
      title: "Draft the changelog",
      column: "doing",
      plan: { horizon: "day", day: TODAY },
    });
    expect(added).toBe(true);
    expect(doing().map((entry) => entry.id)).toEqual(["tasks/new"]);
    expect(toast.warning).toHaveBeenCalledWith(
      "Task added, but its plan wasn't saved.",
      expect.objectContaining({
        id: "planner-edit",
        action: expect.objectContaining({ label: "Retry plan" }),
      }),
    );
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("refreshes only after the add has settled", async () => {
    seed();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const request = pendingRequest<PlannerCreateTaskResponse>();
    create.mockReturnValue(request.promise);
    const added = actions.createIn({
      title: "Late",
      column: "doing",
      plan: null,
    });
    await flush();
    expect(invalidate).not.toHaveBeenCalled();
    request.resolve(response());
    await added;
    expect(invalidate).toHaveBeenCalledTimes(3);
  });
});

describe("placing a card in a column", () => {
  const cardIn = (
    id: string,
    rank: string | null,
    over: Partial<PlannerBoardCard> = {},
  ): PlannerBoardCard => ({
    ...plannerCardFromDetail({
      ...DETAIL,
      task: { ...TASK, id, title: id },
      plan: { ...PLAN, task_id: id },
    }),
    board_rank: rank,
    goal_id: null,
    ...over,
  });
  const todoIds = () =>
    queryClient
      .getQueryData<PlannerBoardResponse>(boardKey)
      ?.columns.todo.map((card) => card.id);
  const doingIds = () =>
    queryClient
      .getQueryData<PlannerBoardResponse>(boardKey)
      ?.columns.doing.map((card) => card.id);

  function seedColumn() {
    const a = cardIn("tasks/a", "d");
    const b = cardIn("tasks/b", "h");
    const c = cardIn("tasks/c", "m");
    queryClient.setQueryData(boardKey, {
      ...EMPTY_BOARD,
      columns: { ...EMPTY_BOARD.columns, todo: [a, b, c] },
    });
    return { a, b, c };
  }

  it("reorders at once, sends the place, and keeps the order when the server answers", async () => {
    const { c } = seedColumn();
    const request = pendingRequest<PlannerTaskPlanResponse>();
    update.mockReturnValue(request.promise);

    actions.reorder(c, { beforeId: "tasks/b" });
    await flush();

    expect(update).toHaveBeenCalledWith("tasks/c", {
      today: TODAY,
      column: "todo",
      before_id: "tasks/b",
    });
    expect(todoIds()).toEqual(["tasks/a", "tasks/c", "tasks/b"]);
    // A reorder does not scroll the card into view: it is under the pointer.
    expect(reveal).not.toHaveBeenCalled();

    request.resolve({
      task: { ...TASK, id: "tasks/c" },
      plan: { ...PLAN, task_id: "tasks/c", board_rank: "todo|f" },
    });
    await flush();

    expect(todoIds()).toEqual(["tasks/a", "tasks/c", "tasks/b"]);
    // Silent when it works.
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("puts the column back exactly as it was when the server refuses, and says so", async () => {
    const { c } = seedColumn();
    update.mockRejectedValue(new ApiError("No", 400));

    actions.reorder(c, { afterId: "tasks/a" });
    await flush();

    expect(todoIds()).toEqual(["tasks/a", "tasks/b", "tasks/c"]);
    const board = queryClient.getQueryData<PlannerBoardResponse>(boardKey);
    expect(board?.columns.todo.map((card) => card.board_rank)).toEqual([
      "d",
      "h",
      "m",
    ]);
    expect(toast.error).toHaveBeenCalledWith(expect.any(String), {
      id: "planner-edit",
    });
  });

  it("restores both columns when a move to a place in another column fails", async () => {
    const { a } = seedColumn();
    const x = cardIn("tasks/x", "g", { status: "in_progress" });
    queryClient.setQueryData(boardKey, {
      ...EMPTY_BOARD,
      columns: {
        ...EMPTY_BOARD.columns,
        todo: [a, cardIn("tasks/b", "h")],
        doing: [x],
      },
    });
    update.mockRejectedValue(new ApiError("No", 500));

    actions.move(x, "todo", { beforeId: "tasks/b" });
    await flush();

    expect(todoIds()).toEqual(["tasks/a", "tasks/b"]);
    expect(doingIds()).toEqual(["tasks/x"]);
    expect(update).toHaveBeenCalledWith("tasks/x", {
      today: TODAY,
      column: "todo",
      before_id: "tasks/b",
    });
  });

  it("lands a move at its place straight away and sends no place for a plain move", async () => {
    const x = cardIn("tasks/x", null, { status: "in_progress" });
    const { a } = seedColumn();
    queryClient.setQueryData(boardKey, {
      ...EMPTY_BOARD,
      columns: { ...EMPTY_BOARD.columns, todo: [a], doing: [x] },
    });
    update.mockReturnValue(new Promise(() => undefined));

    actions.move(x, "todo", { afterId: "tasks/a" });
    await flush();
    expect(todoIds()).toEqual(["tasks/a", "tasks/x"]);
    expect(doingIds()).toEqual([]);

    actions.move(a, "doing");
    await flush();
    expect(update).toHaveBeenLastCalledWith("tasks/a", {
      today: TODAY,
      column: "doing",
    });
  });

  it("puts a card added to a ranked column on top while it waits for the server", async () => {
    seedColumn();
    const request = pendingRequest<PlannerCreateTaskResponse>();
    create.mockReturnValue(request.promise);

    const added = actions.createIn({
      title: "Fresh",
      column: "todo",
      plan: { horizon: "week", day: TODAY },
    });
    await flush();
    expect(todoIds()?.[0]).toMatch(/^tasks\/pending-/);

    request.resolve({
      task: { ...TASK, id: "tasks/new", title: "Fresh" },
      plan: { ...PLAN, task_id: "tasks/new", board_rank: "todo|5" },
    });
    expect(await added).toBe(true);
    expect(todoIds()).toEqual(["tasks/new", "tasks/a", "tasks/b", "tasks/c"]);
  });
});
