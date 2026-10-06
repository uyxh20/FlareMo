import { describe, expect, expectTypeOf, it } from "vitest";
import type { z } from "zod";
import {
  type PlannerBoardCard,
  type PlannerBoardResponse,
  type PlannerColumn,
  type PlannerCommentDto,
  type PlannerCreateTaskInput,
  type PlannerHorizon,
  type PlannerTaskDetailResponse,
  type PlannerUpdateTaskInput,
  plannerBoardQuerySchema,
  plannerBoardResponseSchema,
  plannerColumnSchema,
  plannerCommentBodyMax,
  plannerCommentBodySchema,
  plannerCommentDtoSchema,
  plannerCommentListResponseSchema,
  plannerCommentResponseSchema,
  plannerCreateCommentSchema,
  plannerCreateTaskResponseSchema,
  plannerCreateTaskSchema,
  plannerDaySchema,
  plannerDeleteCommentResponseSchema,
  plannerEffortMax,
  plannerEffortSchema,
  plannerEventDtoSchema,
  plannerHistoryRangeQuerySchema,
  plannerHistoryRangeResponseSchema,
  plannerHorizonSchema,
  plannerHorizons,
  plannerPlanDtoSchema,
  plannerPlanInputSchema,
  plannerRolloverResponseSchema,
  plannerRolloverSchema,
  plannerRollupQuerySchema,
  plannerRollupResponseSchema,
  plannerTaskDetailResponseSchema,
  plannerTaskHistoryResponseSchema,
  plannerTaskPlanResponseSchema,
  plannerTreeNodeDtoSchema,
  plannerTreeNodeResponseSchema,
  plannerTreeResponseSchema,
  plannerUpdateCommentSchema,
  plannerUpdateTaskSchema,
  plannerUpdateTreeNodeSchema,
} from "./planner";
import type { TaskDto } from "./projects";

// Tests for the planner HTTP API contracts (the second half of planner.ts). The
// period helpers have their own suite in planner.test.ts.

const TODAY = "2026-10-07";

/** Every message a failed parse produced, for assertions on what was rejected. */
function messages(result: { success: boolean; error?: z.ZodError }): string[] {
  return result.error?.issues.map((issue) => issue.message) ?? [];
}

describe("planner API request schemas", () => {
  describe("plannerDaySchema", () => {
    it("accepts real calendar days only, exactly as written", () => {
      for (const day of [
        "2026-10-07",
        "2028-02-29",
        "0001-01-01",
        "9999-12-31",
      ]) {
        expect(plannerDaySchema.safeParse(day).success).toBe(true);
      }
      for (const bad of [
        "2026-02-30",
        "2027-02-29",
        "2026-13-01",
        "2026-10-7",
        "26-10-07",
        " 2026-10-07",
        "2026-10-07 ",
        "2026-10-07T00:00:00Z",
        "",
        20261007,
        null,
        undefined,
      ]) {
        expect(plannerDaySchema.safeParse(bad).success).toBe(false);
      }
    });
  });

  describe("horizons, columns and plans", () => {
    it("keeps the horizon enum in step with the period helpers", () => {
      expect(plannerHorizonSchema.options).toEqual([...plannerHorizons]);
    });

    it("lists the four columns in board order", () => {
      expect(plannerColumnSchema.options).toEqual([
        "backlog",
        "todo",
        "doing",
        "done",
      ]);
    });

    it("accepts a plan for each horizon and rejects a bad horizon, day or key", () => {
      for (const horizon of plannerHorizons) {
        expect(
          plannerPlanInputSchema.safeParse({ horizon, day: TODAY }).success,
        ).toBe(true);
      }
      for (const bad of [
        { horizon: "year", day: TODAY },
        { horizon: "Day", day: TODAY },
        { horizon: "week" },
        { day: TODAY },
        { horizon: "week", day: "2026-02-30" },
        { horizon: "week", day: TODAY, extra: true },
        null,
      ]) {
        expect(plannerPlanInputSchema.safeParse(bad).success).toBe(false);
      }
    });
  });

  describe("plannerBoardQuerySchema", () => {
    it("needs only today and defaults the rest", () => {
      expect(plannerBoardQuerySchema.parse({ today: TODAY })).toEqual({
        today: TODAY,
        include_dropped: false,
      });
    });

    it("parses the done window and the dropped flag from URL strings", () => {
      expect(
        plannerBoardQuerySchema.parse({
          today: TODAY,
          done_days: "30",
          include_dropped: "true",
        }),
      ).toEqual({ today: TODAY, done_days: 30, include_dropped: true });
      expect(
        plannerBoardQuerySchema.parse({ today: TODAY, done_days: "0" }),
      ).toMatchObject({ done_days: 0 });
    });

    it('reads the string "false" as false, not as a truthy string', () => {
      for (const [raw, expected] of [
        ["false", false],
        ["0", false],
        ["true", true],
        ["1", true],
      ] as const) {
        expect(
          plannerBoardQuerySchema.parse({ today: TODAY, include_dropped: raw })
            .include_dropped,
        ).toBe(expected);
      }
    });

    it("rejects what is not a whole number of days, an empty value included", () => {
      for (const done_days of ["", "abc", "-1", "1.5", " 7", "7 ", "1e3"]) {
        expect(
          plannerBoardQuerySchema.safeParse({ today: TODAY, done_days })
            .success,
        ).toBe(false);
      }
    });

    it("rejects a missing or invalid today and an unreadable flag, and ignores extra params", () => {
      expect(plannerBoardQuerySchema.safeParse({}).success).toBe(false);
      expect(
        plannerBoardQuerySchema.safeParse({ today: "2026-13-01" }).success,
      ).toBe(false);
      expect(
        plannerBoardQuerySchema.safeParse({
          today: TODAY,
          include_dropped: "maybe",
        }).success,
      ).toBe(false);
      expect(
        plannerBoardQuerySchema.safeParse({ today: TODAY, _: "cache-buster" })
          .success,
      ).toBe(true);
    });
  });

  describe("plannerRolloverSchema", () => {
    it("takes exactly today", () => {
      expect(plannerRolloverSchema.safeParse({ today: TODAY }).success).toBe(
        true,
      );
      expect(plannerRolloverSchema.safeParse({}).success).toBe(false);
      expect(plannerRolloverSchema.safeParse({ today: "soon" }).success).toBe(
        false,
      );
      expect(
        plannerRolloverSchema.safeParse({ today: TODAY, extra: 1 }).success,
      ).toBe(false);
    });
  });

  describe("plannerCreateTaskSchema", () => {
    it("accepts a title with today, and every optional field", () => {
      expect(
        plannerCreateTaskSchema.parse({ title: "  Buy milk ", today: TODAY }),
      ).toEqual({ title: "Buy milk", today: TODAY });
      const full = {
        title: "Fix the gate",
        notes: "Oil it",
        priority: "high",
        due_at: "2026-10-09",
        project_id: "projects/home",
        plan: { horizon: "week", day: "2026-10-09" },
        today: TODAY,
      } as const;
      expect(plannerCreateTaskSchema.parse(full)).toEqual(full);
      expect(
        plannerCreateTaskSchema.parse({ title: "x", plan: null, today: TODAY })
          .plan,
      ).toBeNull();
    });

    it("takes the column a task is created in, each of the four", () => {
      for (const column of ["backlog", "todo", "doing", "done"] as const) {
        expect(
          plannerCreateTaskSchema.parse({ title: "x", column, today: TODAY })
            .column,
        ).toBe(column);
      }
      expect(
        plannerCreateTaskSchema.parse({ title: "x", today: TODAY }),
      ).not.toHaveProperty("column");
      // That To Do needs a plan and Backlog refuses one is the domain's rule, so
      // it answers in the domain's envelope; the schema only checks the shape.
      expect(
        plannerCreateTaskSchema.safeParse({
          title: "x",
          column: "todo",
          today: TODAY,
        }).success,
      ).toBe(true);
      expect(
        plannerCreateTaskSchema.safeParse({
          title: "x",
          column: "backlog",
          plan: { horizon: "day", day: TODAY },
          today: TODAY,
        }).success,
      ).toBe(true);
    });

    it("rejects a missing today, a blank title, bad fields and keys it does not know", () => {
      for (const bad of [
        { title: "No today" },
        { title: "x", column: "archive", today: TODAY },
        { title: "x", column: "Doing", today: TODAY },
        { title: "x", column: null, today: TODAY },
        { title: "   ", today: TODAY },
        { title: "", today: TODAY },
        { title: "x".repeat(2_001), today: TODAY },
        { title: "x", priority: "urgent", today: TODAY },
        { title: "x", due_at: "tomorrow", today: TODAY },
        { title: "x", plan: { horizon: "year", day: TODAY }, today: TODAY },
        // Upstream's own fields that the planner does not take.
        { title: "x", status: "done", today: TODAY },
        { title: "x", source_memo_id: "memos/1", today: TODAY },
      ]) {
        expect(plannerCreateTaskSchema.safeParse(bad).success).toBe(false);
      }
    });
  });

  describe("plannerUpdateTaskSchema", () => {
    const base = { today: TODAY };

    it("accepts each kind of change on its own", () => {
      for (const change of [
        { column: "doing" },
        { plan: { horizon: "week", day: "2026-10-09" } },
        { plan: null },
        { dropped: true },
        { dropped: false },
        { title: "  New title " },
        { notes: null },
        { priority: "high" },
        { due_at: null },
        { project_id: null },
        { effort: 3 },
        { effort: 0 },
        { effort: 2.5 },
        { effort: null },
      ]) {
        expect(
          plannerUpdateTaskSchema.safeParse({ ...base, ...change }).success,
        ).toBe(true);
      }
    });

    it("counts an effort, even null, as the change a request needs", () => {
      expect(plannerUpdateTaskSchema.parse({ ...base, effort: null })).toEqual({
        ...base,
        effort: null,
      });
      expect(plannerUpdateTaskSchema.safeParse(base).success).toBe(false);
    });

    it("accepts an effort beside a column move, a plan or a title edit", () => {
      for (const change of [
        { column: "doing", effort: 4 },
        { plan: { horizon: "week", day: TODAY }, effort: 1.5 },
        { title: "Renamed", effort: null },
        { dropped: true, effort: 2 },
      ]) {
        expect(
          plannerUpdateTaskSchema.safeParse({ ...base, ...change }).success,
          JSON.stringify(change),
        ).toBe(true);
      }
    });

    it("accepts several changes together, a column move beside a title edit included", () => {
      expect(
        plannerUpdateTaskSchema.safeParse({
          ...base,
          column: "done",
          title: "Done and renamed",
          dropped: false,
        }).success,
      ).toBe(true);
    });

    it("trims the title like upstream does", () => {
      expect(
        plannerUpdateTaskSchema.parse({ ...base, title: "  New title " }).title,
      ).toBe("New title");
    });

    it("rejects column and plan together, even plan null", () => {
      for (const plan of [null, { horizon: "day", day: TODAY }]) {
        const result = plannerUpdateTaskSchema.safeParse({
          ...base,
          column: "todo",
          plan,
        });
        expect(result.success).toBe(false);
        expect(result.error?.issues[0]?.path).toEqual(["column"]);
        expect(messages(result)[0]).toContain("not both");
      }
    });

    it("rejects a request that changes nothing", () => {
      const result = plannerUpdateTaskSchema.safeParse(base);
      expect(result.success).toBe(false);
      expect(messages(result)).toContain(
        "At least one field besides today must be updated.",
      );
    });

    it("rejects a missing today, a bad column, plan, flag or field, and unknown keys", () => {
      for (const bad of [
        { title: "No today" },
        { ...base, column: "archive" },
        { ...base, column: "Doing" },
        { ...base, plan: { horizon: "year", day: TODAY } },
        { ...base, plan: { horizon: "day", day: "2026-02-30" } },
        { ...base, dropped: "yes" },
        { ...base, title: "   " },
        { ...base, due_at: "tomorrow" },
        { ...base, priority: "urgent" },
        // status and sort_order stay on /api/app/tasks.
        { ...base, status: "done" },
        { ...base, sort_order: 1 },
        { ...base, title: "x", typo: true },
        // an effort is a number from 0 to 999 with at most one decimal
        { ...base, effort: "3" },
        { ...base, effort: -1 },
        { ...base, effort: 1000 },
        { ...base, effort: 3.25 },
        { ...base, effort: Number.NaN },
        { ...base, effort: Number.POSITIVE_INFINITY },
      ]) {
        expect(plannerUpdateTaskSchema.safeParse(bad).success).toBe(false);
      }
    });
  });

  describe("plannerEffortSchema", () => {
    it("accepts 0 to 999 with at most one decimal place", () => {
      for (const value of [0, 0.1, 0.5, 1, 3, 3.5, 12.3, 100.7, 998.9, 999]) {
        expect(
          plannerEffortSchema.safeParse(value).success,
          String(value),
        ).toBe(true);
      }
      expect(plannerEffortMax).toBe(999);
    });

    it("tolerates float noise on a value that has one decimal, and nothing else", () => {
      // 1.1 * 10 is 11.000000000000002 in binary floats.
      expect(plannerEffortSchema.safeParse(1.1).success).toBe(true);
      expect(plannerEffortSchema.safeParse(0.1 + 0.2).success).toBe(true);
      expect(plannerEffortSchema.safeParse(1.01).success).toBe(false);
      expect(plannerEffortSchema.safeParse(0.05).success).toBe(false);
    });

    it("rejects a number out of range, with two decimals, or that is not a number", () => {
      for (const bad of [
        -0.1,
        999.1,
        1000,
        3.25,
        0.01,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        "3",
        "",
        null,
        undefined,
        true,
      ]) {
        expect(plannerEffortSchema.safeParse(bad).success, String(bad)).toBe(
          false,
        );
      }
    });
  });

  describe("comment bodies", () => {
    it("trim, then need 1 to 5000 characters", () => {
      expect(plannerCommentBodySchema.parse("  hello \n")).toBe("hello");
      expect(plannerCommentBodySchema.parse("line one\nline two")).toBe(
        "line one\nline two",
      );
      const longest = "x".repeat(plannerCommentBodyMax);
      expect(plannerCommentBodySchema.parse(longest)).toBe(longest);
      expect(plannerCommentBodyMax).toBe(5000);
      // Padding does not count against the limit: it is trimmed first.
      expect(plannerCommentBodySchema.safeParse(` ${longest} `).success).toBe(
        true,
      );
    });

    it("reject blank text, too long text and anything that is not text", () => {
      for (const bad of [
        "",
        "   ",
        "\n\t\n",
        "x".repeat(plannerCommentBodyMax + 1),
        null,
        undefined,
        42,
        { text: "hi" },
      ]) {
        expect(
          plannerCommentBodySchema.safeParse(bad).success,
          String(bad).slice(0, 20),
        ).toBe(false);
      }
    });

    it("are the whole body of a create or an update, and nothing else is accepted", () => {
      for (const schema of [
        plannerCreateCommentSchema,
        plannerUpdateCommentSchema,
      ]) {
        expect(schema.parse({ body: "  Looks good " })).toEqual({
          body: "Looks good",
        });
        for (const bad of [
          {},
          { body: "" },
          { body: "   " },
          { body: "x".repeat(plannerCommentBodyMax + 1) },
          { body: "ok", task_id: "tasks/1" },
          { body: "ok", today: TODAY },
          { text: "ok" },
          null,
          "ok",
        ]) {
          expect(schema.safeParse(bad).success, JSON.stringify(bad)).toBe(
            false,
          );
        }
      }
    });
  });

  describe("range queries", () => {
    it("accept a day or a span and reject a reversed or invalid range", () => {
      for (const schema of [
        plannerHistoryRangeQuerySchema,
        plannerRollupQuerySchema,
      ]) {
        expect(
          schema.safeParse({ from: "2026-10-01", to: "2026-10-07" }).success,
        ).toBe(true);
        expect(schema.safeParse({ from: TODAY, to: TODAY }).success).toBe(true);
        const reversed = schema.safeParse({
          from: "2026-10-07",
          to: "2026-10-01",
        });
        expect(reversed.success).toBe(false);
        expect(messages(reversed)).toContain("`from` must not be after `to`.");
        for (const bad of [
          {},
          { from: TODAY },
          { to: TODAY },
          { from: "2026-02-30", to: TODAY },
          { from: TODAY, to: "later" },
        ]) {
          expect(schema.safeParse(bad).success).toBe(false);
        }
      }
    });
  });

  describe("plannerUpdateTreeNodeSchema", () => {
    it("accepts each field alone, and null to clear all but the sort order", () => {
      for (const change of [
        { parent_project_id: "projects/a" },
        { parent_project_id: null },
        { level: "quarter" },
        { level: "a" },
        { level: "milestone-2" },
        { level: "a".repeat(24) },
        { level: null },
        { period_start: "2026-10-01" },
        { period_start: null },
        { period_end: "2026-12-31" },
        { period_end: null },
        { sort_order: 3 },
        { sort_order: -1 },
        { sort_order: 0 },
      ]) {
        expect(plannerUpdateTreeNodeSchema.safeParse(change).success).toBe(
          true,
        );
      }
    });

    it("keeps null as null, so a null parent can clear and an omitted one cannot", () => {
      const cleared = plannerUpdateTreeNodeSchema.parse({
        parent_project_id: null,
        level: null,
      });
      expect(cleared.parent_project_id).toBeNull();
      expect(cleared.level).toBeNull();
      const untouched = plannerUpdateTreeNodeSchema.parse({ sort_order: 1 });
      expect("parent_project_id" in untouched).toBe(false);
      expect("level" in untouched).toBe(false);
    });

    it("rejects an empty update", () => {
      const result = plannerUpdateTreeNodeSchema.safeParse({});
      expect(result.success).toBe(false);
      expect(messages(result)).toContain("At least one field must be updated.");
    });

    it("rejects a bad level, with the slug rule in the message", () => {
      for (const level of [
        "Quarter",
        "QUARTER",
        "1st",
        "-goal",
        "has space",
        "under_score",
        "",
        "a".repeat(25),
        5,
      ]) {
        const result = plannerUpdateTreeNodeSchema.safeParse({ level });
        expect(result.success).toBe(false);
      }
      expect(
        messages(
          plannerUpdateTreeNodeSchema.safeParse({ level: "Quarter" }),
        )[0],
      ).toContain("lowercase slug");
    });

    it("rejects bad dates, a fractional order, an empty parent and unknown keys", () => {
      for (const bad of [
        { period_start: "2026-02-30" },
        { period_end: "end of year" },
        { sort_order: 1.5 },
        { sort_order: "1" },
        { parent_project_id: "" },
        { parent_project_id: "   " },
        { name: "Renamed" },
        { sort_order: 1, typo: true },
      ]) {
        expect(plannerUpdateTreeNodeSchema.safeParse(bad).success).toBe(false);
      }
    });
  });
});

// --- Response schemas -------------------------------------------------------

const TASK: TaskDto = {
  id: "tasks/1",
  project_id: null,
  source_memo_id: null,
  title: "Buy milk",
  notes: null,
  status: "todo",
  priority: "none",
  due_at: null,
  sort_order: 0,
  completed_at: null,
  deleted_at: null,
  created_at: "2026-10-07T09:00:00.000Z",
  updated_at: "2026-10-07T09:00:00.000Z",
};

const PLAN = {
  task_id: "tasks/1",
  horizon: "week",
  period_start: "2026-10-05",
  carry_count: 0,
  dropped_at: null,
  effort: null,
  created_at: "2026-10-07T09:00:00.000Z",
  updated_at: "2026-10-07T09:00:00.000Z",
} as const;

const CARD: PlannerBoardCard = {
  id: "tasks/1",
  project_id: null,
  project_name: null,
  title: "Buy milk",
  status: "todo",
  priority: "none",
  due_at: null,
  sort_order: 0,
  completed_at: null,
  created_at: "2026-10-07T09:00:00.000Z",
  updated_at: "2026-10-07T09:00:00.000Z",
  horizon: "week",
  period_start: "2026-10-05",
  carry_count: 0,
  dropped_at: null,
};

const EVENT = {
  id: 1,
  task_id: "tasks/1",
  task_title: "Buy milk",
  type: "planned",
  data: { from: { horizon: null, period_start: null } },
  source: "planner",
  actor_type: "user",
  actor_name: null,
  occurred_at: "2026-10-07T09:00:00.000Z",
  created_at: "2026-10-07T09:00:00.000Z",
} as const;

const NODE = {
  id: "projects/a",
  name: "Home",
  status: "active",
  parent_project_id: null,
  level: "area",
  period_start: null,
  period_end: null,
  sort_order: 0,
} as const;

const COUNTS = {
  open_tasks: 2,
  done_tasks: 1,
  planned_in_range: 2,
  done_in_range: 1,
  carried_in_range: 0,
};

describe("planner API response schemas", () => {
  it("describe a board, with the dropped column only when present", () => {
    const board = {
      columns: { backlog: [], todo: [CARD], doing: [], done: [], other: [] },
      today: TODAY,
      periods: { day: TODAY, week: "2026-10-05", month: "2026-10-01" },
      history: "ok",
      truncated: false,
    };
    expect(plannerBoardResponseSchema.parse(board)).toEqual(board);
    const withDropped = {
      ...board,
      columns: { ...board.columns, dropped: [{ ...CARD, dropped_at: "x" }] },
      history: "paused",
    };
    expect(plannerBoardResponseSchema.parse(withDropped)).toEqual(withDropped);
  });

  it("keep an unknown status and priority as strings, so the other column can carry them", () => {
    const odd = { ...CARD, status: "blocked", priority: "urgent" };
    expect(plannerBoardCardRoundTrip(odd)).toEqual(odd);
  });

  it("reject a card with a bad horizon, a missing field or a bad history status", () => {
    const columns = { backlog: [], todo: [], doing: [], done: [], other: [] };
    const board = {
      columns,
      today: TODAY,
      periods: { day: TODAY, week: TODAY, month: TODAY },
      history: "ok",
      truncated: false,
    };
    expect(plannerBoardResponseSchema.safeParse(board).success).toBe(true);
    expect(
      plannerBoardResponseSchema.safeParse({ ...board, history: "stale" })
        .success,
    ).toBe(false);
    expect(
      plannerBoardResponseSchema.safeParse({
        ...board,
        columns: { ...columns, todo: [{ ...CARD, horizon: "year" }] },
      }).success,
    ).toBe(false);
    const { carry_count: _omitted, ...incomplete } = CARD;
    expect(
      plannerBoardResponseSchema.safeParse({
        ...board,
        columns: { ...columns, todo: [incomplete] },
      }).success,
    ).toBe(false);
  });

  it("describe a task with its plan, and a create that kept the task but lost the plan", () => {
    expect(
      plannerTaskPlanResponseSchema.parse({ task: TASK, plan: PLAN }),
    ).toEqual({ task: TASK, plan: PLAN });
    expect(
      plannerTaskPlanResponseSchema.parse({ task: TASK, plan: null }).plan,
    ).toBeNull();
    // A task that was never planned still needs the key: plan is null, not absent.
    expect(
      plannerTaskPlanResponseSchema.safeParse({ task: TASK }).success,
    ).toBe(false);

    expect(
      plannerCreateTaskResponseSchema.parse({ task: TASK, plan: PLAN }),
    ).not.toHaveProperty("plan_error");
    expect(
      plannerCreateTaskResponseSchema.parse({
        task: TASK,
        plan: null,
        plan_error: "The plan could not be saved.",
      }),
    ).toEqual({
      task: TASK,
      plan: null,
      plan_error: "The plan could not be saved.",
    });
  });

  it("describe a plan row, a rollover result and the archived events", () => {
    expect(plannerPlanDtoSchema.parse(PLAN)).toEqual(PLAN);
    expect(
      plannerPlanDtoSchema.parse({
        ...PLAN,
        horizon: null,
        period_start: null,
        carry_count: 3,
        dropped_at: "2026-10-07T10:00:00.000Z",
      }).horizon,
    ).toBeNull();
    // An effort-only row: no horizon, an estimate. The key is always present.
    expect(
      plannerPlanDtoSchema.parse({
        ...PLAN,
        horizon: null,
        period_start: null,
        effort: 3.5,
      }),
    ).toMatchObject({ horizon: null, effort: 3.5 });
    expect(
      plannerPlanDtoSchema.safeParse({ ...PLAN, effort: "3" }).success,
    ).toBe(false);
    const { effort: _effort, ...withoutEffort } = PLAN;
    expect(plannerPlanDtoSchema.safeParse(withoutEffort).success).toBe(false);
    expect(
      plannerRolloverResponseSchema.parse({ history: "paused", carried: 4 }),
    ).toEqual({ history: "paused", carried: 4 });
    expect(plannerEventDtoSchema.parse(EVENT)).toEqual(EVENT);
    expect(
      plannerEventDtoSchema.parse({
        ...EVENT,
        source: "sync",
        actor_type: null,
        task_title: null,
      }).actor_type,
    ).toBeNull();
    expect(
      plannerEventDtoSchema.safeParse({ ...EVENT, source: "cron" }).success,
    ).toBe(false);
    expect(
      plannerEventDtoSchema.safeParse({ ...EVENT, actor_type: "robot" })
        .success,
    ).toBe(false);
    expect(plannerTaskHistoryResponseSchema.parse({ events: [EVENT] })).toEqual(
      { events: [EVENT] },
    );
    expect(
      plannerHistoryRangeResponseSchema.parse({
        events: [EVENT],
        truncated: true,
      }),
    ).toEqual({ events: [EVENT], truncated: true });
    expect(
      plannerHistoryRangeResponseSchema.safeParse({ events: [EVENT] }).success,
    ).toBe(false);
  });

  it("describe the tree, one node and a roll-up", () => {
    expect(plannerTreeNodeDtoSchema.parse(NODE)).toEqual(NODE);
    expect(plannerTreeResponseSchema.parse({ nodes: [NODE] })).toEqual({
      nodes: [NODE],
    });
    expect(plannerTreeNodeResponseSchema.parse({ node: NODE })).toEqual({
      node: NODE,
    });
    expect(
      plannerTreeNodeDtoSchema.safeParse({ ...NODE, status: "deleted" })
        .success,
    ).toBe(false);

    const rollup = {
      project_id: "projects/a",
      from: "2026-10-01",
      to: "2026-10-31",
      nodes: [
        {
          id: "projects/a",
          name: "Home",
          parent_project_id: null,
          level: "area",
          depth: 0,
          ...COUNTS,
        },
      ],
      total: COUNTS,
    };
    expect(plannerRollupResponseSchema.parse(rollup)).toEqual(rollup);
    expect(
      plannerRollupResponseSchema.safeParse({ ...rollup, total: undefined })
        .success,
    ).toBe(false);
  });

  const COMMENT = {
    id: "5b0e6a6c-6c0f-4d3a-9a52-1f3f0f0c2f11",
    task_id: "tasks/1",
    body: "Remember the second screen.",
    created_at: "2026-10-07T09:00:00.000Z",
    updated_at: "2026-10-07T09:05:00.000Z",
  };

  it("describe a comment, and the list, create and delete answers", () => {
    expect(plannerCommentDtoSchema.parse(COMMENT)).toEqual(COMMENT);
    expect(
      plannerCommentDtoSchema.safeParse({ ...COMMENT, body: undefined })
        .success,
    ).toBe(false);
    expect(
      plannerCommentListResponseSchema.parse({ comments: [COMMENT, COMMENT] }),
    ).toEqual({ comments: [COMMENT, COMMENT] });
    expect(
      plannerCommentListResponseSchema.parse({ comments: [] }).comments,
    ).toEqual([]);
    expect(plannerCommentResponseSchema.parse({ comment: COMMENT })).toEqual({
      comment: COMMENT,
    });
    expect(plannerDeleteCommentResponseSchema.parse({ ok: true })).toEqual({
      ok: true,
    });
    expect(
      plannerDeleteCommentResponseSchema.safeParse({ ok: false }).success,
    ).toBe(false);
  });

  it("describe the task panel's detail: task, plan with effort, project with its path, comments", () => {
    const detail = {
      task: { ...TASK, notes: "Some notes" },
      plan: { ...PLAN, effort: 3.5 },
      project: {
        id: "projects/marathon",
        name: "Run a marathon",
        ancestors: [{ id: "projects/health", name: "Health" }],
      },
      comments: [COMMENT],
    };
    expect(plannerTaskDetailResponseSchema.parse(detail)).toEqual(detail);

    // A task with nothing else: every key is still there, null or empty.
    const bare = { task: TASK, plan: null, project: null, comments: [] };
    expect(plannerTaskDetailResponseSchema.parse(bare)).toEqual(bare);
    for (const missing of ["task", "plan", "project", "comments"] as const) {
      const { [missing]: _removed, ...rest } = detail;
      expect(
        plannerTaskDetailResponseSchema.safeParse(rest).success,
        missing,
      ).toBe(false);
    }
    // A project needs its path, even when it is empty.
    expect(
      plannerTaskDetailResponseSchema.safeParse({
        ...bare,
        project: { id: "projects/home", name: "Home" },
      }).success,
    ).toBe(false);
  });

  it("export types that match their schemas", () => {
    expectTypeOf<PlannerColumn>().toEqualTypeOf<
      "backlog" | "todo" | "doing" | "done"
    >();
    expectTypeOf<PlannerHorizon>().toEqualTypeOf<
      z.infer<typeof plannerHorizonSchema>
    >();
    expectTypeOf<PlannerBoardResponse["columns"]["dropped"]>().toEqualTypeOf<
      PlannerBoardCard[] | undefined
    >();
    expectTypeOf<
      PlannerBoardCard["horizon"]
    >().toEqualTypeOf<PlannerHorizon | null>();
    expectTypeOf<PlannerUpdateTaskInput["plan"]>().toEqualTypeOf<
      { horizon: PlannerHorizon; day: string } | null | undefined
    >();
    expectTypeOf<PlannerUpdateTaskInput["notes"]>().toEqualTypeOf<
      string | null | undefined
    >();
    expectTypeOf<PlannerUpdateTaskInput["effort"]>().toEqualTypeOf<
      number | null | undefined
    >();
    expectTypeOf<PlannerCreateTaskInput["column"]>().toEqualTypeOf<
      PlannerColumn | undefined
    >();
    expectTypeOf<PlannerTaskDetailResponse["project"]>().toEqualTypeOf<{
      id: string;
      name: string;
      ancestors: Array<{ id: string; name: string }>;
    } | null>();
    expectTypeOf<PlannerCommentDto>().toEqualTypeOf<
      z.infer<typeof plannerCommentDtoSchema>
    >();
  });
});

function plannerBoardCardRoundTrip(card: PlannerBoardCard) {
  const board = plannerBoardResponseSchema.parse({
    columns: { backlog: [], todo: [], doing: [], done: [], other: [card] },
    today: TODAY,
    periods: { day: TODAY, week: TODAY, month: TODAY },
    history: "ok",
    truncated: false,
  });
  return board.columns.other[0];
}
