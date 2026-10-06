import type {
  PlannerCommentDto,
  PlannerTaskDetailResponse,
  TaskDto,
} from "@flaremo/contracts";
import { describe, expect, it } from "vitest";
import {
  plannerCardColumn,
  plannerPredictMove,
  plannerPredictPlan,
  plannerPredictPriority,
  plannerPredictProject,
} from "./board-model";
import {
  plannerCardFromDetail,
  plannerDetailReplacingComment,
  plannerDetailWithAnswer,
  plannerDetailWithCard,
  plannerDetailWithComment,
  plannerDetailWithEffort,
  plannerDetailWithoutComment,
  plannerIsPendingComment,
  plannerLastTouched,
  plannerPendingCommentId,
  plannerProjectPathLabel,
  plannerProjectPaths,
  plannerTaskIdFromParam,
  plannerTaskParamFromId,
} from "./panel-model";

// Wednesday 7 October 2026: its week starts Monday the 5th.
const TODAY = "2026-10-07";
const WEEK = "2026-10-05";
const NOW = new Date("2026-10-07T09:00:00.000Z");

const TASK: TaskDto = {
  id: "tasks/t1",
  project_id: null,
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

function detail(
  overrides: Partial<PlannerTaskDetailResponse> = {},
): PlannerTaskDetailResponse {
  return { task: TASK, plan: null, project: null, comments: [], ...overrides };
}

const PLAN = {
  task_id: "tasks/t1",
  horizon: "week",
  period_start: WEEK,
  carry_count: 1,
  dropped_at: null,
  effort: 3,
  created_at: "2026-10-02T08:00:00.000Z",
  updated_at: "2026-10-02T08:00:00.000Z",
} as const;

function comment(id: string, body = id): PlannerCommentDto {
  return {
    id,
    task_id: "tasks/t1",
    body,
    created_at: "2026-10-03T08:00:00.000Z",
    updated_at: "2026-10-03T08:00:00.000Z",
  };
}

describe("plannerCardFromDetail", () => {
  it("flattens the task, its plan and its project's name into a board card", () => {
    const card = plannerCardFromDetail(
      detail({
        task: { ...TASK, project_id: "projects/p1", priority: "high" },
        plan: PLAN,
        project: { id: "projects/p1", name: "Website", ancestors: [] },
      }),
    );
    expect(card).toMatchObject({
      id: "tasks/t1",
      title: TASK.title,
      project_id: "projects/p1",
      project_name: "Website",
      priority: "high",
      horizon: "week",
      period_start: WEEK,
      carry_count: 1,
      dropped_at: null,
    });
    // A card never carries notes or an effort.
    expect(card).not.toHaveProperty("notes");
    expect(card).not.toHaveProperty("effort");
  });

  it("is a backlog card for a task with no plan, and shows its column", () => {
    const card = plannerCardFromDetail(detail());
    expect(card).toMatchObject({ horizon: null, period_start: null });
    expect(plannerCardColumn(card)).toBe("backlog");
  });

  it("reads a plan row with no horizon, which only holds an effort, as the backlog", () => {
    const card = plannerCardFromDetail(
      detail({ plan: { ...PLAN, horizon: null, period_start: null } }),
    );
    expect(plannerCardColumn(card)).toBe("backlog");
  });
});

describe("plannerDetailWithCard", () => {
  it("shows a column move the way the board's own prediction does", () => {
    const before = detail({ plan: PLAN });
    const moved = plannerPredictMove(plannerCardFromDetail(before), "doing", {
      today: TODAY,
      week: WEEK,
      now: NOW,
    });
    const after = plannerDetailWithCard(before, moved);
    expect(after.task).toMatchObject({
      status: "in_progress",
      completed_at: null,
      updated_at: NOW.toISOString(),
    });
    // The plan is kept, and its effort and age with it.
    expect(after.plan).toMatchObject({
      horizon: "week",
      period_start: WEEK,
      carry_count: 1,
      effort: 3,
      created_at: PLAN.created_at,
      // Nothing about the plan changed, so neither does its timestamp.
      updated_at: PLAN.updated_at,
    });
  });

  it("completes a task: the status, the time and the unchanged plan", () => {
    const before = detail({ plan: PLAN });
    const done = plannerPredictMove(plannerCardFromDetail(before), "done", {
      today: TODAY,
      week: WEEK,
      now: NOW,
    });
    expect(plannerDetailWithCard(before, done).task).toMatchObject({
      status: "done",
      completed_at: NOW.toISOString(),
    });
  });

  it("creates the plan row when a task gets its first plan", () => {
    const before = detail();
    const planned = plannerPredictPlan(
      plannerCardFromDetail(before),
      { horizon: "day", day: TODAY },
      NOW,
    );
    expect(plannerDetailWithCard(before, planned).plan).toEqual({
      task_id: "tasks/t1",
      horizon: "day",
      period_start: TODAY,
      carry_count: 0,
      dropped_at: null,
      effort: null,
      created_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
    });
  });

  it("keeps an empty plan row, and its effort, when the plan is cleared", () => {
    const before = detail({ plan: PLAN });
    const cleared = plannerPredictPlan(
      plannerCardFromDetail(before),
      null,
      NOW,
    );
    expect(plannerDetailWithCard(before, cleared).plan).toMatchObject({
      horizon: null,
      period_start: null,
      effort: 3,
      updated_at: NOW.toISOString(),
    });
  });

  it("leaves a task with no plan row without one when nothing about the plan changed", () => {
    const before = detail();
    const edited = plannerPredictPriority(
      plannerCardFromDetail(before),
      "high",
      NOW,
    );
    const after = plannerDetailWithCard(before, edited);
    expect(after.task.priority).toBe("high");
    expect(after.plan).toBeNull();
  });

  it("leaves the notes, the comments and the other fields alone", () => {
    const before = detail({ comments: [comment("c1")] });
    const edited = plannerPredictPriority(
      plannerCardFromDetail(before),
      "low",
      NOW,
    );
    const after = plannerDetailWithCard(before, edited);
    expect(after.task.notes).toBe("Draft in the doc");
    expect(after.comments).toEqual([comment("c1")]);
    expect(after.task.created_at).toBe(TASK.created_at);
    expect(after.task.id).toBe(TASK.id);
  });

  it("keeps the project's path while it is the same project, and drops it for another", () => {
    const withPath = detail({
      task: { ...TASK, project_id: "projects/p1" },
      project: {
        id: "projects/p1",
        name: "Run a marathon",
        ancestors: [{ id: "projects/p0", name: "Health" }],
      },
    });
    const sameProject = plannerPredictPriority(
      plannerCardFromDetail(withPath),
      "high",
      NOW,
    );
    expect(plannerDetailWithCard(withPath, sameProject).project).toEqual(
      withPath.project,
    );

    const moved = plannerPredictProject(
      plannerCardFromDetail(withPath),
      { id: "projects/p2", name: "Home" },
      NOW,
    );
    expect(plannerDetailWithCard(withPath, moved)).toMatchObject({
      task: { project_id: "projects/p2" },
      project: { id: "projects/p2", name: "Home", ancestors: [] },
    });

    const cleared = plannerPredictProject(
      plannerCardFromDetail(withPath),
      null,
      NOW,
    );
    const after = plannerDetailWithCard(withPath, cleared);
    expect(after.project).toBeNull();
    expect(after.task.project_id).toBeNull();
  });
});

describe("plannerDetailWithEffort", () => {
  it("sets the estimate on the plan row and keeps the rest of it", () => {
    const after = plannerDetailWithEffort(detail({ plan: PLAN }), 5.5, NOW);
    expect(after.plan).toEqual({
      ...PLAN,
      effort: 5.5,
      updated_at: NOW.toISOString(),
    });
  });

  it("makes a plan row with no horizon for a task that had none", () => {
    expect(plannerDetailWithEffort(detail(), 2, NOW).plan).toEqual({
      task_id: "tasks/t1",
      horizon: null,
      period_start: null,
      carry_count: 0,
      dropped_at: null,
      effort: 2,
      created_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
    });
  });

  it("clears the estimate with null", () => {
    expect(
      plannerDetailWithEffort(detail({ plan: PLAN }), null, NOW).plan?.effort,
    ).toBeNull();
  });
});

describe("plannerDetailWithAnswer", () => {
  it("takes the task and plan the server answered with, and keeps the rest", () => {
    const before = detail({ comments: [comment("c1")] });
    const answered = plannerDetailWithAnswer(before, {
      task: { ...TASK, title: "Server's title" },
      plan: PLAN,
    });
    expect(answered.task.title).toBe("Server's title");
    expect(answered.plan).toEqual(PLAN);
    expect(answered.comments).toEqual(before.comments);
  });
});

describe("comments in the detail", () => {
  it("appends a comment at the end, since the list is oldest first", () => {
    const after = plannerDetailWithComment(
      detail({ comments: [comment("c1")] }),
      comment("c2"),
    );
    expect(after.comments.map((entry) => entry.id)).toEqual(["c1", "c2"]);
  });

  it("swaps a pending comment for the real one in place", () => {
    const pending = plannerPendingCommentId(1);
    const before = detail({
      comments: [comment("c1"), comment(pending, "sending"), comment("c3")],
    });
    const after = plannerDetailReplacingComment(
      before,
      pending,
      comment("real", "sent"),
    );
    expect(after.comments.map((entry) => [entry.id, entry.body])).toEqual([
      ["c1", "c1"],
      ["real", "sent"],
      ["c3", "c3"],
    ]);
  });

  it("removes a comment, and does nothing for one that is not there", () => {
    const before = detail({ comments: [comment("c1"), comment("c2")] });
    expect(
      plannerDetailWithoutComment(before, "c1").comments.map((c) => c.id),
    ).toEqual(["c2"]);
    expect(plannerDetailWithoutComment(before, "nope").comments).toEqual(
      before.comments,
    );
  });

  it("knows a pending comment by its id", () => {
    expect(plannerIsPendingComment({ id: plannerPendingCommentId(3) })).toBe(
      true,
    );
    expect(
      plannerIsPendingComment({ id: "5b0e6a6c-6c0f-4d3a-9a52-1f3f0f0c2f11" }),
    ).toBe(false);
  });

  it("does not change the detail it was given", () => {
    const before = detail({ comments: [comment("c1")] });
    const snapshot = JSON.stringify(before);
    plannerDetailWithComment(before, comment("c2"));
    plannerDetailWithoutComment(before, "c1");
    plannerDetailReplacingComment(before, "c1", comment("c9"));
    expect(JSON.stringify(before)).toBe(snapshot);
  });
});

describe("plannerProjectPaths", () => {
  const node = (id: string, name: string, parent: string | null = null) => ({
    id,
    name,
    parent_project_id: parent,
  });

  it("gives each project the names above it, root first", () => {
    const paths = plannerProjectPaths([
      node("health", "Health"),
      node("marathon", "Run a marathon", "health"),
      node("plan", "Training plan", "marathon"),
      node("home", "Home"),
    ]);
    expect(paths.get("health")).toEqual({
      id: "health",
      name: "Health",
      ancestors: [],
    });
    expect(paths.get("plan")).toEqual({
      id: "plan",
      name: "Training plan",
      ancestors: [
        { id: "health", name: "Health" },
        { id: "marathon", name: "Run a marathon" },
      ],
    });
    expect(paths.get("home")?.ancestors).toEqual([]);
    expect(paths.size).toBe(4);
  });

  it("ends a walk at a parent that is not in the list", () => {
    const paths = plannerProjectPaths([node("child", "Child", "binned")]);
    expect(paths.get("child")?.ancestors).toEqual([]);
  });

  it("ends a walk on a cycle instead of looping", () => {
    const paths = plannerProjectPaths([
      node("a", "A", "b"),
      node("b", "B", "a"),
    ]);
    expect(paths.get("a")?.ancestors).toEqual([{ id: "b", name: "B" }]);
    expect(paths.get("b")?.ancestors).toEqual([{ id: "a", name: "A" }]);
    // A project that is its own parent is a root.
    expect(
      plannerProjectPaths([node("self", "Self", "self")]).get("self")
        ?.ancestors,
    ).toEqual([]);
  });

  it("is empty for no projects", () => {
    expect(plannerProjectPaths([]).size).toBe(0);
  });
});

describe("plannerProjectPathLabel", () => {
  it("joins the goals above and the project with a chevron", () => {
    expect(
      plannerProjectPathLabel({
        name: "Run a marathon",
        ancestors: [{ id: "health", name: "Health" }],
      }),
    ).toBe("Health › Run a marathon");
    expect(
      plannerProjectPathLabel({
        name: "Training plan",
        ancestors: [
          { id: "a", name: "Health" },
          { id: "b", name: "Run a marathon" },
        ],
      }),
    ).toBe("Health › Run a marathon › Training plan");
  });

  it("is just the name for a root, and takes another separator", () => {
    expect(plannerProjectPathLabel({ name: "Home", ancestors: [] })).toBe(
      "Home",
    );
    expect(
      plannerProjectPathLabel(
        { name: "B", ancestors: [{ id: "a", name: "A" }] },
        " / ",
      ),
    ).toBe("A / B");
  });
});

describe("plannerLastTouched", () => {
  const TASK_TIME = "2026-10-06T08:00:00.000Z";

  it("is the task's own time when there is no plan row", () => {
    expect(plannerLastTouched(TASK_TIME, null)).toBe(TASK_TIME);
    expect(plannerLastTouched(TASK_TIME, undefined)).toBe(TASK_TIME);
    expect(plannerLastTouched(TASK_TIME, "")).toBe(TASK_TIME);
  });

  it("is the plan row's time when an effort, a plan or a drop touched it later", () => {
    const later = "2026-10-07T09:00:00.000Z";
    expect(plannerLastTouched(TASK_TIME, later)).toBe(later);
  });

  it("is the task's time when the plan row is older", () => {
    expect(plannerLastTouched(TASK_TIME, "2026-10-02T08:00:00.000Z")).toBe(
      TASK_TIME,
    );
  });

  it("compares moments, not text: a different offset is the same clock", () => {
    // 10:00 at +02:00 is 08:00 UTC, so the plan row is the older of the two.
    expect(
      plannerLastTouched(
        "2026-10-06T08:30:00.000Z",
        "2026-10-06T10:00:00+02:00",
      ),
    ).toBe("2026-10-06T08:30:00.000Z");
  });

  it("ignores a time that cannot be read", () => {
    expect(plannerLastTouched(TASK_TIME, "not a time")).toBe(TASK_TIME);
    expect(plannerLastTouched("not a time", "2026-10-07T09:00:00.000Z")).toBe(
      "2026-10-07T09:00:00.000Z",
    );
  });
});

describe("the ?task= address", () => {
  it("turns the bare id of the address into a task id, and back", () => {
    expect(plannerTaskIdFromParam("0b2e5f6a-1111")).toBe("tasks/0b2e5f6a-1111");
    expect(plannerTaskIdFromParam("tasks/0b2e5f6a-1111")).toBe(
      "tasks/0b2e5f6a-1111",
    );
    expect(plannerTaskParamFromId("tasks/0b2e5f6a-1111")).toBe("0b2e5f6a-1111");
    expect(plannerTaskParamFromId("0b2e5f6a-1111")).toBe("0b2e5f6a-1111");
  });

  it("reads a number the router parsed out of the address, and names no task for anything else", () => {
    // The router JSON-parses a value that looks like a number.
    expect(plannerTaskIdFromParam(42)).toBe("tasks/42");
    for (const value of [undefined, null, "", "   ", true, {}, []]) {
      expect(plannerTaskIdFromParam(value), String(value)).toBeNull();
    }
  });

  it("round-trips an id", () => {
    const id = "tasks/5b0e6a6c-6c0f-4d3a-9a52-1f3f0f0c2f11";
    expect(plannerTaskIdFromParam(plannerTaskParamFromId(id))).toBe(id);
  });
});
