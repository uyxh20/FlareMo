import {
  type PlannerBoardResponse,
  type PlannerCommentListResponse,
  type PlannerCommentResponse,
  type PlannerCreateTaskResponse,
  type PlannerDeleteCommentResponse,
  type PlannerHistoryRangeResponse,
  type PlannerTaskDetailResponse,
  type PlannerTaskHistoryResponse,
  type PlannerTaskPlanResponse,
  plannerBoardQuerySchema,
  plannerCreateCommentSchema,
  plannerCreateTaskSchema,
  plannerHistoryRangeQuerySchema,
  plannerUpdateCommentSchema,
  plannerUpdateTaskSchema,
} from "@flaremo/contracts";
import { parseResourceName } from "@flaremo/domain";
import {
  plannerAddComment,
  plannerAddTask,
  plannerChangeTask,
  plannerDeleteComment,
  plannerListComments,
  plannerReadBoard,
  plannerReadCockpitWeek,
  plannerReadHistoryRange,
  plannerReadTaskDetail,
  plannerReadTaskHistory,
  plannerSyncHistory,
  plannerUpdateComment,
} from "@flaremo/domain/src/planner";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { getRequestContext, type HonoBindings } from "../context";
import { jsonError } from "../http";
import { rateLimitGuard } from "../rate-limit";
import { plannerGoalsApi } from "./planner-goals-api";
import {
  plannerAssertToday,
  plannerResolveActor,
} from "./planner-route-helpers";

// The planning cockpit's HTTP API (fork-owned add-on,
// docs/planning-cockpit-implementation-plan.md, section 4), mounted lazily at
// /api/app/planner and registered before /api/app so nothing there can shadow it.
//
// It authenticates exactly like tasks-api.ts: `getRequestContext` accepts a
// cookie session (state-changing requests must carry FlareMo's Origin) or a
// `memos_pat_` PAT, and the actor comes from the credential. All logic lives in
// packages/domain/src/planner (M2); the routes only validate, authenticate,
// throttle and serialise. Each response is typed with its contract, so a domain
// type that drifts from the wire shape fails to compile here.

export const plannerApi = new Hono<HonoBindings>();

// A uniform JSON envelope for unknown paths, like every other /api/* 404. The
// lazy mount hands requests to this sub-app, so its own 404 would otherwise be
// Hono's plain text.
plannerApi.notFound((c) => c.json({ error: { message: "Not found" } }, 404));

// `/api/app/*` routes take a bare resource id in the URL path; the shared
// helper prepends the namespaced prefix (and passes namespaced names through).
function parseTaskId(value: string) {
  return parseResourceName(value, "tasks");
}

// --- Board and rollover -----------------------------------------------------

// The board also carries the week the cockpit's goal cards show and that week's
// goals (migration 9005), so the cockpit draws both from one request.
//
// The board syncs the history archive first, as rollover did before the web stopped
// calling it (section 13.x): loading the cockpit is what keeps the archive current.
// The sync is debounced to 30 seconds and never throws, so a failed sync leaves the
// board readable (its `history` field says `paused`).
plannerApi.get(
  "/board",
  zValidator("query", plannerBoardQuerySchema),
  async (c) => {
    try {
      const { db, user } = await getRequestContext(c);
      const query = c.req.valid("query");
      plannerAssertToday(query.today, new Date());
      await plannerSyncHistory(db, { userId: user.id, now: new Date() });
      const [board, week] = await Promise.all([
        plannerReadBoard(db, {
          userId: user.id,
          today: query.today,
          doneDays: query.done_days,
          includeDropped: query.include_dropped,
        }),
        plannerReadCockpitWeek(db, { userId: user.id, today: query.today }),
      ]);
      const response: PlannerBoardResponse = { ...board, week };
      return c.json(response);
    } catch (error) {
      return jsonError(c, error);
    }
  },
);

// Retired (fork review finding A05). The web no longer calls it, but every call
// still wrote permanent `carried_over` events to the archive, so a stale client
// or a PAT could add history that can never be removed. It still checks the
// credential and the rate limit, then answers 410 Gone. The domain function
// `plannerRollover` stays, unused, under the additive-only rule.
plannerApi.post("/rollover", async (c) => {
  try {
    const context = await getRequestContext(c);
    const throttled = await rateLimitGuard(c, "planner", context.user.id);
    if (throttled) return throttled;
    return c.json(
      {
        error: {
          message:
            "Rollover is no longer supported; plan tasks on the board instead.",
        },
      },
      410,
    );
  } catch (error) {
    return jsonError(c, error);
  }
});

// --- Tasks ------------------------------------------------------------------

// A new task, in a column and with a goal when asked (plannerAddTask). The task
// exists once this answers 201. When only its plan or its goal link could not be
// saved, `plan` is null or the goal is missing and `plan_error` or `goal_error`
// tells the client to retry that part.
plannerApi.post(
  "/tasks",
  zValidator("json", plannerCreateTaskSchema),
  async (c) => {
    try {
      const context = await getRequestContext(c);
      const throttled = await rateLimitGuard(c, "planner", context.user.id);
      if (throttled) return throttled;
      const body = c.req.valid("json");
      plannerAssertToday(body.today, new Date());
      const created = await plannerAddTask(context.db, {
        user: context.user,
        actor: await plannerResolveActor(c, context.credential),
        title: body.title,
        notes: body.notes,
        priority: body.priority,
        dueAt: body.due_at,
        projectId: body.project_id,
        column: body.column,
        plan: body.plan,
        goalId: body.goal_id,
        today: body.today,
      });
      const response: PlannerCreateTaskResponse = {
        task: created.task,
        plan: created.plan,
        ...(created.planError ? { plan_error: created.planError } : {}),
        ...(created.goalError ? { goal_error: created.goalError } : {}),
      };
      return c.json(response, 201);
    } catch (error) {
      return jsonError(c, error);
    }
  },
);

// Everything the task panel shows: the whole task (notes included, which a board
// card leaves out), its plan with the effort estimate, its goal with the path of
// goals above it, and its comments. A task that is missing, in the recycle bin or
// someone else's is a 404. Reads are not throttled and write nothing.
plannerApi.get("/tasks/:id", async (c) => {
  try {
    const { db, user } = await getRequestContext(c);
    const detail: PlannerTaskDetailResponse = await plannerReadTaskDetail(db, {
      userId: user.id,
      taskId: parseTaskId(c.req.param("id")),
    });
    return c.json(detail);
  } catch (error) {
    return jsonError(c, error);
  }
});

// One request can change a task's column and place, plan, effort, start date,
// goal, drop state and upstream fields together. plannerChangeTask owns the order
// (documented on `plannerUpdateTaskSchema`) and checks everything it can refuse
// before the first write.
plannerApi.patch(
  "/tasks/:id",
  zValidator("json", plannerUpdateTaskSchema),
  async (c) => {
    try {
      const context = await getRequestContext(c);
      const throttled = await rateLimitGuard(c, "planner", context.user.id);
      if (throttled) return throttled;
      const body = c.req.valid("json");
      plannerAssertToday(body.today, new Date());
      const result = await plannerChangeTask(context.db, {
        user: context.user,
        actor: await plannerResolveActor(c, context.credential),
        taskId: parseTaskId(c.req.param("id")),
        today: body.today,
        change: {
          dropped: body.dropped,
          title: body.title,
          notes: body.notes,
          priority: body.priority,
          dueAt: body.due_at,
          projectId: body.project_id,
          column: body.column,
          beforeId: body.before_id,
          afterId: body.after_id,
          plan: body.plan,
          effort: body.effort,
          startDate: body.start_date,
          goalId: body.goal_id,
        },
      });
      const response: PlannerTaskPlanResponse = {
        task: result.task,
        plan: result.plan,
      };
      return c.json(response);
    } catch (error) {
      return jsonError(c, error);
    }
  },
);

// History reads sync the archive first, so an edit made through /projects or the
// API a moment ago is already in it. The sync never throws and may report
// `paused`; either way the archive is read, so its result is ignored here. A
// task that is gone (purged) still has its history, so an unknown task id is an
// empty list rather than a 404, and the read is scoped to the caller either way.
plannerApi.get("/tasks/:id/history", async (c) => {
  try {
    const { db, user } = await getRequestContext(c);
    await plannerSyncHistory(db, { userId: user.id, now: new Date() });
    const response: PlannerTaskHistoryResponse = {
      events: await plannerReadTaskHistory(db, {
        userId: user.id,
        taskId: parseTaskId(c.req.param("id")),
      }),
    };
    return c.json(response);
  } catch (error) {
    return jsonError(c, error);
  }
});

// --- Comments ---------------------------------------------------------------
//
// A task's comments live in planner_task_comment and are soft-deleted. A comment
// is the caller's own, and so is its task, so another user's comment id, a deleted
// one and one that never existed all answer 404. Every write is one batch with its
// history event (`commented`, `comment_edited`, `comment_deleted`), which carries
// the comment's id and never its text. DELETE is in the API's CORS allow-list
// (upstream's task delete uses it), so it is a real DELETE.

plannerApi.get("/tasks/:id/comments", async (c) => {
  try {
    const { db, user } = await getRequestContext(c);
    const response: PlannerCommentListResponse = {
      comments: await plannerListComments(db, {
        userId: user.id,
        taskId: parseTaskId(c.req.param("id")),
      }),
    };
    return c.json(response);
  } catch (error) {
    return jsonError(c, error);
  }
});

plannerApi.post(
  "/tasks/:id/comments",
  zValidator("json", plannerCreateCommentSchema),
  async (c) => {
    try {
      const context = await getRequestContext(c);
      const throttled = await rateLimitGuard(c, "planner", context.user.id);
      if (throttled) return throttled;
      const { body } = c.req.valid("json");
      const response: PlannerCommentResponse = {
        comment: await plannerAddComment(context.db, {
          user: context.user,
          actor: await plannerResolveActor(c, context.credential),
          taskId: parseTaskId(c.req.param("id")),
          body,
        }),
      };
      return c.json(response, 201);
    } catch (error) {
      return jsonError(c, error);
    }
  },
);

plannerApi.patch(
  "/comments/:id",
  zValidator("json", plannerUpdateCommentSchema),
  async (c) => {
    try {
      const context = await getRequestContext(c);
      const throttled = await rateLimitGuard(c, "planner", context.user.id);
      if (throttled) return throttled;
      const { body } = c.req.valid("json");
      const response: PlannerCommentResponse = {
        comment: await plannerUpdateComment(context.db, {
          user: context.user,
          actor: await plannerResolveActor(c, context.credential),
          commentId: c.req.param("id"),
          body,
        }),
      };
      return c.json(response);
    } catch (error) {
      return jsonError(c, error);
    }
  },
);

plannerApi.delete("/comments/:id", async (c) => {
  try {
    const context = await getRequestContext(c);
    const throttled = await rateLimitGuard(c, "planner", context.user.id);
    if (throttled) return throttled;
    await plannerDeleteComment(context.db, {
      user: context.user,
      actor: await plannerResolveActor(c, context.credential),
      commentId: c.req.param("id"),
    });
    const response: PlannerDeleteCommentResponse = { ok: true };
    return c.json(response);
  } catch (error) {
    return jsonError(c, error);
  }
});

plannerApi.get(
  "/history",
  zValidator("query", plannerHistoryRangeQuerySchema),
  async (c) => {
    try {
      const { db, user } = await getRequestContext(c);
      const { from, to } = c.req.valid("query");
      await plannerSyncHistory(db, { userId: user.id, now: new Date() });
      const response: PlannerHistoryRangeResponse =
        await plannerReadHistoryRange(db, { userId: user.id, from, to });
      return c.json(response);
    } catch (error) {
      return jsonError(c, error);
    }
  },
);

// --- Goals and the weekly review --------------------------------------------

// Registered last, on the same sub-app, so the lazy mount and the JSON 404 above
// cover them too (planner-goals-api.ts).
plannerApi.route("/", plannerGoalsApi);
