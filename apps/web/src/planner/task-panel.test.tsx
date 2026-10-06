// @vitest-environment jsdom
import type {
  PlannerTaskDetailResponse,
  PlannerTreeResponse,
  TaskDto,
} from "@flaremo/contracts";
import { QueryClient } from "@tanstack/react-query";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listProjects } from "@/api";
import { ApiError } from "@/api/client";
import {
  plannerFetchTaskDetail,
  plannerFetchTaskHistory,
  plannerFetchTree,
} from "./api";
import { plannerPlanTarget } from "./plan-targets";
import { plannerQueryKeys } from "./query-keys";
import { PlannerTaskPanel } from "./task-panel";
import {
  type PlannerTestMount,
  plannerTestActions,
  plannerTestBlur,
  plannerTestClick,
  plannerTestFocus,
  plannerTestKey,
  plannerTestMount,
  plannerTestType,
} from "./test-render";

// The task panel (fork-owned add-on,
// docs/planning-cockpit-implementation-plan.md, section 13), rendered whole in a
// jsdom page with the network replaced: what it shows for a task, what each
// control hands to the cockpit's actions, and how it behaves when the task cannot
// be read. The notes and the comments have their own files; the optimistic edits
// the actions make are in use-planner-actions.test.tsx.

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  plannerFetchTaskDetail: vi.fn(),
  plannerFetchTaskHistory: vi.fn(),
  plannerFetchTree: vi.fn(),
}));
vi.mock("@/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api")>()),
  listProjects: vi.fn(),
}));

const fetchDetail = vi.mocked(plannerFetchTaskDetail);
const fetchHistory = vi.mocked(plannerFetchTaskHistory);
const fetchTree = vi.mocked(plannerFetchTree);
const fetchProjects = vi.mocked(listProjects);

// Wednesday 7 October 2026: its week starts Monday the 5th, and it is in Q4.
const TODAY = "2026-10-07";
const WEEK = "2026-10-05";
const TASK_ID = "tasks/t1";

const TASK: TaskDto = {
  id: TASK_ID,
  project_id: "projects/site",
  source_memo_id: null,
  title: "Write the launch announcement",
  notes: "Draft in the doc",
  status: "todo",
  priority: "high",
  due_at: "2026-10-09",
  sort_order: 0,
  completed_at: null,
  deleted_at: null,
  created_at: "2026-10-01T08:00:00.000Z",
  updated_at: "2026-10-06T08:00:00.000Z",
};

const PLAN = {
  task_id: TASK_ID,
  horizon: "week",
  period_start: WEEK,
  carry_count: 0,
  dropped_at: null,
  effort: 3.5,
  created_at: "2026-10-02T08:00:00.000Z",
  updated_at: "2026-10-02T08:00:00.000Z",
} as const;

const DETAIL: PlannerTaskDetailResponse = {
  task: TASK,
  plan: PLAN,
  project: {
    id: "projects/site",
    name: "Website relaunch",
    ancestors: [{ id: "projects/work", name: "Work" }],
  },
  comments: [],
};

/** A task with nothing set: no plan, due date, priority, goal or estimate. */
const BARE: PlannerTaskDetailResponse = {
  task: {
    ...TASK,
    project_id: null,
    priority: "none",
    due_at: null,
    notes: null,
  },
  plan: null,
  project: null,
  comments: [],
};

const TREE: PlannerTreeResponse = {
  nodes: [
    node("projects/work", "Work", null),
    node("projects/site", "Website relaunch", "projects/work"),
    node("projects/home", "Home", null),
  ],
};

function node(id: string, name: string, parent: string | null) {
  return {
    id,
    name,
    status: "active" as const,
    parent_project_id: parent,
    level: null,
    period_start: null,
    period_end: null,
    sort_order: 0,
  };
}

function project(id: string, name: string, extra: object = {}) {
  return {
    id,
    name,
    description: null,
    status: "active" as const,
    task_count_total: 0,
    task_count_open: 0,
    deleted_at: null,
    created_at: "2026-09-01T08:00:00.000Z",
    updated_at: "2026-09-01T08:00:00.000Z",
    ...extra,
  };
}

let mounted: PlannerTestMount | undefined;
let queryClient: QueryClient;

/** Lets promises that are already settled, and the code waiting on them, run. */
async function settle(rounds = 3) {
  for (let round = 0; round < rounds; round += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** Waits, a turn at a time, for something that needs several round trips to appear. */
async function until(check: () => unknown, rounds = 40) {
  for (let round = 0; round < rounds; round += 1) {
    if (check()) return;
    await settle(1);
  }
  throw new Error("The page did not settle.");
}

beforeEach(() => {
  vi.clearAllMocks();
  queryClient = new QueryClient({
    defaultOptions: {
      // The panel sets its own retry count; the test only shortens the wait.
      queries: {
        retry: false,
        retryDelay: 0,
        gcTime: Number.POSITIVE_INFINITY,
      },
    },
  });
  fetchDetail.mockResolvedValue(DETAIL);
  fetchTree.mockResolvedValue(TREE);
  fetchProjects.mockResolvedValue({
    projects: [
      project("projects/work", "Work"),
      project("projects/site", "Website relaunch"),
      project("projects/home", "Home"),
      project("projects/old", "Old plan", { status: "archived" }),
      project("projects/bin", "In the bin", {
        deleted_at: "2026-09-02T08:00:00.000Z",
      }),
    ],
  });
  fetchHistory.mockResolvedValue({ events: [] });
});

afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
  queryClient.clear();
  for (const leftover of Array.from(document.body.children)) leftover.remove();
});

/** Opens the panel on the seeded task and waits for it to be read. */
async function open(
  options: {
    taskId?: string | null;
    open?: boolean;
    seed?: PlannerTaskDetailResponse;
  } = {},
) {
  const actions = plannerTestActions();
  const onOpenChange = vi.fn();
  if (options.seed) {
    queryClient.setQueryData(plannerQueryKeys.detail(TASK_ID), options.seed);
  }
  const ui = (taskId: string | null, isOpen: boolean) => (
    <PlannerTaskPanel
      actions={actions}
      open={isOpen}
      taskId={taskId}
      today={TODAY}
      onOpenChange={onOpenChange}
    />
  );
  mounted = plannerTestMount(
    ui(
      options.taskId === undefined ? TASK_ID : options.taskId,
      options.open ?? true,
    ),
    { queryClient },
  );
  await settle();
  return {
    actions,
    onOpenChange,
    rerender: (taskId: string | null, isOpen = true) =>
      mounted?.rerender(ui(taskId, isOpen)),
  };
}

// The panel is a Sheet: it renders in a portal on the page, not inside the
// element the test mounted into.
const panel = () =>
  document.body.querySelector<HTMLElement>('[data-slot="sheet-content"]');
const byLabel = <T extends HTMLElement = HTMLElement>(label: string) =>
  document.body.querySelector<T>(`[aria-label="${label}"]`);
const titleField = () => byLabel<HTMLTextAreaElement>("Task title");
const effortField = () => byLabel<HTMLInputElement>("Effort");
const text = () => panel()?.textContent ?? "";

// ---------------------------------------------------------------------------

describe("reading the task", () => {
  it("shows a skeleton while there is nothing to show yet", async () => {
    fetchDetail.mockReturnValue(new Promise(() => undefined));
    await open();
    const loading = document.body.querySelector(
      '[data-testid="planner-panel-loading"]',
    );
    expect(loading).not.toBeNull();
    expect(loading?.getAttribute("aria-busy")).toBe("true");
    // The sheet is already named for a screen reader.
    expect(panel()?.getAttribute("role") ?? "dialog").toBe("dialog");
    expect(text()).toContain("Task details");
    expect(titleField()).toBeNull();
  });

  it("asks the server for the task it was opened on", async () => {
    await open();
    expect(fetchDetail).toHaveBeenCalledTimes(1);
    expect(fetchDetail).toHaveBeenCalledWith(TASK_ID);
    expect(titleField()?.value).toBe("Write the launch announcement");
  });

  it("shows what is cached at once and puts the server's truth under it", async () => {
    let answer!: (detail: PlannerTaskDetailResponse) => void;
    fetchDetail.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    await open({
      seed: { ...DETAIL, task: { ...TASK, title: "Cached title" } },
    });
    // No skeleton: the board already knew this task.
    expect(
      document.body.querySelector('[data-testid="planner-panel-loading"]'),
    ).toBeNull();
    expect(titleField()?.value).toBe("Cached title");

    await act(async () => {
      answer({ ...DETAIL, task: { ...TASK, title: "Server title" } });
    });
    await settle();
    expect(titleField()?.value).toBe("Server title");
  });

  it("says so, with no retry, when the task is gone", async () => {
    fetchDetail.mockRejectedValue(new ApiError("Task not found.", 404));
    await open();
    expect(text()).toContain("This task isn't available any more");
    expect(
      document.body.querySelector('[data-testid="planner-panel-loading"]'),
    ).toBeNull();
    // A task that is gone will not come back by asking again.
    expect(fetchDetail).toHaveBeenCalledTimes(1);
    expect(
      Array.from(panel()?.querySelectorAll("button") ?? []).some(
        (button) => button.textContent === "Retry",
      ),
    ).toBe(false);
  });

  it("offers a retry when the task cannot be read for another reason", async () => {
    fetchDetail.mockRejectedValue(new ApiError("Server error", 500));
    await open();
    const retryButton = () =>
      Array.from(panel()?.querySelectorAll("button") ?? []).find((button) =>
        button.textContent?.includes("Retry"),
      );
    // It tries three times in all before it gives up.
    await until(retryButton);
    expect(fetchDetail).toHaveBeenCalledTimes(3);
    expect(titleField()).toBeNull();
    expect(text()).not.toContain("This task isn't available any more");

    fetchDetail.mockResolvedValue(DETAIL);
    plannerTestClick(retryButton());
    await until(titleField);
    expect(titleField()?.value).toBe("Write the launch announcement");
  });

  it("shows the task it was opened on, and another one when it is opened on that", async () => {
    const { rerender } = await open();
    expect(titleField()?.value).toBe("Write the launch announcement");

    fetchDetail.mockResolvedValue({
      ...DETAIL,
      task: { ...TASK, id: "tasks/t2", title: "Book the venue" },
      plan: null,
    });
    rerender("tasks/t2");
    await settle();
    expect(fetchDetail).toHaveBeenLastCalledWith("tasks/t2");
    expect(titleField()?.value).toBe("Book the venue");
  });

  it("keeps the focus on the sheet itself without drawing a ring round the whole panel", async () => {
    // Opening a task focuses the sheet, not its first field; a deep link or a
    // keyboard open would otherwise outline the whole panel.
    await open();
    expect(panel()?.className).toContain("outline-none");
  });

  it("renders nothing for a panel that is closed and was never opened", async () => {
    await open({ taskId: null, open: false });
    expect(panel()).toBeNull();
    expect(fetchDetail).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

describe("the properties", () => {
  it("lays them out as rows: status, plan, due date, priority, goal, effort and quarter", async () => {
    await open();
    expect(byLabel("Status: To Do")).not.toBeNull();
    expect(byLabel("Plan: This week")).not.toBeNull();
    expect(byLabel("Due date: Fri, Oct 9, 2026")).not.toBeNull();
    expect(byLabel("Priority: High")).not.toBeNull();
    expect(byLabel("Goal: Work › Website relaunch")).not.toBeNull();
    expect(effortField()?.value).toBe("3.5");

    const rows = document.body.querySelector(
      '[data-testid="planner-properties"]',
    )?.textContent;
    expect(rows).toContain("Q4 2026");
    expect(rows).toContain("from plan or due date");
    // The labels read in the order a Notion page would show them.
    const order = [
      "Status",
      "Plan",
      "Due date",
      "Priority",
      "Goal",
      "Effort",
      "Quarter",
    ].map((label) => rows?.indexOf(label) ?? -1);
    expect(order.every((position) => position >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("says Empty for a property that has no value, as Notion does", async () => {
    fetchDetail.mockResolvedValue(BARE);
    await open();
    expect(byLabel("Status: To Do")).toBeNull();
    expect(byLabel("Status: Backlog")).not.toBeNull();
    expect(byLabel("Plan: Empty")).not.toBeNull();
    expect(byLabel("Due date: Empty")).not.toBeNull();
    expect(byLabel("Priority: Empty")).not.toBeNull();
    expect(byLabel("Goal: Empty")).not.toBeNull();
    expect(effortField()?.value).toBe("");
    expect(effortField()?.getAttribute("placeholder")).toBe("Empty");
    const quarter = Array.from(
      document.body.querySelectorAll(
        '[data-testid="planner-properties"] > div',
      ),
    ).find((row) => row.textContent?.startsWith("Quarter"));
    expect(quarter?.textContent).toContain("Empty");
  });

  it("works the quarter out from the due date when there is no plan", async () => {
    fetchDetail.mockResolvedValue({
      ...BARE,
      task: { ...BARE.task, due_at: "2027-02-14" },
    });
    await open();
    expect(
      document.body.querySelector('[data-testid="planner-properties"]')
        ?.textContent,
    ).toContain("Q1 2027");
  });

  it("puts a task with an effort but no plan in Backlog, its estimate still showing", async () => {
    fetchDetail.mockResolvedValue({
      ...BARE,
      plan: { ...PLAN, horizon: null, period_start: null, effort: 2 },
    });
    await open();
    expect(byLabel("Status: Backlog")).not.toBeNull();
    expect(byLabel("Plan: Empty")).not.toBeNull();
    expect(effortField()?.value).toBe("2");
  });

  it("names a task in Doing and a finished one by their column", async () => {
    fetchDetail.mockResolvedValue({
      ...DETAIL,
      task: { ...TASK, status: "in_progress" },
    });
    await open();
    expect(byLabel("Status: Doing")).not.toBeNull();
    mounted?.unmount();

    fetchDetail.mockResolvedValue({
      ...DETAIL,
      task: { ...TASK, status: "done", completed_at: "2026-10-06T09:00:00Z" },
    });
    queryClient.clear();
    await open();
    expect(byLabel("Status: Done")).not.toBeNull();
    // A finished task keeps its plan only as history: shown, not editable.
    expect(byLabel("Plan: This week")).toBeNull();
    expect(text()).toContain("Plan: ");
    expect(text()).toContain("This week");
  });

  it("falls back to No priority for a priority it does not know", async () => {
    fetchDetail.mockResolvedValue({
      ...DETAIL,
      task: { ...TASK, priority: "urgent" as TaskDto["priority"] },
    });
    await open();
    expect(byLabel("Priority: Empty")).not.toBeNull();
  });

  it("counts a change to the plan (an effort, a plan, a drop) as the task being touched", async () => {
    // Those edit the plan row, not the upstream task row, so the task's own
    // time would keep saying "Updated" an hour ago right after one.
    fetchDetail.mockResolvedValue({
      ...DETAIL,
      plan: { ...PLAN, updated_at: "2026-10-07T09:00:00.000Z" },
    });
    await open();
    const updated = Array.from(panel()?.querySelectorAll("time") ?? []).find(
      (time) => time.textContent?.startsWith("Updated"),
    );
    expect(updated?.getAttribute("datetime")).toBe("2026-10-07T09:00:00.000Z");
    expect(updated?.getAttribute("title")).toMatch(/Oct 7, 2026/);
  });

  it("shows when the task was made and last touched, the exact times on hover", async () => {
    await open();
    const times = Array.from(panel()?.querySelectorAll("time") ?? []);
    const created = times.find((time) =>
      time.textContent?.startsWith("Created"),
    );
    const updated = times.find((time) =>
      time.textContent?.startsWith("Updated"),
    );
    expect(created?.getAttribute("datetime")).toBe(TASK.created_at);
    expect(updated?.getAttribute("datetime")).toBe(TASK.updated_at);
    // The exact moment is the hover text, in the page's own language.
    expect(created?.getAttribute("title")).toMatch(/Oct 1, 2026/);
    expect(created?.textContent).toContain(
      created?.getAttribute("title") ?? "?",
    );
    expect(updated?.getAttribute("title")).toMatch(/Oct 6, 2026/);
  });
});

// ---------------------------------------------------------------------------

describe("the title", () => {
  it("saves a new title when Enter is pressed", async () => {
    const { actions } = await open();
    const field = titleField() as HTMLTextAreaElement;
    plannerTestFocus(field);
    plannerTestType(field, "Write the launch post");
    const kept = plannerTestKey(field, "Enter");
    // Enter is the end of the edit, not a line break in a title.
    expect(kept).toBe(false);
    await settle();
    expect(actions.setTitle).toHaveBeenCalledTimes(1);
    expect(actions.setTitle).toHaveBeenCalledWith(
      expect.objectContaining({ id: TASK_ID }),
      "Write the launch post",
    );
  });

  it("saves it when the field loses focus, trimmed", async () => {
    const { actions } = await open();
    const field = titleField() as HTMLTextAreaElement;
    plannerTestFocus(field);
    plannerTestType(field, "  Spaced out  ");
    plannerTestBlur(field);
    expect(actions.setTitle).toHaveBeenCalledWith(
      expect.objectContaining({ id: TASK_ID }),
      "Spaced out",
    );
  });

  it("turns a pasted line break into a space", async () => {
    const { actions } = await open();
    const field = titleField() as HTMLTextAreaElement;
    plannerTestFocus(field);
    plannerTestType(field, "First line\n  second line");
    expect(field.value).toBe("First line second line");
    plannerTestBlur(field);
    expect(actions.setTitle).toHaveBeenCalledWith(
      expect.anything(),
      "First line second line",
    );
  });

  it("puts the saved title back on Escape, and leaves the panel open", async () => {
    const { actions, onOpenChange } = await open();
    const field = titleField() as HTMLTextAreaElement;
    plannerTestFocus(field);
    plannerTestType(field, "Never mind");
    plannerTestKey(field, "Escape");
    await settle();
    expect(field.value).toBe("Write the launch announcement");
    expect(actions.setTitle).not.toHaveBeenCalled();
    // Escape belonged to the field: the sheet behind it stays.
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(panel()).not.toBeNull();
  });

  it("does not save an empty title: a task needs one", async () => {
    const { actions } = await open();
    const field = titleField() as HTMLTextAreaElement;
    plannerTestFocus(field);
    plannerTestType(field, "   ");
    plannerTestBlur(field);
    expect(actions.setTitle).not.toHaveBeenCalled();
    expect(field.value).toBe("Write the launch announcement");
  });

  it("does not save a title that did not change", async () => {
    const { actions } = await open();
    const field = titleField() as HTMLTextAreaElement;
    plannerTestFocus(field);
    plannerTestType(field, "Write the launch announcement ");
    plannerTestBlur(field);
    expect(actions.setTitle).not.toHaveBeenCalled();
  });

  it("follows the saved title while it is not being typed into", async () => {
    await open();
    const field = titleField() as HTMLTextAreaElement;
    expect(field.value).toBe("Write the launch announcement");
    act(() => {
      queryClient.setQueryData<PlannerTaskDetailResponse>(
        plannerQueryKeys.detail(TASK_ID),
        { ...DETAIL, task: { ...TASK, title: "Renamed elsewhere" } },
      );
    });
    // The query tells the page about it a turn later.
    await settle();
    expect(titleField()?.value).toBe("Renamed elsewhere");
  });

  it("does not take a typed title away when the saved one changes under it", async () => {
    await open();
    const field = titleField() as HTMLTextAreaElement;
    plannerTestFocus(field);
    plannerTestType(field, "Half typed");
    act(() => {
      queryClient.setQueryData<PlannerTaskDetailResponse>(
        plannerQueryKeys.detail(TASK_ID),
        { ...DETAIL, task: { ...TASK, title: "Renamed elsewhere" } },
      );
    });
    await settle();
    expect(titleField()?.value).toBe("Half typed");
  });
});

// ---------------------------------------------------------------------------

describe("the effort", () => {
  it("saves a number when the field loses focus", async () => {
    const { actions } = await open();
    const field = effortField() as HTMLInputElement;
    plannerTestFocus(field);
    plannerTestType(field, "5");
    expect(actions.setEffort).not.toHaveBeenCalled();
    plannerTestBlur(field);
    expect(actions.setEffort).toHaveBeenCalledWith(
      expect.objectContaining({ id: TASK_ID }),
      5,
    );
  });

  it("saves on Enter, and takes a comma as the decimal point", async () => {
    const { actions } = await open();
    const field = effortField() as HTMLInputElement;
    plannerTestFocus(field);
    plannerTestType(field, "2,5");
    plannerTestKey(field, "Enter");
    expect(actions.setEffort).toHaveBeenCalledWith(expect.anything(), 2.5);
  });

  it("clears the estimate when the field is emptied", async () => {
    const { actions } = await open();
    const field = effortField() as HTMLInputElement;
    plannerTestFocus(field);
    plannerTestType(field, "");
    plannerTestBlur(field);
    expect(actions.setEffort).toHaveBeenCalledWith(expect.anything(), null);
  });

  it("says what is wrong with something that is not a number, and saves nothing", async () => {
    const { actions } = await open();
    const field = effortField() as HTMLInputElement;
    plannerTestFocus(field);
    plannerTestType(field, "3.25");
    const hint = document.body.querySelector('[role="alert"]');
    expect(hint?.textContent).toBe(
      "Use a number from 0 to 999, with one decimal at most.",
    );
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(field.getAttribute("aria-describedby")).toBe(hint?.id);

    plannerTestBlur(field);
    expect(actions.setEffort).not.toHaveBeenCalled();
    // The saved estimate is back, and the hint is gone.
    expect(field.value).toBe("3.5");
    expect(document.body.querySelector('[role="alert"]')).toBeNull();
    expect(field.getAttribute("aria-invalid")).toBeNull();
  });

  it("does not save an estimate that did not change", async () => {
    const { actions } = await open();
    const field = effortField() as HTMLInputElement;
    plannerTestFocus(field);
    plannerTestType(field, "3.50");
    plannerTestBlur(field);
    expect(actions.setEffort).not.toHaveBeenCalled();
  });

  it("puts the saved estimate back on Escape, and leaves the panel open", async () => {
    const { actions, onOpenChange } = await open();
    const field = effortField() as HTMLInputElement;
    plannerTestFocus(field);
    plannerTestType(field, "8");
    plannerTestKey(field, "Escape");
    await settle();
    expect(field.value).toBe("3.5");
    expect(actions.setEffort).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

describe("the due date", () => {
  const dueField = () => byLabel<HTMLInputElement>("Due date");

  it("turns into a date field when it is clicked", async () => {
    await open();
    expect(dueField()).toBeNull();
    plannerTestClick(byLabel("Due date: Fri, Oct 9, 2026"));
    const field = dueField();
    expect(field?.type).toBe("date");
    expect(field?.value).toBe("2026-10-09");
    // One click from the value to typing.
    expect(document.activeElement).toBe(field);
  });

  it("saves a day that was picked, and goes back to showing it", async () => {
    const { actions } = await open();
    plannerTestClick(byLabel("Due date: Fri, Oct 9, 2026"));
    plannerTestType(dueField() as HTMLInputElement, "2026-10-20");
    expect(actions.setDue).toHaveBeenCalledWith(
      expect.objectContaining({ id: TASK_ID }),
      "2026-10-20",
    );
    expect(dueField()).toBeNull();
  });

  it("does not save the years a typed year passes through on its way to 2026", async () => {
    const { actions } = await open();
    plannerTestClick(byLabel("Due date: Fri, Oct 9, 2026"));
    const field = dueField() as HTMLInputElement;
    for (const partial of ["0002-10-09", "0020-10-09", "0202-10-09"]) {
      plannerTestType(field, partial);
    }
    expect(actions.setDue).not.toHaveBeenCalled();
    // Still being typed into.
    expect(dueField()).not.toBeNull();
    plannerTestType(field, "2026-10-19");
    expect(actions.setDue).toHaveBeenCalledTimes(1);
    expect(actions.setDue).toHaveBeenCalledWith(
      expect.anything(),
      "2026-10-19",
    );
  });

  it("does not save the day it already has", async () => {
    const { actions } = await open();
    plannerTestClick(byLabel("Due date: Fri, Oct 9, 2026"));
    plannerTestType(dueField() as HTMLInputElement, "2026-10-09");
    expect(actions.setDue).not.toHaveBeenCalled();
  });

  it("closes the field on Escape, not the panel behind it", async () => {
    const { actions, onOpenChange } = await open();
    plannerTestClick(byLabel("Due date: Fri, Oct 9, 2026"));
    plannerTestKey(dueField() as HTMLInputElement, "Escape");
    await settle();
    expect(dueField()).toBeNull();
    expect(actions.setDue).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(byLabel("Due date: Fri, Oct 9, 2026")).not.toBeNull();
  });

  it("clears the due date with the X beside it", async () => {
    const { actions } = await open();
    plannerTestClick(byLabel("Clear due date"));
    expect(actions.setDue).toHaveBeenCalledWith(
      expect.objectContaining({ id: TASK_ID }),
      null,
    );
  });

  it("has no X when there is no due date to clear", async () => {
    fetchDetail.mockResolvedValue(BARE);
    await open();
    expect(byLabel("Clear due date")).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe("a dropped task", () => {
  const dropped: PlannerTaskDetailResponse = {
    ...DETAIL,
    plan: {
      ...PLAN,
      dropped_at: new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
    },
  };

  it("says so in a banner with the one thing to do about it", async () => {
    fetchDetail.mockResolvedValue(dropped);
    const { actions } = await open();
    const banner = panel()?.querySelector('[role="status"]');
    expect(banner?.textContent).toContain("Dropped 3 hours ago");
    expect(banner?.textContent).toContain(
      "Undrop it to plan or move it again.",
    );
    const undrop = Array.from(banner?.querySelectorAll("button") ?? []).find(
      (button) => button.textContent === "Undrop",
    );
    plannerTestClick(undrop);
    expect(actions.undrop).toHaveBeenCalledWith(
      expect.objectContaining({ id: TASK_ID }),
    );
  });

  it("shows Dropped as its status, and shows its plan without offering to change it", async () => {
    fetchDetail.mockResolvedValue(dropped);
    await open();
    expect(byLabel("Status: Dropped")).not.toBeNull();
    expect(byLabel("Plan: This week")).toBeNull();
    expect(text()).toContain("This week");
  });

  it("draws the read-only plan's icon at the size of the other rows' icons", async () => {
    fetchDetail.mockResolvedValue(dropped);
    await open();
    const value = panel()?.querySelector(
      '[title="Undrop it to plan or move it again."]',
    );
    expect(value).not.toBeNull();
    // Outside a button nothing sizes an icon for it: left alone it is 24px.
    expect(value?.querySelector("svg")?.getAttribute("class")).toContain(
      "size-4",
    );
  });

  it("has no banner for a task that is not dropped", async () => {
    await open();
    expect(panel()?.querySelector('[role="status"]')).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe("the history", () => {
  const toggle = () =>
    Array.from(panel()?.querySelectorAll("button") ?? []).find(
      (button) => button.textContent === "History",
    ) as HTMLButtonElement;

  it("is folded away, and not even read, until it is asked for", async () => {
    await open();
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(fetchHistory).not.toHaveBeenCalled();
  });

  it("unfolds into the task's timeline, read when it opens", async () => {
    const when = new Date(Date.now() - 5 * 60_000).toISOString();
    fetchHistory.mockResolvedValue({
      events: [
        {
          id: 1,
          task_id: TASK_ID,
          task_title: TASK.title,
          type: "effort_changed",
          data: { from: null, to: 3.5 },
          source: "planner",
          actor_type: "user",
          actor_name: null,
          occurred_at: when,
          created_at: when,
        },
      ],
    });
    await open();
    plannerTestClick(toggle());
    await settle();
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(fetchHistory).toHaveBeenCalledWith(TASK_ID);
    expect(text()).toContain("Effort set to 3.5");
    expect(text()).toContain("5 minutes ago");

    plannerTestClick(toggle());
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(text()).not.toContain("Effort set to 3.5");
  });
});

// ---------------------------------------------------------------------------

describe("the menus", () => {
  /** Opens a base-ui menu the way a mouse does: press, release, click. */
  function openMenu(trigger: Element | null) {
    if (!trigger) throw new Error("There is no menu button.");
    act(() => {
      for (const type of [
        "pointerdown",
        "mousedown",
        "pointerup",
        "mouseup",
        "click",
      ]) {
        trigger.dispatchEvent(
          new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 }),
        );
      }
    });
  }
  const items = () =>
    Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    );
  const item = (name: string) =>
    items().find((entry) => entry.textContent?.trim() === name) as HTMLElement;
  const names = () => items().map((entry) => entry.textContent?.trim());
  const checked = () =>
    items()
      .filter((entry) => entry.querySelector("svg.lucide-check"))
      .map((entry) => entry.textContent?.trim());

  async function openAndPick(label: string, name: string) {
    openMenu(byLabel(label));
    await settle();
    plannerTestClick(item(name));
    await settle();
  }

  describe("status", () => {
    it("offers the four columns, the current one ticked", async () => {
      await open();
      openMenu(byLabel("Status: To Do"));
      await settle();
      expect(names()).toEqual(["Backlog", "To Do", "Doing", "Done"]);
      expect(checked()).toEqual(["To Do"]);
    });

    it("moves the task to the column that is picked", async () => {
      const { actions } = await open();
      await openAndPick("Status: To Do", "Doing");
      expect(actions.move).toHaveBeenCalledTimes(1);
      expect(actions.move).toHaveBeenCalledWith(
        expect.objectContaining({ id: TASK_ID }),
        "doing",
      );
    });

    it("does nothing for the column the task is already in", async () => {
      const { actions } = await open();
      await openAndPick("Status: To Do", "To Do");
      expect(actions.move).not.toHaveBeenCalled();
    });

    it("offers a dropped task one thing only: Undrop", async () => {
      fetchDetail.mockResolvedValue({
        ...DETAIL,
        plan: { ...PLAN, dropped_at: "2026-10-06T08:00:00.000Z" },
      });
      const { actions } = await open();
      openMenu(byLabel("Status: Dropped"));
      await settle();
      expect(names()).toEqual(["Undrop"]);
      plannerTestClick(item("Undrop"));
      expect(actions.undrop).toHaveBeenCalledWith(
        expect.objectContaining({ id: TASK_ID }),
      );
      expect(actions.move).not.toHaveBeenCalled();
    });
  });

  describe("priority", () => {
    it("offers every priority, the current one ticked", async () => {
      await open();
      openMenu(byLabel("Priority: High"));
      await settle();
      expect(names()).toEqual(["None", "Low", "Medium", "High"]);
      expect(checked()).toEqual(["High"]);
    });

    it("sets the priority that is picked", async () => {
      const { actions } = await open();
      await openAndPick("Priority: High", "Low");
      expect(actions.setPriority).toHaveBeenCalledWith(
        expect.objectContaining({ id: TASK_ID }),
        "low",
      );
    });

    it("clears it with None", async () => {
      const { actions } = await open();
      await openAndPick("Priority: High", "None");
      expect(actions.setPriority).toHaveBeenCalledWith(
        expect.anything(),
        "none",
      );
    });

    it("does nothing for the priority the task already has", async () => {
      const { actions } = await open();
      await openAndPick("Priority: High", "High");
      expect(actions.setPriority).not.toHaveBeenCalled();
    });
  });

  describe("plan", () => {
    it("offers the same choices as the card's menu, the current plan ticked", async () => {
      await open();
      openMenu(byLabel("Plan: This week"));
      await settle();
      expect(names()).toEqual([
        "Today",
        "Tomorrow",
        "This week",
        "Next week",
        "This month",
        "Next month",
        "Pick a day…",
        "Clear plan",
      ]);
      expect(checked()).toEqual(["This week"]);
    });

    it("plans the task for the choice that is picked", async () => {
      const { actions } = await open();
      await openAndPick("Plan: This week", "Today");
      expect(actions.plan).toHaveBeenCalledWith(
        expect.objectContaining({ id: TASK_ID }),
        plannerPlanTarget("today", TODAY),
      );
    });

    it("clears the plan", async () => {
      const { actions } = await open();
      await openAndPick("Plan: This week", "Clear plan");
      expect(actions.plan).toHaveBeenCalledWith(expect.anything(), null);
    });

    it("cannot clear a plan there is not one of", async () => {
      fetchDetail.mockResolvedValue(BARE);
      await open();
      openMenu(byLabel("Plan: Empty"));
      await settle();
      expect(item("Clear plan").hasAttribute("data-disabled")).toBe(true);
    });

    it("asks for a day in a dialog, and plans the task for it", async () => {
      const { actions } = await open();
      await openAndPick("Plan: This week", "Pick a day…");
      const dialog = document.body.querySelector<HTMLElement>(
        '[data-slot="dialog-content"]',
      );
      expect(dialog?.textContent).toContain("Plan for a day");
      const field = dialog?.querySelector<HTMLInputElement>(
        'input[type="date"]',
      ) as HTMLInputElement;
      // A plan cannot start before today.
      expect(field.min).toBe(TODAY);
      plannerTestType(field, "2026-10-14");
      const confirm = Array.from(dialog?.querySelectorAll("button") ?? []).find(
        (button) => button.textContent === "Plan",
      );
      plannerTestClick(confirm);
      await settle();
      expect(actions.plan).toHaveBeenCalledWith(
        expect.objectContaining({ id: TASK_ID }),
        { horizon: "day", day: "2026-10-14" },
      );
    });
  });

  describe("goal", () => {
    it("lists the live goals by their path, the current one ticked", async () => {
      await open();
      openMenu(byLabel("Goal: Work › Website relaunch"));
      await settle();
      // None first; then the active projects, by path. The archived one and the
      // one in the bin are not offered.
      expect(names()).toEqual([
        "None",
        "Home",
        "Work",
        "Work › Website relaunch",
      ]);
      expect(checked()).toEqual(["Work › Website relaunch"]);
    });

    it("moves the task to the goal that is picked, with its path", async () => {
      const { actions } = await open();
      await openAndPick("Goal: Work › Website relaunch", "Home");
      expect(actions.setProject).toHaveBeenCalledWith(
        expect.objectContaining({ id: TASK_ID }),
        { id: "projects/home", name: "Home", ancestors: [] },
      );
    });

    it("hands over the goals above a nested one", async () => {
      fetchDetail.mockResolvedValue(BARE);
      const { actions } = await open();
      await openAndPick("Goal: Empty", "Work › Website relaunch");
      expect(actions.setProject).toHaveBeenCalledWith(expect.anything(), {
        id: "projects/site",
        name: "Website relaunch",
        ancestors: [{ id: "projects/work", name: "Work" }],
      });
    });

    it("takes the task out of its goal with None", async () => {
      const { actions } = await open();
      await openAndPick("Goal: Work › Website relaunch", "None");
      expect(actions.setProject).toHaveBeenCalledWith(expect.anything(), null);
    });

    it("does nothing for the goal the task already has", async () => {
      const { actions } = await open();
      await openAndPick(
        "Goal: Work › Website relaunch",
        "Work › Website relaunch",
      );
      expect(actions.setProject).not.toHaveBeenCalled();
    });

    it("cannot take a task out of a goal it is not in", async () => {
      fetchDetail.mockResolvedValue(BARE);
      await open();
      openMenu(byLabel("Goal: Empty"));
      await settle();
      expect(item("None").hasAttribute("data-disabled")).toBe(true);
    });

    it("keeps a goal that has been archived in the list while the task still has it", async () => {
      fetchDetail.mockResolvedValue({
        ...DETAIL,
        task: { ...TASK, project_id: "projects/old" },
        project: { id: "projects/old", name: "Old plan", ancestors: [] },
      });
      await open();
      openMenu(byLabel("Goal: Old plan"));
      await settle();
      expect(names()).toContain("Old plan");
      expect(checked()).toEqual(["Old plan"]);
    });

    it("lists the goals by name alone when the goal tree cannot be read", async () => {
      fetchTree.mockRejectedValue(new ApiError("Server error", 500));
      await open();
      openMenu(byLabel("Goal: Work › Website relaunch"));
      await settle();
      expect(names()).toEqual(["None", "Home", "Website relaunch", "Work"]);
    });

    it("says there are no projects when there are none", async () => {
      fetchProjects.mockResolvedValue({ projects: [] });
      fetchDetail.mockResolvedValue(BARE);
      await open();
      openMenu(byLabel("Goal: Empty"));
      await settle();
      expect(names()).toEqual([
        "None",
        "No projects yet. Create one under Projects.",
      ]);
    });
  });
});
